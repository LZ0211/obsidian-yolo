export type TaskEvent =
  | { type: 'task_started'; taskId: string; runId: string }
  | { type: 'task_completed'; runId: string; result: string }
  | { type: 'task_failed'; runId: string; error: string }
  | { type: 'task_timed_out'; runId: string }
  | { type: 'task_cancelled'; runId: string }
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
  | {
      // Emitted after queue-control operations (pause/resume/clear/priority
      // bump) that change queue state without starting or ending any run —
      // UI queue monitors refresh on this event, otherwise they would show
      // stale state until an unrelated task event happens to fire.
      type: 'queue_changed'
    }

type TaskEventSubscriber = (event: TaskEvent) => void

export type TaskEventChannel = {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void
  postMessage(message: unknown): void
  close(): void
}

export type TaskEventBusOptions = {
  channel?: TaskEventChannel | null
  channelName?: string
}

const isTaskEvent = (value: unknown): value is TaskEvent => {
  if (typeof value !== 'object' || value === null) return false
  const event = value as Record<string, unknown>
  if (typeof event.type !== 'string') return false
  if (event.type === 'queue_changed') return true
  if (event.type === 'tasks_batch_updated') {
    return (
      Array.isArray(event.taskIds) &&
      event.taskIds.every((taskId) => typeof taskId === 'string')
    )
  }
  if (event.type === 'task_started' || event.type === 'retry_scheduled') {
    return typeof event.taskId === 'string' && typeof event.runId === 'string'
  }
  if (
    event.type === 'task_completed' ||
    event.type === 'task_failed' ||
    event.type === 'task_timed_out' ||
    event.type === 'task_cancelled'
  ) {
    return typeof event.runId === 'string'
  }
  return false
}

/** Same subscribe/emit shape as BackgroundActivityRegistry (src/core/background/backgroundActivityRegistry.ts). */
export class TaskEventBus {
  private readonly allSubscribers = new Set<TaskEventSubscriber>()
  private readonly runSubscribers = new Map<string, Set<TaskEventSubscriber>>()
  private readonly taskSubscribers = new Map<string, Set<TaskEventSubscriber>>()
  /** Tracks which runId belongs to which taskId so run-scoped events (which only carry a runId) can still be routed to per-task subscribers. */
  private readonly runToTaskId = new Map<string, string>()
  private readonly channel: TaskEventChannel | null
  private disposed = false

  private readonly handleChannelMessage = (event: MessageEvent<unknown>) => {
    if (this.disposed || !isTaskEvent(event.data)) return
    this.dispatch(event.data)
  }

  constructor(options: TaskEventBusOptions = {}) {
    if (options.channel !== undefined) {
      this.channel = options.channel
    } else if (
      options.channelName &&
      typeof globalThis.BroadcastChannel === 'function'
    ) {
      this.channel = new globalThis.BroadcastChannel(
        options.channelName,
      ) as unknown as TaskEventChannel
    } else {
      this.channel = null
    }
    this.channel?.addEventListener('message', this.handleChannelMessage)
  }

  emit(event: TaskEvent): void {
    if (this.disposed) return
    this.dispatch(event)
    this.channel?.postMessage(event)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.channel?.removeEventListener('message', this.handleChannelMessage)
    this.channel?.close()
    this.allSubscribers.clear()
    this.runSubscribers.clear()
    this.taskSubscribers.clear()
    this.runToTaskId.clear()
  }

  private dispatch(event: TaskEvent): void {
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
    if (this.disposed) return () => undefined
    this.allSubscribers.add(callback)
    return () => {
      this.allSubscribers.delete(callback)
    }
  }

  subscribeToTaskRun(runId: string, callback: TaskEventSubscriber): () => void {
    if (this.disposed) return () => undefined
    const set = this.runSubscribers.get(runId) ?? new Set()
    set.add(callback)
    this.runSubscribers.set(runId, set)
    return () => {
      set.delete(callback)
      if (set.size === 0) this.runSubscribers.delete(runId)
    }
  }

  subscribeToTask(taskId: string, callback: TaskEventSubscriber): () => void {
    if (this.disposed) return () => undefined
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
    if (event.type === 'task_started' || event.type === 'retry_scheduled')
      return event.taskId
    if ('runId' in event) return this.runToTaskId.get(event.runId)
    return undefined
  }
}
