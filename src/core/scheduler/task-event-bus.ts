export type TaskEvent =
  | { type: 'task_started'; taskId: string; runId: string }
  | {
      type: 'task_running'
      runId: string
      message: string
      progress?: { current: number; total: number }
    }
  | { type: 'task_completed'; runId: string; result: string }
  | { type: 'task_failed'; runId: string; error: string }
  | { type: 'task_timed_out'; runId: string }
  | { type: 'task_cancelled'; runId: string }
  | { type: 'scheduled'; taskId: string; nextRunTime: number }
  | {
      // pi-style retry progress: the failed run (runId) is being retried as the
      // given attempt, scheduled to run at nextAttemptAtMs (exponential backoff).
      type: 'retry_scheduled'
      taskId: string
      runId: string
      attempt: number
      nextAttemptAtMs: number
    }
  | { type: 'tasks_batch_updated'; taskIds: string[] }

type TaskEventSubscriber = (event: TaskEvent) => void

/** Same subscribe/emit shape as BackgroundActivityRegistry (src/core/background/backgroundActivityRegistry.ts). */
export class TaskEventBus {
  private readonly allSubscribers = new Set<TaskEventSubscriber>()
  private readonly runSubscribers = new Map<string, Set<TaskEventSubscriber>>()
  private readonly taskSubscribers = new Map<string, Set<TaskEventSubscriber>>()
  /** Tracks which runId belongs to which taskId so run-scoped events (which only carry a runId) can still be routed to per-task subscribers. */
  private readonly runToTaskId = new Map<string, string>()

  emit(event: TaskEvent): void {
    if (event.type === 'task_started') {
      this.runToTaskId.set(event.runId, event.taskId)
    }

    this.allSubscribers.forEach((cb) => cb(event))

    const runId = 'runId' in event ? event.runId : undefined
    if (runId != null) {
      this.runSubscribers.get(runId)?.forEach((cb) => cb(event))
    }

    if (event.type === 'tasks_batch_updated') {
      for (const taskId of event.taskIds) {
        this.taskSubscribers.get(taskId)?.forEach((cb) => cb(event))
      }
    } else {
      const taskId = this.resolveTaskId(event)
      if (taskId != null) {
        this.taskSubscribers.get(taskId)?.forEach((cb) => cb(event))
      }
    }

    if (
      event.type === 'task_completed' ||
      event.type === 'task_failed' ||
      event.type === 'task_timed_out' ||
      event.type === 'task_cancelled'
    ) {
      this.runToTaskId.delete(event.runId)
    }
  }

  subscribeAll(callback: TaskEventSubscriber): () => void {
    this.allSubscribers.add(callback)
    return () => {
      this.allSubscribers.delete(callback)
    }
  }

  subscribeToTaskRun(runId: string, callback: TaskEventSubscriber): () => void {
    const set = this.runSubscribers.get(runId) ?? new Set()
    set.add(callback)
    this.runSubscribers.set(runId, set)
    return () => {
      set.delete(callback)
      if (set.size === 0) this.runSubscribers.delete(runId)
    }
  }

  subscribeToTask(taskId: string, callback: TaskEventSubscriber): () => void {
    const set = this.taskSubscribers.get(taskId) ?? new Set()
    set.add(callback)
    this.taskSubscribers.set(taskId, set)
    return () => {
      set.delete(callback)
      if (set.size === 0) this.taskSubscribers.delete(taskId)
    }
  }

  private resolveTaskId(event: TaskEvent): string | undefined {
    // retry_scheduled must route by its explicit taskId: it is emitted after
    // the failed run's terminal event, which already deleted the runToTaskId
    // mapping — relying on it would silently drop per-task subscribers.
    if (
      event.type === 'task_started' ||
      event.type === 'scheduled' ||
      event.type === 'retry_scheduled'
    )
      return event.taskId
    if ('runId' in event) return this.runToTaskId.get(event.runId)
    return undefined
  }
}
