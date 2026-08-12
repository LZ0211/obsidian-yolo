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

const isRetryableError = (error: unknown): boolean => {
  // Deterministic script failure (non-zero exit): retrying repeats the same
  // mistake. Timeouts and everything else stay conservatively retryable.
  if (error instanceof ScriptExecutionError) return false
  if (error instanceof TaskTimeoutError) return true
  return true
}

/**
 * Top-level scheduler. Multi-window leader election uses the Web Locks API (`navigator.locks`)
 * where available: only the window holding the exclusive `yolo-scheduled-tasks-leader` lock runs
 * the poll loop, so two Obsidian windows against the same vault don't double-execute due tasks.
 * Environments without `navigator.locks` (older runtimes, the Jest `node` test environment) fall
 * back to running the poll loop directly, unguarded — single-window behavior identical to before.
 */
export class ScheduledTaskScheduler {
  private readonly queue: TaskQueue
  private readonly runAbortControllers = new Map<string, AbortController>()
  private checkInterval?: ReturnType<typeof setInterval>
  private isChecking = false // mutex: prevents the 30s timer and a manual trigger from re-entering and double-enqueueing
  private stopped = true
  private shuttingDown = false
  private releaseLeaderLock?: () => void
  // Scoped by store.rootDir (one per vault) so two different vaults opened in the same Obsidian
  // process/session never contend for each other's lock, while multiple windows on the *same*
  // vault correctly compete for one.
  private readonly leaderLockName: string

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
      /** One-shot hook, fired exactly once per leader acquisition just before the first due-check.
       * Lets the leader recover cross-window/crash state (e.g. orphaned RUNNING runs) before it
       * starts polling, so a second Obsidian window that never wins the leader lock can't touch a
       * live run. May return a promise (e.g. recovery) — the poll loop awaits it so the first check
       * always observes the recovered state. (Typed `unknown` so both sync callbacks and
       * promise-returning recovery like `recoverOrphanedRuns` are accepted.) */
      onLeaderAcquired?: () => unknown
    },
  ) {
    this.leaderLockName = `yolo-scheduled-tasks-leader:${deps.store.rootDir}`
    this.queue = new TaskQueue(deps.queuePolicy)
    this.queue.subscribe((event) => {
      if (event.type === 'task-ready') {
        // run was already constructed synchronously by TaskQueue.tryProcessNext (see
        // task-queue.ts) — consumed directly here, not rebuilt.
        void this.executeQueuedTask(event.item, event.run)
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
    if (this.hasWebLocks()) {
      // The callback (and therefore the poll loop) only runs once this window is granted the
      // exclusive lock; the lock is held until the promise it returns resolves, which happens in
      // stop() via releaseLeaderLock. Lock acquisition is asynchronous even with no contention,
      // so runLeaderPollLoop() re-checks `stopped` in case stop() already ran by the time it fires.
      void navigator.locks.request(
        this.leaderLockName,
        { mode: 'exclusive' },
        () => this.runLeaderPollLoop(),
      )
    } else {
      void this.runLeaderPollLoop()
    }
  }

  stop(): void {
    this.stopped = true
    if (this.checkInterval) clearInterval(this.checkInterval)
    this.checkInterval = undefined
    this.releaseLeaderLock?.()
    this.releaseLeaderLock = undefined
  }

  /** Stops polling and prevents in-flight completions from touching a store that
   * the plugin is about to close. Pending work is discarded because it has no
   * persisted run row yet and will be reconsidered by the next startup. */
  shutdown(): void {
    this.shuttingDown = true
    this.stop()
    this.queue.pause()
    this.queue.clear()
  }

  private hasWebLocks(): boolean {
    return typeof navigator !== 'undefined' && 'locks' in navigator
  }

  /** Runs the poll loop and returns a promise that only resolves once stop() releases it — this is what keeps a Web Lock held for as long as this window remains the leader. */
  private async runLeaderPollLoop(): Promise<void> {
    if (this.stopped) return Promise.resolve() // stop() already ran before this window was granted the lock
    try {
      await this.deps.onLeaderAcquired?.()
    } catch (error) {
      // A throwing leader hook (e.g. recoverOrphanedRuns -> store.listRunningRuns) must not tear
      // down this window's poll loop: on the Web Locks path it would reject navigator.locks.request()
      // (unhandled rejection + the lock would be released so another window takes over), and on the
      // fallback path it would reject runLeaderPollLoop() the same way — either way this window
      // silently stops polling and re-runs the same due tasks. Log and keep going so the interval
      // still gets installed.
      console.error(
        '[YOLO][ScheduledTasks] leader hook failed; continuing to poll',
        error,
      )
    }
    // stop() may have run while the leader hook was in flight (e.g. a long orphan-recovery or a
    // plugin cleanup during lock acquisition) — don't start polling a scheduler that's shutting
    // down, and don't install an interval that stop() already missed clearing.
    if (this.stopped) return Promise.resolve()
    this.checkAndEnqueueScheduledTasks()
    this.checkInterval = setInterval(() => {
      this.checkAndEnqueueScheduledTasks()
      this.queue.pruneStaleBatches(PRUNE_SAFETY_MARGIN_MS)
    }, CHECK_INTERVAL_MS)
    return new Promise((resolve) => {
      this.releaseLeaderLock = resolve
    })
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

  deleteTask(id: string): void {
    this.queue.removePendingTask(id)
    this.deps.store.deleteTask(id)
  }

  toggleTask(id: string, enabled: boolean): void {
    this.deps.store.updateTask(id, { enabled }, Date.now())
  }

  getTask(id: string): ScheduledTask | null {
    return this.deps.store.getTask(id)
  }

  listTasks(filters?: TaskFilters): ScheduledTask[] {
    return this.deps.store.listTasks({ enabledOnly: filters?.enabled })
  }

  /** Copies config fields, not runtime state (id/lastRunAt/lastRunStatus/lastError); nextRunTime is recomputed from the (possibly overridden) schedule. */
  duplicateTask(
    id: string,
    overrides?: Partial<Pick<TaskConfig, 'name'>>,
  ): ScheduledTask {
    const source = this.deps.store.getTask(id)
    if (!source) {
      throw new Error(
        translate('scheduler.errors.taskNotFound', `任务不存在: ${id}`).replace(
          '{id}',
          id,
        ),
      )
    }
    const {
      id: _id,
      createdAt: _createdAt,
      updatedAt: _updatedAt,
      lastRunAt: _lastRunAt,
      lastRunStatus: _lastRunStatus,
      lastError: _lastError,
      ...rest
    } = source
    return this.createTask({
      ...rest,
      name:
        overrides?.name ??
        translate('scheduler.duplicateNameSuffix', '{name} 副本').replace(
          '{name}',
          source.name,
        ),
    })
  }

  /**
   * Bulk enable/disable/delete: internally still calls the single-task methods one at a time
   * (reusing the same validation/cleanup logic rather than duplicating it), but only emits one
   * summary event once all of them are done — a UI subscriber selecting 20 tasks gets a single
   * refresh, not 20 consecutive ones.
   */
  toggleTasks(ids: string[], enabled: boolean): void {
    for (const id of ids) this.toggleTask(id, enabled)
    this.deps.eventBus.emit({ type: 'tasks_batch_updated', taskIds: ids })
  }

  deleteTasks(ids: string[]): void {
    for (const id of ids) this.deleteTask(id)
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
    const queueStatusBefore = this.queue.getQueueStatus()

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

    const reason = queueStatusBefore.paused
      ? 'queue_paused'
      : task.dependsOn?.length
        ? 'waiting_dependency'
        : queueStatusBefore.executing >= queueStatusBefore.policy.maxConcurrent
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
  }

  pauseQueue(): void {
    this.queue.pause()
  }

  resumeQueue(): void {
    this.queue.resume()
  }

  clearQueue(): void {
    this.queue.clear()
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
      let dueTasks = this.deps.store.listDueTasks(now)
      if (dueTasks.length === 0) return

      const maxAgentRunsPerTick = this.deps.getMaxAgentRunsPerTick?.() ?? null
      if (maxAgentRunsPerTick != null) {
        dueTasks = this.limitAgentRunsForTick(dueTasks, maxAgentRunsPerTick)
        if (dueTasks.length === 0) return
      }

      const batchId = crypto.randomUUID() // tasks discovered due in the same tick share one batch for dependency resolution

      // Batch membership must be registered before the first enqueue(): enqueue() synchronously
      // triggers tryProcessNext() -> dequeue(), so if a task depends on another due task that
      // happens to sort later in this loop, batchMembers must already reflect the full round's
      // membership — otherwise "not processed yet" gets misjudged as "doesn't exist in this
      // batch" and fails fast unnecessarily (see task-queue.ts findUnresolvableDependency).
      this.queue.registerBatchMembers(
        batchId,
        dueTasks.map((task) => task.id),
      )
      const expectedCompletionTime =
        now + Math.max(...dueTasks.map((task) => task.timeoutSeconds * 1000))
      this.queue.markBatchExpectedCompletion(batchId, expectedCompletionTime)

      for (const task of dueTasks) {
        // Dedup: the previous trigger's run hasn't finished yet (e.g. it ran longer than the
        // 30s check interval) — skip without recomputing nextRunTime or enqueueing again; once
        // it actually finishes and is cleared from executing via markCompleted/markFailed, the
        // next tick will naturally pick it up again since nextRunTime is still "due".
        if (this.queue.isTaskQueued(task.id)) continue

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
    } finally {
      this.isChecking = false
    }
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
      if (task.type === 'script') {
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
      } else {
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
      }

      if (this.shuttingDown) {
        this.queue.markFailed(item.taskId, item.batchId, false)
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
      if (this.deps.store.getRun(runId)?.status === TaskRunStatus.CANCELLED) {
        // A user-initiated cancel already wrote the terminal state; just
        // advance the queue without emitting a failure event or retrying.
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

      this.queue.markFailed(item.taskId, item.batchId, isRetryableError(error))
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
      run.logs = [...(run.logs ?? []), entry]
      const now = Date.now()
      if (run.logs.length % 20 === 0 || now - lastFlushAt >= 500) {
        lastFlushAt = now
        this.deps.store.updateRun(runId, toTaskRunInsert(run))
      }
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
