import { Notice } from 'obsidian'

import { createTranslationFunction } from '../../i18n'
import { resolveObsidianLanguage } from '../../i18n/obsidianLanguage'

import { calculateNextRunTime } from './cron-parser'
import { validateDependencyGraph } from './dependency-graph'
import {
  type ScheduledTask,
  type ScheduledTasksStore,
  type TaskConfig,
  type TaskRunLogEntry,
  type TaskRunRuntimeState,
  TaskRunStatus,
  toTaskRunInsert,
} from './scheduledTasksStore'
import type { TaskEventBus } from './task-event-bus'
import {
  ScriptExecutionError,
  type TaskExecutor,
  TaskTimeoutError,
} from './task-executor'
import { type QueuePolicy, TaskQueue, type TaskQueueItem } from './task-queue'

export type TaskFilters = { enabled?: boolean }

/** Translate a scheduler-facing message in the current Obsidian language. */
const translate = (keyPath: string, fallback?: string): string =>
  createTranslationFunction(resolveObsidianLanguage())(keyPath, fallback)

export type EnqueueResult =
  | { outcome: 'started'; runId: string; batchId: string }
  // The 'queued' branch has no runId: a TaskRunRuntimeState is only created once TaskQueue
  // actually dequeues the item (see task-queue.ts tryProcessNext), so a queued task has no run
  // record yet. Callers that want to track it should subscribe to the event bus filtered by
  // batchId instead.
  | {
      outcome: 'queued'
      batchId: string
      reason:
        | 'queue_paused'
        | 'group_busy'
        | 'concurrency_limit'
        | 'waiting_dependency'
    }
  | {
      outcome: 'rejected'
      reason: 'task_not_found' | 'task_disabled' | 'already_queued'
    }

const PRUNE_SAFETY_MARGIN_MS = 5 * 60 * 1000
const CHECK_INTERVAL_MS = 30_000
/** How often the scheduler checks run-history size and prunes (age cutoff + per-task cap). */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000
/** Runs started (or scheduled) more than this long ago are deleted by the periodic prune. */
const RUNS_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** After the age cutoff, each task keeps at most this many most-recent runs. */
const RUNS_KEEP_LAST_N_PER_TASK = 50

/**
 * Startup quiet window: the catch-up pass is deferred this long after
 * scheduler.start(), so an Obsidian startup with many overdue recurring tasks
 * doesn't storm the queue with make-up runs while cold-start IO is settling
 * (cherry-studio's 60s startup-recovery delay, halved). The only startup work
 * is recoverOrphanedRuns via beforeFirstCheck (backup behavior, unchanged).
 */
const CATCH_UP_QUIET_WINDOW_MS = 30_000

/**
 * A trigger point only counts as "missed" once it has been overdue by more
 * than one full polling period. Within the 30s tick granularity a due task is
 * picked up by the regular due-check — without this margin every recurring
 * task would be labeled a catch-up on its own next fire (lastRunAt is always
 * before nextRunTime by construction), and normal fires would drift a tick.
 */
const CATCH_UP_OVERDUE_THRESHOLD_MS = 2 * CHECK_INTERVAL_MS

const isRetryableError = (error: unknown): boolean => {
  // Deterministic script failure (non-zero exit): retrying repeats the same
  // mistake. Timeouts and everything else stay conservatively retryable.
  if (error instanceof ScriptExecutionError) return false
  if (error instanceof TaskTimeoutError) return true
  return true
}

/**
 * A cron/interval trigger point is "missed" when it came and went while the
 * process wasn't polling: `nextRunTime` is overdue by more than a full polling
 * period (see CATCH_UP_OVERDUE_THRESHOLD_MS), and no run has satisfied it
 * since (`lastRunAt` before the trigger point — a later manual run covers the
 * trigger and must not be re-executed). `once` schedules are never caught up
 * (cherry catchUp.ts: "once: never overdue here"; a consumed one is disabled
 * anyway, an unconsumed one is the regular due-check's job). Missed triggers
 * belong to the catch-up pass, not the regular due-check: the due-check defers
 * them so the startup quiet window can hold the make-up runs back.
 */
const isMissedTrigger = (task: ScheduledTask, now: number): boolean =>
  task.scheduleType !== 'once' &&
  task.nextRunTime != null &&
  task.nextRunTime <= now - CATCH_UP_OVERDUE_THRESHOLD_MS &&
  (task.lastRunAt == null || task.lastRunAt < task.nextRunTime)

/** Top-level scheduler owned by the plugin's singleton service. */
export class ScheduledTaskScheduler {
  private readonly queue: TaskQueue
  private readonly runAbortControllers = new Map<string, AbortController>()
  /** In-flight `executeQueuedTask` promises, tracked so `settleInFlightRuns` can wait for them. */
  private readonly inFlightRuns = new Set<Promise<void>>()
  private checkInterval?: ReturnType<typeof setInterval>
  private isChecking = false // mutex: prevents the 30s timer and a manual trigger from re-entering and double-enqueueing
  private stopped = true
  private shuttingDown = false
  /** Timestamp of the most recent prune; 0 delays the first prune until PRUNE_INTERVAL_MS after the poll loop starts. */
  private lastPruneAt = 0
  /** Timestamp of the most recent start(): the catch-up pass is held back until
   * CATCH_UP_QUIET_WINDOW_MS after it, so a fresh startup never storms the queue. */
  private startedAt = 0

  constructor(
    private readonly deps: {
      store: ScheduledTasksStore
      executor: TaskExecutor
      eventBus: TaskEventBus
      queuePolicy?: QueuePolicy
      /**
       * Per-tick agent-run budget (C8). When provided, at most this many agent
       * tasks may start per schedule tick; isolated agent tasks beyond the
       * budget keep their due `nextRunTime` and are picked up by the next tick.
       * Returns null/undefined to disable the cap.
       */
      getMaxAgentRunsPerTick?: () => number | null | undefined
      /** One-shot hook, fired once per start just before the first due-check. */
      beforeFirstCheck?: () => unknown
    },
  ) {
    this.queue = new TaskQueue(deps.queuePolicy)
    this.queue.subscribe((event) => {
      if (event.type === 'task-ready') {
        // run was already constructed synchronously by TaskQueue.tryProcessNext (see
        // task-queue.ts) — consumed directly here, not rebuilt.
        this.trackInFlightRun(this.executeQueuedTask(event.item, event.run))
      } else {
        this.handleUnresolvableDependency(
          event.item,
          event.missingDependencyTaskId,
          event.reason,
        )
      }
    })
  }

  // ---- lifecycle ----

  start(): void {
    if (this.shuttingDown) return
    if (!this.stopped) return
    this.stopped = false
    this.startedAt = Date.now() // arms the catch-up quiet window for this start
    void this.runPollLoop()
  }

  stop(): void {
    this.stopped = true
    if (this.checkInterval) clearInterval(this.checkInterval)
    this.checkInterval = undefined
    this.queue.clear()
  }

  /** Stops polling and prevents in-flight completions from touching a store that
   * the plugin is about to close. Pending work is discarded because it has no
   * persisted run row yet and will be reconsidered by the next startup. */
  shutdown(): void {
    this.shuttingDown = true
    this.stop()
    this.queue.pause()
    this.queue.clear()
    // Abort in-flight runs: a plugin reload/disable must not leave the previous
    // instance's script/agent runs running — their completion writes would hit a
    // store the new instance already re-opened, and a reload's orphan recovery
    // would mark them CANCELLED while the old run was still writing COMPLETED.
    // executeQueuedTask's shuttingDown branch already skips persistence, so the
    // aborted runs settle without touching the store.
    for (const controller of this.runAbortControllers.values()) {
      controller.abort()
    }
    this.runAbortControllers.clear()
  }

  private trackInFlightRun(promise: Promise<void>): void {
    this.inFlightRuns.add(promise)
    // Both arms consume the promise, so a (hypothetical) rejection can't
    // surface as an unhandled rejection on the derived chain.
    promise.then(
      () => this.inFlightRuns.delete(promise),
      () => this.inFlightRuns.delete(promise),
    )
  }

  /**
   * Waits (bounded) for every in-flight run to settle — used by the service's
   * `cleanup()` after a settings-toggle has stopped polling and dropped queued
   * work. Runs are bounded
   * by their `timeoutSeconds`, but a run can outlive that (e.g. an abort that
   * is slow to honor), so the wait is capped at `timeoutMs` and returns
   * regardless; any still-running run settles later on its own without
   * touching the store in a way that could race the toggle (the store stays
   * open on the cleanup path).
   */
  async settleInFlightRuns(timeoutMs: number): Promise<void> {
    const inFlight = [...this.inFlightRuns]
    if (inFlight.length === 0) return
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, timeoutMs)
    })
    try {
      await Promise.race([
        Promise.allSettled(inFlight).then(() => undefined),
        timeout,
      ])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
    }
  }

  private async runPollLoop(): Promise<void> {
    if (this.stopped) return
    try {
      await this.deps.beforeFirstCheck?.()
    } catch (error) {
      // A throwing startup hook (e.g. recoverOrphanedRuns -> store.listRunningRuns) must not stop
      // this scheduler's poll loop. Log and keep going so the interval still gets installed.
      console.error(
        '[YOLO][ScheduledTasks] before-first-check hook failed; continuing to poll',
        error,
      )
    }
    // stop() may have run while the startup hook was in flight — don't install an interval that
    // stop() already missed clearing.
    if (this.stopped) return
    this.checkAndEnqueueScheduledTasks()
    // Run-history retention is deliberately NOT applied here (only on the
    // periodic tick): recovery (beforeFirstCheck) must finish first and its
    // recovered runs stay visible to the operator until the next tick.
    this.checkInterval = setInterval(() => {
      this.checkAndEnqueueScheduledTasks()
      this.queue.pruneStaleBatches(PRUNE_SAFETY_MARGIN_MS)
      this.queue.drain() // fires retries whose exponential backoff elapsed since the last tick
      this.maybePruneRuns()
    }, CHECK_INTERVAL_MS)
  }

  // ---- task CRUD ----

  createTask(config: TaskConfig): ScheduledTask {
    const id = crypto.randomUUID()
    const validation = validateDependencyGraph([
      ...this.deps.store
        .listTasks()
        .map((task) => ({ id: task.id, dependsOn: task.dependsOn })),
      { id, dependsOn: config.dependsOn },
    ])
    if (validation) throw new Error(validation.message)

    const nextRunTime = calculateNextRunTime(config, Date.now())
    return this.deps.store.createTask(
      id,
      { ...config, nextRunTime },
      Date.now(),
    )
  }

  /**
   * Recomputes `nextRunTime` whenever the patch touches a schedule field — without this, editing
   * e.g. a running task's cron expression would silently leave the old `nextRunTime` in place
   * until the task happened to fire once more under the old schedule.
   */
  updateTask(id: string, patch: Partial<TaskConfig>): void {
    if (patch.dependsOn !== undefined) {
      const validation = validateDependencyGraph(
        this.deps.store
          .listTasks()
          .map((task) =>
            task.id === id
              ? { id: task.id, dependsOn: patch.dependsOn ?? null }
              : { id: task.id, dependsOn: task.dependsOn },
          ),
      )
      if (validation) throw new Error(validation.message)
    }

    const scheduleFieldsChanged = (
      [
        'scheduleType',
        'cronExpression',
        'intervalSeconds',
        'oneTimeDateTime',
        // T3: a timezone change alone must also recompute nextRunTime — the
        // same cron expression fires at a different instant in a new tz.
        'timezone',
      ] as const
    ).some((key) => key in patch)
    if (!scheduleFieldsChanged) {
      this.deps.store.updateTask(id, patch, Date.now())
      return
    }

    const existing = this.deps.store.getTask(id)
    if (!existing) {
      throw new Error(
        translate('scheduler.errors.taskNotFound', `任务不存在: ${id}`).replace(
          '{id}',
          id,
        ),
      )
    }
    const nextRunTime = calculateNextRunTime(
      { ...existing, ...patch },
      Date.now(),
    )
    this.deps.store.updateTask(id, { ...patch, nextRunTime }, Date.now())
  }

  /** Cancels local work before deleting the task and its run history. */
  deleteTask(id: string): void {
    this.queue.removePendingTask(id)
    const inFlightRunIds = this.queue
      .getExecutingTasks()
      .filter((run) => run.taskId === id)
      .map((run) => run.runId)
    for (const runId of inFlightRunIds) {
      this.cancelTaskRun(runId)
    }
    this.deps.store.deleteTask(id)
  }

  toggleTask(id: string, enabled: boolean): void {
    this.deps.store.updateTask(id, { enabled }, Date.now())
  }

  listTasks(filters?: TaskFilters): ScheduledTask[] {
    return this.deps.store.listTasks({ enabledOnly: filters?.enabled })
  }

  /**
   * Bulk enable/disable: internally still calls the single-task method one at
   * a time (reusing the same validation/cleanup logic rather than duplicating
   * it), but only emits one summary event once all of them are done — a UI
   * subscriber selecting 20 tasks gets a single refresh, not 20 consecutive
   * ones.
   */
  toggleTasks(ids: string[], enabled: boolean): void {
    for (const id of ids) this.toggleTask(id, enabled)
    this.deps.eventBus.emit({ type: 'tasks_batch_updated', taskIds: ids })
  }

  // ---- manual operations ----

  /**
   * "Run now": bypasses the schedule and jumps the queue at the highest priority. The return
   * value explicitly distinguishes "already executing" from "queued but waiting" so the caller
   * (UI / future agent tool) can show "running" vs "queued, position N" accordingly. Manual
   * triggers get their own batchId so they don't affect other batches' dependency resolution.
   */
  executeTaskNow(taskId: string): EnqueueResult {
    const task = this.deps.store.getTask(taskId)
    if (!task) return { outcome: 'rejected', reason: 'task_not_found' }
    if (!task.enabled) return { outcome: 'rejected', reason: 'task_disabled' }
    // Already queued or executing (either from the schedule, or an earlier "run now" that
    // hasn't finished yet) — don't enqueue a second time.
    if (this.queue.isTaskQueued(taskId))
      return { outcome: 'rejected', reason: 'already_queued' }
    const batchId = crypto.randomUUID()
    this.queue.enqueue({
      taskId: task.id,
      batchId,
      queueGroup: task.queueGroup ?? undefined,
      scheduleTime: Date.now(),
      enqueuedAt: Date.now(),
      priority: 10, // highest priority for manual triggers
      dependency: task.dependsOn?.length
        ? {
            dependsOn: task.dependsOn,
            continueOnDependencyFailure: task.continueOnDependencyFailure,
          }
        : undefined,
      attempt: 1,
      maxRetries: task.maxRetries,
      source: 'manual',
    })

    // enqueue() synchronously calls tryProcessNext() internally; runId only exists once the
    // item is actually dequeued (see task-queue.ts), so it can't be pre-generated and compared
    // — reverse-lookup by taskId + batchId instead.
    const started = this.queue
      .getExecutingTasks()
      .find((r) => r.taskId === task.id && r.batchId === batchId)
    if (started) return { outcome: 'started', runId: started.runId, batchId }

    // Reason is derived from the post-enqueue state (enqueue already ran
    // tryProcessNext synchronously), not a pre-enqueue snapshot that can be
    // stale the moment the call returns.
    const queueStatus = this.queue.getQueueStatus()
    const reason = queueStatus.paused
      ? 'queue_paused'
      : task.dependsOn?.length
        ? 'waiting_dependency'
        : queueStatus.executing >= queueStatus.policy.maxConcurrent
          ? 'concurrency_limit'
          : 'group_busy'
    return { outcome: 'queued', batchId, reason }
  }

  cancelTaskRun(runId: string): void {
    const controller = this.runAbortControllers.get(runId)
    if (!controller) return
    controller.abort()
    const now = Date.now()
    this.deps.store.updateRun(runId, {
      status: TaskRunStatus.CANCELLED,
      completedAt: now,
    })
    this.deps.eventBus.emit({ type: 'task_cancelled', runId })
  }

  /** Persists the new priority, and if the task happens to still be queued (not yet dequeued), re-sorts it in place immediately instead of waiting for the next schedule tick. */
  changePriority(taskId: string, priority: number): void {
    this.deps.store.updateTask(taskId, { priority }, Date.now())
    this.queue.updatePendingPriority(taskId, priority)
    this.deps.eventBus.emit({ type: 'queue_changed' })
  }

  /**
   * Transient "move to front" (see TaskQueue.promotePendingTask): the queued
   * run jumps ahead of everything for THIS dequeue only — the task's stored
   * priority is untouched, so future schedule ticks and retries keep the
   * task's configured priority. Returns false when the task is no longer
   * pending (already executing/finished), in which case nothing changes.
   */
  promoteTaskToFront(taskId: string): boolean {
    const promoted = this.queue.promotePendingTask(taskId)
    if (promoted) this.deps.eventBus.emit({ type: 'queue_changed' })
    return promoted
  }

  pauseQueue(): void {
    this.queue.pause()
    this.deps.eventBus.emit({ type: 'queue_changed' })
  }

  resumeQueue(): void {
    this.queue.resume()
    this.deps.eventBus.emit({ type: 'queue_changed' })
  }

  clearQueue(): void {
    this.queue.clear()
    this.deps.eventBus.emit({ type: 'queue_changed' })
  }

  getQueueStatus(): ReturnType<TaskQueue['getQueueStatus']> {
    return this.queue.getQueueStatus()
  }

  getPendingTasks(): TaskQueueItem[] {
    return this.queue.getPendingTasks()
  }

  getExecutingTasks(): TaskRunRuntimeState[] {
    return this.queue.getExecutingTasks()
  }

  // ---- internals ----

  private checkAndEnqueueScheduledTasks(): void {
    if (this.isChecking) return // mutex: skip this round if the previous one hasn't finished, to avoid double-enqueueing
    this.isChecking = true
    try {
      const now = Date.now()
      // The round = catch-up (quiet-window gated, missed triggers) + regular
      // due-check (due within the polling granularity). The regular due-check
      // defers missed triggers to the catch-up pass — everything else runs
      // exactly as before.
      const missedTasks = this.listMissedTasks(now)
      const dueTasks = this.deps.store
        .listDueTasks(now)
        .filter((task) => !isMissedTrigger(task, now))

      // Cross-batch dependency deferral: a task whose dependency is a live
      // recurring task OUTSIDE this round's batch would be fast-failed by the
      // queue's batch-scoped judgment ("not in this batch") even though the
      // dependency WILL run — it just lands in a later tick (the catch-up pass
      // is held back by the quiet window, or the dependency fires on a slower
      // cadence, or it already ran this startup and its next fire is later).
      // Deferring keeps nextRunTime due and re-evaluates next tick, so the
      // chain enqueues together in one batch once the dependency joins a round
      // (e.g. a missed task depending on a task due at restart, or a due task
      // depending on a missed one). A queued/executing dependency is treated
      // the same way: its in-flight completion lands in an OLDER batch, and
      // this round's batch would only hold a phantom member the dependent
      // could wait on forever — defer to the dependency's next fire instead.
      // Deleted/disabled/once dependencies are NOT deferred — they can never
      // run, and the queue's fast-fail surfaces them as config errors, exactly
      // as before. The fixpoint also defers dependents of deferred tasks (a
      // task whose dependency is itself being deferred this tick can't resolve
      // either).
      const roundIds = new Set([...missedTasks, ...dueTasks].map((t) => t.id))
      const deferredIds = new Set<string>()
      let deferralGrew: boolean
      do {
        deferralGrew = false
        for (const task of [...missedTasks, ...dueTasks]) {
          if (deferredIds.has(task.id)) continue
          const defer = (task.dependsOn ?? []).some((depId) => {
            if (deferredIds.has(depId)) return true // dependent of a deferred task
            if (this.queue.isTaskQueued(depId)) return true // in-flight from an older batch
            if (roundIds.has(depId)) return false // will run in this round's batch
            const dep = this.deps.store.getTask(depId)
            return (
              dep != null &&
              dep.enabled &&
              dep.scheduleType !== 'once' &&
              dep.nextRunTime != null
            )
          })
          if (defer) {
            deferredIds.add(task.id)
            deferralGrew = true
          }
        }
      } while (deferralGrew)

      // C8: the per-tick agent budget spans the WHOLE round (catch-up + due),
      // exactly like the pre-catch-up semantics — at most maxAgentRunsPerTick
      // agent tasks may start per schedule tick, so the catch-up pass can't
      // blow the budget on top of the due-check's allowance. Deferred tasks
      // keep their due nextRunTime and are picked up by the next tick.
      const maxAgentRunsPerTick = this.deps.getMaxAgentRunsPerTick?.() ?? null
      const roundTasks = [...missedTasks, ...dueTasks].filter(
        (task) => !deferredIds.has(task.id),
      )
      const toEnqueue =
        maxAgentRunsPerTick != null
          ? this.limitAgentRunsForTick(roundTasks, maxAgentRunsPerTick)
          : roundTasks
      if (toEnqueue.length === 0) return

      // ONE batch per tick, shared by the catch-up and due passes: dependency
      // resolution is scoped to the batch (see task-queue.ts), so a missed
      // task whose dependency is due in the same tick — or a due task
      // depending on a missed one — must live in the same batch or it gets
      // fast-failed as "not in this batch". This preserves the same-batch
      // guarantee the due-check alone provided before catch-up existed.
      const batchId = crypto.randomUUID()

      // Batch membership must be registered before the first enqueue(): enqueue() synchronously
      // triggers tryProcessNext() -> dequeue(), so if a task depends on another task that
      // happens to sort later in this round, batchMembers must already reflect the full round's
      // membership — otherwise "not processed yet" gets misjudged as "doesn't exist in this
      // batch" and fails fast unnecessarily (see task-queue.ts findUnresolvableDependency).
      this.queue.registerBatchMembers(
        batchId,
        toEnqueue.map((task) => task.id),
      )
      const expectedCompletionTime =
        now + Math.max(...toEnqueue.map((task) => task.timeoutSeconds * 1000))
      this.queue.markBatchExpectedCompletion(batchId, expectedCompletionTime)

      const catchUpIds = new Set(missedTasks.map((task) => task.id))
      for (const task of toEnqueue) {
        if (catchUpIds.has(task.id)) {
          this.enqueueCatchUpRun(task, batchId, now)
        } else {
          this.enqueueScheduledRun(task, batchId, now)
        }
      }
    } finally {
      this.isChecking = false
    }
  }

  /**
   * Catch-up scan, held back by the startup quiet window: during the first
   * 30s after start() only beforeFirstCheck (recoverOrphanedRuns) touches
   * startup state — overdue triggers wait, so an Obsidian startup with many
   * missed recurring tasks doesn't storm the queue (cherry's 60s
   * startup-recovery delay, halved). Returns the cron/interval tasks with a
   * genuinely missed trigger (see isMissedTrigger); the actual enqueue
   * happens in enqueueCatchUpRun, sharing the tick's batch.
   */
  private listMissedTasks(now: number): ScheduledTask[] {
    if (now - this.startedAt < CATCH_UP_QUIET_WINDOW_MS) return []
    return this.deps.store
      .listTasks({ enabledOnly: true })
      .filter((task) => isMissedTrigger(task, now))
  }

  /**
   * Enqueues ONE make-up run for a missed trigger — skip-missed semantics:
   * the single most recent missed fire, then nextRunTime resumes from now, so
   * the two triggers missed during a shutdown are not replayed one by one.
   * Runs are auditable: `scheduledFor` carries the missed trigger point and
   * `catchUpRunAt` the moment the make-up run was enqueued. Mirrors
   * cherry-studio's catchUp.ts after-startup policy for our poll-loop model.
   */
  private enqueueCatchUpRun(
    task: ScheduledTask,
    batchId: string,
    now: number,
  ): void {
    const missedTrigger = task.nextRunTime
    if (missedTrigger == null) return // listMissedTasks guarantees non-null; re-check for TS narrowing
    if (this.queue.isTaskQueued(task.id)) return // dedup: already enqueued (e.g. by a manual run)
    const catchUpAt = Date.now()
    this.queue.enqueue({
      taskId: task.id,
      batchId,
      queueGroup: task.queueGroup ?? undefined,
      scheduleTime: missedTrigger, // the missed trigger point, not "now" — run history shows which fire is being made up
      enqueuedAt: catchUpAt,
      priority: task.priority,
      dependency: task.dependsOn?.length
        ? {
            dependsOn: task.dependsOn,
            continueOnDependencyFailure: task.continueOnDependencyFailure,
          }
        : undefined,
      attempt: 1,
      maxRetries: task.maxRetries,
      source: 'schedule',
      catchUpRunAt: catchUpAt, // audit marker on the run record
    })
    // Single catch-up, then the schedule resumes from now (skip-missed).
    this.deps.store.updateTask(
      task.id,
      { nextRunTime: calculateNextRunTime(task, now) },
      now,
    )
  }

  private enqueueScheduledRun(
    task: ScheduledTask,
    batchId: string,
    now: number,
  ): void {
    // Dedup: the previous trigger's run hasn't finished yet (e.g. it ran longer than the
    // 30s check interval) — skip without recomputing nextRunTime or enqueueing again; once
    // it actually finishes and is cleared from executing via markCompleted/markFailed, the
    // next tick will naturally pick it up again since nextRunTime is still "due".
    if (this.queue.isTaskQueued(task.id)) return
    // Compute the next time / whether to disable before enqueueing: even if the follow-up
    // updateTask fails, the enqueue has already happened, so a "recompute failure" won't
    // cause this run to be silently repeated next tick.
    const isOneTime = task.scheduleType === 'once'
    this.queue.enqueue({
      taskId: task.id,
      batchId,
      queueGroup: task.queueGroup ?? undefined,
      scheduleTime: now,
      enqueuedAt: now,
      priority: task.priority,
      dependency: task.dependsOn?.length
        ? {
            dependsOn: task.dependsOn,
            continueOnDependencyFailure: task.continueOnDependencyFailure,
          }
        : undefined,
      attempt: 1,
      maxRetries: task.maxRetries,
      source: 'schedule',
    })

    this.deps.store.updateTask(
      task.id,
      isOneTime
        ? { enabled: false, nextRunTime: null } // one-time tasks are disabled permanently after running once, so they can't "revive"
        : { nextRunTime: calculateNextRunTime(task, now) },
      now,
    )
  }

  /**
   * C8: cap how many agent tasks may start in a single schedule tick.
   *
   * Only *isolated* agent tasks (no dependency edges to any other due task in
   * this round) are deferred — dependency chains must stay within one batch,
   * because the queue judges dependency readiness strictly within a batch.
   * Deferred tasks are not enqueued and their `nextRunTime` stays due, so the
   * next tick naturally picks them up again. Script tasks never count toward
   * the agent budget.
   */
  private limitAgentRunsForTick(
    dueTasks: ScheduledTask[],
    maxAgentRuns: number,
  ): ScheduledTask[] {
    const agentTasks = dueTasks.filter((task) => task.type === 'agent')
    if (agentTasks.length <= maxAgentRuns) return dueTasks

    const dependedOn = new Set<string>()
    for (const task of dueTasks) {
      for (const dependencyId of task.dependsOn ?? []) {
        dependedOn.add(dependencyId)
      }
    }
    const isolated = agentTasks.filter(
      (task) => (task.dependsOn?.length ?? 0) === 0 && !dependedOn.has(task.id),
    )
    const deferredIds = new Set(
      isolated
        .slice(0, agentTasks.length - maxAgentRuns)
        .map((task) => task.id),
    )
    return dueTasks.filter((task) => !deferredIds.has(task.id))
  }

  /**
   * run was already constructed by TaskQueue.tryProcessNext() in the same synchronous call that
   * dequeued it (see task-queue.ts) — not rebuilt here, so there's only ever one source of
   * truth for a run's identity/state.
   */
  private async executeQueuedTask(
    item: TaskQueueItem,
    run: TaskRunRuntimeState,
  ): Promise<void> {
    const task = this.deps.store.getTask(item.taskId)
    if (!task) {
      this.queue.markFailed(item.taskId, item.batchId, false)
      return
    }

    const runId = run.runId
    run.startedAt = Date.now()
    run.status = TaskRunStatus.RUNNING
    this.deps.store.insertRun(toTaskRunInsert(run))
    const abortController = new AbortController()
    this.runAbortControllers.set(runId, abortController)
    this.deps.eventBus.emit({
      type: 'task_started',
      taskId: item.taskId,
      runId,
    })

    try {
      switch (task.type) {
        case 'script': {
          const result = await this.deps.executor.executeScript(
            task.scriptPath ?? '',
            {
              timeoutMs: task.timeoutSeconds * 1000,
              onLog: this.createLogAppender(runId, run),
              externalAbortSignal: abortController.signal,
            },
          )
          run.output = result.output
          run.exitCode = result.exitCode
          if (result.exitCode !== 0) {
            throw new ScriptExecutionError(
              `Script exited with code ${result.exitCode}`,
            )
          }
          break
        }
        case 'agent': {
          const result = await this.deps.executor.executeAgent(
            task.agentPrompt ?? '',
            {
              timeoutMs: task.timeoutSeconds * 1000,
              agentConfig: task.agentConfig,
              externalAbortSignal: abortController.signal,
            },
          )
          run.result = result.result
          run.conversationId = result.conversationId
          break
        }
        case 'ragIndex':
        case 'ragAutoUpdate': {
          const options = {
            timeoutMs: task.timeoutSeconds * 1000,
            externalAbortSignal: abortController.signal,
          }
          const result =
            task.type === 'ragIndex'
              ? await this.deps.executor.executeRagIndex(options)
              : await this.deps.executor.executeRagAutoUpdate(options)
          run.output = result.output
          run.exitCode = result.exitCode
          break
        }
      }

      if (this.shuttingDown) {
        this.queue.markFailed(item.taskId, item.batchId, false)
        return
      }
      const persistedRun = this.deps.store.getRun(runId)
      if (!persistedRun || persistedRun.status === TaskRunStatus.CANCELLED) {
        // Cancellation or task deletion won the race. Advance the queue
        // without recreating the run or emitting success.
        this.queue.markCompleted(item.taskId, item.batchId)
        return
      }

      run.status = TaskRunStatus.COMPLETED
      run.completedAt = Date.now()
      this.deps.store.updateRun(runId, toTaskRunInsert(run))
      this.deps.store.updateTask(
        task.id,
        {
          lastRunAt: run.completedAt,
          lastRunStatus: run.status,
          lastError: null,
        },
        run.completedAt,
      )
      this.deps.eventBus.emit({
        type: 'task_completed',
        runId,
        result: run.result ?? run.output ?? '',
      })
      this.notify(task, 'success')

      this.queue.markCompleted(item.taskId, item.batchId) // critical: advances the queue to the next task
    } catch (error) {
      if (this.shuttingDown) {
        this.queue.markFailed(item.taskId, item.batchId, false)
        return
      }
      const persistedRun = this.deps.store.getRun(runId)
      if (!persistedRun || persistedRun.status === TaskRunStatus.CANCELLED) {
        // Cancellation or task deletion won the race. Advance the queue
        // without recreating the run, emitting failure, or retrying.
        this.queue.markCompleted(item.taskId, item.batchId)
        return
      }
      const timedOut = error instanceof TaskTimeoutError
      run.status = timedOut ? TaskRunStatus.TIMED_OUT : TaskRunStatus.FAILED
      run.error = error instanceof Error ? error.message : String(error)
      run.completedAt = Date.now()
      this.deps.store.updateRun(runId, toTaskRunInsert(run))
      this.deps.store.updateTask(
        task.id,
        {
          lastRunAt: run.completedAt,
          lastRunStatus: run.status,
          lastError: run.error,
        },
        run.completedAt,
      )
      this.deps.eventBus.emit(
        timedOut
          ? { type: 'task_timed_out', runId }
          : { type: 'task_failed', runId, error: run.error },
      )
      this.notify(task, 'failure')

      // pi-style retry progress: when the queue schedules a retry (exponential
      // backoff), announce which attempt will run and when. The queue itself is
      // event-bus-agnostic; it reports the outcome and the scheduler emits.
      const retry = this.queue.markFailed(
        item.taskId,
        item.batchId,
        isRetryableError(error),
      )
      if (retry.retried) {
        this.deps.eventBus.emit({
          type: 'retry_scheduled',
          taskId: item.taskId,
          runId,
          attempt: retry.attempt,
          nextAttemptAtMs: retry.nextAttemptAtMs,
        })
      }
    } finally {
      this.runAbortControllers.delete(runId)
    }
  }

  /**
   * Builds an `onLog` callback for `TaskExecutor.executeScript()`: accumulates log entries onto
   * the in-memory `run` and persists incrementally (every 20 entries, or every 500ms) rather than
   * writing to sqlite on every stdout/stderr chunk. The final state is always persisted anyway by
   * `executeQueuedTask()`'s success/failure branch, so a throttled write here can never lose the
   * last few entries.
   */
  private createLogAppender(
    runId: string,
    run: TaskRunRuntimeState,
  ): (entry: TaskRunLogEntry) => void {
    let lastFlushAt = Date.now()
    return (entry: TaskRunLogEntry) => {
      if (this.shuttingDown || !this.runAbortControllers.has(runId)) return
      run.logs = [...(run.logs ?? []), entry]
      const now = Date.now()
      if (run.logs.length % 20 === 0 || now - lastFlushAt >= 500) {
        lastFlushAt = now
        this.deps.store.updateRun(runId, toTaskRunInsert(run))
      }
    }
  }

  /**
   * Periodic run-history retention (scheduler owns the policy, store owns the
   * delete): terminal runs older than RUNS_MAX_AGE_MS are dropped and each
   * task is kept to its RUNS_KEEP_LAST_N_PER_TASK most recent terminal runs —
   * prevents task_runs from growing without bound on a long-lived vault (only
   * terminal runs, so crash-recovery can always find a RUNNING orphan).
   * Prunes at most once per PRUNE_INTERVAL_MS, on the poll tick only — never
   * during startup, while recovery is still completing. Failures
   * are logged and polling continues (same containment as the startup-hook
   * path) — housekeeping must not take down the schedule loop.
   */
  private maybePruneRuns(): void {
    const now = Date.now()
    if (now - this.lastPruneAt < PRUNE_INTERVAL_MS) return
    try {
      this.deps.store.pruneRuns({
        olderThanMs: RUNS_MAX_AGE_MS,
        keepLastNPerTask: RUNS_KEEP_LAST_N_PER_TASK,
      })
      // Only a successful prune arms the next interval; a failure leaves
      // lastPruneAt stale so the next tick retries instead of waiting 6h.
      this.lastPruneAt = now
    } catch (error) {
      console.error('[YOLO][ScheduledTasks] run-history prune failed', error)
    }
  }

  /**
   * Triggered when TaskQueue detects that a dependency "does not exist anywhere in this batch"
   * (a config error, e.g. dependsOn pointing at a disabled/deleted task). Records a FAILED run
   * so the user can see, in the run history, why the task never ran, rather than letting it
   * silently disappear from the queue — TaskQueue itself only tracks in-memory batch
   * completed/failed state and doesn't touch persistence.
   */
  private handleUnresolvableDependency(
    item: TaskQueueItem,
    missingDependencyTaskId: string,
    reason: 'missing' | 'failed',
  ): void {
    const task = this.deps.store.getTask(item.taskId)
    if (!task) return

    const runId = crypto.randomUUID()
    const now = Date.now()
    const run: TaskRunRuntimeState = {
      runId,
      taskId: item.taskId,
      batchId: item.batchId,
      attempt: item.attempt,
      triggeredBy: item.source,
      scheduledFor: item.scheduleTime,
      status: TaskRunStatus.FAILED,
      startedAt: now,
      completedAt: now,
      error:
        reason === 'failed'
          ? translate(
              'scheduler.errors.dependencyFailed',
              `依赖的任务 ${missingDependencyTaskId} 执行失败，无法调度`,
            ).replace('{id}', missingDependencyTaskId)
          : translate(
              'scheduler.errors.dependencyMissing',
              `依赖的任务 ${missingDependencyTaskId} 在本批次中不存在（可能已被禁用/删除），无法调度`,
            ).replace('{id}', missingDependencyTaskId),
    }
    this.deps.store.insertRun(toTaskRunInsert(run))
    this.deps.store.updateTask(
      task.id,
      {
        lastRunAt: run.completedAt,
        lastRunStatus: run.status,
        lastError: run.error,
      },
      now,
    )
    this.deps.eventBus.emit({
      type: 'task_failed',
      runId,
      error: run.error ?? '',
    })
    this.notify(task, 'failure')
  }

  /**
   * `notifyOn` only distinguishes 'success'/'failure' (no separate 'timeout'/'cancelled' variant —
   * see scheduledTasksStore.ts), so a timed-out run is treated as a 'failure' by its caller.
   */
  private notify(task: ScheduledTask, kind: 'success' | 'failure'): void {
    if (!task.notifyOn.includes(kind)) return
    const message =
      kind === 'success'
        ? translate(
            'notices.scheduledTaskSucceeded',
            'Scheduled task succeeded: {name}',
          ).replace('{name}', task.name)
        : translate(
            'notices.scheduledTaskFailed',
            'Scheduled task failed: {name}',
          ).replace('{name}', task.name)
    new Notice(message, 6000)
  }
}
