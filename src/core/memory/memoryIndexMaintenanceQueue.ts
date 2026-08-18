import { logFlightEvent } from '../../utils/debug/flightLog'

import type { MemoryIndexMaintenanceStore } from './memoryIndex'
import type { MemorySourceSnapshot } from './memoryManager'
import type { MemoryPartition, MemorySector } from './memoryTypes'

const DEFAULT_MAX_ACTIVE_WORKERS = 2
const DEFAULT_MAX_PENDING_PARTITIONS = 32
const MAX_RECONCILE_SOURCE_ENTRIES = 20_000

type ReconcileTask = Readonly<{
  kind: 'reconcile'
  partition: MemoryPartition
  sourcePath: string
  sectorHints?: Readonly<Record<string, MemorySector | null>>
}>

type GraphTask = Readonly<{
  kind: 'graph'
  partition: MemoryPartition
  localIds: readonly string[]
}>

type ReflectionTask = Readonly<{
  kind: 'reflection'
  partition: MemoryPartition
}>

type DecayTask = Readonly<{
  kind: 'decay'
  partition: MemoryPartition
}>

type MaintenanceTask =
  | ReconcileTask
  | GraphTask
  | ReflectionTask
  | DecayTask

type MaintenanceLane = {
  active: boolean
  controller: AbortController | null
  pending: MaintenanceTask[]
  running: MaintenanceTask['kind'] | null
}

export type MemoryIndexMaintenanceQueueOptions = {
  store: MemoryIndexMaintenanceStore
  getSourceSnapshot: (
    partition: MemoryPartition,
  ) => Promise<MemorySourceSnapshot>
  maxActiveWorkers?: number
  maxPendingPartitions?: number
  isReflectionEnabled?: () => boolean
  runReflectionModel?: (prompt: string, signal: AbortSignal) => Promise<string>
  onReconciled?: (input: {
    partition: MemoryPartition
    snapshot: MemorySourceSnapshot
  }) => Promise<void> | void
  clock?: () => number
}

export class MemoryIndexMaintenanceQueue {
  private readonly lanes = new Map<string, MaintenanceLane>()
  private readonly activeTasks = new Set<Promise<void>>()
  private readonly maxActiveWorkers: number
  private readonly maxPendingPartitions: number
  private accepting = true
  private activeWorkers = 0

  constructor(private readonly options: MemoryIndexMaintenanceQueueOptions) {
    this.maxActiveWorkers = Math.max(
      1,
      Math.trunc(options.maxActiveWorkers ?? DEFAULT_MAX_ACTIVE_WORKERS),
    )
    this.maxPendingPartitions = Math.max(
      0,
      Math.trunc(
        options.maxPendingPartitions ?? DEFAULT_MAX_PENDING_PARTITIONS,
      ),
    )
  }

  enqueueReconcile(input: Omit<ReconcileTask, 'kind'>): void {
    if (!this.accepting) return
    const lane = this.getOrCreateLane(input.partition)
    if (!lane) {
      void this.options.store
        .markDirty({
          partition: input.partition,
          reason: 'maintenance queue capacity exceeded',
        })
        .catch(() => undefined)
      return
    }

    const next: ReconcileTask = { kind: 'reconcile', ...input }
    const existingIndex = lane.pending.findIndex(
      (task) => task.kind === 'reconcile',
    )
    if (existingIndex === -1) {
      lane.pending.push(next)
    } else {
      const existing = lane.pending[existingIndex] as ReconcileTask
      lane.pending[existingIndex] = {
        ...next,
        sectorHints:
          existing.sectorHints || next.sectorHints
            ? { ...existing.sectorHints, ...next.sectorHints }
            : undefined,
      }
    }
    this.schedule()
  }

  /**
   * Periodic maintenance (decay + cold archive, plus reflection when
   * configured) for a partition without a reconcile. The scheduler calls
   * this on an interval so salience decay and cold archival run even when
   * no source file changed.
   */
  enqueueMaintenance(partition: MemoryPartition): void {
    if (!this.accepting) return
    const lane = this.getOrCreateLane(partition)
    if (!lane) {
      void this.options.store
        .markDirty({
          partition,
          reason: 'maintenance queue capacity exceeded',
        })
        .catch(() => undefined)
      return
    }
    if (
      lane.running === 'reconcile' ||
      lane.pending.some((task) => task.kind === 'reconcile')
    )
      return
    // A pending or in-flight decay already covers this partition (reconcile
    // follow-ups enqueue one after every reconcile).
    if (
      lane.running === 'decay' ||
      lane.running === 'reflection' ||
      lane.pending.some(
        (task) => task.kind === 'decay' || task.kind === 'reflection',
      )
    )
      return
    const tasks: MaintenanceTask[] = [{ kind: 'decay', partition }]
    if (this.options.runReflectionModel && this.options.isReflectionEnabled?.()) {
      tasks.push({ kind: 'reflection', partition })
    }
    lane.pending.push(...tasks)
    this.schedule()
  }

  async drain(): Promise<void> {
    while (this.hasWork()) {
      this.schedule()
      if (this.activeTasks.size === 0) return
      await Promise.race(this.activeTasks)
    }
  }

  async shutdown(drainTimeoutMs = 1_000): Promise<boolean> {
    this.accepting = false
    const timeout = Math.max(0, Math.trunc(drainTimeoutMs))
    let timedOut = false
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      this.drain(),
      new Promise<void>(
        (resolve) =>
          (timeoutId = setTimeout(() => {
            timedOut = true
            resolve()
          }, timeout)),
      ),
    ])
    if (timeoutId) clearTimeout(timeoutId)
    if (!timedOut) return false
    for (const lane of this.lanes.values()) {
      lane.pending = []
      lane.controller?.abort()
    }
    return true
  }

  cancelPartition(partitionKey: string): void {
    const lane = this.lanes.get(partitionKey)
    if (!lane) return
    lane.pending = []
    lane.controller?.abort()
    if (!lane.active) this.lanes.delete(partitionKey)
  }

  private getOrCreateLane(partition: MemoryPartition): MaintenanceLane | null {
    const existing = this.lanes.get(partition.partitionKey)
    if (existing) return existing

    const pendingPartitions = [...this.lanes.values()].filter(
      (lane) => !lane.active && lane.pending.length > 0,
    ).length
    const startsImmediately = this.activeWorkers < this.maxActiveWorkers
    if (!startsImmediately && pendingPartitions >= this.maxPendingPartitions) {
      return null
    }

    const lane: MaintenanceLane = {
      active: false,
      controller: null,
      pending: [],
      running: null,
    }
    this.lanes.set(partition.partitionKey, lane)
    return lane
  }

  private hasWork(): boolean {
    return (
      this.activeTasks.size > 0 ||
      [...this.lanes.values()].some((lane) => lane.pending.length > 0)
    )
  }

  private schedule(): void {
    while (this.activeWorkers < this.maxActiveWorkers) {
      const next = [...this.lanes.entries()].find(
        ([, lane]) => !lane.active && lane.pending.length > 0,
      )
      if (!next) return
      const [partitionKey, lane] = next
      this.startLane(partitionKey, lane)
    }
  }

  private startLane(partitionKey: string, lane: MaintenanceLane): void {
    lane.active = true
    lane.controller = new AbortController()
    this.activeWorkers += 1
    const task = this.runLane(partitionKey, lane).finally(() => {
      lane.active = false
      lane.controller = null
      this.activeWorkers -= 1
      this.activeTasks.delete(task)
      if (lane.pending.length === 0) this.lanes.delete(partitionKey)
      this.schedule()
    })
    this.activeTasks.add(task)
  }

  private async runLane(
    partitionKey: string,
    lane: MaintenanceLane,
  ): Promise<void> {
    while (lane.pending.length > 0) {
      const task = lane.pending.shift()
      if (!task) return
      lane.running = task.kind
      try {
        await this.runTask(
          task,
          lane.controller?.signal ?? new AbortController().signal,
        )
      } catch (error) {
        console.warn('[YOLO][MemoryIndex] maintenance task failed', error)
      }
      lane.running = null
      if (!this.lanes.has(partitionKey)) return
    }
  }

  private async runTask(
    task: MaintenanceTask,
    signal: AbortSignal,
  ): Promise<void> {
    const taskStartedAt = Date.now()
    logFlightEvent('memory-index', `task-${task.kind}-start`, {
      id: task.partition.partitionKey,
    })
    try {
      await this.runTaskInner(task, signal)
    } finally {
      logFlightEvent('memory-index', `task-${task.kind}-done`, {
        id: task.partition.partitionKey,
        detail: `took ${Date.now() - taskStartedAt}ms`,
      })
    }
  }

  private async runTaskInner(
    task: MaintenanceTask,
    signal: AbortSignal,
  ): Promise<void> {
    if (task.kind === 'graph') {
      await this.options.store.rebuildEdges({
        partition: task.partition,
        localIds: task.localIds,
      })
      return
    }
    if (task.kind === 'reflection') {
      const runModel = this.options.runReflectionModel
      if (!runModel || !this.options.isReflectionEnabled?.()) return
      await this.options.store.runReflection({
        partition: task.partition,
        nowMs: this.options.clock?.() ?? Date.now(),
        runModel,
        signal,
      })
      return
    }
    if (task.kind === 'decay') {
      await this.options.store.applyDecay({
        partition: task.partition,
        nowMs: this.options.clock?.() ?? Date.now(),
      })
      await this.options.store.archiveColdEntries({ partition: task.partition })
      return
    }

    const snapshot = await this.options.getSourceSnapshot(task.partition)
    await this.options.store.reconcilePartition({
      partition: task.partition,
      sourcePath: task.sourcePath,
      sourceFileFingerprint: snapshot.sourceFileFingerprint,
      parserVersion: snapshot.parserVersion,
      entries: snapshot.entries,
      sectorHints: task.sectorHints,
      signal,
    })
    if (
      !snapshot.valid ||
      snapshot.entries.length > MAX_RECONCILE_SOURCE_ENTRIES
    )
      return
    await this.options.onReconciled?.({
      partition: task.partition,
      snapshot,
    })
    if (signal.aborted) return
    const lane = this.lanes.get(task.partition.partitionKey)
    if (!lane) return
    const followUps: MaintenanceTask[] = [
      { kind: 'decay', partition: task.partition },
      {
        kind: 'graph',
        partition: task.partition,
        localIds: snapshot.entries.map((entry) => entry.localId),
      },
    ]
    if (
      this.options.runReflectionModel &&
      this.options.isReflectionEnabled?.()
    ) {
      followUps.push({ kind: 'reflection', partition: task.partition })
    }
    lane.pending.unshift(...followUps)
  }
}
