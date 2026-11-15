import { useCallback, useEffect, useMemo, useState } from 'react'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  resetModule,
  runAction as applyAction,
} from '@/api/local-service'
import {
  exportGraphVersions,
  getGraphVersions,
  simulateConcurrentEnable,
  updateLineageRelations,
} from '@/api/lineage-service'
import type { EntryRow } from '@/data/types'
import type { GraphVersion } from '@/data/graph-store'

const meta = moduleMeta('lineage')
const columns = [
  "节点编号",
  "节点类型",
  "节点名称",
  "上游节点列表",
  "下游节点列表",
  "转换说明",
  "采集时间",
  "图谱版本"
]
const actions = [
  "提交校验",
  "启用节点",
  "停用节点"
]
const statuses = [
  "草稿",
  "待校验",
  "已启用",
  "已停用"
]
const statLabels = ["血缘节点总数", "已启用节点", "待校验节点"]

type EditDraft = {
  id: number
  code: string
  upstream: string
  downstream: string
}

function downloadCsv(payload: { filename: string; content: string }): void {
  const blob = new Blob([payload.content], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = payload.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

export default function LineageView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [infoMessage, setInfoMessage] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [versions, setVersions] = useState<GraphVersion[]>([])
  const [editing, setEditing] = useState<EditDraft | null>(null)
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setVersions(getGraphVersions())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '血缘图谱列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  const stats = useMemo(() => {
    const countBy = (status: string) => rows.filter((row) => String(row.status) === status).length
    return [
      { label: statLabels[0], value: rows.length },
      { label: statLabels[1], value: countBy('已启用') },
      { label: statLabels[2], value: countBy('待校验') },
    ]
  }, [rows])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setInfoMessage('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setInfoMessage(result.message)
    }
    reload()
  }

  function openEditor(row: EntryRow) {
    setEditing({
      id: Number(row.id),
      code: String(row['节点编号'] ?? ''),
      upstream: String(row['上游节点列表'] ?? ''),
      downstream: String(row['下游节点列表'] ?? ''),
    })
  }

  function saveRelations() {
    if (!editing) {
      return
    }
    const result = updateLineageRelations(editing.id, editing.upstream, editing.downstream)
    if (!result.ok) {
      setErrorMessage(result.message)
    } else {
      setInfoMessage(result.message)
      setEditing(null)
    }
    reload()
  }

  function runConcurrencyDrill(row: EntryRow) {
    setErrorMessage('')
    setInfoMessage('')
    const drill = simulateConcurrentEnable(Number(row.id))
    const failed = drill.requests.find((item) => !item.ok)
    if (failed) {
      setErrorMessage(failed.message)
    } else {
      const reused = drill.requests.some((item) => item.reused)
      setInfoMessage(
        `并发启用演练完成：${drill.requests.length} 个请求仅冻结版本 ${drill.versionCode ?? ''}，` +
        `${reused ? '后到请求复用已有版本、未生成重复边' : '未触发复用，请检查并发路径'}`,
      )
    }
    reload()
  }

  function handleReset() {
    resetModule(meta.key)
    setInfoMessage('血缘模块已回到初始数据，冻结版本与同步的元数据条目一并清空')
    reload()
  }

  return (
    <section className="page" data-module="lineage">
      <header className="page-head">
        <div>
          <h2>血缘图谱管理</h2>
          <p className="page-desc">
            启用节点前执行上下游关系检查（自引用、反向边、环路、停用引用、节点上限），校验通过冻结图谱版本并同步元数据中心；同一图谱并发启用只允许一个版本成功。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn primary" type="button" onClick={() => setErrorMessage('血缘节点登记入口尚未接入审批流')}>
            登记血缘节点
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出血缘图谱清单
          </button>
          <button className="btn" type="button" onClick={() => downloadCsv(exportGraphVersions())}>
            导出冻结版本清单
          </button>
          <button className="btn ghost" type="button" onClick={handleReset}>
            重置模块数据
          </button>
        </div>
      </header>

      <div className="stat-row">
        {stats.map((item) => (
          <article key={item.label} className="stat-card">
            <span className="stat-label">{item.label}</span>
            <strong className="stat-value">{item.value}</strong>
          </article>
        ))}
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
      </p>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
                <button className="link" type="button" onClick={() => openEditor(row)}>编辑关系</button>
                <button className="link" type="button" onClick={() => runConcurrencyDrill(row)}>并发启用演练</button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无血缘图谱数据，可先登记血缘节点</td>
            </tr>
          )}
        </tbody>
      </table>

      <section className="version-panel">
        <h3>已冻结图谱版本（可复核）</h3>
        {versions.length === 0 ? (
          <p className="page-desc">尚无冻结版本：血缘节点启用校验通过后会在此生成不可变版本，并同步到元数据中心。</p>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>版本编号</th>
                <th>冻结时间</th>
                <th>结构指纹</th>
                <th>节点数</th>
                <th>边数（去重后）</th>
                <th>触发节点</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((version) => {
                const trigger = version.nodes.find((node) => node.id === version.enabledNodeId)
                return (
                  <tr key={version.versionCode}>
                    <td>{version.versionCode}</td>
                    <td>{version.createdAt}</td>
                    <td>{version.checksum}</td>
                    <td>{version.nodeCount}</td>
                    <td>{version.edgeCount}</td>
                    <td>{trigger ? trigger.code : version.enabledNodeId}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </section>

      {editing && (
        <div className="modal-mask" role="dialog" aria-modal="true">
          <div className="modal-card">
            <h3>编辑上下游关系 · {editing.code}</h3>
            <p className="page-desc">
              多个节点用逗号、分号或顿号分隔，可填节点编号或节点名称；已启用节点需先停用才能编辑。保存后在启用时统一执行环路与停用引用校验。
            </p>
            <label className="filter-item">
              <span>上游节点列表</span>
              <input value={editing.upstream} onChange={(event) => setEditing({ ...editing, upstream: event.target.value })} />
            </label>
            <label className="filter-item">
              <span>下游节点列表</span>
              <input value={editing.downstream} onChange={(event) => setEditing({ ...editing, downstream: event.target.value })} />
            </label>
            <div className="modal-actions">
              <button className="btn primary" type="button" onClick={saveRelations}>保存关系</button>
              <button className="btn ghost" type="button" onClick={() => setEditing(null)}>取消</button>
            </div>
          </div>
        </div>
      )}

      <footer className="page-foot">
        <span>共 {total} 条血缘图谱记录</span>
        {infoMessage && <span className="info-text">{infoMessage}</span>}
        {errorMessage && <span className="error-text">{errorMessage}</span>}
      </footer>
    </section>
  )
}
