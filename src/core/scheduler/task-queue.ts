import { type TaskRunRuntimeState, TaskRunStatus } from './scheduledTasksStore'

export type QueuePolicy = {
  /** Global concurrency ceiling across the whole queue, spanning all queueGroups. */
  maxConcurrent: number
  /** Whether tasks without an explicit queueGroup are treated as sharing one anonymous group ('sequential') or as fully independent ('concurrent'). */
  defaultMode: 'sequential' | 'concurrent'
}

export type TaskDependencyPolicy = {
  dependsOn: string[]
  /** false (default): if any dependency fails, this task is permanently blocked rather than "pretending" it's ready. */
  continueOnDependencyFailure: boolean
}

export type TaskQueueItem = {
  taskId: string
  executionClaimId?: string
  /**
   * The batch this enqueue belongs to. Dependency readiness (completed/failed) is looked up
   * strictly within the same batchId — not a taskId-lifetime-spanning global Set — so each
   * trigger of a recurring task gets its own independent dependency judgement instead of being
   * polluted by a previous run's terminal state.
   */
  batchId: string
  queueGroup?: string
  scheduleTime: number // planned execution time; pushed back on retry
  enqueuedAt: number
  priority: number // 1-10, default 5
  dependency?: TaskDependencyPolicy
  attempt: number // starts at 1
  maxRetries: number
  /** Explicit trigger origin; the run record no longer infers this from priority. */
  source: 'manual' | 'schedule' | 'retry'
  /** Set when this enqueue is a catch-up of a missed trigger (see scheduler.ts
   * catchUpMissedTasks): flows onto the run record as `catchUpRunAt` for audit. */
  catchUpRunAt?: number
}

/**
 * 'task-ready' is emitted by tryProcessNext() in the same synchronous call that dequeues the
 * item, and always carries a run. 'task-dependency-unresolvable' is emitted by the fast-fail
 * branch in dequeue() and never carries a run, but carries missingDependencyTaskId instead.
 * The two shapes are deliberately different so subscribers can narrow on `event.type` at
 * compile time instead of scattering defensive `run` undefined-checks through business logic.
 */
export type TaskQueueEvent =
  | { type: 'task-ready'; item: TaskQueueItem; run: TaskRunRuntimeState }
  | {
      type: 'task-dependency-unresolvable'
      item: TaskQueueItem
      run: undefined
      missingDependencyTaskId: string
      reason: 'missing' | 'failed'
    }

const DEFAULT_QUEUE_GROUP = '__default__'

/** Upper bound on the exponential retry backoff: a retry waits at most this long after the failed attempt (2^n s, capped at 5 minutes). */
const MAX_RETRY_BACKOFF_MS = 300_000

/** Outcome of markFailed, so the scheduler can surface a scheduled retry (e.g. a retry_scheduled event) without coupling the queue to the event bus. */
export type MarkFailedResult =
  | { retried: true; attempt: number; nextAttemptAtMs: number }
  | { retried: false }

export class TaskQueue {
  private items: TaskQueueItem[] = []
  private executing: Map<
    string,
    { item: TaskQueueItem; run: TaskRunRuntimeState }
  > = new Map()
  /** Dependency state is isolated per batchId so recurring tasks don't bleed state across batches; see the batchId comment above. */
  private batches: Map<
    string,
    { completed: Set<string>; failed: Set<string> }
  > = new Map()
  private batchCreatedAt: Map<string, number> = new Map()
  /** Each batch's "expected full membership" (the set of taskIds enqueued together this round), used to decide whether a dependency can *never* be satisfied. */
  private batchMembers: Map<string, Set<string>> = new Map()
  private batchExpectedCompletion: Map<string, number> = new Map()
  private paused = false

  constructor(
    private policy: QueuePolicy = {
      maxConcurrent: 1,
      defaultMode: 'sequential',
    },
  ) {}

  enqueue(item: TaskQueueItem): void {
    this.items.push(item)
    // priority descending, then enqueuedAt ascending (FIFO) within the same priority
    this.items.sort((a, b) =>
      a.priority !== b.priority
        ? b.priority - a.priority
        : a.enqueuedAt - b.enqueuedAt,
    )
    this.tryProcessNext()
  }

  /**
   * Declares "these are all the taskIds in this batch", called by the scheduler before/around
   * a round of checkAndEnqueueScheduledTasks's enqueue() calls. A dependency that isn't in the
   * batch's declared membership (and isn't in executing/items or completed/failed) is judged as
   * permanently missing rather than "still running" — usually a sign of two tasks with
   * mismatched schedule frequencies (e.g. depending on a daily task while triggering hourly).
   * Skipped for enqueues that don't register batch membership (e.g. a single manual
   * executeTaskNow), which degrades to "wait indefinitely, never fail fast".
   */
  registerBatchMembers(batchId: string, taskIds: string[]): void {
    this.batchMembers.set(batchId, new Set(taskIds))
  }

  /**
   * Prunes stale batches by their expected completion time rather than a fixed blanket TTL:
   * a batch's lifetime depends on the latest scheduled time + longest timeout among its
   * members, not a magic number unrelated to actual task configuration. The caller
   * (ScheduledTaskScheduler) supplies "this batch's latest expected completion time" on each
   * scheduling tick.
   */
  markBatchExpectedCompletion(
    batchId: string,
    expectedCompletionTime: number,
  ): void {
    this.batchExpectedCompletion.set(batchId, expectedCompletionTime)
  }

  /** safetyMarginMs should be a fixed conservative buffer (e.g. 5 minutes) to cover clock drift / extreme queueing delays. */
  pruneStaleBatches(safetyMarginMs: number): void {
    const now = Date.now()
    for (const [batchId, expectedCompletionTime] of this
      .batchExpectedCompletion) {
      if (now > expectedCompletionTime + safetyMarginMs) {
        this.batches.delete(batchId)
        this.batchCreatedAt.delete(batchId)
        this.batchMembers.delete(batchId)
        this.batchExpectedCompletion.delete(batchId)
      }
    }
  }

  /** Whether taskId is already in this queue (queued or executing). Used to dedup before enqueueing. */
  isTaskQueued(taskId: string): boolean {
    return (
      this.executing.has(taskId) ||
      this.items.some((item) => item.taskId === taskId)
    )
  }

  /** Latest priority set via updatePendingPriority; applied to retry items so a
   * priority bump while the task is executing still carries into its retry
   * (the retry item is copied from the executing entry, which predates the bump). */
  private latestPriority = new Map<string, number>()

  /** Updates the priority of a still-queued (not yet dequeued) task and re-sorts. Returns false if not found (already executing/finished). */
  updatePendingPriority(taskId: string, priority: number): boolean {
    this.latestPriority.set(taskId, priority)
    const item = this.items.find((i) => i.taskId === taskId)
    if (!item) return false
    item.priority = priority
    this.items.sort((a, b) =>
      a.priority !== b.priority
        ? b.priority - a.priority
        : a.enqueuedAt - b.enqueuedAt,
    )
    return true
  }

  /**
   * Transient "move to front" for a still-queued (not yet dequeued) item:
   * re-sorts it ahead of everything for THIS dequeue only. The pre-bump
   * priority is recorded in latestPriority before jumping to 10, so a retry
   * of a failed run falls back to the task's stored priority instead of
   * inheriting the transient bump (the permanent priority lives in the task
   * store and is edited there). Returns false if not found (already
   * executing/finished).
   */
  promotePendingTask(taskId: string): boolean {
    const item = this.items.find((i) => i.taskId === taskId)
    if (!item) return false
    this.latestPriority.set(taskId, item.priority)
    item.priority = 10
    this.items.sort((a, b) =>
      a.priority !== b.priority
        ? b.priority - a.priority
        : a.enqueuedAt - b.enqueuedAt,
    )
    return true
  }

  /** Removes pending work for a deleted task. Executing work is left intact and is
   * cleaned up by the scheduler when its current attempt settles. */
  removePendingTask(taskId: string): boolean {
    const before = this.items.length
    this.items = this.items.filter((item) => item.taskId !== taskId)
    return this.items.length !== before
  }

  /** Called when a task completes — automatically advances the queue (the core of "one after another"). */
  markCompleted(taskId: string, batchId: string): void {
    this.executing.delete(taskId)
    this.getBatchState(batchId).completed.add(taskId)
    this.tryProcessNext()
  }

  /**
   * Retries with exponential backoff on failure (next attempt scheduled
   * `2^attempt` seconds later, capped at MAX_RETRY_BACKOFF_MS); only counted as
   * a terminal failure for the batch once maxRetries is exceeded. Returns what
   * happened so callers can surface the scheduled retry (see MarkFailedResult).
   */
  markFailed(
    taskId: string,
    batchId: string,
    isRetryable: boolean,
  ): MarkFailedResult {
    const entry = this.executing.get(taskId)
    this.executing.delete(taskId)
    if (!entry) {
      // Defensive branch: under normal flow, executing always has this taskId (see the
      // "mark executing on dequeue" design in tryProcessNext below). Should be unreachable.
      this.tryProcessNext()
      return { retried: false }
    }

    const { item } = entry
    if (isRetryable && item.attempt < item.maxRetries) {
      const nextAttemptAtMs =
        Date.now() +
        Math.min(1000 * Math.pow(2, item.attempt), MAX_RETRY_BACKOFF_MS) // 2s/4s/8s..., capped at 5min
      this.items.push({
        ...item,
        attempt: item.attempt + 1,
        source: 'retry',
        scheduleTime: nextAttemptAtMs,
        priority: this.latestPriority.get(taskId) ?? item.priority,
      })
      this.items.sort((a, b) =>
        a.priority !== b.priority
          ? b.priority - a.priority
          : a.enqueuedAt - b.enqueuedAt,
      )
      this.tryProcessNext()
      return { retried: true, attempt: item.attempt + 1, nextAttemptAtMs }
    }
    this.getBatchState(batchId).failed.add(taskId)
    this.tryProcessNext()
    return { retried: false }
  }

  /**
   * Starts any queued items whose scheduleTime has arrived. The scheduler calls
   * this on every poll tick so a retried run fires at (or soon after) its
   * backoff time even when no other task is due — otherwise a retry would only
   * run when some other enqueue/markCompleted prodded the queue (up to one
   * schedule period late, or never for a one-off manual task).
   */
  drain(): void {
    this.tryProcessNext()
  }

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
    this.tryProcessNext()
  }

  clear(): void {
    this.items = []
  }

  getQueueStatus(): {
    pending: number
    executing: number
    completed: number
    failed: number
    policy: QueuePolicy
    paused: boolean
  } {
    let completed = 0
    let failed = 0
    for (const b of this.batches.values()) {
      completed += b.completed.size
      failed += b.failed.size
    }
    return {
      pending: this.items.length,
      executing: this.executing.size,
      completed,
      failed,
      policy: this.policy,
      paused: this.paused,
    }
  }

  getPendingTasks(): TaskQueueItem[] {
    return [...this.items]
  }

  getExecutingTasks(): TaskRunRuntimeState[] {
    return Array.from(this.executing.values()).map((e) => e.run)
  }

  private subscribers = new Set<(event: TaskQueueEvent) => void>()
  subscribe(cb: (event: TaskQueueEvent) => void): () => void {
    this.subscribers.add(cb)
    return () => this.subscribers.delete(cb)
  }

  private emit(event: TaskQueueEvent): void {
    this.subscribers.forEach((cb) => cb(event))
  }

  private getBatchState(batchId: string): {
    completed: Set<string>
    failed: Set<string>
  } {
    let state = this.batches.get(batchId)
    if (!state) {
      state = { completed: new Set(), failed: new Set() }
      this.batches.set(batchId, state)
      this.batchCreatedAt.set(batchId, Date.now())
    }
    return state
  }

  private effectiveGroup(
    item: Pick<TaskQueueItem, 'queueGroup'>,
  ): string | undefined {
    return (
      item.queueGroup ??
      (this.policy.defaultMode === 'sequential'
        ? DEFAULT_QUEUE_GROUP
        : undefined)
    )
  }

  private isGroupBusy(group: string): boolean {
    for (const { item } of this.executing.values()) {
      if (this.effectiveGroup(item) === group) return true
    }
    return false
  }

  /** Whether the dependency is "guaranteed absent from this batch" (a config error), not "still queued/executing". */
  private findUnresolvableDependency(item: TaskQueueItem): string | undefined {
    const members = this.batchMembers.get(item.batchId)
    if (!members) return undefined // batch membership wasn't registered (e.g. manual trigger) — skip this check
    const { completed, failed } = this.getBatchState(item.batchId)
    return item.dependency!.dependsOn.find(
      (depId) =>
        !members.has(depId) && !completed.has(depId) && !failed.has(depId),
    )
  }

  private isDependencyReady(item: TaskQueueItem): boolean {
    const { completed, failed } = this.getBatchState(item.batchId)
    const batchScoped = this.batchMembers.has(item.batchId)
    return item.dependency!.dependsOn.every((depId) => {
      if (completed.has(depId)) return true
      if (failed.has(depId)) return item.dependency!.continueOnDependencyFailure
      if (batchScoped) {
        return false // dependency still queued/executing in this batch — keep waiting
      }
      // Manual trigger (no batch membership registered): the dependency's
      // completion is recorded in ITS own batch, which this run can never
      // observe, so batch-scoped readiness would wait forever. Judge globally
      // instead — satisfied once the dependency is no longer queued or
      // executing anywhere (a manual "run now" is an explicit instruction to
      // run; it only waits for a dependency that is actually in flight).
      return (
        !this.executing.has(depId) &&
        !this.items.some((item) => item.taskId === depId)
      )
    })
  }

  private findFailedDependency(item: TaskQueueItem): string | undefined {
    const { failed } = this.getBatchState(item.batchId)
    return item.dependency!.dependsOn.find((depId) => failed.has(depId))
  }

  private dequeue(): TaskQueueItem | null {
    if (this.paused) return null
    if (this.executing.size >= this.policy.maxConcurrent) return null // global concurrency ceiling
    const now = Date.now()

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]
      if (item.scheduleTime > now) continue

      const group = this.effectiveGroup(item)
      if (group && this.isGroupBusy(group)) continue // group mutual exclusion: another task in the same group is running

      if (item.dependency?.dependsOn.length) {
        const unresolvable = this.findUnresolvableDependency(item)
        if (unresolvable) {
          // Fail fast with a clear record instead of letting the task sit silently in the queue forever.
          this.items.splice(i, 1)
          this.getBatchState(item.batchId).failed.add(item.taskId)
          this.emit({
            type: 'task-dependency-unresolvable',
            item,
            run: undefined,
            missingDependencyTaskId: unresolvable,
            reason: 'missing',
          })
          i--
          continue
        }
        const failedDependency = this.findFailedDependency(item)
        if (failedDependency && !item.dependency.continueOnDependencyFailure) {
          this.items.splice(i, 1)
          this.getBatchState(item.batchId).failed.add(item.taskId)
          this.emit({
            type: 'task-dependency-unresolvable',
            item,
            run: undefined,
            missingDependencyTaskId: failedDependency,
            reason: 'failed',
          })
          i--
          continue
        }
        if (!this.isDependencyReady(item)) continue
      }

      this.items.splice(i, 1)
      return item
    }
    return null
  }

  /**
   * Dequeue → build runtime state → mark executing is merged into a single synchronous step
   * (rather than requiring the subscriber to call a separate "mark executing" method after
   * receiving 'task-ready', which is an implicit contract easy to break during a refactor).
   * Subscribers see an already-"executing" state when they receive the event, and have no way
   * to make a second decision about whether to execute. This keeps `executing.size` accurate
   * across every loop iteration, eliminating any possibility of the concurrency ceiling being
   * double-issued without relying on external discipline.
   */
  private tryProcessNext(): void {
    let next: TaskQueueItem | null
    while ((next = this.dequeue()) !== null) {
      const run: TaskRunRuntimeState = {
        runId: crypto.randomUUID(),
        taskId: next.taskId,
        batchId: next.batchId,
        attempt: next.attempt,
        triggeredBy: next.source,
        scheduledFor: next.scheduleTime,
        status: TaskRunStatus.PENDING,
        catchUpRunAt: next.catchUpRunAt,
      }
      this.executing.set(next.taskId, { item: next, run })
      this.emit({ type: 'task-ready', item: next, run })
    }
  }
}
