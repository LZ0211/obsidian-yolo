import { App, Notice } from 'obsidian'
import { useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { describeSchedule } from '../../core/scheduler/cron-parser'
import type { ScheduledTask } from '../../core/scheduler/scheduledTasksStore'
import YoloPlugin from '../../main'
import { ObsidianButton } from '../common/ObsidianButton'
import { ConfirmModal } from '../modals/ConfirmModal'

import { EditScheduledTaskModal } from './TaskEditorModal'
import { TaskRunsHistoryModal } from './TaskRunsHistory'
import { getTaskStatusIcon } from './taskStatusIcons'

type ScheduledTaskCardProps = {
  app: App
  plugin: YoloPlugin
  task: ScheduledTask
  isExecuting: boolean
  onChanged: () => void
}

export function ScheduledTaskCard({
  app,
  plugin,
  task,
  isExecuting,
  onChanged,
}: ScheduledTaskCardProps) {
  const { t } = useLanguage()
  const [busy, setBusy] = useState(false)

  const service = plugin.getScheduledTasksService()

  const handleRunNow = () => {
    if (!service) return
    setBusy(true)
    void service
      .executeTaskNow(task.id)
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
      .finally(() => {
        setBusy(false)
        onChanged()
      })
  }

  const handleToggleEnabled = () => {
    if (!service) return
    void service.toggleTasks([task.id], !task.enabled).then(onChanged)
  }

  const handleDelete = () => {
    new ConfirmModal(app, {
      title: t(
        'settings.scheduledTasks.deleteTaskTitle',
        'Delete scheduled task',
      ),
      message: t(
        'settings.scheduledTasks.deleteTaskMessage',
        'Remove "{name}"? This cannot be undone.',
      ).replace('{name}', task.name),
      ctaText: t('common.delete', 'Delete'),
      onConfirm: () => {
        if (!service) return
        void service.deleteTask(task.id).then(onChanged)
      },
    }).open()
  }

  return (
    <div className="setting-item yolo-settings-card">
      <div className="setting-item-info">
        <div
          className="setting-item-name"
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          {getTaskStatusIcon(task, isExecuting)}
          {task.name}
        </div>
        <div className="setting-item-description">
          {describeSchedule(task, t)}
          {task.lastRunAt
            ? ` · ${t('settings.scheduledTasks.lastRun', 'Last run')}: ${new Date(
                task.lastRunAt,
              ).toLocaleString()}`
            : ` · ${t('settings.scheduledTasks.neverRun', 'Never run')}`}
          {task.lastError ? ` · ${task.lastError}` : ''}
        </div>
      </div>
      <div className="setting-item-control yolo-item-control">
        <ObsidianButton
          text={t('settings.scheduledTasks.runNow', 'Run now')}
          onClick={handleRunNow}
          disabled={busy || isExecuting || !task.enabled}
        />
        <ObsidianButton
          text={t('settings.scheduledTasks.history', 'History')}
          onClick={() => new TaskRunsHistoryModal(app, plugin, task).open()}
        />
        <ObsidianButton
          text={t('common.edit', 'Edit')}
          onClick={() =>
            new EditScheduledTaskModal(app, plugin, task, onChanged).open()
          }
        />
        <ObsidianButton
          text={
            task.enabled
              ? t('settings.scheduledTasks.disable', 'Disable')
              : t('settings.scheduledTasks.enable', 'Enable')
          }
          onClick={handleToggleEnabled}
        />
        <ObsidianButton
          text={t('common.delete', 'Delete')}
          onClick={handleDelete}
        />
      </div>
    </div>
  )
}
