import { buildMemoryPartition } from './memoryIndex'
import {
  clearFlightLog,
  getFlightEvents,
  setFlightLogEnabled,
} from '../../utils/debug/flightLog'
import type { MemoryIndexMaintenanceStore } from './memoryIndex'
import { MemoryIndexMaintenanceQueue } from './memoryIndexMaintenanceQueue'
import type { MemorySourceSnapshot } from './memoryManager'

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const makeSnapshot = (
  partition: ReturnType<typeof buildMemoryPartition>,
  fingerprint: string,
): MemorySourceSnapshot => ({
  partition,
  sourcePath:
    partition.scope === 'global'
      ? 'YOLO/memory/global.md'
      : `YOLO/memory/${partition.assistantId}.md`,
  sourceFileFingerprint: fingerprint,
  parserVersion: 'test-v1',
  entries: [],
  valid: true,
})

const makeStore = (
  reconcilePartition: MemoryIndexMaintenanceStore['reconcilePartition'],
): jest.Mocked<MemoryIndexMaintenanceStore> =>
  ({
    capability: 'sqlite',
    reconcilePartition: jest.fn(reconcilePartition),
    query: jest.fn(async () => []),
    isPartitionReady: jest.fn(async () => true),
    reinforce: jest.fn(async () => undefined),
    applyDecay: jest.fn(async () => undefined),
    archiveColdEntries: jest.fn(async () => undefined),
    markDirty: jest.fn(async () => undefined),
    rebuildEdges: jest.fn(async () => undefined),
    expandViaEdges: jest.fn(async ({ seeds }) => seeds),
    deletePartition: jest.fn(async () => undefined),
    findPartitionBySourcePath: jest.fn(async () => null),
    runReflection: jest.fn(async () => undefined),
  }) as unknown as jest.Mocked<MemoryIndexMaintenanceStore>

describe('MemoryIndexMaintenanceQueue', () => {
  it('coalesces only pending reconciliation work for the same partition', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const first = deferred()
    const reconciled: string[] = []
    const store = makeStore(async (input) => {
      reconciled.push(input.sourceFileFingerprint)
      if (input.sourceFileFingerprint === 'one') await first.promise
    })
    let snapshot = makeSnapshot(partition, 'one')
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => snapshot,
    })

    queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    await Promise.resolve()
    snapshot = makeSnapshot(partition, 'two')
    queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    snapshot = makeSnapshot(partition, 'three')
    queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    first.resolve()
    await queue.drain()

    expect(reconciled).toEqual(['one', 'three'])
    expect(store.rebuildEdges).toHaveBeenCalledTimes(2)
  })

  it('drains periodic maintenance for a partition without a reconcile', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const store = makeStore(async () => undefined)
    const runReflectionModel = jest.fn(async () => '{}')
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => makeSnapshot(partition, 'one'),
      isReflectionEnabled: () => true,
      runReflectionModel,
      clock: () => 123,
    })

    queue.enqueueMaintenance(partition)
    await queue.drain()

    expect(store.applyDecay).toHaveBeenCalledTimes(1)
    expect(store.applyDecay).toHaveBeenCalledWith({ partition, nowMs: 123 })
    expect(store.archiveColdEntries).toHaveBeenCalledTimes(1)
    expect(store.runReflection).toHaveBeenCalledTimes(1)
    expect(store.reconcilePartition).not.toHaveBeenCalled()
  })

  it('coalesces repeated maintenance while a decay task is pending', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const store = makeStore(async () => undefined)
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => makeSnapshot(partition, 'one'),
    })

    queue.enqueueMaintenance(partition)
    queue.enqueueMaintenance(partition)
    await queue.drain()

    expect(store.applyDecay).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate maintenance while reflection is active', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const reflectionStarted = deferred()
    const releaseReflection = deferred()
    const store = makeStore(async () => undefined)
    store.runReflection.mockImplementation(async () => {
      reflectionStarted.resolve()
      await releaseReflection.promise
    })
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => makeSnapshot(partition, 'one'),
      isReflectionEnabled: () => true,
      runReflectionModel: async () => '{}',
    })

    queue.enqueueMaintenance(partition)
    await reflectionStarted.promise
    queue.enqueueMaintenance(partition)
    releaseReflection.resolve()
    await queue.drain()

    expect(store.applyDecay).toHaveBeenCalledTimes(1)
    expect(store.runReflection).toHaveBeenCalledTimes(1)
  })

  it('does not duplicate maintenance queued while reconciliation is active', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const reconcileStarted = deferred()
    const releaseReconcile = deferred()
    const snapshot = makeSnapshot(partition, 'one')
    const store = makeStore(async () => {
      reconcileStarted.resolve()
      await releaseReconcile.promise
    })
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => snapshot,
      isReflectionEnabled: () => true,
      runReflectionModel: async () => '{}',
    })

    queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    await reconcileStarted.promise
    queue.enqueueMaintenance(partition)
    releaseReconcile.resolve()
    await queue.drain()

    expect(store.applyDecay).toHaveBeenCalledTimes(1)
    expect(store.runReflection).toHaveBeenCalledTimes(1)
  })

  it('applies salience decay after each reconcile using the injected clock', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const store = makeStore(async () => undefined)
    const snapshot = makeSnapshot(partition, 'one')
    const clock = jest.fn(() => 1_000_000)
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => snapshot,
      clock,
    })

    queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    await queue.drain()

    expect(store.applyDecay).toHaveBeenCalledWith({
      partition,
      nowMs: 1_000_000,
    })
    expect(store.applyDecay).toHaveBeenCalledTimes(1)
    expect(store.archiveColdEntries).toHaveBeenCalledWith({ partition })
    expect(store.archiveColdEntries).toHaveBeenCalledTimes(1)
  })

  it('runs at most two partition lanes concurrently', async () => {
    const gates = [deferred(), deferred(), deferred()]
    let active = 0
    let maxActive = 0
    const store = makeStore(async (input) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      const index = Number(input.partition.assistantId)
      await gates[index].promise
      active -= 1
    })
    const snapshots = new Map<string, MemorySourceSnapshot>()
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async (partition) =>
        snapshots.get(partition.partitionKey)!,
    })

    for (let index = 0; index < 3; index += 1) {
      const partition = buildMemoryPartition({
        scope: 'assistant',
        assistantId: String(index),
      })
      const snapshot = makeSnapshot(partition, String(index))
      snapshots.set(partition.partitionKey, snapshot)
      queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    }
    await Promise.resolve()
    expect(active).toBe(2)
    gates[0].resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(maxActive).toBe(2)
    gates[1].resolve()
    gates[2].resolve()
    await queue.drain()
  })

  it('continues later reconciliation after graph maintenance fails', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const reconciled: string[] = []
    const store = makeStore(async (input) => {
      reconciled.push(input.sourceFileFingerprint)
    })
    store.rebuildEdges.mockRejectedValueOnce(new Error('graph unavailable'))
    let snapshot = makeSnapshot(partition, 'one')
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => snapshot,
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
      await queue.drain()
      snapshot = makeSnapshot(partition, 'two')
      queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
      await queue.drain()

      expect(reconciled).toEqual(['one', 'two'])
      expect(store.rebuildEdges).toHaveBeenCalledTimes(2)
    } finally {
      warn.mockRestore()
    }
  })

  it('schedules the optional reflection runner after reconciliation', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const snapshot = makeSnapshot(partition, 'one')
    const store = makeStore(async () => undefined)
    const runReflectionModel = jest.fn(async () => '{}')
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => snapshot,
      isReflectionEnabled: () => true,
      runReflectionModel,
      clock: () => 123,
    })

    queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    await queue.drain()

    expect(store.runReflection).toHaveBeenCalledWith({
      partition,
      nowMs: 123,
      runModel: runReflectionModel,
      signal: expect.any(AbortSignal),
    })
  })

  it('aborts an in-flight reflection when its partition is cancelled', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const snapshot = makeSnapshot(partition, 'one')
    const store = makeStore(async () => undefined)
    const reflectionStarted = deferred()
    let reflectionSignal: AbortSignal | undefined
    store.runReflection.mockImplementation(async (input) => {
      reflectionSignal = input.signal
      reflectionStarted.resolve()
      await new Promise<void>((resolve) =>
        input.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      )
    })
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => snapshot,
      isReflectionEnabled: () => true,
      runReflectionModel: async () => '{}',
    })

    queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    await reflectionStarted.promise
    queue.cancelPartition(partition.partitionKey)
    await queue.drain()

    expect(reflectionSignal?.aborted).toBe(true)
  })

  it('passes the lane abort signal into reconciliation work', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const snapshot = makeSnapshot(partition, 'one')
    const reconcileStarted = deferred()
    let reconcileSignal: AbortSignal | undefined
    const store = makeStore(async (input) => {
      reconcileSignal = input.signal
      reconcileStarted.resolve()
      await new Promise<void>((resolve) =>
        input.signal?.addEventListener('abort', () => resolve(), {
          once: true,
        }),
      )
    })
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => snapshot,
    })

    queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    await reconcileStarted.promise
    queue.cancelPartition(partition.partitionKey)
    await queue.drain()

    expect(reconcileSignal?.aborted).toBe(true)
  })

  it('marks excess pending partitions durably dirty', async () => {
    const gate = deferred()
    const store = makeStore(async () => gate.promise)
    const snapshots = new Map<string, MemorySourceSnapshot>()
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async (partition) =>
        snapshots.get(partition.partitionKey)!,
      maxActiveWorkers: 1,
      maxPendingPartitions: 2,
    })

    for (let index = 0; index < 4; index += 1) {
      const partition = buildMemoryPartition({
        scope: 'assistant',
        assistantId: String(index),
      })
      const snapshot = makeSnapshot(partition, String(index))
      snapshots.set(partition.partitionKey, snapshot)
      queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    }
    await Promise.resolve()

    expect(store.markDirty).toHaveBeenCalledWith({
      partition: buildMemoryPartition({
        scope: 'assistant',
        assistantId: '3',
      }),
      reason: 'maintenance queue capacity exceeded',
    })
    gate.resolve()
    await queue.drain()
  })

  it('returns from shutdown after the bounded drain timeout', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const store = makeStore(async () => new Promise<void>(() => undefined))
    const snapshot = makeSnapshot(partition, 'one')
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => snapshot,
    })
    queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
    await Promise.resolve()

    const startedAt = Date.now()
    await queue.shutdown(20)

    expect(Date.now() - startedAt).toBeLessThan(250)
  })
})

describe('MemoryIndexMaintenanceQueue flight events', () => {
  beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    setFlightLogEnabled(true)
    clearFlightLog()
  })

  afterEach(() => {
    setFlightLogEnabled(false)
    clearFlightLog()
    jest.restoreAllMocks()
  })

  it('records a task-error event when a task fails', async () => {
    const partition = buildMemoryPartition({ scope: 'global' })
    const snapshot = makeSnapshot(partition, 'one')
    const store = makeStore(async () => undefined)
    store.rebuildEdges.mockRejectedValueOnce(new Error('graph unavailable'))
    const queue = new MemoryIndexMaintenanceQueue({
      store,
      getSourceSnapshot: async () => snapshot,
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      queue.enqueueReconcile({ partition, sourcePath: snapshot.sourcePath })
      await queue.drain()

      const error = getFlightEvents().find(
        (event) => event.event === 'task-graph-error',
      )
      expect(error).toBeDefined()
      expect(error?.detail).toContain('graph unavailable')
    } finally {
      warn.mockRestore()
    }
  })
})
