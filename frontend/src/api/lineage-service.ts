import {
  ENABLED_STATUS,
  GRAPH_KEY,
  joinRelations,
  nodeCode,
  nodeName,
  parseRelationList,
  validateEnable,
} from '../domain/lineage-graph'
import {
  acquireEnableLock,
  appendVersion,
  commitEnableLock,
  latestVersion,
  listVersions,
  loadGraphStore,
  deleteInFlightLock,
  replaceGraphStore,
  resetGraphStore,
  snapshotGraphStore,
  armWriteFailure,
  graphStorageKey,
  type GraphVersion,
} from '../data/graph-store'
import {
  listRows,
  replaceAllRows,
  resetRows,
  saveRows,
  snapshotRows,
} from '../data/local-store'
import type { ActionResult, EntryRow } from '../data/types'

const META_KEY = 'meta'
const SYNC_MARKER = '血缘同步'
const SYNC_NODE_CODE = '关联节点编号'
const SYNC_VERSION = '关联图谱版本'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function nextMetaId(metaRows: EntryRow[]): number {
  return metaRows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
}

function buildMetaEntry(id: number, node: EntryRow, versionCode: string, nowIso: string): EntryRow {
  return {
    id,
    status: '已生效',
    pending: false,
    abnormal: false,
    条目编号: `META-${String(id).padStart(4, '0')}`,
    对象类型: '血缘节点',
    对象名称: nodeName(node),
    属性键: '图谱版本',
    属性值: versionCode,
    数据来源: '血缘图谱启用同步',
    更新频率: nowIso.slice(0, 10),
    版本变更: versionCode,
    [SYNC_MARKER]: 'true',
    [SYNC_NODE_CODE]: nodeCode(node),
    [SYNC_VERSION]: versionCode,
  }
}

// 图谱版本同步到元数据中心：已有条目更新版本引用，没有则新建，保证不重复登记。
function upsertMeta(metaRows: EntryRow[], node: EntryRow, versionCode: string, nowIso: string): EntryRow[] {
  const next = [...metaRows]
  const index = next.findIndex((row) => String(row[SYNC_MARKER] ?? '') === 'true' && String(row[SYNC_NODE_CODE] ?? '') === nodeCode(node))
  if (index >= 0) {
    next[index] = {
      ...next[index],
      属性值: versionCode,
      版本变更: versionCode,
      [SYNC_VERSION]: versionCode,
      更新频率: nowIso.slice(0, 10),
      status: '已生效',
      pending: false,
      abnormal: false,
    }
    return next
  }
  next.push(buildMetaEntry(nextMetaId(metaRows), node, versionCode, nowIso))
  return next
}

export type EnableOutcome = ActionResult & { versionCode?: string; reused?: boolean }

// 启用节点：校验 → 并发锁/幂等 → 冻结版本 → 同步元数据 → 提交，任一步失败整体回退。
export function enableLineageNode(id: number): EnableOutcome {
  const rowsBefore = listRows(GRAPH_KEY)
  const target = rowsBefore.find((row) => Number(row.id) === Number(id))
  if (!target) {
    return { ok: false, message: `没有找到编号为 ${id} 的血缘节点` }
  }
  if (String(target.status) === ENABLED_STATUS) {
    // 历史取值沿用旧规则：已是启用态的节点不重算、不重复冻结。
    return { ok: false, message: '血缘节点已经是「已启用」，不用重复操作' }
  }

  // 一、前沿上下游关系检查：自引用、反向边、环路、停用引用、悬空引用、超上限。
  const validation = validateEnable(Number(id), rowsBefore)
  if (!validation.ok) {
    const detail = validation.issues.map((issue) => issue.message).join('；')
    return { ok: false, message: `启用被拒绝，血缘校验未通过：${detail}` }
  }

  // 二、事务边界：同时快照业务条目库与图谱版本库，失败时双库整体还原。
  // 锁申请本身也可能落库失败，因此并入同一事务，任何一步出错都走回退。
  const entrySnapshot = snapshotRows()
  const graphSnapshot = snapshotGraphStore()
  let acquiredChecksum: string | null = null
  try {
    // 同一图谱并发启用控制：按结构指纹加锁，后到请求直接复用已提交版本。
    const lock = acquireEnableLock(validation.checksum)
    if (!lock.locked && !lock.reusable) {
      throw new Error('同一图谱正在启用处理中，存在并发冲突，请稍后重试')
    }
    if (lock.locked) {
      acquiredChecksum = validation.checksum
    }

    let version: GraphVersion | undefined = lock.reusable
    const reused = Boolean(lock.reusable)
    if (!version) {
      version = appendVersion({
        checksum: validation.checksum,
        createdAt: new Date().toISOString(),
        nodeCount: validation.graph.nodes.length,
        edgeCount: validation.graph.edges.length,
        nodes: validation.graph.nodes.map((row) => ({
          id: Number(row.id),
          code: nodeCode(row),
          name: nodeName(row),
          type: String(row['节点类型'] ?? ''),
          status: String(row.status),
        })),
        edges: validation.graph.edges.map((edge) => ({
          source: edge.source,
          target: edge.target,
          declaredBy: edge.declaredBy,
          via: edge.via,
        })),
        enabledNodeId: Number(id),
      })
    }

    const nextSnapshot = clone(entrySnapshot)
    const lineageRows = [...(nextSnapshot[GRAPH_KEY] ?? [])]
    const targetIndex = lineageRows.findIndex((row) => Number(row.id) === Number(id))
    lineageRows[targetIndex] = {
      ...lineageRows[targetIndex],
      status: ENABLED_STATUS,
      pending: false,
      abnormal: false,
      图谱版本: version.versionCode,
    }
    nextSnapshot[GRAPH_KEY] = lineageRows
    nextSnapshot[META_KEY] = upsertMeta(nextSnapshot[META_KEY] ?? [], target, version.versionCode, new Date().toISOString())

    // 一次性提交整库下一态，避免只写半套连接关系。
    replaceAllRows(nextSnapshot)
    if (!reused) {
      commitEnableLock(validation.checksum, version.versionCode)
    }

    return reused
      ? { ok: true, reused: true, versionCode: version.versionCode, message: `同结构图谱版本 ${version.versionCode} 已存在，本次启用直接复用，未生成重复边，元数据条目已引用该版本` }
      : { ok: true, reused: false, versionCode: version.versionCode, message: `血缘校验通过，已冻结图谱版本 ${version.versionCode} 并同步至元数据中心` }
  } catch (error) {
    // 四、整次启用回退：业务条目与版本库都还原到启用前，不留下半套连接关系。
    replaceAllRows(entrySnapshot)
    replaceGraphStore(graphSnapshot)
    if (acquiredChecksum) {
      // 仅清理本次事务拿到的在途锁；复用既有版本时不碰别人的锁。
      deleteInFlightLock(acquiredChecksum)
    }
    const reason = error instanceof Error ? error.message : '未知存储故障'
    return { ok: false, message: `图谱版本未能完整落库，本次启用已整体回退：${reason}` }
  }
}

// 并发启用演练：同一图谱连续两次启用，只有第一次冻结版本，第二次必须复用。
export function simulateConcurrentEnable(id: number): { requests: EnableOutcome[]; versionCode?: string; duplicatedEdges: boolean } {
  const beforeVersionCount = listVersions().length
  const first = enableLineageNode(id)
  // 第二次对同一节点发起并发请求：已启用节点会先被旧规则拦截，
  // 因此改为选择同图中另一个未启用、未停用的节点来真实演练复用路径。
  const rows = listRows(GRAPH_KEY)
  const peer = rows.find((row) => Number(row.id) !== Number(id) && String(row.status) !== ENABLED_STATUS && String(row.status) !== '已停用')
  const secondTarget = peer ? Number(peer.id) : Number(id)
  const second = enableLineageNode(secondTarget)
  const afterVersionCount = listVersions().length
  const current = latestVersion()
  return {
    requests: [first, second],
    versionCode: current?.versionCode,
    duplicatedEdges: afterVersionCount > beforeVersionCount + (first.ok && !first.reused ? 1 : 0),
  }
}

// 直接编辑上下游列表：已启用节点的关系随版本冻结，必须先停用才能改。
export function updateLineageRelations(id: number, upstream: string, downstream: string): ActionResult {
  const rows = listRows(GRAPH_KEY)
  const index = rows.findIndex((row) => Number(row.id) === Number(id))
  if (index < 0) {
    return { ok: false, message: `没有找到编号为 ${id} 的血缘节点` }
  }
  const current = rows[index]
  if (String(current.status) === ENABLED_STATUS) {
    return { ok: false, message: '已启用节点的上下游关系已随图谱版本冻结，请先停用节点再编辑' }
  }
  const normalizedUpstream = joinRelations(parseRelationList(upstream))
  const normalizedDownstream = joinRelations(parseRelationList(downstream))
  const next = [...rows]
  next[index] = {
    ...current,
    上游节点列表: normalizedUpstream,
    下游节点列表: normalizedDownstream,
  }
  saveRows(GRAPH_KEY, next)
  return { ok: true, message: `节点 ${nodeCode(current)} 的上下游关系已保存，启用时将执行环路与停用引用校验` }
}

export function getGraphVersions(): GraphVersion[] {
  return listVersions()
}

export function exportGraphVersions(): { filename: string; content: string } {
  const header = ['版本编号', '冻结时间', '结构指纹', '节点数', '边数', '触发启用节点']
  const lines = [header.join(',')]
  for (const version of listVersions()) {
    const trigger = version.nodes.find((node) => node.id === version.enabledNodeId)
    lines.push([
      version.versionCode,
      version.createdAt,
      version.checksum,
      version.nodeCount,
      version.edgeCount,
      trigger ? trigger.code : String(version.enabledNodeId),
    ].join(','))
  }
  return { filename: '血缘图谱-冻结版本清单.csv', content: `﻿${lines.join('\n')}` }
}

// 重置血缘模块：业务节点、冻结版本库、同步到元数据中心的条目一起回到初始态。
export function resetLineageModule(): void {
  resetRows(GRAPH_KEY)
  resetGraphStore()
  const metaRows = listRows(META_KEY)
  const remaining = metaRows.filter((row) => String(row[SYNC_MARKER] ?? '') !== 'true')
  saveRows(META_KEY, remaining)
}

export const lineageTestSeams = {
  armWriteFailure,
  deleteInFlightLock,
  loadGraphStore,
  graphStorageKey,
}
