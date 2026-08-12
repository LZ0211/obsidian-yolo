/** @jest-environment jsdom */

import type { App } from 'obsidian'
import { act } from 'react'
import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import { DatabaseMaintenanceController } from '../../../core/maintenance/DatabaseMaintenanceController'
import type {
  SqliteExplorerSnapshot,
  SqliteQueryResult,
} from '../../../database/sqlite/sqliteDatabaseExplorer'

jest.mock('../../common/ReactModal', () => ({
  ReactModal: class {
    Component: unknown
    props: unknown

    constructor({ Component, props }: { Component: unknown; props: unknown }) {
      this.Component = Component
      this.props = props
    }
  },
}))

import { SqliteDatabaseExplorerModal } from './SqliteDatabaseExplorerModal'

type InspectOptions = {
  table?: string
  columns?: string[]
  cursor?: string | null
  pageSize?: number
}

type ExplorerPlugin = {
  t: jest.Mock<string, [string, string?]>
  inspectRagDatabase: jest.Mock<
    Promise<SqliteExplorerSnapshot>,
    [InspectOptions]
  >
  countRagDatabaseTableRows: jest.Mock<Promise<number>, [string]>
  queryRagDatabase: jest.Mock<Promise<SqliteQueryResult>, [string]>
  getDatabaseMaintenanceController: jest.Mock<
    DatabaseMaintenanceController,
    ['rag']
  >
}

type DatabaseKind = 'rag'
type ExplorerComponentProps = {
  plugin: ExplorerPlugin
  kind: DatabaseKind
  onClose: () => void
}

type CapturedModal = {
  Component: ComponentType<ExplorerComponentProps>
  props: Omit<ExplorerComponentProps, 'onClose'>
}

const tableSnapshot = (
  table: string,
  cursor: string | null = null,
  value = `${table}-${cursor ?? 0}`,
): SqliteExplorerSnapshot => ({
  tables: [],
  table: {
    name: table,
    columns: ['id'],
    nextCursor: cursor === null ? '10' : null,
    pageSize: 10,
    rows: [{ id: value }],
    hasNextPage: cursor === null,
  },
})

const defaultInspect = async (
  options: InspectOptions,
): Promise<SqliteExplorerSnapshot> =>
  options.table
    ? tableSnapshot(options.table, options.cursor ?? null)
    : { tables: ['records', 'events'] }

const createPlugin = (): ExplorerPlugin => {
  const plugin = {
    t: jest.fn((key: string) => {
      if (key === 'settings.databaseExplorer.pageIndicator') {
        return 'Page {{current}} / {{total}}'
      }
      if (key === 'settings.databaseExplorer.pageCurrent') {
        return 'Page {{current}}'
      }
      return `translated:${key}`
    }),
    inspectRagDatabase: jest.fn(defaultInspect),
    countRagDatabaseTableRows: jest.fn(async (_tableName: string) => 25),
    queryRagDatabase: jest.fn(async (_sql: string) => ({
      columns: ['value'],
      rows: [{ value: 'query-result' }],
      truncated: false,
    })),
  } as unknown as ExplorerPlugin
  const controllers = new Map<string, DatabaseMaintenanceController>()
  plugin.getDatabaseMaintenanceController = jest.fn((kind) => {
    const existing = controllers.get(kind)
    if (existing) return existing
    const inspect = plugin.inspectRagDatabase
    const count = plugin.countRagDatabaseTableRows
    const query = plugin.queryRagDatabase
    const controller = new DatabaseMaintenanceController({
      backend: {
        kind,
        getHeadSequence: jest.fn(async () => 1),
        getSummary: jest.fn(async () => ({ headSequence: 1, rowCount: 0 })),
        getRowCount: async (table) => count(table),
        loadPage: async (request) => {
          const result = await inspect({
            table: request.table,
            columns: request.columns ? [...request.columns] : undefined,
            cursor: request.cursor,
            pageSize: request.limit,
          })
          if (!result.table) {
            return {
              cursor: request.cursor,
              rows: result.tables.map((name) => ({ name })),
              nextCursor: null,
            }
          }
          return {
            cursor: request.cursor,
            table: result.table.name,
            columns: result.table.columns,
            rows: result.table.rows,
            nextCursor: result.table.nextCursor,
            hasNextPage: result.table.hasNextPage,
          }
        },
        runQuery: async (request) => query(request.source),
        runJob: jest.fn(async () => undefined),
      },
    })
    controllers.set(kind, controller)
    return controller
  })
  return plugin
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('SqliteDatabaseExplorerModal', () => {
  let container: HTMLDivElement
  let root: Root

  beforeAll(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    })
  })

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })

  async function flush() {
    await act(async () => {
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve())
      })
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
    })
  }

  async function click(element: Element | null) {
    if (!(element instanceof HTMLElement)) throw new Error('Missing control')
    await act(async () => {
      element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })
  }

  async function renderExplorer(
    plugin: ExplorerPlugin,
    kind: DatabaseKind = 'rag',
  ) {
    const modal = new SqliteDatabaseExplorerModal(
      {} as App,
      plugin as never,
      kind,
    ) as unknown as CapturedModal

    await act(async () => {
      root.render(
        <modal.Component {...modal.props} onClose={() => undefined} />,
      )
    })
    await flush()
  }

  it('loads tables and the first page without automatically counting rows', async () => {
    const plugin = createPlugin()

    await renderExplorer(plugin)

    expect(plugin.inspectRagDatabase).toHaveBeenCalledTimes(2)
    expect(plugin.inspectRagDatabase).toHaveBeenNthCalledWith(1, {
      table: undefined,
      columns: undefined,
      cursor: null,
      pageSize: 200,
    })
    expect(plugin.inspectRagDatabase).toHaveBeenNthCalledWith(2, {
      table: 'records',
      columns: undefined,
      cursor: null,
      pageSize: 10,
    })
    expect(plugin.countRagDatabaseTableRows).not.toHaveBeenCalled()
    expect(
      container.querySelector('.yolo-sqlite-explorer-pagination span')
        ?.textContent,
    ).toBe('Page 1')
  })

  it('preserves current rows and reuses columns while loading another page', async () => {
    const plugin = createPlugin()
    const nextPage = deferred<SqliteExplorerSnapshot>()
    plugin.inspectRagDatabase.mockImplementation(async (options) => {
      if (options.table === 'records' && options.cursor === '10') {
        return nextPage.promise
      }
      return defaultInspect(options)
    })
    await renderExplorer(plugin)

    await click(
      container.querySelector('button[aria-label="translated:common.next"]'),
    )

    expect(container.textContent).toContain('records-0')
    expect(
      container
        .querySelector('.yolo-sqlite-explorer-table-wrap')
        ?.getAttribute('aria-busy'),
    ).toBe('true')
    expect(plugin.inspectRagDatabase).toHaveBeenLastCalledWith({
      table: 'records',
      columns: ['id'],
      cursor: '10',
      pageSize: 10,
    })

    await act(async () => {
      nextPage.resolve(tableSnapshot('records', '10', 'records-next'))
      await nextPage.promise
    })

    expect(container.textContent).toContain('records-next')
    expect(container.textContent).not.toContain('records-0')
  })

  it('walks forward and back using rowid keyset boundaries', async () => {
    const plugin = createPlugin()
    await renderExplorer(plugin)
    expect(container.textContent).toContain('records-0')

    await click(
      container.querySelector('button[aria-label="translated:common.next"]'),
    )
    expect(container.textContent).toContain('records-10')

    await click(
      container.querySelector(
        'button[aria-label="translated:common.previous"]',
      ),
    )
    expect(container.textContent).toContain('records-0')
    expect(plugin.inspectRagDatabase).toHaveBeenLastCalledWith({
      table: 'records',
      columns: ['id'],
      cursor: null,
      pageSize: 10,
    })
  })

  it('ignores a stale table request that resolves after the latest selection', async () => {
    const plugin = createPlugin()
    const staleEvents = deferred<SqliteExplorerSnapshot>()
    plugin.inspectRagDatabase.mockImplementation(async (options) => {
      if (options.table === 'events') return staleEvents.promise
      if (options.table === 'records' && options.columns) {
        return tableSnapshot('records', null, 'records-latest')
      }
      return defaultInspect(options)
    })
    await renderExplorer(plugin)

    await click(
      Array.from(
        container.querySelectorAll('.yolo-sqlite-explorer-table'),
      ).find((element) => element.textContent === 'events') ?? null,
    )
    await click(
      Array.from(
        container.querySelectorAll('.yolo-sqlite-explorer-table'),
      ).find((element) => element.textContent === 'records') ?? null,
    )

    await act(async () => {
      staleEvents.resolve(tableSnapshot('events', null, 'events-stale'))
      await staleEvents.promise
    })

    expect(container.textContent).toContain('records-latest')
    expect(container.textContent).not.toContain('events-stale')
  })

  it('deduplicates SQL execution and reports truncated results', async () => {
    const plugin = createPlugin()
    const query = deferred<SqliteQueryResult>()
    plugin.queryRagDatabase.mockReturnValue(query.promise)
    await renderExplorer(plugin)
    const runButton = container.querySelector('.mod-cta')

    if (!(runButton instanceof HTMLElement))
      throw new Error('Missing run button')
    await act(async () => {
      runButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      runButton.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    expect(plugin.queryRagDatabase).toHaveBeenCalledTimes(1)
    expect(runButton.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      query.resolve({
        columns: ['value'],
        rows: [{ value: 'bounded-result' }],
        truncated: true,
      })
      await query.promise
    })

    expect(container.textContent).toContain('bounded-result')
    expect(
      container.querySelector('.yolo-sqlite-explorer-truncated')?.textContent,
    ).toBe('translated:settings.databaseExplorer.queryTruncated')
  })
})
