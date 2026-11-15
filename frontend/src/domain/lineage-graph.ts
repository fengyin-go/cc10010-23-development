import type { EntryRow } from '../data/types'

// 血缘图谱领域规则：纯函数、无存储依赖，启用链路与页面都复用这里的结论。
// 历史数据不回溯校验，只有新的「启用节点」动作会走这套规则。

export const GRAPH_KEY = 'lineage'
export const ENABLED_STATUS = '已启用'
export const DISABLED_STATUS = '已停用'

// 环路条件里的「超出节点上限」：整张图的节点数上限、单节点上下游关系数上限。
export const MAX_GRAPH_NODES = 100
export const MAX_RELATIONS_PER_NODE = 20

export type IssueCode =
  | 'SELF_REFERENCE'
  | 'REVERSE_EDGE'
  | 'CYCLE'
  | 'DEACTIVATED_REF'
  | 'DANGLING_REF'
  | 'NODE_LIMIT_EXCEEDED'
  | 'RELATION_LIMIT_EXCEEDED'

export type ValidationIssue = {
  code: IssueCode
  nodeCode: string
  relatedCode?: string
  message: string
}

export type GraphEdge = {
  source: string
  target: string
  declaredBy: string
  via: '上游节点列表' | '下游节点列表'
}

export type BuiltGraph = {
  nodes: EntryRow[]
  // 节点编号 / 节点名称 / 行 id 都能定位到同一个节点，边里统一存节点编号。
  byRef: Map<string, EntryRow>
  edges: GraphEdge[]
  adjacency: Map<string, Set<string>>
  dangling: ValidationIssue[]
}

export type EnableValidation = {
  ok: boolean
  issues: ValidationIssue[]
  graph: BuiltGraph
  checksum: string
}

const SPLIT_PATTERN = /[,，;；、|\s]+/

export function nodeCode(row: EntryRow): string {
  return String(row['节点编号'] ?? '')
}

export function nodeName(row: EntryRow): string {
  return String(row['节点名称'] ?? '')
}

// 上游/下游列表在数据里是文本，统一按常见分隔符拆开、去空、去重。
export function parseRelationList(raw: unknown): string[] {
  if (raw === undefined || raw === null) {
    return []
  }
  const tokens = String(raw).split(SPLIT_PATTERN).map((item) => item.trim()).filter(Boolean)
  return [...new Set(tokens)]
}

function buildReferenceIndex(rows: EntryRow[]): Map<string, EntryRow> {
  const index = new Map<string, EntryRow>()
  for (const row of rows) {
    index.set(nodeCode(row), row)
    index.set(nodeName(row), row)
    index.set(String(row.id), row)
  }
  return index
}

export function buildGraph(rows: EntryRow[]): BuiltGraph {
  const byRef = buildReferenceIndex(rows)
  const edges: GraphEdge[] = []
  const adjacency = new Map<string, Set<string>>()
  const dangling: ValidationIssue[] = []
  const seenEdge = new Set<string>()

  const ensureAdj = (code: string) => {
    let set = adjacency.get(code)
    if (!set) {
      set = new Set<string>()
      adjacency.set(code, set)
    }
    return set
  }

  const addEdge = (source: string, target: string, declaredBy: string, via: GraphEdge['via']) => {
    const key = `${source}->${target}`
    ensureAdj(source).add(target)
    ensureAdj(target)
    if (seenEdge.has(key)) {
      // 同一条边只保留一份，启用冻结时不再生成重复边。
      return
    }
    seenEdge.add(key)
    edges.push({ source, target, declaredBy, via })
  }

  for (const row of rows) {
    const code = nodeCode(row)
    ensureAdj(code)
    const upstream = parseRelationList(row['上游节点列表'])
    const downstream = parseRelationList(row['下游节点列表'])

    for (const token of upstream) {
      const ref = byRef.get(token)
      if (!ref) {
        dangling.push({
          code: 'DANGLING_REF',
          nodeCode: code,
          relatedCode: token,
          message: `节点 ${code} 的上游节点「${token}」在血缘图谱中不存在`,
        })
        continue
      }
      addEdge(nodeCode(ref), code, code, '上游节点列表')
    }

    for (const token of downstream) {
      const ref = byRef.get(token)
      if (!ref) {
        dangling.push({
          code: 'DANGLING_REF',
          nodeCode: code,
          relatedCode: token,
          message: `节点 ${code} 的下游节点「${token}」在血缘图谱中不存在`,
        })
        continue
      }
      addEdge(code, nodeCode(ref), code, '下游节点列表')
    }
  }

  return { nodes: rows, byRef, edges, adjacency, dangling }
}

// 结构指纹只看节点编号集合与去重后的边，状态变化不影响指纹：
// 同一张图连续启用两个节点时，后一次必须复用同一个冻结版本。
export function computeChecksum(graph: BuiltGraph): string {
  const codes = graph.nodes.map(nodeCode).sort()
  const pairs = graph.edges
    .map((edge) => `${edge.source}->${edge.target}`)
    .sort()
  const payload = [...codes, ...pairs].join('\n')
  return fnv1aHex(payload)
}

function fnv1aHex(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function findSelfReferences(graph: BuiltGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const row of graph.nodes) {
    const code = nodeCode(row)
    const ownRefs = new Set([code, nodeName(row), String(row.id)])
    const allRelations = [
      ...parseRelationList(row['上游节点列表']),
      ...parseRelationList(row['下游节点列表']),
    ]
    for (const token of allRelations) {
      if (ownRefs.has(token)) {
        issues.push({
          code: 'SELF_REFERENCE',
          nodeCode: code,
          relatedCode: token,
          message: `节点 ${code} 存在自引用：上下游关系不能指向节点自身（${token}）`,
        })
      }
    }
  }
  return issues
}

function findDeactivatedRefs(graph: BuiltGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const row of graph.nodes) {
    const code = nodeCode(row)
    const allRelations = [
      ...parseRelationList(row['上游节点列表']).map((token) => ({ token, dir: '上游' as const })),
      ...parseRelationList(row['下游节点列表']).map((token) => ({ token, dir: '下游' as const })),
    ]
    for (const { token, dir } of allRelations) {
      const ref = graph.byRef.get(token)
      if (ref && String(ref.status) === DISABLED_STATUS) {
        issues.push({
          code: 'DEACTIVATED_REF',
          nodeCode: code,
          relatedCode: nodeCode(ref),
          message: `节点 ${code} 的${dir}节点 ${nodeCode(ref)} 已停用，不能随启用链路建立连接`,
        })
      }
    }
  }
  return issues
}

function findReverseEdges(graph: BuiltGraph): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const reported = new Set<string>()
  for (const edge of graph.edges) {
    if (edge.source === edge.target) {
      continue
    }
    if (graph.adjacency.get(edge.target)?.has(edge.source)) {
      const key = [edge.source, edge.target].sort().join('|')
      if (reported.has(key)) {
        continue
      }
      reported.add(key)
      issues.push({
        code: 'REVERSE_EDGE',
        nodeCode: edge.source,
        relatedCode: edge.target,
        message: `节点 ${edge.source} 与 ${edge.target} 之间同时存在正向边和反向边，构成双向环路`,
      })
    }
  }
  return issues
}

// 三色 DFS：白=未访问，灰=当前路径，黑=已完成；回边即环路。
// 自环与两节点反向边已单独分类，这里只补充更长的环路路径。
function findCycles(graph: BuiltGraph): ValidationIssue[] {
  const WHITE = 0
  const GRAY = 1
  const BLACK = 2
  const color = new Map<string, number>()
  for (const code of graph.adjacency.keys()) {
    color.set(code, WHITE)
  }
  const stack: string[] = []
  const issues: ValidationIssue[] = []

  const visit = (code: string): void => {
    color.set(code, GRAY)
    stack.push(code)
    for (const next of graph.adjacency.get(code) ?? []) {
      if (color.get(next) === GRAY) {
        const cycleStart = stack.indexOf(next)
        const path = [...stack.slice(cycleStart), next]
        if (path.length === 2) {
          // 自环：findSelfReferences 已报
          continue
        }
        if (path.length === 3 && path[0] === path[2]) {
          // 两节点反向边：findReverseEdges 已报
          continue
        }
        issues.push({
          code: 'CYCLE',
          nodeCode: path[0],
          message: `血缘关系存在环路：${path.join(' -> ')}`,
        })
      } else if (color.get(next) === WHITE) {
        visit(next)
      }
    }
    stack.pop()
    color.set(code, BLACK)
  }

  for (const code of graph.adjacency.keys()) {
    if (color.get(code) === WHITE) {
      visit(code)
    }
  }
  return issues
}

function findLimitIssues(rows: EntryRow[]): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  if (rows.length > MAX_GRAPH_NODES) {
    issues.push({
      code: 'NODE_LIMIT_EXCEEDED',
      nodeCode: '-',
      message: `图谱节点数 ${rows.length} 已超过上限 ${MAX_GRAPH_NODES}，不能冻结新的图谱版本`,
    })
  }
  for (const row of rows) {
    const code = nodeCode(row)
    const relationCount =
      parseRelationList(row['上游节点列表']).length +
      parseRelationList(row['下游节点列表']).length
    if (relationCount > MAX_RELATIONS_PER_NODE) {
      issues.push({
        code: 'RELATION_LIMIT_EXCEEDED',
        nodeCode: code,
        message: `节点 ${code} 的上下游关系数 ${relationCount} 已超过单节点上限 ${MAX_RELATIONS_PER_NODE}`,
      })
    }
  }
  return issues
}

// 启用前的全量检查：任意一条不通过都拒绝成为已启用节点。
export function validateEnable(targetId: number, rows: EntryRow[]): EnableValidation {
  const target = rows.find((row) => Number(row.id) === Number(targetId))
  const graph = buildGraph(rows)
  const issues: ValidationIssue[] = [
    ...findLimitIssues(rows),
    ...graph.dangling,
    ...findSelfReferences(graph),
    ...findDeactivatedRefs(graph),
    ...findReverseEdges(graph),
    ...findCycles(graph),
  ]
  if (!target) {
    issues.push({
      code: 'DANGLING_REF',
      nodeCode: '-',
      message: `没有找到编号为 ${targetId} 的血缘节点`,
    })
  }
  return { ok: issues.length === 0, issues, graph, checksum: computeChecksum(graph) }
}

export function joinRelations(tokens: string[]): string {
  return tokens.join('，')
}
