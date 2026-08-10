import { loadDesktopNodeModuleSync } from '../../utils/platform/desktopNodeModule'

type SqliteStatementLike = {
  all: (...params: unknown[]) => unknown[]
  get: (...params: unknown[]) => unknown
  run: (...params: unknown[]) => unknown
}

type SqliteDatabaseLike = {
  exec: (sql: string) => unknown
  prepare: (sql: string) => SqliteStatementLike
  close: () => void
}

type SqliteModule = {
  DatabaseSync: new (filename: string) => SqliteDatabaseLike
}

const PREPARED_STATEMENT_CACHE_LIMIT = 128
const CACHEABLE_SQL_PATTERN = /^\s*(insert|update|delete|select)\b/i

export type SqliteNativeRuntimeOptions = {
  dbPath: string
}

export type SqliteNativeRuntimeStatus = {
  status: 'ready'
  dbPath: string
  isOpen: boolean
}

export type SqliteNativeRuntimeFacade = {
  exec(sql: string, params?: unknown[]): void
  query<T>(sql: string, params?: unknown[]): T[]
  queryOne<T>(sql: string, params?: unknown[]): T | undefined
  prepare(sql: string): SqliteStatementLike
  transaction<T>(fn: (runtime: SqliteNativeRuntimeFacade) => T): T
  close(): void
  getStatus(): SqliteNativeRuntimeStatus
}

function bindStatementParams(
  statement: SqliteStatementLike,
  params: unknown[] | undefined,
) {
  if (params == null || params.length === 0) {
    return statement
  }

  return {
    all: () => statement.all(...params),
    get: () => statement.get(...params),
    run: () => statement.run(...params),
  }
}

export function openSqliteRuntime(
  options: SqliteNativeRuntimeOptions,
): SqliteNativeRuntimeFacade {
  const fs = loadDesktopNodeModuleSync<typeof import('node:fs')>('node:fs')
  const path =
    loadDesktopNodeModuleSync<typeof import('node:path')>('node:path')
  const { DatabaseSync } =
    loadDesktopNodeModuleSync<SqliteModule>('node:sqlite')
  fs.mkdirSync(path.dirname(options.dbPath), { recursive: true })
  let database: SqliteDatabaseLike | null = new DatabaseSync(options.dbPath)
  database.exec('pragma foreign_keys = on;')
  database.exec('pragma journal_mode = WAL;')
  database.exec('pragma synchronous = normal;')
  database.exec('pragma busy_timeout = 1000;')
  const preparedStatementCache = new Map<string, SqliteStatementLike>()

  const assertReady = (): SqliteDatabaseLike => {
    if (database == null) {
      throw new Error('sqlite runtime is closed')
    }
    return database
  }

  const getPreparedStatement = (sql: string): SqliteStatementLike => {
    if (!CACHEABLE_SQL_PATTERN.test(sql)) {
      return assertReady().prepare(sql)
    }
    const cached = preparedStatementCache.get(sql)
    if (cached != null) {
      preparedStatementCache.delete(sql)
      preparedStatementCache.set(sql, cached)
      return cached
    }
    const statement = assertReady().prepare(sql)
    if (preparedStatementCache.size >= PREPARED_STATEMENT_CACHE_LIMIT) {
      const oldest = preparedStatementCache.keys().next().value
      if (typeof oldest === 'string') preparedStatementCache.delete(oldest)
    }
    preparedStatementCache.set(sql, statement)
    return statement
  }

  const facade: SqliteNativeRuntimeFacade = {
    exec(sql, params) {
      const db = assertReady()
      if (params == null || params.length === 0) {
        db.exec(sql)
        return
      }

      bindStatementParams(getPreparedStatement(sql), params).run()
    },

    query<T>(sql: string, params?: unknown[]) {
      assertReady()
      return bindStatementParams(getPreparedStatement(sql), params).all() as T[]
    },

    queryOne<T>(sql: string, params?: unknown[]) {
      assertReady()
      return bindStatementParams(getPreparedStatement(sql), params).get() as
        | T
        | undefined
    },

    prepare(sql: string) {
      return assertReady().prepare(sql)
    },

    transaction<T>(fn: (runtime: SqliteNativeRuntimeFacade) => T) {
      const db = assertReady()
      db.exec('begin immediate;')
      try {
        const result = fn(facade)
        db.exec('commit;')
        return result
      } catch (error) {
        db.exec('rollback;')
        throw error
      }
    },

    close() {
      database?.close()
      preparedStatementCache.clear()
      database = null
    },

    getStatus() {
      return {
        status: 'ready',
        dbPath: options.dbPath,
        isOpen: database != null,
      }
    },
  }

  return facade
}
