import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { saveRows, listRows } from '../src/data/local-store'
import { resetGraphStore } from '../src/data/graph-store'
import { SEED_ROWS } from '../src/data/seed'
import {
  enableLineageNode,
  updateLineageRelations,
  resetLineageModule,
  getGraphVersions,
  exportGraphVersions,
  simulateConcurrentEnable,
  lineageTestSeams,
} from '../src/api/lineage-service'
import { exportEntries, runAction } from '../src/api/local-service'

let seq = 0
function row(code, upstream = '', downstream = '', status = '草稿') {
  seq += 1
  return {
    id: seq,
    status,
    pending: true,
    abnormal: false,
    节点编号: code,
    节点类型: '表',
    节点名称: `${code}-名称`,
    上游节点列表: upstream,
    下游节点列表: downstream,
    转换说明: '',
    采集时间: '2026-11-01',
    图谱版本: '',
  }
}

function seedLineage(rows) {
  seq = 0
  saveRows('lineage', rows)
  saveRows('meta', [])
  resetGraphStore()
}

describe('启用节点事务', () => {
  beforeEach(() => {
    seedLineage([row('A', '', 'B'), row('B', 'A', 'C'), row('C', 'B', '')])
  })

  it('校验通过后冻结版本、节点置为已启用、元数据条目引用同一版本', () => {
    const result = enableLineageNode(1)
    assert.equal(result.ok, true)
    assert.equal(result.reused, false)
    const version = result.versionCode
    assert.match(version, /^GRAPHV-\d{8}-\d{4}$/)

    const stored = listRows('lineage')
    assert.equal(stored[0].status, '已启用')
    assert.equal(stored[0].图谱版本, version)

    const versions = getGraphVersions()
    assert.equal(versions.length, 1)
    assert.deepEqual(
      versions[0].edges.map((e) => `${e.source}->${e.target}`).sort(),
      ['A->B', 'B->C'],
    )

    const meta = listRows('meta')
    assert.equal(meta.length, 1)
    assert.equal(meta[0].关联节点编号, 'A')
    assert.equal(meta[0].关联图谱版本, version)
    assert.equal(meta[0].status, '已生效')
  })

  it('同一图谱并发启用：后到请求复用已有版本，不生成重复边', () => {
    const first = enableLineageNode(1)
    const second = enableLineageNode(2)
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.equal(second.reused, true)
    assert.equal(second.versionCode, first.versionCode)
    assert.equal(getGraphVersions().length, 1)

    // 在全新图状态上演练并发入口：两个请求只能产生一个冻结版本
    seedLineage([row('A', '', 'B'), row('B', 'A', 'C'), row('C', 'B', '')])
    const drill = simulateConcurrentEnable(1)
    assert.equal(drill.duplicatedEdges, false)
    assert.ok(drill.requests.every((r) => r.ok))
    assert.ok(drill.requests.some((r) => r.reused))
    assert.equal(getGraphVersions().length, 1)
  })

  it('元数据条目随复用版本保持同一结论，不重复登记', () => {
    enableLineageNode(1)
    enableLineageNode(2)
    const meta = listRows('meta')
    assert.equal(meta.length, 2)
    const versions = new Set(meta.map((m) => m.关联图谱版本))
    assert.equal(versions.size, 1)
  })

  it('自引用拒绝启用，且不冻结任何版本、不改状态、不同步元数据', () => {
    seedLineage([row('A', 'A', '')])
    const result = enableLineageNode(1)
    assert.equal(result.ok, false)
    assert.match(result.message, /自引用/)
    assert.equal(getGraphVersions().length, 0)
    assert.equal(listRows('lineage')[0].status, '草稿')
    assert.equal(listRows('meta').length, 0)
  })

  it('反向边拒绝启用', () => {
    seedLineage([row('A', '', 'B'), row('B', '', 'A')])
    const result = enableLineageNode(1)
    assert.equal(result.ok, false)
    assert.match(result.message, /反向边|环路/)
    assert.equal(getGraphVersions().length, 0)
  })

  it('指向已停用节点拒绝启用', () => {
    seedLineage([row('A', '', 'B'), row('B', '', '', '已停用')])
    const result = enableLineageNode(1)
    assert.equal(result.ok, false)
    assert.match(result.message, /已停用/)
    assert.equal(getGraphVersions().length, 0)
  })

  it('存储故障时整次启用回退，不留下半套连接关系，且可重新启用', () => {
    lineageTestSeams.armWriteFailure()
    const failed = enableLineageNode(1)
    assert.equal(failed.ok, false)
    assert.match(failed.message, /整体回退/)

    // 回退确认：节点状态、版本库、元数据、锁都回到启用前
    assert.equal(listRows('lineage')[0].status, '草稿')
    assert.equal(getGraphVersions().length, 0)
    assert.equal(listRows('meta').length, 0)
    assert.deepEqual(lineageTestSeams.loadGraphStore().locks, {})

    const retry = enableLineageNode(1)
    assert.equal(retry.ok, true)
    assert.equal(getGraphVersions().length, 1)
    assert.equal(listRows('lineage')[0].status, '已启用')
  })

  it('重复启用同一节点沿用旧规则直接拒绝，不新增版本', () => {
    enableLineageNode(1)
    const again = enableLineageNode(1)
    assert.equal(again.ok, false)
    assert.equal(getGraphVersions().length, 1)
  })

  it('runAction 启用节点走同一套校验与冻结链路', () => {
    const result = runAction('lineage', 2, '启用节点')
    assert.equal(result.ok, true)
    assert.equal(getGraphVersions().length, 1)
    assert.equal(listRows('lineage')[1].status, '已启用')
  })
})

describe('上下游关系编辑', () => {
  beforeEach(() => {
    seedLineage([row('A', '', 'B'), row('B', 'A', '')])
  })

  it('草稿节点可编辑并规范化分隔符', () => {
    const result = updateLineageRelations(1, ' B ', '')
    assert.equal(result.ok, true)
    assert.equal(listRows('lineage')[0].上游节点列表, 'B')
  })

  it('已启用节点关系随版本冻结，拒绝编辑', () => {
    enableLineageNode(1)
    const result = updateLineageRelations(1, 'B', '')
    assert.equal(result.ok, false)
    assert.match(result.message, /冻结/)
  })
})

describe('模块间导出结果一致', () => {
  beforeEach(() => {
    seedLineage([row('A', '', 'B'), row('B', 'A', 'C'), row('C', 'B', '')])
  })

  it('血缘清单、元数据清单、冻结版本清单反映同一版本结论', () => {
    enableLineageNode(1)
    const version = getGraphVersions()[0].versionCode

    const lineageCsv = exportEntries('lineage').content
    const metaCsv = exportEntries('meta').content
    const versionCsv = exportGraphVersions().content

    assert.ok(lineageCsv.includes(version))
    assert.ok(metaCsv.includes(version))
    assert.ok(versionCsv.includes(version))
    assert.ok(versionCsv.includes('A->B') === false) // 版本清单是汇总视图，不含边明细列
    assert.equal((versionCsv.match(new RegExp(version, 'g')) || []).length, 1)
  })

  it('重置模块后版本库与同步的元数据条目一并清空', () => {
    enableLineageNode(1)
    resetLineageModule()
    assert.equal(getGraphVersions().length, 0)
    assert.equal(listRows('meta').filter((m) => m.血缘同步 === 'true').length, 0)
  })
})

describe('历史取值沿用旧规则', () => {
  it('种子数据里历史已启用节点不回溯校验、不重复冻结，保留旧图谱版本号', () => {
    saveRows('lineage', JSON.parse(JSON.stringify(SEED_ROWS.lineage)))
    saveRows('meta', JSON.parse(JSON.stringify(SEED_ROWS.meta)))
    resetGraphStore()

    const legacy = listRows('lineage').find((r) => r.status === '已启用')
    const legacyVersion = legacy.图谱版本
    const again = enableLineageNode(Number(legacy.id))
    assert.equal(again.ok, false)
    assert.match(again.message, /重复操作/)
    assert.equal(getGraphVersions().length, 0)
    assert.equal(listRows('lineage').find((r) => Number(r.id) === Number(legacy.id)).图谱版本, legacyVersion)
  })
})
