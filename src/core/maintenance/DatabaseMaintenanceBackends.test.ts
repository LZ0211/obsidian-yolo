import { createLazySqliteMaintenanceBackend } from './DatabaseMaintenanceBackends'
import { MAINTENANCE_BACKEND_KIND, MAINTENANCE_JOB_KIND } from './types'

describe('lazy database maintenance backends', () => {
  it('does not open the runtime until an explicit detail request', async () => {
    const open = jest.fn(async () => ({
      inspect: jest.fn(async () => ({ tables: ['records'] })),
      count: jest.fn(),
      query: jest.fn(),
    }))
    const backend = createLazySqliteMaintenanceBackend({
      kind: MAINTENANCE_BACKEND_KIND.RAG,
      open,
      runJob: jest.fn(async () => undefined),
    })

    expect(open).not.toHaveBeenCalled()
    await backend.loadPage(
      { cursor: null, limit: 50 },
      new AbortController().signal,
    )
    expect(open).toHaveBeenCalledTimes(1)
  })

  it('maps table pages without expanding the complete table', async () => {
    const inspect = jest.fn(async () => ({
      tables: [],
      table: {
        name: 'records',
        columns: ['id'],
        nextCursor: '2',
        pageSize: 2,
        rows: [{ id: 1 }, { id: 2 }],
        hasNextPage: true,
      },
    }))
    const backend = createLazySqliteMaintenanceBackend({
      kind: MAINTENANCE_BACKEND_KIND.RAG,
      open: jest.fn(async () => ({
        inspect,
        count: jest.fn(),
        query: jest.fn(),
      })),
      runJob: jest.fn(async () => undefined),
    })

    const result = await backend.loadPage(
      {
        cursor: null,
        limit: 2,
        table: 'records',
        columns: ['id'],
      },
      new AbortController().signal,
    )

    expect(result).toMatchObject({
      table: 'records',
      rows: [{ id: 1 }, { id: 2 }],
      nextCursor: '2',
    })
    expect(inspect).toHaveBeenCalledWith({
      table: 'records',
      columns: ['id'],
      cursor: null,
      pageSize: 2,
    })
  })

  it('forwards maintenance cancellation to the explicit job callback', async () => {
    const runJob = jest.fn(async () => undefined)
    const backend = createLazySqliteMaintenanceBackend({
      kind: MAINTENANCE_BACKEND_KIND.RAG,
      open: jest.fn(async () => ({
        inspect: jest.fn(async () => ({ tables: [] })),
        count: jest.fn(),
        query: jest.fn(),
      })),
      runJob,
    })
    const signal = new AbortController().signal

    await backend.runJob(
      {
        kind: MAINTENANCE_JOB_KIND.VACUUM,
        operationKey: 'rag:vacuum',
      },
      signal,
      jest.fn(),
    )

    expect(runJob).toHaveBeenCalledWith(
      expect.objectContaining({ kind: MAINTENANCE_JOB_KIND.VACUUM }),
      signal,
      expect.any(Function),
    )
  })

  it('allows a later detail request to retry after lazy open fails', async () => {
    const open = jest
      .fn()
      .mockRejectedValueOnce(new Error('temporary open failure'))
      .mockResolvedValueOnce({
        inspect: jest.fn(async () => ({ tables: ['records'] })),
        count: jest.fn(),
        query: jest.fn(),
      })
    const backend = createLazySqliteMaintenanceBackend({
      kind: MAINTENANCE_BACKEND_KIND.RAG,
      open,
      runJob: jest.fn(async () => undefined),
    })

    await expect(
      backend.loadPage(
        { cursor: null, limit: 50 },
        new AbortController().signal,
      ),
    ).rejects.toThrow('temporary open failure')
    await expect(
      backend.loadPage(
        { cursor: null, limit: 50 },
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ rows: [{ name: 'records' }] })
    expect(open).toHaveBeenCalledTimes(2)
  })
})
