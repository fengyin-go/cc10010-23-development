// 图谱版本与启用并发锁的本地持久化：独立于业务条目存储，便于整库快照与回退。
const GRAPH_STORE_KEY = 'lake-govern-config:graph-store'

export type FrozenEdge = {
  source: string
  target: string
  declaredBy: string
  via: string
}

export type FrozenNode = {
  id: number
  code: string
  name: string
  type: string
  status: string
}

export type GraphVersion = {
  versionCode: string
  checksum: string
  createdAt: string
  nodeCount: number
  edgeCount: number
  nodes: FrozenNode[]
  edges: FrozenEdge[]
  enabledNodeId: number
}

export type EnableLock = {
  checksum: string
  status: 'in-flight' | 'committed'
  versionCode?: string
  since: string
}

export type GraphStoreState = {
  versions: GraphVersion[]
  sequence: number
  locks: Record<string, EnableLock>
}

// 测试用故障注入：置位后下一次落库会抛错，用于验证整次启用回退。
let failNextWrite = false

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function emptyState(): GraphStoreState {
  return { versions: [], sequence: 0, locks: {} }
}

function readState(): GraphStoreState {
  if (typeof window === 'undefined' || !window.localStorage) {
    return memoryState
  }
  const raw = window.localStorage.getItem(GRAPH_STORE_KEY)
  if (!raw) {
    return emptyState()
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GraphStoreState>
    return {
      versions: Array.isArray(parsed.versions) ? (parsed.versions as GraphVersion[]) : [],
      sequence: typeof parsed.sequence === 'number' ? parsed.sequence : 0,
      locks: parsed.locks && typeof parsed.locks === 'object' ? parsed.locks : {},
    }
  } catch {
    return emptyState()
  }
}

let memoryState: GraphStoreState = emptyState()

function writeState(state: GraphStoreState): void {
  if (failNextWrite) {
    failNextWrite = false
    throw new Error('模拟存储故障：图谱版本未能完整落库')
  }
  const serializable = clone(state)
  if (typeof window === 'undefined' || !window.localStorage) {
    memoryState = serializable
    return
  }
  window.localStorage.setItem(GRAPH_STORE_KEY, JSON.stringify(serializable))
}

export function loadGraphStore(): GraphStoreState {
  return readState()
}

// 事务支持：与业务条目库的 snapshotRows/replaceAllRows 对齐，保证双库可一起回退。
export function snapshotGraphStore(): GraphStoreState {
  return clone(readState())
}

export function replaceGraphStore(snapshot: GraphStoreState): void {
  writeState(clone(snapshot))
}

export function resetGraphStore(): GraphStoreState {
  const fresh = emptyState()
  failNextWrite = false
  writeState(fresh)
  return fresh
}

export function listVersions(): GraphVersion[] {
  return readState().versions
}

export function latestVersion(): GraphVersion | undefined {
  const { versions } = readState()
  return versions[versions.length - 1]
}

// 同一图谱（同结构指纹）并发启用：先到的拿 in-flight 锁，后到的请求复用已有版本。
export function acquireEnableLock(
  checksum: string,
): { locked: boolean; reusable: GraphVersion | undefined; existingLock: EnableLock | undefined } {
  const state = readState()
  const existing = state.locks[checksum]
  if (existing) {
    if (existing.status === 'committed' && existing.versionCode) {
      const reusable = state.versions.find((item) => item.versionCode === existing.versionCode)
      return { locked: false, reusable, existingLock: existing }
    }
    return { locked: false, reusable: undefined, existingLock: existing }
  }
  state.locks[checksum] = { checksum, status: 'in-flight', since: new Date().toISOString() }
  writeState(state)
  return { locked: true, reusable: undefined, existingLock: undefined }
}

export function commitEnableLock(checksum: string, versionCode: string): void {
  const state = readState()
  state.locks[checksum] = {
    checksum,
    status: 'committed',
    versionCode,
    since: state.locks[checksum]?.since ?? new Date().toISOString(),
  }
  writeState(state)
}

export function releaseEnableLock(checksum: string): void {
  const state = readState()
  const lock = state.locks[checksum]
  if (lock && lock.status === 'in-flight') {
    delete state.locks[checksum]
    writeState(state)
  }
}

// 事务回退专用：在途锁随版本库快照一起还原；若回退前没有任何成功落库，
// writeState 也可能抛错，此时吞掉异常并复位内存态，保证调用方不会带着锁残留。
export function deleteInFlightLock(checksum: string): void {
  try {
    releaseEnableLock(checksum)
  } catch {
    const state = readState()
    if (state.locks[checksum]?.status === 'in-flight') {
      delete state.locks[checksum]
    }
  }
}

export function appendVersion(
  draft: Omit<GraphVersion, 'versionCode'>,
): GraphVersion {
  const state = readState()
  state.sequence += 1
  const code = buildVersionCode(state.sequence, new Date(draft.createdAt))
  const version: GraphVersion = { ...draft, versionCode: code }
  state.versions.push(version)
  writeState(state)
  return version
}

function buildVersionCode(sequence: number, now: Date): string {
  const yyyy = now.getFullYear()
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `GRAPHV-${yyyy}${mm}${dd}-${String(sequence).padStart(4, '0')}`
}

export function armWriteFailure(): void {
  failNextWrite = true
}

export function graphStorageKey(): string {
  return GRAPH_STORE_KEY
}
