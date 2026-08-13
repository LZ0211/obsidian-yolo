import { App, Notice } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  type TaskRun,
  type TaskTriggeredBy,
  TaskRunStatus,
} from '../../core/scheduler/scheduledTasksStore'
import YoloPlugin from '../../main'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianSetting } from '../common/ObsidianSetting'
import { ReactModal } from '../common/ReactModal'

import { getStatusIcon } from './taskStatusIcons'

type TaskRunDetailsComponentProps = {
  plugin: YoloPlugin
  runId: string
  taskName: string
}

export class TaskRunDetailsModal extends ReactModal<TaskRunDetailsComponentProps> {
  constructor(app: App, plugin: YoloPlugin, runId: string, taskName: string) {
    super({
      app,
      Component: TaskRunDetailsComponent,
      props: { plugin, runId, taskName },
      options: {
        title: plugin
          .t('settings.scheduledTasks.runDetailsTitle', 'Run details: {name}')
          .replace('{name}', taskName),
      },
      plugin,
    })
  }
}

const POLL_MS = 2000

function TaskRunDetailsComponent({
  plugin,
  runId,
}: TaskRunDetailsComponentProps) {
  const { t } = useLanguage()
  const [run, setRun] = useState<TaskRun | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [retryInfo, setRetryInfo] = useState<{
    attempt: number
    nextAttemptAtMs: number
  } | null>(null)
  const service = plugin.getScheduledTasksService()
  const runRef = useRef(run)
  runRef.current = run
  const loadErrorRef = useRef(loadError)
  loadErrorRef.current = loadError

  useEffect(() => {
    if (!service) return
    let cancelled = false
    const load = () => {
      void service
        .getTaskRun(runId)
        .then((next) => {
          if (!cancelled) {
            setRun(next)
            setLoadError(null)
          }
        })
        .catch(() => {
          // The run may have been pruned by run-history retention after the
          // history list rendered — surface that instead of hanging on
          // "Loading..." forever with an unhandled rejection every poll.
          if (!cancelled) {
            setLoadError(
              t(
                'settings.scheduledTasks.runNotFound',
                'Run record not found (it may have been pruned by retention).',
              ),
            )
          }
        })
    }
    load()

    const unsubscribe = service.subscribeToTaskRun(runId, (event) => {
      if (event.type === 'retry_scheduled' && event.runId === runId) {
        setRetryInfo({
          attempt: event.attempt,
          nextAttemptAtMs: event.nextAttemptAtMs,
        })
      }
      load()
    })

    // Only polls while the run hasn't reached a terminal state (and never
    // after a load error) — event-driven updates via subscribeToTaskRun cover
    // the rest, this is just a safety net for the "running" gap.
    const interval = setInterval(() => {
      if (loadErrorRef.current) return
      const current = runRef.current
      if (
        !current ||
        current.status === TaskRunStatus.RUNNING ||
        current.status === TaskRunStatus.PENDING
      ) {
        load()
      }
    }, POLL_MS)

    return () => {
      cancelled = true
      unsubscribe()
      clearInterval(interval)
    }
  }, [service, runId])

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

  if (!run) {
    return <div>{loadError ?? t('common.loading', 'Loading...')}</div>
  }

  const canRetry = [
    TaskRunStatus.COMPLETED,
    TaskRunStatus.FAILED,
    TaskRunStatus.CANCELLED,
    TaskRunStatus.TIMED_OUT,
  ].includes(run.status)

  const handleRetry = () => {
    setRetrying(true)
    void service
      .executeTaskNow(run.taskId)
      .then((result) => {
        if (result.outcome === 'rejected') {
          const reasons: Record<string, string> = {
            task_not_found: t(
              'settings.scheduledTasks.runNowTaskNotFound',
              'Task not found',
            ),
            task_disabled: t(
              'settings.scheduledTasks.runNowTaskDisabled',
              'Task is disabled',
            ),
            already_queued: t(
              'settings.scheduledTasks.runNowAlreadyQueued',
              'Already queued or running',
            ),
          }
          new Notice(reasons[result.reason])
        }
      })
      .finally(() => setRetrying(false))
  }

  const statusLabels: Record<TaskRunStatus, string> = {
    [TaskRunStatus.PENDING]: t(
      'settings.scheduledTasks.runStatusPending',
      'Pending',
    ),
    [TaskRunStatus.RUNNING]: t(
      'settings.scheduledTasks.runStatusRunning',
      'Running',
    ),
    [TaskRunStatus.COMPLETED]: t(
      'settings.scheduledTasks.runStatusCompleted',
      'Completed',
    ),
    [TaskRunStatus.FAILED]: t(
      'settings.scheduledTasks.runStatusFailed',
      'Failed',
    ),
    [TaskRunStatus.CANCELLED]: t(
      'settings.scheduledTasks.runStatusCancelled',
      'Cancelled',
    ),
    [TaskRunStatus.TIMED_OUT]: t(
      'settings.scheduledTasks.runStatusTimedOut',
      'Timed out',
    ),
  }
  const triggeredByLabels: Record<TaskTriggeredBy, string> = {
    schedule: t('settings.scheduledTasks.runTriggeredBySchedule', 'Schedule'),
    manual: t('settings.scheduledTasks.runTriggeredByManual', 'Manual'),
    agent: t('settings.scheduledTasks.runTriggeredByAgent', 'Agent'),
    retry: t('settings.scheduledTasks.runTriggeredByRetry', 'Retry'),
  }

  return (
    <div className="yolo-prewrap">
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          marginBottom: 8,
        }}
      >
        {getStatusIcon(run.status)}
        <strong>{statusLabels[run.status]}</strong>
      </div>
      {retryInfo && (
        <div className="setting-item-description">
          {t(
            'settings.scheduledTasks.runRetryScheduled',
            'Retry #{attempt} scheduled at {time}',
          )
            .replace('{attempt}', String(retryInfo.attempt))
            .replace(
              '{time}',
              new Date(retryInfo.nextAttemptAtMs).toLocaleString(),
            )}
        </div>
      )}
      {canRetry && (
        <ObsidianSetting>
          <ObsidianButton
            text={t('settings.scheduledTasks.runRetry', 'Retry')}
            onClick={handleRetry}
            disabled={retrying}
          />
        </ObsidianSetting>
      )}
      <div>
        {t('settings.scheduledTasks.runTriggeredBy', 'Triggered by')}:{' '}
        {triggeredByLabels[run.triggeredBy]}
      </div>
      <div>
        {t('settings.scheduledTasks.runScheduledFor', 'Scheduled for')}:{' '}
        {new Date(run.scheduledFor).toLocaleString()}
      </div>
      {run.startedAt && (
        <div>
          {t('settings.scheduledTasks.runStartedAt', 'Started at')}:{' '}
          {new Date(run.startedAt).toLocaleString()}
        </div>
      )}
      {run.completedAt && (
        <div>
          {t('settings.scheduledTasks.runCompletedAt', 'Completed at')}:{' '}
          {new Date(run.completedAt).toLocaleString()}
          {run.durationMs != null ? ` (${run.durationMs}ms)` : ''}
        </div>
      )}
      <div>
        {t('settings.scheduledTasks.runAttempt', 'Attempt')}: {run.attempt}
      </div>
      {run.result && (
        <div>
          <div className="setting-item-name">
            {t('settings.scheduledTasks.runResult', 'Result')}
          </div>
          <div className="yolo-prewrap">{run.result}</div>
        </div>
      )}
      {run.error && (
        <div>
          <div className="setting-item-name">
            {t('settings.scheduledTasks.runError', 'Error')}
          </div>
          <div className="yolo-prewrap">{run.error}</div>
        </div>
      )}
      {run.logs && run.logs.length > 0 && (
        <div>
          <div className="setting-item-name">
            {t('settings.scheduledTasks.runLogs', 'Logs')}
          </div>
          {run.logs.map((entry, index) => (
            <div key={index}>
              [{new Date(entry.timestamp).toLocaleTimeString()}] {entry.level}:{' '}
              {entry.message}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
