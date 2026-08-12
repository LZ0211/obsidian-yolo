import {
  AlarmClockOff,
  Check,
  CircleSlash,
  Clock,
  Loader2,
  X,
} from 'lucide-react'

import {
  type ScheduledTask,
  TaskRunStatus,
} from '../../core/scheduler/scheduledTasksStore'

/** Icon for a single run's terminal/in-flight status. */
export function getStatusIcon(status: TaskRunStatus) {
  switch (status) {
    case TaskRunStatus.RUNNING:
      return <Loader2 size={14} className="yolo-spinner" />
    case TaskRunStatus.COMPLETED:
      return <Check size={14} />
    case TaskRunStatus.FAILED:
      return <X size={14} />
    case TaskRunStatus.CANCELLED:
      return <CircleSlash size={14} />
    case TaskRunStatus.TIMED_OUT:
      return <AlarmClockOff size={14} />
    case TaskRunStatus.PENDING:
      return <Clock size={14} />
  }
}

/**
 * Card-level status is a priority cascade, distinct from a single run's status: an executing task
 * always shows as running regardless of its last recorded run, a disabled task always shows as
 * disabled regardless of history, and only once both of those are ruled out does the last run's
 * outcome (or "never run") apply.
 */
export function getTaskStatusIcon(task: ScheduledTask, isExecuting: boolean) {
  if (isExecuting) return <Loader2 size={14} className="yolo-spinner" />
  if (!task.enabled) return <CircleSlash size={14} />
  if (task.lastRunStatus == null) return <Clock size={14} />
  return getStatusIcon(task.lastRunStatus)
}
