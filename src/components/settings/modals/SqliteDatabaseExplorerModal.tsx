import { ChevronLeft, ChevronRight, Play, RefreshCw } from 'lucide-react'
import { App } from 'obsidian'
import { useCallback, useEffect, useRef, useState } from 'react'

import type { MaintenancePage } from '../../../core/maintenance/types'
import { formatSqliteExplorerValue } from '../../../database/sqlite/sqliteDatabaseExplorer'
import type YoloPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'

import { useDatabaseMaintenanceProjection } from './useDatabaseMaintenanceProjection'

type DatabaseKind = 'rag'
type Props = { plugin: YoloPlugin; kind: DatabaseKind }

export const SQLITE_EXPLORER_PAGE_SIZE = 10

export class SqliteDatabaseExplorerModal extends ReactModal<Props> {
  constructor(app: App, plugin: YoloPlugin, kind: DatabaseKind) {
    super({
      app,
      Component: SqliteDatabaseExplorer,
      props: { plugin, kind },
      options: {
        title: plugin.t('settings.rag.databaseExplorer', 'RAG database'),
        className: 'yolo-modal--wide',
      },
    })
  }
}

function SqliteDatabaseExplorer({ plugin, kind }: Props) {
  const controller = plugin.getDatabaseMaintenanceController(kind)
  const projection = useDatabaseMaintenanceProjection(controller)
  const [tables, setTables] = useState<string[]>([])
  const [selectedTable, setSelectedTable] = useState<string>()
  const [page, setPage] = useState(0)
  const [totalRows, setTotalRows] = useState<number>()
  const [sql, setSql] = useState(
    `select * from sqlite_master limit ${SQLITE_EXPLORER_PAGE_SIZE}`,
  )
  const [loadingTables, setLoadingTables] = useState(true)
  const [loadingPage, setLoadingPage] = useState(false)
  const [countingRows, setCountingRows] = useState(false)
  const [runningSql, setRunningSql] = useState(false)
  const [sqlResult, setSqlResult] = useState<{
    columns: readonly string[]
    rows: readonly Record<string, unknown>[]
    truncated: boolean
  } | null>(null)
  const [tablePage, setTablePage] = useState<MaintenancePage | null>(null)

  const mountedRef = useRef(true)
  const selectedTableRef = useRef<string>()
  const pageRef = useRef(0)
  const nextCursorRef = useRef<string | null>(null)
  // boundaries[page] is the rowid cursor that starts that page (null = start).
  const boundariesRef = useRef<(string | null)[]>([null])
  const columnsCacheRef = useRef(new Map<string, readonly string[]>())
  const requestRef = useRef(0)
  const tableListRequestRef = useRef(0)
  const countingRowsRef = useRef(false)
  const runningSqlRef = useRef(false)

  const loadTablePage = useCallback(
    async (tableName: string, nextPage: number, cursor: string | null) => {
      const request = ++requestRef.current
      setLoadingPage(true)
      try {
        const result = await controller.loadPage({
          table: tableName,
          columns: columnsCacheRef.current.get(tableName),
          cursor,
          limit: SQLITE_EXPLORER_PAGE_SIZE,
        })
        if (
          !mountedRef.current ||
          request !== requestRef.current ||
          selectedTableRef.current !== tableName ||
          pageRef.current !== nextPage ||
          result.status !== 'fulfilled' ||
          result.value == null
        ) {
          return
        }
        columnsCacheRef.current.set(tableName, result.value.columns ?? [])
        nextCursorRef.current = result.value.nextCursor
        setTablePage(result.value)
      } finally {
        if (request === requestRef.current && mountedRef.current) {
          setLoadingPage(false)
        }
      }
    },
    [controller],
  )

  const loadTables = useCallback(async () => {
    const request = ++tableListRequestRef.current
    setLoadingTables(true)
    try {
      const result = await controller.loadPage({
        cursor: null,
        limit: 200,
      })
      if (
        !mountedRef.current ||
        request !== tableListRequestRef.current ||
        result.status !== 'fulfilled' ||
        result.value == null
      ) {
        return
      }
      const names = result.value.rows
        .map((row) => row.name)
        .filter((name): name is string => typeof name === 'string')
      setTables(names)
      const nextTable =
        selectedTableRef.current && names.includes(selectedTableRef.current)
          ? selectedTableRef.current
          : names[0]
      if (!nextTable) {
        selectedTableRef.current = undefined
        pageRef.current = 0
        nextCursorRef.current = null
        boundariesRef.current = [null]
        setSelectedTable(undefined)
        setPage(0)
        setTablePage(null)
        setTotalRows(undefined)
        return
      }
      selectedTableRef.current = nextTable
      pageRef.current = 0
      nextCursorRef.current = null
      boundariesRef.current = [null]
      setSelectedTable(nextTable)
      setPage(0)
      setTotalRows(undefined)
      await loadTablePage(nextTable, 0, null)
    } finally {
      if (request === tableListRequestRef.current && mountedRef.current) {
        setLoadingTables(false)
      }
    }
  }, [controller, loadTablePage])

  useEffect(() => {
    mountedRef.current = true
    const detach = controller.attachView(`sqlite-explorer:${kind}`)
    const frame = requestAnimationFrame(() => {
      void controller.loadSummary()
      void loadTables()
    })
    return () => {
      mountedRef.current = false
      cancelAnimationFrame(frame)
      detach()
    }
  }, [controller, kind, loadTables])

  const selectTable = (tableName: string) => {
    if (selectedTableRef.current === tableName && pageRef.current === 0) return
    requestRef.current += 1
    selectedTableRef.current = tableName
    pageRef.current = 0
    nextCursorRef.current = null
    boundariesRef.current = [null]
    setSelectedTable(tableName)
    setPage(0)
    setTablePage(null)
    setTotalRows(undefined)
    setRunningSql(false)
    setSqlResult(null)
    void loadTablePage(tableName, 0, null)
  }

  const changePage = (nextPage: number) => {
    const tableName = selectedTableRef.current
    if (!tableName || loadingPage || nextPage < 0) return
    const boundaries = boundariesRef.current
    let cursor: string | null
    if (nextPage === 0) {
      boundariesRef.current = [null]
      cursor = null
    } else if (nextPage === page + 1) {
      cursor = nextCursorRef.current
      boundaries[nextPage] = cursor
    } else if (nextPage === page - 1) {
      boundaries.pop()
      cursor = boundaries[nextPage]
    } else {
      return
    }
    pageRef.current = nextPage
    setPage(nextPage)
    void loadTablePage(tableName, nextPage, cursor)
  }

  const refresh = () => {
    requestRef.current += 1
    columnsCacheRef.current.clear()
    selectedTableRef.current = undefined
    nextCursorRef.current = null
    boundariesRef.current = [null]
    setSelectedTable(undefined)
    setTablePage(null)
    setTotalRows(undefined)
    setSqlResult(null)
    setLoadingTables(true)
    void loadTables()
  }

  const countRows = async () => {
    const tableName = selectedTableRef.current
    if (!tableName || countingRowsRef.current) return
    countingRowsRef.current = true
    setCountingRows(true)
    try {
      const result = await controller.loadTableRowCount(tableName)
      if (result.status === 'fulfilled' && mountedRef.current) {
        setTotalRows(result.value)
      }
    } finally {
      countingRowsRef.current = false
      if (mountedRef.current) setCountingRows(false)
    }
  }

  const runSql = async () => {
    if (runningSqlRef.current) return
    runningSqlRef.current = true
    setRunningSql(true)
    try {
      const result = await controller.runReadOnlyQuery({ source: sql })
      if (result.status === 'fulfilled' && mountedRef.current) {
        setSqlResult(result.value)
      }
    } finally {
      runningSqlRef.current = false
      if (mountedRef.current) setRunningSql(false)
    }
  }

  const visibleTable =
    tablePage?.table === selectedTable
      ? tablePage
      : projection.page?.table === selectedTable
        ? projection.page
        : null
  const rows = sqlResult?.rows ?? visibleTable?.rows ?? []
  const columns = sqlResult?.columns ?? visibleTable?.columns ?? []
  const totalPages =
    totalRows === undefined
      ? undefined
      : Math.max(1, Math.ceil(totalRows / SQLITE_EXPLORER_PAGE_SIZE))
  const pageLabel =
    totalPages === undefined
      ? plugin
          .t('settings.databaseExplorer.pageCurrent', 'Page {{current}}')
          .replace('{{current}}', String(page + 1))
      : plugin
          .t(
            'settings.databaseExplorer.pageIndicator',
            'Page {{current}} / {{total}}',
          )
          .replace('{{current}}', String(page + 1))
          .replace('{{total}}', String(totalPages))

  return (
    <div
      className="yolo-sqlite-explorer"
      data-testid="yolo-database-explorer-shell"
    >
      <aside className="yolo-sqlite-explorer-sidebar">
        <div className="yolo-sqlite-explorer-sidebar-heading">
          <span>{plugin.t('settings.databaseExplorer.tables', 'Tables')}</span>
          <button
            className="clickable-icon yolo-sqlite-explorer-refresh"
            aria-label={plugin.t('common.refresh', 'Refresh')}
            aria-busy={loadingTables}
            disabled={loadingTables}
            onClick={refresh}
          >
            <RefreshCw size={15} />
          </button>
        </div>
        {tables.map((name) => (
          <button
            key={name}
            className={`yolo-sqlite-explorer-table${name === selectedTable ? ' is-active' : ''}`}
            disabled={loadingTables}
            onClick={() => selectTable(name)}
          >
            {name}
          </button>
        ))}
      </aside>
      <section className="yolo-sqlite-explorer-main">
        <div className="yolo-sqlite-explorer-toolbar">
          <strong>
            {selectedTable ??
              plugin.t(
                'settings.databaseExplorer.selectTable',
                'Select a table',
              )}
          </strong>
          {selectedTable ? (
            totalRows === undefined ? (
              <button
                className="yolo-sqlite-explorer-count"
                aria-busy={countingRows}
                disabled={countingRows}
                onClick={() => void countRows()}
              >
                {countingRows
                  ? plugin.t(
                      'settings.databaseExplorer.countingRows',
                      'Counting rows...',
                    )
                  : plugin.t(
                      'settings.databaseExplorer.countRows',
                      'Count rows',
                    )}
              </button>
            ) : (
              <span>
                {totalRows} {plugin.t('settings.databaseExplorer.rows', 'rows')}
              </span>
            )
          ) : null}
        </div>
        <ResultTable
          columns={[...columns]}
          rows={[...rows]}
          loading={
            loadingTables || loadingPage || projection.status === 'loading'
          }
          preserveRows={Boolean(visibleTable || sqlResult)}
          loadingLabel={plugin.t(
            'settings.databaseExplorer.loading',
            'Loading...',
          )}
          emptyLabel={plugin.t('settings.databaseExplorer.noRows', 'No rows')}
        />
        {visibleTable && !sqlResult ? (
          <div className="yolo-sqlite-explorer-pagination">
            <button
              className="clickable-icon yolo-sqlite-explorer-page-button"
              aria-label={plugin.t('common.previous', 'Previous')}
              disabled={loadingPage || page === 0}
              onClick={() => changePage(page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span>{pageLabel}</span>
            <button
              className="clickable-icon yolo-sqlite-explorer-page-button"
              aria-label={plugin.t('common.next', 'Next')}
              disabled={loadingPage || !visibleTable.hasNextPage}
              onClick={() => changePage(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
          </div>
        ) : null}
        <div className="yolo-sqlite-explorer-sql">
          <textarea
            value={sql}
            onChange={(event) => setSql(event.target.value)}
            aria-label={plugin.t(
              'settings.databaseExplorer.sqlLabel',
              'Read-only SQL',
            )}
          />
          <button
            className="mod-cta yolo-sqlite-explorer-run"
            aria-busy={runningSql}
            disabled={runningSql}
            onClick={() => void runSql()}
          >
            <Play size={15} />
            {runningSql
              ? plugin.t('settings.databaseExplorer.runningQuery', 'Running...')
              : plugin.t('settings.databaseExplorer.runQuery', 'Run query')}
          </button>
        </div>
        {sqlResult?.truncated ? (
          <div className="yolo-sqlite-explorer-truncated" role="status">
            {plugin.t(
              'settings.databaseExplorer.queryTruncated',
              'Only the first 500 rows are shown.',
            )}
          </div>
        ) : null}
        {projection.error ? (
          <div className="yolo-sqlite-explorer-error" role="alert">
            {projection.error.code}
          </div>
        ) : null}
      </section>
    </div>
  )
}

const explorerCellClass = (value: unknown): string => {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return 'yolo-sqlite-explorer-cell yolo-sqlite-explorer-cell--blob'
  }
  if (value !== null && typeof value === 'object') {
    return 'yolo-sqlite-explorer-cell yolo-sqlite-explorer-cell--json'
  }
  return 'yolo-sqlite-explorer-cell'
}

function ResultTable({
  columns,
  rows,
  loading,
  preserveRows,
  loadingLabel,
  emptyLabel,
}: {
  columns: string[]
  rows: Array<Record<string, unknown>>
  loading: boolean
  preserveRows: boolean
  loadingLabel: string
  emptyLabel: string
}) {
  if (loading && !preserveRows) {
    return (
      <div className="yolo-sqlite-explorer-empty" aria-busy="true">
        {loadingLabel}
      </div>
    )
  }
  if (!columns.length) {
    return <div className="yolo-sqlite-explorer-empty">{emptyLabel}</div>
  }
  return (
    <div className="yolo-sqlite-explorer-table-wrap" aria-busy={loading}>
      {loading ? (
        <div className="yolo-sqlite-explorer-loading" role="status">
          {loadingLabel}
        </div>
      ) : null}
      <table>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const key =
              columns.map((column) => String(row[column] ?? '')).join('|') ||
              `row-${index}`
            return (
              <tr key={key}>
                {columns.map((column) => {
                  const value = row[column]
                  const formatted = formatSqliteExplorerValue(value)
                  return (
                    <td key={column} title={formatted}>
                      <span className={explorerCellClass(value)}>
                        {formatted}
                      </span>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
