import { App } from 'obsidian'
import { useEffect, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { useSettings } from '../../contexts/settings-context'
import { useScheduledTasks } from '../../hooks/useScheduledTasksEvents'
import YoloPlugin from '../../main'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianSetting } from '../common/ObsidianSetting'
import { ObsidianToggle } from '../common/ObsidianToggle'
import { StringListInput } from '../settings/inputs/StringListInput'

import { ScheduledTaskCard } from './ScheduledTaskCard'
import { AddScheduledTaskModal } from './TaskEditorModal'
import { TaskQueueMonitorModal } from './TaskQueueMonitor'
import { AllRunsHistoryModal } from './TaskRunsHistory'

type ScheduledTasksPanelProps = {
  app: App
  plugin: YoloPlugin
}

export function ScheduledTasksPanel({ app, plugin }: ScheduledTasksPanelProps) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  // The service is built asynchronously on plugin load (dynamic import + store
  // open); if this panel mounts before that finishes, a plain getter read
  // would show the "unavailable" message forever with no way to re-render.
  const [service, setService] = useState(() =>
    plugin.getScheduledTasksService(),
  )
  const { tasks, executingTaskIds, reload } = useScheduledTasks(service)

  useEffect(() => {
    if (service) return
    const interval = setInterval(() => {
      const next = plugin.getScheduledTasksService()
      if (next) {
        setService(next)
        clearInterval(interval)
      }
    }, 500)
    return () => clearInterval(interval)
  }, [service, plugin])

  if (!service) {
    return (
      <div className="yolo-settings-desc">
        {t(
          'settings.scheduledTasks.serviceUnavailable',
          'Scheduled tasks are unavailable in this environment (requires a desktop vault).',
        )}
      </div>
    )
  }

  return (
    <div className="yolo-settings-section">
      <section className="yolo-settings-block">
        <div className="yolo-settings-block-head">
          <div className="yolo-settings-block-head-title-row">
            <div className="yolo-settings-sub-header yolo-settings-block-title">
              {t('settings.scheduledTasks.title', 'Scheduled Tasks')}
            </div>
            <div className="yolo-settings-desc yolo-settings-block-desc">
              {t(
                'settings.scheduledTasks.desc',
                'Run agent prompts automatically on a schedule, or trigger them manually.',
              )}
            </div>
          </div>
          <div className="yolo-settings-block-action">
            <ObsidianButton
              text={t(
                'settings.scheduledTasks.openQueueMonitor',
                'Queue Monitor',
              )}
              onClick={() => new TaskQueueMonitorModal(app, plugin).open()}
            />
            <ObsidianButton
              text={t('settings.scheduledTasks.allRunsHistory', 'All runs')}
              onClick={() => new AllRunsHistoryModal(app, plugin).open()}
            />
            <ObsidianButton
              cta
              text={t('settings.scheduledTasks.addTask', '+ Add Task')}
              onClick={() =>
                new AddScheduledTaskModal(app, plugin, reload).open()
              }
            />
          </div>
        </div>

        <div className="yolo-settings-block-content">
          <ObsidianSetting
            name={t(
              'settings.scheduledTasks.enableGlobal',
              'Enable Scheduled Tasks',
            )}
            desc={t(
              'settings.scheduledTasks.enableGlobalDesc',
              'Turn on the scheduler so interval/cron/one-time tasks run automatically. Manual "Run now" works either way.',
            )}
          >
            <ObsidianToggle
              value={settings.scheduledTasks.enabled}
              onChange={(value) =>
                void setSettings({
                  ...settings,
                  scheduledTasks: {
                    ...settings.scheduledTasks,
                    enabled: value,
                  },
                })
              }
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t(
              'settings.scheduledTasks.enableScriptExecution',
              'Allow script execution',
            )}
            desc={t(
              'settings.scheduledTasks.enableScriptExecutionDesc',
              'Allow script-type scheduled tasks to run vault-relative .js files in a worker thread. Leave off unless you need it.',
            )}
          >
            <ObsidianToggle
              value={settings.scheduledTasks.enableScriptExecution}
              onChange={(value) =>
                void setSettings({
                  ...settings,
                  scheduledTasks: {
                    ...settings.scheduledTasks,
                    enableScriptExecution: value,
                  },
                })
              }
            />
          </ObsidianSetting>
          {settings.scheduledTasks.enableScriptExecution && (
            <ObsidianSetting
              name={t(
                'settings.scheduledTasks.allowedScriptDirectories',
                'Allowed script directories',
              )}
              desc={t(
                'settings.scheduledTasks.allowedScriptDirectoriesDesc',
                'Vault-relative directories scripts are allowed to run from. Leave empty to allow the entire vault.',
              )}
            >
              <StringListInput
                value={settings.scheduledTasks.allowedScriptDirectories}
                onChange={(next) =>
                  void setSettings({
                    ...settings,
                    scheduledTasks: {
                      ...settings.scheduledTasks,
                      allowedScriptDirectories: next,
                    },
                  })
                }
                placeholder={t(
                  'settings.scheduledTasks.allowedScriptDirectoriesPlaceholder',
                  'scripts',
                )}
                addLabel={t('common.add', 'Add')}
                removeLabel={t('common.remove', 'Remove')}
              />
            </ObsidianSetting>
          )}
          {tasks.length === 0 && (
            <div className="yolo-settings-desc">
              {t(
                'settings.scheduledTasks.noTasks',
                'No scheduled tasks yet. Click "+ Add Task" to create your first one.',
              )}
            </div>
          )}
          {tasks.map((task) => (
            <ScheduledTaskCard
              key={task.id}
              app={app}
              plugin={plugin}
              task={task}
              isExecuting={executingTaskIds.has(task.id)}
              onChanged={reload}
            />
          ))}
        </div>
      </section>
    </div>
  )
}
