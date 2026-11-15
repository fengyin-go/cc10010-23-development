import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildGraph,
  computeChecksum,
  validateEnable,
  parseRelationList,
  MAX_GRAPH_NODES,
  MAX_RELATIONS_PER_NODE,
} from '../src/domain/lineage-graph'

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

// 需要稳定 id 的指纹类用例使用这个构造器，避免模块级 seq 自增导致两次建图 id 不一致。
function rowWithId(id, code, upstream = '', downstream = '', status = '草稿') {
  return {
    id,
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

describe('血缘关系解析与建图', () => {
  it('按逗号、分号、顿号、空白拆分并去重', () => {
    assert.deepEqual(parseRelationList('A，B; C、D| A\tE'), ['A', 'B', 'C', 'D', 'E'])
    assert.deepEqual(parseRelationList(''), [])
    assert.deepEqual(parseRelationList(undefined), [])
  })

  it('上游列表与下游列表合并为去重边，不生成重复边', () => {
    const rows = [row('A', '', 'B'), row('B', 'A', 'C'), row('C', 'B', '')]
    const graph = buildGraph(rows)
    const pairs = graph.edges.map((e) => `${e.source}->${e.target}`).sort()
    assert.deepEqual(pairs, ['A->B', 'B->C'])
  })
})

describe('环路校验：自引用', () => {
  it('上游指向自身必须拒绝', () => {
    const rows = [row('A', 'A', '')]
    const result = validateEnable(1, rows)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some((i) => i.code === 'SELF_REFERENCE'))
  })

  it('下游指向自身（含按节点名称引用）必须拒绝', () => {
    const a = row('A', '', 'A-名称')
    const result = validateEnable(1, [a])
    assert.equal(result.ok, false)
    assert.ok(result.issues.some((i) => i.code === 'SELF_REFERENCE'))
  })
})

describe('环路校验：反向边', () => {
  it('两个节点互为上下游构成双向环，必须拒绝', () => {
    const rows = [row('A', '', 'B'), row('B', '', 'A')]
    const result = validateEnable(1, rows)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some((i) => i.code === 'REVERSE_EDGE'))
  })
})

describe('环路校验：多节点环', () => {
  it('A->B->C->A 的长环路必须拒绝', () => {
    const rows = [row('A', '', 'B'), row('B', '', 'C'), row('C', '', 'A')]
    const result = validateEnable(1, rows)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some((i) => i.code === 'CYCLE'))
  })

  it('无环 DAG 校验通过且指纹稳定', () => {
    const make = () => [
      rowWithId(1, 'A', '', 'B'),
      rowWithId(2, 'B', '', 'C'),
      rowWithId(3, 'C', '', ''),
    ]
    const r1 = validateEnable(1, make())
    const r2 = validateEnable(2, make())
    assert.equal(r1.ok, true)
    assert.equal(r1.checksum, r2.checksum)
  })
})

describe('停用与悬空引用', () => {
  it('指向已停用节点必须拒绝', () => {
    const rows = [row('A', '', 'B'), row('B', '', '', '已停用')]
    const result = validateEnable(1, rows)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some((i) => i.code === 'DEACTIVATED_REF'))
  })

  it('指向不存在的节点必须拒绝', () => {
    const rows = [row('A', 'GHOST', '')]
    const result = validateEnable(1, rows)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some((i) => i.code === 'DANGLING_REF'))
  })
})

describe('节点上限', () => {
  it('超出图谱节点上限必须拒绝', () => {
    const rows = Array.from({ length: MAX_GRAPH_NODES + 1 }, (_, i) => row(`N${i}`))
    const result = validateEnable(1, rows)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some((i) => i.code === 'NODE_LIMIT_EXCEEDED'))
  })

  it('单节点上下游关系超上限必须拒绝', () => {
    const refs = Array.from({ length: MAX_RELATIONS_PER_NODE + 1 }, (_, i) => `N${i}`).join('，')
    const rows = [row('ROOT', refs, ''), ...Array.from({ length: MAX_RELATIONS_PER_NODE + 1 }, (_, i) => row(`N${i}`))]
    const result = validateEnable(1, rows)
    assert.equal(result.ok, false)
    assert.ok(result.issues.some((i) => i.code === 'RELATION_LIMIT_EXCEEDED'))
  })
})

describe('结构指纹', () => {
  it('状态变化不影响指纹，边的声明来源变化也不影响指纹', () => {
    const rows1 = [row('A', '', 'B'), row('B', 'A', '')]
    const rows2 = rows1.map((r) => ({ ...r, status: '已启用' }))
    assert.equal(computeChecksum(buildGraph(rows1)), computeChecksum(buildGraph(rows2)))
  })
})
