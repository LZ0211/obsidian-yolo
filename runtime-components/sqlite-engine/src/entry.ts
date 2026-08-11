/**
 * sqlite-engine runtime component.
 *
 * sql.js-backed SQLite for platforms without node:sqlite (mobile). The whole
 * database lives in memory; persistence is a debounced export of the full
 * database to a vault file (write in place, mirroring how Obsidian writes its
 * own data). Memory index volume is small (a few thousand rows), so the
 * full-file write cost is negligible. Data is rebuildable from the md sources
 * via reconcile, so a corrupted file is rotated aside and a fresh database is
 * created instead of bricking the store.
 *
 * The wasm binary is inlined at build time (virtual module, base64), so the
 * component is a single self-contained entry.js with no network fetch.
 * The API is a factory: `openSqliteJsRuntime(options)` returns a facade that
 * stays valid independently of the component instance (the SQL.Database lives
 * in the facade's closure), so the host can acquire/release around each open.
 */

import initSqlJs, {
  type Database as SqlJsDatabase,
  type SqlValue,
} from 'sql.js'
import SQLJS_WASM_BASE64 from 'virtual:sql-js-wasm'

/** Minimal vault-adapter surface the runtime needs (host-agnostic). */
export type SqliteJsVaultAdapter = {
  exists(path: string): Promise<boolean>
  readBinary(path: string): Promise<ArrayBuffer>
  writeBinary(path: string, data: ArrayBuffer): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
}

export type SqliteJsRuntimeOptions = {
  /** Vault-relative file path of the database. */
  relativePath: string
  adapter: SqliteJsVaultAdapter
  /** Debounce for full-file flushes after a mutation. Defaults to 1000ms. */
  flushDebounceMs?: number
}

export type SqliteJsRuntimeFacade = {
  exec(sql: string, params?: unknown[]): void
  query<T>(sql: string, params?: unknown[]): T[]
  queryOne<T>(sql: string, params?: unknown[]): T | undefined
  prepare(sql: string): SqlJsStatementLike
  transaction<T>(fn: (runtime: SqliteJsRuntimeFacade) => T): T
  close(): void
  getStatus(): { status: string; dbPath: string; isOpen: boolean }
  /** Force an immediate full-file flush. Resolves when the write settles. */
  flush(): Promise<void>
}

export type SqlJsStatementLike = {
  all: (...params: unknown[]) => unknown[]
  get: (...params: unknown[]) => unknown
  run: (...params: unknown[]) => unknown
}

const SQLJS_DEFAULT_FLUSH_DEBOUNCE_MS = 1000

const base64ToBytes = (base64: string): Uint8Array => {
  if (typeof atob === 'function') {
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    return bytes
  }
  return Uint8Array.from(Buffer.from(base64, 'base64'))
}

let sqlJsModulePromise: ReturnType<typeof initSqlJs> | null = null

const getSqlJsModule = async (): Promise<ReturnType<typeof initSqlJs>> => {
  if (!sqlJsModulePromise) {
    sqlJsModulePromise = initSqlJs({
      wasmBinary: base64ToBytes(SQLJS_WASM_BASE64),
    })
  }
  return sqlJsModulePromise
}

export async function openSqliteJsRuntime(
  options: SqliteJsRuntimeOptions,
): Promise<SqliteJsRuntimeFacade> {
  const { relativePath, adapter } = options
  const SQL = await getSqlJsModule()

  let database: SqlJsDatabase | undefined
  try {
    if (await adapter.exists(relativePath)) {
      const bytes = await adapter.readBinary(relativePath)
      database = new SQL.Database(
        bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      )
    } else {
      database = new SQL.Database()
    }
    // sql.js defers file parsing until the first statement; corrupt bytes only
    // surface here, so pragmas are inside the same guard.
    database.run('pragma foreign_keys = on;')
    database.run('pragma journal_mode = MEMORY;')
    database.run('pragma synchronous = OFF;')
  } catch (error) {
    // Corrupt or unreadable database: rotate it aside and start fresh rather
    // than locking the memory index into an unavailable state forever.
    try {
      database?.close()
    } catch {
      // best-effort
    }
    try {
      const rotated = `${relativePath}.corrupt-${Date.now()}`
      await adapter.rename(relativePath, rotated)
      console.warn(
        '[YOLO][sqlite-engine] Rotated unreadable database to',
        rotated,
        error,
      )
    } catch {
      // Rotation is best-effort; fall through to a fresh database.
    }
    database = new SQL.Database()
    database.run('pragma foreign_keys = on;')
    database.run('pragma journal_mode = MEMORY;')
    database.run('pragma synchronous = OFF;')
  }

  // Both branches above assign `database`; the flow analysis cannot see past
  // the catch, so narrow it explicitly.
  if (!database) {
    throw new Error('sqlite-engine failed to initialize a database')
  }

  let dirty = false
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  let closed = false
  let flushChain: Promise<void> = Promise.resolve()

  const markDirty = (): void => {
    dirty = true
    if (flushTimer !== null || closed) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushChain = flushChain.then(() => doFlush())
    }, options.flushDebounceMs ?? SQLJS_DEFAULT_FLUSH_DEBOUNCE_MS)
  }

  const doFlush = async (): Promise<void> => {
    if (!dirty || closed) return
    dirty = false
    try {
      const bytes = database.export()
      await adapter.writeBinary(relativePath, bytes)
    } catch (error) {
      // Keep dirty so the next flush retries; data remains intact in memory.
      dirty = true
      console.warn('[YOLO][sqlite-engine] Failed to flush database file', error)
    }
  }

  const assertReady = (): SqlJsDatabase => {
    if (closed) throw new Error('sqlite-engine runtime is closed')
    return database
  }

  const facade: SqliteJsRuntimeFacade = {
    exec(sql, params) {
      const db = assertReady()
      if (params == null || params.length === 0) {
        db.exec(sql)
      } else {
        db.run(sql, params as SqlValue[])
      }
      markDirty()
    },

    query<T>(sql: string, params?: unknown[]) {
      const statement = assertReady().prepare(sql)
      try {
        if (params != null && params.length > 0)
          statement.bind(params as SqlValue[])
        const rows: T[] = []
        while (statement.step()) {
          rows.push(statement.getAsObject() as T)
        }
        return rows
      } finally {
        statement.free()
      }
    },

    queryOne<T>(sql: string, params?: unknown[]) {
      const statement = assertReady().prepare(sql)
      try {
        if (params != null && params.length > 0)
          statement.bind(params as SqlValue[])
        return statement.step() ? (statement.getAsObject() as T) : undefined
      } finally {
        statement.free()
      }
    },

    prepare(sql: string): SqlJsStatementLike {
      const db = assertReady()
      return {
        all: (...params: unknown[]) => {
          const statement = db.prepare(sql)
          try {
            if (params.length > 0) statement.bind(params as SqlValue[])
            const rows: unknown[] = []
            while (statement.step()) {
              rows.push(statement.getAsObject())
            }
            return rows
          } finally {
            statement.free()
          }
        },
        get: (...params: unknown[]) => {
          const statement = db.prepare(sql)
          try {
            if (params.length > 0) statement.bind(params as SqlValue[])
            return statement.step() ? statement.getAsObject() : undefined
          } finally {
            statement.free()
          }
        },
        run: (...params: unknown[]) => {
          const statement = db.prepare(sql)
          try {
            if (params.length > 0) statement.bind(params as SqlValue[])
            while (statement.step()) {
              // consume rows; sql.js statements must be fully stepped to run
            }
          } finally {
            statement.free()
          }
          markDirty()
          return undefined
        },
      }
    },

    transaction<T>(fn: (runtime: SqliteJsRuntimeFacade) => T) {
      const db = assertReady()
      db.run('begin;')
      try {
        const result = fn(facade)
        db.run('commit;')
        markDirty()
        return result
      } catch (error) {
        db.run('rollback;')
        throw error
      }
    },

    close() {
      if (closed) return
      closed = true
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      // Export a snapshot synchronously, then hand the file write to the
      // flush chain; data in memory is dropped with the database object.
      if (dirty) {
        const bytes = database.export()
        dirty = false
        flushChain = flushChain
          .then(() => adapter.writeBinary(relativePath, bytes))
          .catch((error) => {
            console.warn('[YOLO][sqlite-engine] Close flush failed', error)
          })
      }
      database.close()
    },

    getStatus() {
      return {
        status: 'ready',
        dbPath: relativePath,
        isOpen: !closed,
      }
    },

    async flush() {
      await flushChain
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      await doFlush()
    },
  }

  return facade
}

globalThis.__yolo_register_runtime_component__({
  id: 'sqlite-engine',
  create() {
    let disposed = false
    return Object.freeze({
      async openSqliteJsRuntime(options: SqliteJsRuntimeOptions) {
        if (disposed) throw new Error('sqlite-engine is disposed')
        return openSqliteJsRuntime(options)
      },
      dispose() {
        disposed = true
      },
    })
  },
})

export default { openSqliteJsRuntime }
