import { DatabaseMaintenanceController } from './DatabaseMaintenanceController'
import {
  type DatabaseMaintenanceBackend,
  MAINTENANCE_BACKEND_KIND,
  MAINTENANCE_JOB_KIND,
  type MaintenancePage,
} from './types'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

const page = (cursor: string | null): MaintenancePage => ({
  cursor,
  rows: [{ id: cursor ?? 'initial' }],
  nextCursor: cursor === 'second' ? null : 'second',
})

describe('DatabaseMaintenanceController', () => {
  it('forwards table and column selection to paged maintenance reads', async () => {
    const backend: DatabaseMaintenanceBackend = {
      kind: MAINTENANCE_BACKEND_KIND.RAG,
      getHeadSequence: jest.fn(async () => 1),
      getSummary: jest.fn(async () => ({ headSequence: 1, rowCount: 1 })),
      loadPage: jest.fn(async (request) => ({
        cursor: request.cursor,
        table: request.table,
        columns: request.columns,
        rows: [],
        nextCursor: null,
      })),
      runQuery: jest.fn(),
      runJob: jest.fn(async () => undefined),
    }
    const controller = new DatabaseMaintenanceController({ backend })

    await controller.loadPage({
      cursor: null,
      limit: 10,
      table: 'records',
      columns: ['id'],
    })

    expect(backend.loadPage).toHaveBeenCalledWith(
      {
        cursor: null,
        limit: 10,
        table: 'records',
        columns: ['id'],
      },
      expect.any(AbortSignal),
    )
  })

  it('keeps the newest page result when an older request resolves later', async () => {
    const first = deferred<MaintenancePage>()
    const backend: DatabaseMaintenanceBackend = {
      kind: MAINTENANCE_BACKEND_KIND.RAG,
      getHeadSequence: jest.fn(async () => 1),
      getSummary: jest.fn(async () => ({ headSequence: 1, rowCount: 1 })),
      loadPage: jest.fn(({ cursor }: { cursor: string | null }) =>
        cursor === 'first' ? first.promise : Promise.resolve(page('second')),
      ),
      runQuery: jest.fn(),
      runJob: jest.fn(async () => undefined),
    }
    const controller = new DatabaseMaintenanceController({ backend })

    const older = controller.loadPage({ cursor: 'first', limit: 50 })
    const newer = controller.loadPage({ cursor: 'second', limit: 50 })
    await newer
    first.resolve(page('first'))
    await older

    expect(controller.getSnapshot().page?.cursor).toBe('second')
  })

  it('cancels view reads when the last view detaches but keeps an accepted job running', async () => {
    const detail = deferred<MaintenancePage>()
    const job = deferred<void>()
    let detailSignal: AbortSignal | undefined
    let jobSignal: AbortSignal | undefined
    const backend: DatabaseMaintenanceBackend = {
      kind: MAINTENANCE_BACKEND_KIND.RAG,
      getHeadSequence: jest.fn(async () => 1),
      getSummary: jest.fn(async () => ({ headSequence: 1, rowCount: 1 })),
      loadPage: jest.fn((_request, signal) => {
        detailSignal = signal
        return detail.promise
      }),
      runQuery: jest.fn(),
      runJob: jest.fn((_command, signal) => {
        jobSignal = signal
        return job.promise
      }),
    }
    const controller = new DatabaseMaintenanceController({ backend })
    const detach = controller.attachView('modal-1')
    const details = controller.loadPage({ cursor: null, limit: 50 })
    const acceptedJob = controller.startJob({
      kind: MAINTENANCE_JOB_KIND.VACUUM,
      operationKey: 'rag:vacuum',
    })

    await Promise.resolve()
    detach()
    expect(detailSignal?.aborted).toBe(true)
    expect(jobSignal?.aborted).toBe(false)

    detail.resolve(page(null))
    job.resolve()
    await expect(details).resolves.toMatchObject({ status: 'cancelled' })
    await expect(acceptedJob).resolves.toMatchObject({ status: 'completed' })
  })

  it('caches summaries until the backend head sequence changes', async () => {
    let headSequence = 7
    const backend: DatabaseMaintenanceBackend = {
      kind: MAINTENANCE_BACKEND_KIND.RAG,
      getHeadSequence: jest.fn(async () => headSequence),
      getSummary: jest.fn(async () => ({ headSequence, rowCount: 3 })),
      loadPage: jest.fn(),
      runQuery: jest.fn(),
      runJob: jest.fn(async () => undefined),
    }
    const controller = new DatabaseMaintenanceController({ backend })

    await controller.loadSummary()
    await controller.loadSummary()
    expect(backend.getSummary).toHaveBeenCalledTimes(1)

    headSequence = 8
    await controller.loadSummary()
    expect(backend.getSummary).toHaveBeenCalledTimes(2)
  })
})
