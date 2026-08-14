import { createTranslationFunction } from '../i18n'
import { resolveObsidianLanguage } from '../i18n/obsidianLanguage'

import {
  type ScheduledTask,
  type ScheduledTasksStore,
  type TaskConfig,
  type TaskRun,
  type TaskRunRuntimeState,
  TaskRunStatus,
  type TaskStatistics,
} from './scheduler/scheduledTasksStore'
import {
  type EnqueueResult,
  ScheduledTaskScheduler,
  type TaskFilters,
} from './scheduler/scheduler'
import type { TaskEvent, TaskEventBus } from './scheduler/task-event-bus'
import type { TaskExecutor } from './scheduler/task-executor'
import type { QueuePolicy, TaskQueueItem } from './scheduler/task-queue'
import {
  type ScriptExecutionSettings,
  validateScriptPath,
} from './scheduler/validateScriptPath'

export type QueueStatus = ReturnType<ScheduledTaskScheduler['getQueueStatus']>

/**
 * How long `cleanup()` waits for in-flight runs to settle before stopping the
 * poll loop (see the cleanup() doc comment). Runs are individually bounded by
 * their `timeoutSeconds`; this cap only guards against an abort that is slow
 * to honor, so a settings-toggle stop never blocks on a hung run.
 */
const CLEANUP_SETTLE_TIMEOUT_MS = 5000

/** Per design doc §7 — the UI (and later, agent tools) only ever depend on this interface, never on `ScheduledTaskScheduler` directly. */
export type IScheduledTasksService = {
  createTask(config: TaskConfig): Promise<ScheduledTask>
  getTask(id: string): Promise<ScheduledTask>
  updateTask(id: string, config: Partial<TaskConfig>): Promise<void>
  deleteTask(id: string): Promise<void>
  listTasks(filters?: TaskFilters): Promise<ScheduledTask[]>

  toggleTasks(ids: string[], enabled: boolean): Promise<void>

  executeTaskNow(taskId: string): Promise<EnqueueResult>
  cancelTaskRun(runId: string): Promise<void>
  pauseQueue(): void
  resumeQueue(): void
  clearQueue(): void
  changePriority(taskId: string, priority: number): Promise<void>
  /** Transient "move to front" — this queued run only; the stored priority is untouched. */
  promoteTaskToFront(taskId: string): Promise<boolean>
  getQueueStatus(): QueueStatus
  getPendingTasks(): TaskQueueItem[]
  getExecutingTasks(): TaskRunRuntimeState[]

  getTaskRun(runId: string): Promise<TaskRun>
  listTaskRuns(
    taskId: string,
    options?: { filter?: TaskRunStatus; limit: number; offset: number },
  ): Promise<{ runs: TaskRun[]; total: number }>
  /** Runs across every task, newest first — the "All runs" history view. */
  listAllRuns(options?: {
    filter?: TaskRunStatus
    limit: number
    offset: number
  }): Promise<{ runs: TaskRun[]; total: number }>
  getTaskStatistics(taskId: string): Promise<TaskStatistics>

  subscribeToAllTaskEvents(callback: (event: TaskEvent) => void): () => void
  subscribeToTaskRun(
    runId: string,
    callback: (event: TaskEvent) => void,
  ): () => void
  subscribeToTask(
    taskId: string,
    callback: (event: TaskEvent) => void,
  ): () => void
}

export type ScheduledTasksServiceDeps = {
  store: ScheduledTasksStore
  eventBus: TaskEventBus
  executor: TaskExecutor
  queuePolicy?: QueuePolicy
  /** Per-tick agent-run budget; null/undefined disables the cap (see scheduler.ts). */
  getMaxAgentRunsPerTick?: () => number | null | undefined
  /** Rejects a `type=script` create/update at input time (before the task is ever scheduled), rather than waiting for `TaskExecutor.executeScript()`'s own defense to fire at run time. */
  getScriptExecutionSettings?: () => ScriptExecutionSettings
}

/** Translate a service-facing message in the current Obsidian language. */
const translate = (keyPath: string, fallback?: string): string =>
  createTranslationFunction(resolveObsidianLanguage())(keyPath, fallback)

/**
 * Facade over `ScheduledTaskScheduler` + `ScheduledTasksStore` (design doc §7). Every method the
 * scheduler/store already expose synchronously is re-exposed here returning a Promise instead —
 * this is the contract UI code and (later) agent tools are written against, so neither has to
 * change if a future revision moves task execution behind a worker/IPC boundary.
 *
 * `initialize()`/`cleanup()` (not part of `IScheduledTasksService`) start/stop the scheduler's
 * poll loop — mirrors `BotService`'s constructor-DI + initialize()/cleanup() convention
 * (`src/core/bot/bot-service.ts`), called from `main.ts` once the vault base dir is resolved and
 * the store has been opened.
 */
export class ScheduledTasksService implements IScheduledTasksService {
  private readonly scheduler: ScheduledTaskScheduler
  private readonly store: ScheduledTasksStore
  private readonly eventBus: TaskEventBus
  private readonly getScriptExecutionSettings?: () => ScriptExecutionSettings
  private initializePromise: Promise<void> | null = null
  private initialized = false

  constructor(deps: ScheduledTasksServiceDeps) {
    this.store = deps.store
    this.eventBus = deps.eventBus
    this.getScriptExecutionSettings = deps.getScriptExecutionSettings
    this.scheduler = new ScheduledTaskScheduler({
      store: deps.store,
      executor: deps.executor,
      eventBus: deps.eventBus,
      queuePolicy: deps.queuePolicy,
      getMaxAgentRunsPerTick: deps.getMaxAgentRunsPerTick,
      // Orphan recovery runs once the scheduler actually wins the leader lock (before its first
      // due-check), never unconditionally on every window's initialize(). Otherwise a second
      // Obsidian window that never becomes leader would mark the leader's RUNNING runs CANCELLED.
      onLeaderAcquired: () => this.recoverOrphanedRuns(),
    })
  }

  private assertValidScriptPath(scriptPath: string | null | undefined): void {
    if (!scriptPath) return
    const settings = this.getScriptExecutionSettings?.()
    if (!settings) return
    const pathError = validateScriptPath(scriptPath, settings)
    if (pathError) throw new Error(pathError.message)
  }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (this.initializePromise) return this.initializePromise

    const sharedPromise = (async () => {
      // Orphan recovery is NOT done here — it's the scheduler's onLeaderAcquired hook, so it only
      // fires on the window that actually wins the leader lock (see the constructor above).
      this.scheduler.start()
      this.initialized = true
    })().then(
      () => {
        if (this.initializePromise === sharedPromise) {
          this.initializePromise = null
        }
      },
      (error: unknown) => {
        if (this.initializePromise === sharedPromise) {
          this.initializePromise = null
        }
        throw error
      },
    )
    this.initializePromise = sharedPromise
    return sharedPromise
  }

  /**
   * Settings-toggle stop (enabled → disabled): waits for in-flight runs to
   * settle (bounded at CLEANUP_SETTLE_TIMEOUT_MS — every run is bounded by its
   * own timeoutSeconds, but an abort that is slow to honor can outlive the
   * cap, in which case the run settles on its own afterwards; the store stays
   * open on this path so its completion writes remain safe) and then stops
   * the poll loop. Pending queue work is dropped — it is reconsidered the
   * next time the scheduler starts.
   */
  async cleanup(): Promise<void> {
    await this.scheduler.settleInFlightRuns(CLEANUP_SETTLE_TIMEOUT_MS)
    this.scheduler.stop()
    this.initialized = false
  }

  shutdown(): void {
    this.scheduler.shutdown()
    this.initialized = false
  }

  /**
   * A run left in RUNNING state can only mean the previous process was killed (crashed/force-quit)
   * before the run reached a terminal status — a clean unload calls shutdown(), which aborts
   * in-flight runs (they settle without touching the store), and a settings-toggle stop calls
   * cleanup(), which waits for in-flight runs to settle. Marks each orphan as CANCELLED (not
   * FAILED/TIMED_OUT: nothing about the run itself failed, the host process did) so the run
   * history/queue monitor stop showing it as perpetually "running". Deliberately does not
   * re-enqueue — restarting several stale tasks at once on every plugin load would be surprising;
   * the user can re-trigger any of them manually via "Run now".
   *
   * Serves as the scheduler's `onLeaderAcquired` hook, so it only runs on the window that wins the
   * leader lock, before that window's first due-check — a second window that never becomes leader
   * can't reset the leader's still-live RUNNING runs.
   */
  private async recoverOrphanedRuns(): Promise<number> {
    const orphaned = this.store.listRunningRuns()
    const now = Date.now()
    for (const run of orphaned) {
      const error = translate(
        'scheduler.orphanRunCancelled',
        '插件重启前该任务仍在运行，状态已重置为已取消（可能由于应用崩溃或强制退出）',
      )
      this.store.updateRun(run.id, {
        status: TaskRunStatus.CANCELLED,
        completedAt: now,
        error,
      })
      this.store.updateTask(
        run.taskId,
        {
          lastRunAt: now,
          lastRunStatus: TaskRunStatus.CANCELLED,
          lastError: error,
        },
        now,
      )
    }
    return orphaned.length
  }

  // ---- CRUD ----

  async createTask(config: TaskConfig): Promise<ScheduledTask> {
    if (config.type === 'script') {
      this.assertValidScriptPath(config.scriptPath)
    }
    return this.scheduler.createTask(config)
  }

  async getTask(id: string): Promise<ScheduledTask> {
    const task = this.store.getTask(id)
    if (!task) {
      throw new Error(
        translate('scheduler.errors.taskNotFound', `任务不存在: ${id}`).replace(
          '{id}',
          id,
        ),
      )
    }
    return task
  }

  async updateTask(id: string, config: Partial<TaskConfig>): Promise<void> {
    // Only re-validate when the patch actually touches scriptPath — leaving it untouched
    // shouldn't re-check a value that was already valid when it was first set.
    if ('scriptPath' in config) {
      this.assertValidScriptPath(config.scriptPath)
    }
    this.scheduler.updateTask(id, config)
  }

  async deleteTask(id: string): Promise<void> {
    this.scheduler.deleteTask(id)
  }

  async listTasks(filters?: TaskFilters): Promise<ScheduledTask[]> {
    return this.scheduler.listTasks(filters)
  }

  // ---- bulk operations ----

  async toggleTasks(ids: string[], enabled: boolean): Promise<void> {
    this.scheduler.toggleTasks(ids, enabled)
  }

  // ---- execution & queue control ----

  async executeTaskNow(taskId: string): Promise<EnqueueResult> {
    return this.scheduler.executeTaskNow(taskId)
  }

  async cancelTaskRun(runId: string): Promise<void> {
    this.scheduler.cancelTaskRun(runId)
  }

  pauseQueue(): void {
    this.scheduler.pauseQueue()
  }

  resumeQueue(): void {
    this.scheduler.resumeQueue()
  }

  clearQueue(): void {
    this.scheduler.clearQueue()
  }

  async changePriority(taskId: string, priority: number): Promise<void> {
    this.scheduler.changePriority(taskId, priority)
  }

  async promoteTaskToFront(taskId: string): Promise<boolean> {
    return this.scheduler.promoteTaskToFront(taskId)
  }

  getQueueStatus(): QueueStatus {
    return this.scheduler.getQueueStatus()
  }

  getPendingTasks(): TaskQueueItem[] {
    return this.scheduler.getPendingTasks()
  }

  getExecutingTasks(): TaskRunRuntimeState[] {
    return this.scheduler.getExecutingTasks()
  }

  // ---- history ----

  async getTaskRun(runId: string): Promise<TaskRun> {
    const run = this.store.getRun(runId)
    if (!run) {
      throw new Error(
        translate(
          'scheduler.errors.runNotFound',
          `运行记录不存在: ${runId}`,
        ).replace('{runId}', runId),
      )
    }
    return run
  }

  async listTaskRuns(
    taskId: string,
    options?: { filter?: TaskRunStatus; limit: number; offset: number },
  ): Promise<{ runs: TaskRun[]; total: number }> {
    return this.store.listRunsByTask(taskId, {
      status: options?.filter,
      limit: options?.limit,
      offset: options?.offset,
    })
  }

  async getTaskStatistics(taskId: string): Promise<TaskStatistics> {
    return this.store.getTaskStatistics(taskId)
  }

  async listAllRuns(options?: {
    filter?: TaskRunStatus
    limit: number
    offset: number
  }): Promise<{ runs: TaskRun[]; total: number }> {
    return this.store.listAllRuns({
      status: options?.filter,
      limit: options?.limit,
      offset: options?.offset,
    })
  }

  // ---- events ----

  subscribeToAllTaskEvents(callback: (event: TaskEvent) => void): () => void {
    return this.eventBus.subscribeAll(callback)
  }

  subscribeToTaskRun(
    runId: string,
    callback: (event: TaskEvent) => void,
  ): () => void {
    return this.eventBus.subscribeToTaskRun(runId, callback)
  }

  subscribeToTask(
    taskId: string,
    callback: (event: TaskEvent) => void,
  ): () => void {
    return this.eventBus.subscribeToTask(taskId, callback)
  }
}
