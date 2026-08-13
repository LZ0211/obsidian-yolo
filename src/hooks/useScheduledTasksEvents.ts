// 订阅定时任务事件的 React hook：初始快照 + 事件驱动刷新，仿 useLiveTaskStream.ts 的
// useState/useEffect subscribe-cleanup 结构。定时任务事件频率低，不需要节流。

import { useCallback, useEffect, useState } from 'react'

import type {
  IScheduledTasksService,
  QueueStatus,
} from '../core/scheduled-tasks-service'
import type {
  ScheduledTask,
  TaskRunRuntimeState,
} from '../core/scheduler/scheduledTasksStore'
import type { TaskQueueItem } from '../core/scheduler/task-queue'

export function useScheduledTasks(service: IScheduledTasksService | null): {
  tasks: ScheduledTask[]
  executingTaskIds: Set<string>
  reload: () => void
} {
  const [tasks, setTasks] = useState<ScheduledTask[]>([])
  const [executingTaskIds, setExecutingTaskIds] = useState<Set<string>>(
    () => new Set(),
  )

  const reload = useCallback(() => {
    if (!service) {
      setTasks([])
      setExecutingTaskIds(new Set())
      return
    }
    void service.listTasks().then(setTasks)
    setExecutingTaskIds(
      new Set(service.getExecutingTasks().map((run) => run.taskId)),
    )
  }, [service])

  useEffect(() => {
    reload()
    if (!service) {
      return
    }
    return service.subscribeToAllTaskEvents(() => reload())
  }, [service, reload])

  return { tasks, executingTaskIds, reload }
}

/**
 * Per-task retry visibility for the task card: tracks the latest
 * `retry_scheduled` event for the task and ticks a 1s clock so the card can
 * render "Retry #N in Xs" (the countdown) and fresh relative timestamps. The
 * retry state is cleared as soon as any run event for the task fires (the
 * retry started, or the task otherwise moved on).
 */
export function useTaskRetryInfo(
  service: IScheduledTasksService | null,
  taskId: string,
): {
  retry: { attempt: number; nextAttemptAtMs: number } | null
  /** Re-armed each time a retry becomes pending; the card derives the countdown from it. */
  now: number
} {
  const [retry, setRetry] = useState<{
    attempt: number
    nextAttemptAtMs: number
  } | null>(null)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    setRetry(null)
    if (!service) return
    return service.subscribeToTask(taskId, (event) => {
      if (event.type === 'retry_scheduled') {
        setRetry({
          attempt: event.attempt,
          nextAttemptAtMs: event.nextAttemptAtMs,
        })
      } else if (
        event.type === 'task_started' ||
        event.type === 'task_completed' ||
        event.type === 'task_failed' ||
        event.type === 'task_timed_out' ||
        event.type === 'task_cancelled'
      ) {
        setRetry(null)
      }
    })
  }, [service, taskId])

  // Always-on 1s tick: keeps both the retry countdown ("in Xs") and the
  // card's relative timestamps (last run) fresh while the card is mounted.
  useEffect(() => {
    setNow(Date.now())
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  return { retry, now }
}

/** Same subscribe-cleanup shape as `useScheduledTasks`, for the queue monitor's status/pending/executing snapshot. */
export function useTaskQueueStatus(service: IScheduledTasksService | null): {
  status: QueueStatus | null
  pending: TaskQueueItem[]
  executing: TaskRunRuntimeState[]
  reload: () => void
} {
  const [status, setStatus] = useState<QueueStatus | null>(null)
  const [pending, setPending] = useState<TaskQueueItem[]>([])
  const [executing, setExecuting] = useState<TaskRunRuntimeState[]>([])

  const reload = useCallback(() => {
    if (!service) {
      setStatus(null)
      setPending([])
      setExecuting([])
      return
    }
    setStatus(service.getQueueStatus())
    setPending(service.getPendingTasks())
    setExecuting(service.getExecutingTasks())
  }, [service])

  useEffect(() => {
    reload()
    if (!service) {
      return
    }
    return service.subscribeToAllTaskEvents(() => reload())
  }, [service, reload])

  return { status, pending, executing, reload }
}
