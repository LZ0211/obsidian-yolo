import { App, Menu, Notice } from 'obsidian'
import { useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { describeSchedule } from '../../core/scheduler/cron-parser'
import type { ScheduledTask } from '../../core/scheduler/scheduledTasksStore'
import { useTaskRetryInfo } from '../../hooks/useScheduledTasksEvents'
import YoloPlugin from '../../main'
import { formatRelativeTime } from '../../utils/common/relative-time'
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

const pad2 = (n: number): string => String(n).padStart(2, '0')

export function ScheduledTaskCard({
  app,
  plugin,
  task,
  isExecuting,
  onChanged,
}: ScheduledTaskCardProps) {
  const { t, language } = useLanguage()
  const [busy, setBusy] = useState(false)
  const menuButtonRef = useRef<HTMLDivElement>(null)

  const service = plugin.getScheduledTasksService()
  const { retry, now } = useTaskRetryInfo(service, task.id)

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
    const runningWarning = isExecuting
      ? t(
          'settings.scheduledTasks.deleteTaskRunningWarning',
          'This task is currently executing. Deleting it will cancel the current run.',
        )
      : ''
    new ConfirmModal(app, {
      title: t(
        'settings.scheduledTasks.deleteTaskTitle',
        'Delete scheduled task',
      ),
      message: runningWarning
        ? `${runningWarning}\n\n${t(
            'settings.scheduledTasks.deleteTaskMessage',
            'Remove "{name}"? This cannot be undone.',
          ).replace('{name}', task.name)}`
        : t(
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

  const openMenu = () => {
    const menu = new Menu()
    menu.addItem((item) =>
      item
        .setTitle(t('settings.scheduledTasks.history', 'History'))
        .setIcon('history')
        .onClick(() => new TaskRunsHistoryModal(app, plugin, task).open()),
    )
    menu.addItem((item) =>
      item
        .setTitle(
          task.enabled
            ? t('settings.scheduledTasks.disable', 'Disable')
            : t('settings.scheduledTasks.enable', 'Enable'),
        )
        .setIcon(task.enabled ? 'toggle-left' : 'toggle-right')
        .onClick(handleToggleEnabled),
    )
    menu.addItem((item) => {
      item.setTitle(t('common.delete', 'Delete')).setIcon('trash')
      // Obsidian's runtime MenuItem supports setWarning(); the bundled d.ts
      // predates it, so the method is asserted through a local interface.
      ;(item as unknown as { setWarning(): unknown }).setWarning()
      item.onClick(handleDelete)
    })
    const rect = menuButtonRef.current?.getBoundingClientRect()
    if (rect) {
      menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 })
    } else {
      menu.showAtMouseEvent(
        new MouseEvent('click', {
          clientX: window.innerWidth / 2,
          clientY: window.innerHeight / 2,
        }),
      )
    }
  }

  // "下次：今天 09:00" / "Next: Today at 09:00" — local time, hour/minute
  // precision on the card; the absolute timestamp rides along as the title.
  const formatNextRunTime = (ms: number): string => {
    const d = new Date(ms)
    const today = new Date(now)
    const time = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate()
    if (sameDay) {
      return t(
        'settings.scheduledTasks.nextRunTodayAt',
        'Today at {time}',
      ).replace('{time}', time)
    }
    return t('settings.scheduledTasks.nextRunAt', 'Next: {time}').replace(
      '{time}',
      `${d.getMonth() + 1}/${d.getDate()} ${time}`,
    )
  }

  const retrySecondsLeft =
    retry != null ? Math.ceil((retry.nextAttemptAtMs - now) / 1000) : null
  const showRetry =
    retry != null && retrySecondsLeft != null && retrySecondsLeft > 0

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
          {describeSchedule(task, t, language)}
          {task.lastRunAt
            ? ` · ${t('settings.scheduledTasks.lastRun', 'Last run')}: ${formatRelativeTime(task.lastRunAt, now, t)}`
            : ` · ${t('settings.scheduledTasks.neverRun', 'Never run')}`}
        </div>
        {showRetry && (
          <div className="setting-item-description">
            {t(
              'settings.scheduledTasks.retryInSeconds',
              'Retry #{attempt} in {seconds}s',
            )
              .replace('{attempt}', String(retry!.attempt))
              .replace('{seconds}', String(retrySecondsLeft))}
          </div>
        )}
        {task.nextRunTime != null && task.enabled && (
          <div
            className="setting-item-description"
            title={new Date(task.nextRunTime).toLocaleString()}
          >
            {formatNextRunTime(task.nextRunTime)}
          </div>
        )}
        {task.lastError && (
          <div
            className="yolo-scheduled-task-error"
            title={task.lastError}
            ref={(el) => {
              if (el) el.setCssProps({ cursor: 'help' })
            }}
          >
            {task.lastError}
          </div>
        )}
      </div>
      <div className="setting-item-control yolo-item-control">
        <ObsidianButton
          text={t('settings.scheduledTasks.runNow', 'Run now')}
          onClick={handleRunNow}
          disabled={busy || isExecuting || !task.enabled}
        />
        <ObsidianButton
          text={t('common.edit', 'Edit')}
          onClick={() =>
            new EditScheduledTaskModal(app, plugin, task, onChanged).open()
          }
        />
        <div ref={menuButtonRef}>
          <ObsidianButton
            icon="more-horizontal"
            tooltip={t('settings.scheduledTasks.moreActions', 'More actions')}
            onClick={openMenu}
          />
        </div>
      </div>
    </div>
  )
}
