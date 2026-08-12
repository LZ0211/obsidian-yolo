import { App, Notice } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import {
  type TaskRun,
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
  const service = plugin.getScheduledTasksService()
  const runRef = useRef(run)
  runRef.current = run

  useEffect(() => {
    if (!service) return
    let cancelled = false
    const load = () => {
      void service.getTaskRun(runId).then((next) => {
        if (!cancelled) setRun(next)
      })
    }
    load()

    const unsubscribe = service.subscribeToTaskRun(runId, () => load())

    // Only polls while the run hasn't reached a terminal state — event-driven updates via
    // subscribeToTaskRun cover the rest, this is just a safety net for the "running" gap.
    const interval = setInterval(() => {
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
    return <div>{t('common.loading', 'Loading...')}</div>
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
        <strong>{run.status}</strong>
      </div>
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
        {run.triggeredBy}
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
