// 浏览器路径冒烟测试：用 localStorage 垫片跑完整的启用→复用→回退→重置链路。
import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const storage = new Map()
globalThis.window = {
  localStorage: {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  },
}

const { saveRows, listRows, storageKey } = await import('../src/data/local-store')
const { resetGraphStore, graphStorageKey } = await import('../src/data/graph-store')
const service = await import('../src/api/lineage-service')

function row(id, code, upstream = '', downstream = '', status = '草稿') {
  return {
    id, status, pending: true, abnormal: false,
    节点编号: code, 节点类型: '表', 节点名称: `${code}-名称`,
    上游节点列表: upstream, 下游节点列表: downstream,
    转换说明: '', 采集时间: '2026-11-01', 图谱版本: '',
  }
}

describe('浏览器 localStorage 冒烟链路', () => {
  beforeEach(() => {
    storage.clear()
    saveRows('lineage', [row(1, 'A', '', 'B'), row(2, 'B', 'A', 'C'), row(3, 'C', 'B', '')])
    saveRows('meta', [])
    resetGraphStore()
  })

  it('完整链路：启用→复用→故障回退→再启用，且数据真实写入 localStorage', () => {
    // 先在节点 1 的首次启用注入落库故障，验证整库回退
    service.lineageTestSeams.armWriteFailure()
    const failed = service.enableLineageNode(1)
    assert.equal(failed.ok, false)
    assert.equal(listRows('lineage')[0].status, '草稿')
    assert.equal(JSON.parse(storage.get(graphStorageKey())).versions.length, 0)
    assert.deepEqual(JSON.parse(storage.get(graphStorageKey())).locks, {})

    // 故障恢复后重新启用成功，数据真实落库
    const r1 = service.enableLineageNode(1)
    assert.equal(r1.ok, true)
    assert.ok(storage.has(storageKey()))
    assert.ok(storage.has(graphStorageKey()))

    const persistedGraph = JSON.parse(storage.get(graphStorageKey()))
    assert.equal(persistedGraph.versions.length, 1)
    const checksum = persistedGraph.versions[0].checksum
    assert.equal(persistedGraph.locks[checksum]?.status, 'committed')

    // 同图第二个节点启用：复用版本，不产生第二个冻结版本
    const r2 = service.enableLineageNode(2)
    assert.equal(r2.reused, true)
    assert.equal(JSON.parse(storage.get(graphStorageKey())).versions.length, 1)

    const r3 = service.enableLineageNode(3)
    assert.equal(r3.ok, true)
    assert.equal(listRows('lineage')[2].status, '已启用')

    const meta = listRows('meta')
    assert.equal(meta.length, 3)
    assert.ok(meta.every((m) => m.关联图谱版本 === r1.versionCode))

    const csv = service.exportGraphVersions().content
    assert.equal((csv.match(/GRAPHV-/g) || []).length, 1)
  })

  it('环路数据在浏览器路径同样被拒绝', () => {
    saveRows('lineage', [row(1, 'A', '', 'B'), row(2, 'B', '', 'A')])
    const result = service.enableLineageNode(1)
    assert.equal(result.ok, false)
    assert.equal(JSON.parse(storage.get(graphStorageKey())).versions.length, 0)
  })
})
