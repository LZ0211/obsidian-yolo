import { App } from 'obsidian'
import { useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { TaskRunStatus } from '../../core/scheduler/scheduledTasksStore'
import {
  useScheduledTasks,
  useTaskQueueStatus,
} from '../../hooks/useScheduledTasksEvents'
import YoloPlugin from '../../main'
import { ObsidianButton } from '../common/ObsidianButton'
import { ReactModal } from '../common/ReactModal'
import { ConfirmModal } from '../modals/ConfirmModal'

import { getStatusIcon } from './taskStatusIcons'

type TaskQueueMonitorComponentProps = {
  app: App
  plugin: YoloPlugin
}

export class TaskQueueMonitorModal extends ReactModal<TaskQueueMonitorComponentProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: TaskQueueMonitorComponent,
      props: { app, plugin },
      options: {
        title: plugin.t(
          'settings.scheduledTasks.queueMonitorTitle',
          'Task Queue Monitor',
        ),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function TaskQueueMonitorComponent({
  app,
  plugin,
}: TaskQueueMonitorComponentProps) {
  const { t } = useLanguage()
  const service = plugin.getScheduledTasksService()
  const { status, pending, executing } = useTaskQueueStatus(service)
  const { tasks } = useScheduledTasks(service)
  // 1s local tick so the executing "Elapsed" counters keep counting between
  // queue events (they are computed from Date.now() at render time, which
  // would otherwise freeze until the next event or poll).
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(interval)
  }, [])

  const taskNameById = useMemo(
    () => new Map(tasks.map((task) => [task.id, task.name])),
    [tasks],
  )

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

  const handleClearQueue = () => {
    new ConfirmModal(app, {
      title: t(
        'settings.scheduledTasks.clearQueueTitle',
        'Clear pending queue',
      ),
      message: t(
        'settings.scheduledTasks.clearQueueMessage',
        'Remove all pending (not yet executing) tasks from the queue? This cannot be undone.',
      ),
      ctaText: t('settings.scheduledTasks.clearQueue', 'Clear queue'),
      onConfirm: () => service.clearQueue(),
    }).open()
  }

  return (
    <div>
      {status && (
        <div className="setting-item-description" style={{ marginBottom: 12 }}>
          {t('settings.scheduledTasks.queueStatusPending', 'Pending')}:{' '}
          {status.pending} ·{' '}
          {t('settings.scheduledTasks.queueStatusExecuting', 'Executing')}:{' '}
          {status.executing} ·{' '}
          {t('settings.scheduledTasks.queueStatusCompleted', 'Completed')}:{' '}
          {status.completed} ·{' '}
          {t('settings.scheduledTasks.queueStatusFailed', 'Failed')}:{' '}
          {status.failed} ·{' '}
          {t('settings.scheduledTasks.queueMaxConcurrent', 'Max concurrent')}:{' '}
          {status.policy.maxConcurrent}
          {status.paused
            ? ` · ${t('settings.scheduledTasks.queuePaused', 'Paused')}`
            : ''}
        </div>
      )}

      <div
        className="setting-item-control yolo-item-control"
        style={{ marginBottom: 12 }}
      >
        <ObsidianButton
          text={t('settings.scheduledTasks.pauseQueue', 'Pause queue')}
          onClick={() => service.pauseQueue()}
          disabled={status?.paused}
        />
        <ObsidianButton
          text={t('settings.scheduledTasks.resumeQueue', 'Resume queue')}
          onClick={() => service.resumeQueue()}
          disabled={!status?.paused}
        />
        <ObsidianButton
          text={t('settings.scheduledTasks.clearQueue', 'Clear queue')}
          onClick={handleClearQueue}
          warning
          disabled={pending.length === 0}
        />
      </div>

      <div className="setting-item-name">
        {t('settings.scheduledTasks.queueExecutingSection', 'Executing')} (
        {executing.length})
      </div>
      {executing.length === 0 ? (
        <div className="yolo-settings-desc">
          {t(
            'settings.scheduledTasks.queueExecutingEmpty',
            'Nothing is executing right now.',
          )}
        </div>
      ) : (
        executing.map((run) => (
          <div className="setting-item yolo-settings-card" key={run.runId}>
            <div className="setting-item-info">
              <div
                className="setting-item-name"
                style={{ display: 'flex', alignItems: 'center', gap: 6 }}
              >
                {getStatusIcon(TaskRunStatus.RUNNING)}
                {taskNameById.get(run.taskId) ?? run.taskId}
              </div>
              <div className="setting-item-description">
                {run.startedAt
                  ? `${t('settings.scheduledTasks.queueElapsed', 'Elapsed')}: ${Math.round(
                      (now - run.startedAt) / 1000,
                    )}s`
                  : ''}
              </div>
            </div>
          </div>
        ))
      )}

      <div className="setting-item-name" style={{ marginTop: 12 }}>
        {t('settings.scheduledTasks.queuePendingSection', 'Pending queue')} (
        {pending.length})
      </div>
      {pending.length === 0 ? (
        <div className="yolo-settings-desc">
          {t(
            'settings.scheduledTasks.queuePendingEmpty',
            'No tasks are waiting in the queue.',
          )}
        </div>
      ) : (
        pending.map((item, index) => (
          <div
            className="setting-item yolo-settings-card"
            key={`${item.taskId}-${item.batchId}-${item.attempt}`}
          >
            <div className="setting-item-info">
              <div className="setting-item-name">
                #{index + 1} {taskNameById.get(item.taskId) ?? item.taskId}
              </div>
              <div className="setting-item-description">
                {t('settings.scheduledTasks.fieldPriority', 'Priority')}:{' '}
                {item.priority}
              </div>
            </div>
            <div className="setting-item-control">
              <ObsidianButton
                text={t(
                  'settings.scheduledTasks.queueBumpPriority',
                  'Move to front',
                )}
                tooltip={t(
                  'settings.scheduledTasks.queueBumpPriorityTooltip',
                  'Only affects the currently queued run. To change the task priority permanently, edit the task.',
                )}
                onClick={() => void service.promoteTaskToFront(item.taskId)}
                disabled={index === 0}
              />
            </div>
          </div>
        ))
      )}
    </div>
  )
}
