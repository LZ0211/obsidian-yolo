import type { SearchJobProjection } from '../search/SearchMaintenanceJobQueue'
import type { StateIncident } from '../state/stateIncident'

export const MAINTENANCE_BACKEND_KIND = {
  RAG: 'rag',
  SESSIONS: 'sessions',
} as const

export type MaintenanceBackendKind =
  (typeof MAINTENANCE_BACKEND_KIND)[keyof typeof MAINTENANCE_BACKEND_KIND]

export const MAINTENANCE_JOB_KIND = {
  UPDATE_CHANGED_SOURCES: 'update_changed_sources',
  FULL_REBUILD: 'full_rebuild',
  CLEAN_STALE_RECORDS: 'clean_stale_records',
  VACUUM: 'vacuum',
} as const

export type MaintenanceJobKind =
  (typeof MAINTENANCE_JOB_KIND)[keyof typeof MAINTENANCE_JOB_KIND]

export type MaintenanceJobCommand = {
  kind: MaintenanceJobKind
  operationKey: string
  scope?: { kind: 'all' } | { kind: 'paths'; paths: string[] }
}

export const MAINTENANCE_CONTROLLER_STATUS = {
  IDLE: 'idle',
  LOADING: 'loading',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  FAILED: 'failed',
} as const

export type MaintenanceControllerStatus =
  (typeof MAINTENANCE_CONTROLLER_STATUS)[keyof typeof MAINTENANCE_CONTROLLER_STATUS]

export type MaintenanceRow = Record<string, unknown>

export type MaintenancePage = {
  cursor: string | null
  table?: string
  columns?: readonly string[]
  rows: readonly MaintenanceRow[]
  nextCursor: string | null
  hasNextPage?: boolean
}

export type DatabaseSummary = {
  headSequence: number
  rowCount: number
  tableCount?: number
}

export type MaintenanceQueryRequest = {
  source: string
  rowLimit?: number
}

export type MaintenanceQueryResult = {
  columns: readonly string[]
  rows: readonly MaintenanceRow[]
  truncated: boolean
}

export type MaintenancePageRequest = {
  cursor: string | null
  limit: number
  table?: string
  columns?: readonly string[]
}

export type MaintenanceProgress = {
  completed: number
  total?: number
  message?: string
}

export type DatabaseMaintenanceBackend = {
  kind: MaintenanceBackendKind
  getHeadSequence(signal: AbortSignal): Promise<number>
  getSummary(signal: AbortSignal): Promise<DatabaseSummary>
  getRowCount?(table: string, signal: AbortSignal): Promise<number>
  loadPage(
    request: MaintenancePageRequest,
    signal: AbortSignal,
  ): Promise<MaintenancePage>
  runQuery(
    request: MaintenanceQueryRequest,
    signal: AbortSignal,
  ): Promise<MaintenanceQueryResult>
  runJob(
    command: MaintenanceJobCommand,
    signal: AbortSignal,
    onProgress: (progress: MaintenanceProgress) => void,
  ): Promise<void>
  close?(): Promise<void>
}

export type MaintenanceJobProjection =
  SearchJobProjection<MaintenanceJobCommand>

export type MaintenanceSnapshot = {
  status: MaintenanceControllerStatus
  summary: DatabaseSummary | null
  activeJob: MaintenanceJobProjection | null
  page: MaintenancePage | null
  query: MaintenanceQueryResult | null
  error: StateIncident | null
}

export type MaintenanceRequestResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'cancelled' }
  | { status: 'failed'; incident: StateIncident }
