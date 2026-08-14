import { App } from 'obsidian'
import { useCallback, useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  type ScheduledTask,
  type TaskRun,
  TaskRunStatus,
  type TaskStatistics,
  type TaskTriggeredBy,
} from '../../core/scheduler/scheduledTasksStore'
import { useScheduledTasks } from '../../hooks/useScheduledTasksEvents'
import YoloPlugin from '../../main'
import { formatRelativeTime } from '../../utils/common/relative-time'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianDropdown } from '../common/ObsidianDropdown'
import { ObsidianSetting } from '../common/ObsidianSetting'
import { ReactModal } from '../common/ReactModal'

import { TaskRunDetailsModal } from './TaskRunDetailsModal'
import { getStatusIcon } from './taskStatusIcons'

type TaskRunsHistoryComponentProps = {
  app: App
  plugin: YoloPlugin
  task: ScheduledTask
}

export class TaskRunsHistoryModal extends ReactModal<TaskRunsHistoryComponentProps> {
  constructor(app: App, plugin: YoloPlugin, task: ScheduledTask) {
    super({
      app,
      Component: TaskRunsHistoryComponent,
      props: { app, plugin, task },
      options: {
        title: plugin
          .t('settings.scheduledTasks.historyTitle', 'Run history: {name}')
          .replace('{name}', task.name),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

const RUNS_PAGE_SIZE = 10

const FILTER_ALL = 'all'

function TaskRunsHistoryComponent({
  app,
  plugin,
  task,
}: TaskRunsHistoryComponentProps) {
  const { t } = useLanguage()
  const service = plugin.getScheduledTasksService()
  const [filter, setFilter] = useState<string>(FILTER_ALL)
  const [page, setPage] = useState(0)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [total, setTotal] = useState(0)
  const [stats, setStats] = useState<TaskStatistics | null>(null)
  // Guards against a slow earlier response overwriting the state of a newer
  // page/filter: only the response for the latest request is applied.
  const loadSeq = useRef(0)

  const load = useCallback(() => {
    if (!service) return
    const seq = ++loadSeq.current
    void service
      .listTaskRuns(task.id, {
        filter: filter === FILTER_ALL ? undefined : (filter as TaskRunStatus),
        limit: RUNS_PAGE_SIZE,
        offset: page * RUNS_PAGE_SIZE,
      })
      .then((result) => {
        if (seq !== loadSeq.current) return
        setRuns(result.runs)
        setTotal(result.total)
      })
    void service.getTaskStatistics(task.id).then((nextStats) => {
      if (seq !== loadSeq.current) return
      setStats(nextStats)
    })
  }, [service, task.id, filter, page])

  useEffect(() => {
    load()
    if (!service) return
    return service.subscribeToTask(task.id, () => load())
  }, [service, task.id, load])

  const filterOptions: Record<string, string> = {
    [FILTER_ALL]: t('settings.scheduledTasks.filterAll', 'All'),
    [TaskRunStatus.PENDING]: t(
      'settings.scheduledTasks.filterPending',
      'Pending',
    ),
    [TaskRunStatus.RUNNING]: t(
      'settings.scheduledTasks.filterRunning',
      'Running',
    ),
    [TaskRunStatus.COMPLETED]: t(
      'settings.scheduledTasks.filterCompleted',
      'Completed',
    ),
    [TaskRunStatus.FAILED]: t('settings.scheduledTasks.filterFailed', 'Failed'),
    [TaskRunStatus.CANCELLED]: t(
      'settings.scheduledTasks.filterCancelled',
      'Cancelled',
    ),
    [TaskRunStatus.TIMED_OUT]: t(
      'settings.scheduledTasks.filterTimedOut',
      'Timed out',
    ),
  }

  const triggeredByLabels: Record<TaskTriggeredBy, string> = {
    schedule: t('settings.scheduledTasks.runTriggeredBySchedule', 'Schedule'),
    manual: t('settings.scheduledTasks.runTriggeredByManual', 'Manual'),
    agent: t('settings.scheduledTasks.runTriggeredByAgent', 'Agent'),
    retry: t('settings.scheduledTasks.runTriggeredByRetry', 'Retry'),
  }

  const totalPages = Math.max(1, Math.ceil(total / RUNS_PAGE_SIZE))

  if (!service) {
    return (
      <div>
        {t(
          'settings.scheduledTasks.errorServiceUnavailable',
          'Scheduled tasks service is not available yet',
        )}
      </div>
    )
  }

  return (
    <div>
      {stats && (
        <div className="setting-item-description" style={{ marginBottom: 12 }}>
          {t('settings.scheduledTasks.statsTotal', 'Total runs')}:{' '}
          {stats.totalRuns} ·{' '}
          {t('settings.scheduledTasks.statsSuccess', 'Success')}:{' '}
          {stats.successCount} ·{' '}
          {t('settings.scheduledTasks.statsFailure', 'Failure')}:{' '}
          {stats.failureCount} ·{' '}
          {t('settings.scheduledTasks.statsSuccessRate', 'Success rate')}:{' '}
          {stats.successRate}% ·{' '}
          {t('settings.scheduledTasks.statsAvgDuration', 'Avg duration')}:{' '}
          {stats.averageDurationMs != null
            ? `${Math.round(stats.averageDurationMs)}ms`
            : '-'}
        </div>
      )}

      <ObsidianSetting
        name={t('settings.scheduledTasks.filterLabel', 'Filter')}
      >
        <ObsidianDropdown
          value={filter}
          options={filterOptions}
          onChange={(value) => {
            setFilter(value)
            setPage(0)
          }}
        />
      </ObsidianSetting>

      {runs.length === 0 && (
        <div className="yolo-settings-desc">
          {t('settings.scheduledTasks.noRuns', 'No runs yet.')}
        </div>
      )}

      {runs.map((run) => (
        <div
          className="setting-item yolo-settings-card"
          key={run.id}
          onClick={() =>
            new TaskRunDetailsModal(app, plugin, run.id, task.name).open()
          }
          ref={(el) => {
            if (el) el.setCssProps({ cursor: 'pointer' })
          }}
        >
          <div className="setting-item-info">
            <div
              className="setting-item-name"
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              title={new Date(run.scheduledFor).toLocaleString()}
            >
              {getStatusIcon(run.status)}
              {formatRelativeTime(run.scheduledFor, Date.now(), t)}
            </div>
            <div className="setting-item-description">
              {triggeredByLabels[run.triggeredBy]}
              {run.durationMs != null ? ` · ${run.durationMs}ms` : ''}
              {run.error ? ` · ${run.error}` : ''}
            </div>
          </div>
        </div>
      ))}

      {total > RUNS_PAGE_SIZE && (
        <div
          className="setting-item-control"
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 8,
          }}
        >
          <ObsidianButton
            text={t('common.previous', 'Previous')}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          />
          <span className="setting-item-description">
            {page + 1} / {totalPages}
          </span>
          <ObsidianButton
            text={t('common.next', 'Next')}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page + 1 >= totalPages}
          />
        </div>
      )}
    </div>
  )
}

// ---- All runs (across every task) ----

type AllRunsHistoryComponentProps = {
  app: App
  plugin: YoloPlugin
}

export class AllRunsHistoryModal extends ReactModal<AllRunsHistoryComponentProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: AllRunsHistoryComponent,
      props: { app, plugin },
      options: {
        title: plugin.t(
          'settings.scheduledTasks.allRunsHistoryTitle',
          'All runs',
        ),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function AllRunsHistoryComponent({
  app,
  plugin,
}: AllRunsHistoryComponentProps) {
  const { t } = useLanguage()
  const service = plugin.getScheduledTasksService()
  const { tasks } = useScheduledTasks(service)
  const [filter, setFilter] = useState<string>(FILTER_ALL)
  const [page, setPage] = useState(0)
  const [runs, setRuns] = useState<TaskRun[]>([])
  const [total, setTotal] = useState(0)
  const loadSeq = useRef(0)

  const taskNameById = useCallback(
    () => new Map(tasks.map((task) => [task.id, task.name])),
    [tasks],
  )

  const load = useCallback(() => {
    if (!service) return
    const seq = ++loadSeq.current
    void service
      .listAllRuns({
        filter: filter === FILTER_ALL ? undefined : (filter as TaskRunStatus),
        limit: RUNS_PAGE_SIZE,
        offset: page * RUNS_PAGE_SIZE,
      })
      .then((result) => {
        if (seq !== loadSeq.current) return
        setRuns(result.runs)
        setTotal(result.total)
      })
  }, [service, filter, page])

  useEffect(() => {
    load()
    if (!service) return
    return service.subscribeToAllTaskEvents(() => load())
  }, [service, load])

  const filterOptions: Record<string, string> = {
    [FILTER_ALL]: t('settings.scheduledTasks.filterAll', 'All'),
    [TaskRunStatus.PENDING]: t(
      'settings.scheduledTasks.filterPending',
      'Pending',
    ),
    [TaskRunStatus.RUNNING]: t(
      'settings.scheduledTasks.filterRunning',
      'Running',
    ),
    [TaskRunStatus.COMPLETED]: t(
      'settings.scheduledTasks.filterCompleted',
      'Completed',
    ),
    [TaskRunStatus.FAILED]: t('settings.scheduledTasks.filterFailed', 'Failed'),
    [TaskRunStatus.CANCELLED]: t(
      'settings.scheduledTasks.filterCancelled',
      'Cancelled',
    ),
    [TaskRunStatus.TIMED_OUT]: t(
      'settings.scheduledTasks.filterTimedOut',
      'Timed out',
    ),
  }

  const triggeredByLabels: Record<TaskTriggeredBy, string> = {
    schedule: t('settings.scheduledTasks.runTriggeredBySchedule', 'Schedule'),
    manual: t('settings.scheduledTasks.runTriggeredByManual', 'Manual'),
    agent: t('settings.scheduledTasks.runTriggeredByAgent', 'Agent'),
    retry: t('settings.scheduledTasks.runTriggeredByRetry', 'Retry'),
  }

  const totalPages = Math.max(1, Math.ceil(total / RUNS_PAGE_SIZE))
  const names = taskNameById()

  if (!service) {
    return (
      <div>
        {t(
          'settings.scheduledTasks.errorServiceUnavailable',
          'Scheduled tasks service is not available yet',
        )}
      </div>
    )
  }

  return (
    <div>
      <ObsidianSetting
        name={t('settings.scheduledTasks.filterLabel', 'Filter')}
      >
        <ObsidianDropdown
          value={filter}
          options={filterOptions}
          onChange={(value) => {
            setFilter(value)
            setPage(0)
          }}
        />
      </ObsidianSetting>

      {runs.length === 0 && (
        <div className="yolo-settings-desc">
          {t('settings.scheduledTasks.noRuns', 'No runs yet.')}
        </div>
      )}

      {runs.map((run) => (
        <div
          className="setting-item yolo-settings-card"
          key={run.id}
          onClick={() =>
            new TaskRunDetailsModal(
              app,
              plugin,
              run.id,
              names.get(run.taskId) ?? run.taskId,
            ).open()
          }
          ref={(el) => {
            if (el) el.setCssProps({ cursor: 'pointer' })
          }}
        >
          <div className="setting-item-info">
            <div
              className="setting-item-name"
              style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              title={new Date(run.scheduledFor).toLocaleString()}
            >
              {getStatusIcon(run.status)}
              {names.get(run.taskId) ?? run.taskId}
            </div>
            <div className="setting-item-description">
              {formatRelativeTime(run.scheduledFor, Date.now(), t)}
              {` · ${triggeredByLabels[run.triggeredBy]}`}
              {run.durationMs != null ? ` · ${run.durationMs}ms` : ''}
              {run.error ? ` · ${run.error}` : ''}
            </div>
          </div>
        </div>
      ))}

      {total > RUNS_PAGE_SIZE && (
        <div
          className="setting-item-control"
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            marginTop: 8,
          }}
        >
          <ObsidianButton
            text={t('common.previous', 'Previous')}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
          />
          <span className="setting-item-description">
            {page + 1} / {totalPages}
          </span>
          <ObsidianButton
            text={t('common.next', 'Next')}
            onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
            disabled={page + 1 >= totalPages}
          />
        </div>
      )}
    </div>
  )
}
