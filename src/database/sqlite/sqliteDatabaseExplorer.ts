import type { SqliteNativeRuntimeFacade } from './sqliteNativeRuntime'

export type SqliteExplorerTable = {
  name: string
  columns: string[]
  nextCursor: string | null
  pageSize: number
  rows: Array<Record<string, unknown>>
  hasNextPage: boolean
}

export type SqliteExplorerSnapshot = {
  tables: string[]
  table?: SqliteExplorerTable
}

export type SqliteQueryResult = {
  columns: string[]
  rows: Array<Record<string, unknown>>
  truncated: boolean
}

export const SQLITE_QUERY_ROW_LIMIT = 500

const quoteIdentifier = (value: string): string =>
  `"${value.replace(/"/g, '""')}"`

const listTables = (runtime: SqliteNativeRuntimeFacade): string[] =>
  runtime
    .query<{
      name: string
    }>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name",
    )
    .map((row) => row.name)

const ROWID_ALIAS = '__yolo_rowid'

const parseCursor = (cursor: string | null | undefined): number => {
  if (cursor == null || cursor.trim() === '') return 0
  const value = Number.parseInt(cursor, 10)
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

export function inspectSqliteDatabase(
  runtime: SqliteNativeRuntimeFacade,
  options: {
    table?: string
    columns?: string[]
    cursor?: string | null
    pageSize?: number
  } = {},
): SqliteExplorerSnapshot {
  if (!options.table) return { tables: listTables(runtime) }
  const pageSize = Math.max(
    1,
    Math.min(200, Math.floor(options.pageSize ?? 50)),
  )
  const table = quoteIdentifier(options.table)
  const columns = options.columns ?? getTableColumns(runtime, table)
  if (columns.length === 0) throw new Error(`Unknown table: ${options.table}`)
  // Keyset pagination by rowid: each page costs O(pageSize) instead of
  // O(offset), and never reads the payload columns of skipped rows.
  const boundary = parseCursor(options.cursor)
  const fetchedRows = runtime.query<Record<string, unknown>>(
    `select rowid as "${ROWID_ALIAS}", * from ${table}
     where rowid > ? order by rowid limit ?`,
    [boundary, pageSize + 1],
  )
  const hasNextPage = fetchedRows.length > pageSize
  const pageRows = fetchedRows.slice(0, pageSize)
  const rows = pageRows.map((row) =>
    Object.fromEntries(columns.map((column) => [column, row[column]])),
  )
  const lastRowid = pageRows.at(-1)?.[ROWID_ALIAS]
  return {
    tables: [],
    table: {
      name: options.table,
      columns,
      nextCursor:
        hasNextPage && typeof lastRowid === 'number' ? String(lastRowid) : null,
      pageSize,
      rows,
      hasNextPage,
    },
  }
}

export function countSqliteTableRows(
  runtime: SqliteNativeRuntimeFacade,
  tableName: string,
): number {
  const table = quoteIdentifier(tableName)
  if (getTableColumns(runtime, table).length === 0)
    throw new Error(`Unknown table: ${tableName}`)
  return (
    runtime.queryOne<{ count: number }>(
      `select count(*) as count from ${table}`,
    )?.count ?? 0
  )
}

export function runReadOnlySql(
  runtime: SqliteNativeRuntimeFacade,
  source: string,
  rowLimit = SQLITE_QUERY_ROW_LIMIT,
): SqliteQueryResult {
  const sql = assertReadOnlySql(source)
  const limit = Math.max(
    1,
    Math.min(SQLITE_QUERY_ROW_LIMIT, Math.floor(rowLimit)),
  )
  const canWrap = /^(select|with)\b/i.test(sql)
  const fetchedRows = canWrap
    ? runtime.query<Record<string, unknown>>(
        `select * from (${sql}) as yolo_query limit ?`,
        [limit + 1],
      )
    : runtime.query<Record<string, unknown>>(sql)
  const truncated = fetchedRows.length > limit
  const rows = fetchedRows.slice(0, limit)
  const columns =
    rows.length > 0 ? Object.keys(rows[0]) : columnNames(runtime, sql)
  return { columns, rows, truncated }
}

export const formatSqliteExplorerValue = (value: unknown): string => {
  if (value == null) return ''
  if (value instanceof Uint8Array) return `BLOB (${value.byteLength} bytes)`
  if (value instanceof ArrayBuffer) return `BLOB (${value.byteLength} bytes)`
  if (typeof value === 'object') return JSON.stringify(value) ?? ''
  if (typeof value === 'string') return value
  if (
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint' ||
    typeof value === 'symbol'
  ) {
    return String(value)
  }
  return ''
}

const columnNames = (
  runtime: SqliteNativeRuntimeFacade,
  sql: string,
): string[] => {
  const statement = runtime.prepare(sql)
  const row = statement.get() as Record<string, unknown> | undefined
  return row ? Object.keys(row) : []
}

const getTableColumns = (
  runtime: SqliteNativeRuntimeFacade,
  quotedTable: string,
): string[] =>
  runtime
    .query<{ name: string }>(`pragma table_info(${quotedTable})`)
    .map((column) => column.name)

const assertReadOnlySql = (source: string): string => {
  const sql = source.trim()
  if (!sql) throw new Error('Enter a SQL statement.')
  const withoutTrailingTerminator = sql.replace(/;\s*$/, '')
  if (withoutTrailingTerminator.includes(';'))
    throw new Error('Only one SQL statement is allowed.')
  if (/--|\/\*/.test(withoutTrailingTerminator))
    throw new Error('SQL comments are not allowed.')
  const normalized = withoutTrailingTerminator.toLocaleLowerCase()
  const first = normalized.match(/^([a-z]+)/)?.[1]
  const allowed =
    first === 'select' ||
    first === 'with' ||
    first === 'explain' ||
    (first === 'pragma' && !/[=()]/.test(normalized.replace(/^pragma\s+/, '')))
  const forbidden =
    /\b(attach|detach|vacuum|reindex|analyze|load_extension|begin|commit|rollback|insert|update|delete|replace|create|alter|drop)\b/
  if (!allowed || forbidden.test(normalized))
    throw new Error('Only read-only SQL statements are allowed.')
  return withoutTrailingTerminator
}
