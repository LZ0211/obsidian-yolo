import type {
  SqliteExplorerSnapshot,
  SqliteQueryResult,
} from '../../database/sqlite/sqliteDatabaseExplorer'

import {
  type DatabaseMaintenanceBackend,
  MAINTENANCE_JOB_KIND,
  type MaintenanceJobCommand,
  type MaintenancePageRequest,
  type MaintenanceProgress,
  type MaintenanceQueryRequest,
} from './types'

export type LazySqliteMaintenanceRuntime = {
  inspect(options: {
    table?: string
    columns?: string[]
    cursor?: string | null
    pageSize?: number
  }): Promise<SqliteExplorerSnapshot> | SqliteExplorerSnapshot
  count(table: string): Promise<number> | number
  query(
    source: string,
    rowLimit?: number,
  ): Promise<SqliteQueryResult> | SqliteQueryResult
  headSequence?(): Promise<number> | number
  close?(): Promise<void> | void
}

export type LazySqliteMaintenanceBackendInput = {
  kind: DatabaseMaintenanceBackend['kind']
  open(signal: AbortSignal): Promise<LazySqliteMaintenanceRuntime>
  runJob(
    command: MaintenanceJobCommand,
    signal: AbortSignal,
    onProgress: (progress: MaintenanceProgress) => void,
  ): Promise<void>
}

const throwIfAborted = (signal: AbortSignal): void => {
  if (signal.aborted)
    throw new DOMException('Maintenance cancelled', 'AbortError')
}

export const createLazySqliteMaintenanceBackend = (
  input: LazySqliteMaintenanceBackendInput,
): DatabaseMaintenanceBackend => {
  let runtimePromise: Promise<LazySqliteMaintenanceRuntime> | null = null
  let runtime: LazySqliteMaintenanceRuntime | null = null
  let headSequence = 0

  const getRuntime = async (
    signal: AbortSignal,
  ): Promise<LazySqliteMaintenanceRuntime> => {
    throwIfAborted(signal)
    if (!runtimePromise) {
      const pending = input.open(signal).then((opened) => {
        runtime = opened
        return opened
      })
      let retryable: Promise<LazySqliteMaintenanceRuntime>
      retryable = pending.catch((error) => {
        if (runtimePromise === retryable) runtimePromise = null
        throw error
      })
      runtimePromise = retryable
    }
    const opened = await runtimePromise
    throwIfAborted(signal)
    return opened
  }

  return {
    kind: input.kind,
    async getHeadSequence(signal) {
      const opened = await getRuntime(signal)
      const observed = await opened.headSequence?.()
      if (typeof observed === 'number' && Number.isFinite(observed)) {
        headSequence = observed
      } else if (headSequence === 0) {
        headSequence = 1
      }
      return headSequence
    },
    async getSummary(signal) {
      const opened = await getRuntime(signal)
      const head = await opened.headSequence?.()
      if (typeof head === 'number' && Number.isFinite(head)) {
        headSequence = head
      } else if (headSequence === 0) {
        headSequence = 1
      }
      const snapshot = await opened.inspect({})
      return {
        headSequence,
        rowCount: 0,
        tableCount: snapshot.tables.length,
      }
    },
    async getRowCount(table, signal) {
      const opened = await getRuntime(signal)
      return await opened.count(table)
    },
    async loadPage(request: MaintenancePageRequest, signal) {
      const opened = await getRuntime(signal)
      const snapshot = await opened.inspect({
        table: request.table,
        columns: request.columns ? [...request.columns] : undefined,
        cursor: request.cursor,
        pageSize: request.limit,
      })
      if (!snapshot.table) {
        return {
          cursor: request.cursor,
          rows: snapshot.tables.map((name) => ({ name })),
          nextCursor: null,
          hasNextPage: false,
        }
      }
      return {
        cursor: request.cursor,
        table: snapshot.table.name,
        columns: snapshot.table.columns,
        rows: snapshot.table.rows,
        nextCursor: snapshot.table.nextCursor,
        hasNextPage: snapshot.table.hasNextPage,
      }
    },
    async runQuery(request: MaintenanceQueryRequest, signal) {
      const opened = await getRuntime(signal)
      return await opened.query(request.source, request.rowLimit)
    },
    async runJob(command, signal, onProgress) {
      await input.runJob(command, signal, onProgress)
      if (command.kind !== MAINTENANCE_JOB_KIND.VACUUM) headSequence += 1
    },
    async close() {
      const opened = runtime
      runtime = null
      runtimePromise = null
      await opened?.close?.()
    },
  }
}
