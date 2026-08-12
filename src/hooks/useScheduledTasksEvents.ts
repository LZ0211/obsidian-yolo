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
