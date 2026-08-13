import { App, Notice } from 'obsidian'
import { useEffect, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { DEFAULT_ASSISTANT_ID } from '../../core/agent/default-assistant'
import { validateCronExpression } from '../../core/scheduler/cron-parser'
import type {
  ScheduleType,
  ScheduledTask,
  ScheduledTaskType,
  TaskConfig,
} from '../../core/scheduler/scheduledTasksStore'
import YoloPlugin from '../../main'
import { ObsidianButton } from '../common/ObsidianButton'
import { ObsidianDropdown } from '../common/ObsidianDropdown'
import { ObsidianSetting } from '../common/ObsidianSetting'
import { ObsidianTextArea } from '../common/ObsidianTextArea'
import { ObsidianTextInput } from '../common/ObsidianTextInput'
import { ObsidianToggle } from '../common/ObsidianToggle'
import { ReactModal } from '../common/ReactModal'

type TaskEditorModalComponentProps = {
  plugin: YoloPlugin
  task: ScheduledTask | null // null when creating a new task
  onSaved?: () => void
}

const USE_DEFAULT_ASSISTANT_VALUE = ''

function createDefaultTaskConfig(): TaskConfig {
  return {
    name: '',
    type: 'agent',
    createdBy: 'user',
    scheduleType: 'interval',
    cronExpression: null,
    intervalSeconds: 3600,
    oneTimeDateTime: null,
    nextRunTime: null,
    scriptPath: null,
    agentPrompt: '',
    agentConfig: null,
    queueGroup: null,
    dependsOn: null,
    continueOnDependencyFailure: false,
    priority: 5,
    timeoutSeconds: 300,
    maxRetries: 3,
    enabled: true,
    notifyOn: [],
  }
}

function taskToConfig(task: ScheduledTask): TaskConfig {
  const {
    id: _id,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    lastRunAt: _lastRunAt,
    lastRunStatus: _lastRunStatus,
    lastError: _lastError,
    ...config
  } = task
  return config
}

function toDatetimeLocalValue(ms: number | null): string {
  if (!ms) return ''
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromDatetimeLocalValue(value: string): number | null {
  if (!value) return null
  const ms = new Date(value).getTime()
  return Number.isNaN(ms) ? null : ms
}

export class AddScheduledTaskModal extends ReactModal<TaskEditorModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin, onSaved?: () => void) {
    super({
      app,
      Component: TaskEditorModalComponent,
      props: { plugin, task: null, onSaved },
      options: {
        title: plugin.t(
          'settings.scheduledTasks.addTaskTitle',
          'New scheduled task',
        ),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

export class EditScheduledTaskModal extends ReactModal<TaskEditorModalComponentProps> {
  constructor(
    app: App,
    plugin: YoloPlugin,
    task: ScheduledTask,
    onSaved?: () => void,
  ) {
    super({
      app,
      Component: TaskEditorModalComponent,
      props: { plugin, task, onSaved },
      options: {
        title: plugin
          .t(
            'settings.scheduledTasks.editTaskTitle',
            'Edit scheduled task: {name}',
          )
          .replace('{name}', task.name),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function TaskEditorModalComponent({
  plugin,
  task,
  onSaved,
  onClose,
}: TaskEditorModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const [formData, setFormData] = useState<TaskConfig>(
    task ? taskToConfig(task) : createDefaultTaskConfig(),
  )
  const [otherTasks, setOtherTasks] = useState<ScheduledTask[]>([])

  useEffect(() => {
    const service = plugin.getScheduledTasksService()
    if (!service) return
    void service
      .listTasks()
      .then((all) =>
        setOtherTasks(all.filter((other) => other.id !== task?.id)),
      )
  }, [plugin, task?.id])

  const assistantOptions: Record<string, string> = {
    [USE_DEFAULT_ASSISTANT_VALUE]: t(
      'settings.scheduledTasks.followCurrentAssistant',
      'Follow current default assistant',
    ),
    ...Object.fromEntries(
      plugin.settings.assistants.map((assistant) => [
        assistant.id,
        assistant.id === DEFAULT_ASSISTANT_ID
          ? t('settings.bots.defaultAssistant', 'Default')
          : assistant.name,
      ]),
    ),
  }

  const scheduleTypeOptions: Record<ScheduleType, string> = {
    interval: t('settings.scheduledTasks.scheduleInterval', 'Interval'),
    cron: t('settings.scheduledTasks.scheduleCron', 'Cron expression'),
    once: t('settings.scheduledTasks.scheduleOnce', 'Once'),
  }

  const taskTypeOptions: Record<ScheduledTaskType, string> = {
    agent: t('settings.scheduledTasks.typeAgent', 'Agent prompt'),
    script: t('settings.scheduledTasks.typeScript', 'Script'),
    ragIndex: t('settings.scheduledTasks.typeRagIndex', 'RAG index'),
    ragAutoUpdate: t(
      'settings.scheduledTasks.typeRagAutoUpdate',
      'RAG auto-update',
    ),
  }

  const handleSubmit = () => {
    const errors: string[] = []
    if (!formData.name.trim()) {
      errors.push(
        t('settings.scheduledTasks.errorNameRequired', 'Name is required'),
      )
    }
    if (formData.type === 'script') {
      if (!formData.scriptPath?.trim()) {
        errors.push(
          t(
            'settings.scheduledTasks.errorScriptPathRequired',
            'Script path is required',
          ),
        )
      }
    } else if (formData.type === 'agent' && !formData.agentPrompt?.trim()) {
      errors.push(
        t('settings.scheduledTasks.errorPromptRequired', 'Prompt is required'),
      )
    }
    if (formData.scheduleType === 'cron') {
      if (!formData.cronExpression?.trim()) {
        errors.push(
          t(
            'settings.scheduledTasks.errorCronRequired',
            'Cron expression is required',
          ),
        )
      } else {
        const cronError = validateCronExpression(formData.cronExpression)
        if (cronError) {
          errors.push(
            t(
              'settings.scheduledTasks.errorCronInvalid',
              'Invalid cron expression: {error}',
            ).replace('{error}', cronError),
          )
        }
      }
    } else if (formData.scheduleType === 'interval') {
      if (!formData.intervalSeconds || formData.intervalSeconds <= 0) {
        errors.push(
          t(
            'settings.scheduledTasks.errorIntervalRequired',
            'Interval must be greater than 0 seconds',
          ),
        )
      }
    } else if (formData.scheduleType === 'once') {
      if (!formData.oneTimeDateTime) {
        errors.push(
          t('settings.scheduledTasks.errorOnceRequired', 'Pick a run time'),
        )
      } else if (formData.oneTimeDateTime <= Date.now()) {
        // A past time would fire at the very next poll tick with no warning;
        // the catch-up pass deliberately skips 'once' schedules, so the run
        // would also be silently lost if the process was down at that moment.
        errors.push(
          t(
            'settings.scheduledTasks.errorOnceInPast',
            'The run time must be in the future',
          ),
        )
      }
    }
    if (formData.timeoutSeconds <= 0) {
      errors.push(
        t(
          'settings.scheduledTasks.errorTimeoutRequired',
          'Timeout must be greater than 0 seconds',
        ),
      )
    }

    if (errors.length > 0) {
      new Notice(errors.join('\n'))
      return
    }

    const execute = async () => {
      const service = plugin.getScheduledTasksService()
      if (!service) {
        new Notice(
          t(
            'settings.scheduledTasks.errorServiceUnavailable',
            'Scheduled tasks service is not available yet',
          ),
        )
        return
      }
      try {
        if (task) {
          await service.updateTask(task.id, formData)
        } else {
          await service.createTask(formData)
        }
        onSaved?.()
        onClose()
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error))
      }
    }
    void execute()
  }

  return (
    <div>
      <ObsidianSetting
        name={t('settings.scheduledTasks.fieldName', 'Name')}
        required
      >
        <ObsidianTextInput
          value={formData.name}
          placeholder={t(
            'settings.scheduledTasks.namePlaceholder',
            'Nightly summary',
          )}
          onChange={(value) =>
            setFormData((prev) => ({ ...prev, name: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.scheduledTasks.fieldEnabled', 'Enabled')}
      >
        <ObsidianToggle
          value={formData.enabled}
          onChange={(value) =>
            setFormData((prev) => ({ ...prev, enabled: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.scheduledTasks.fieldType', 'Task type')}
        desc={t(
          'settings.scheduledTasks.fieldTypeDesc',
          'What this task runs when it fires',
        )}
      >
        <ObsidianDropdown
          value={formData.type}
          options={taskTypeOptions}
          onChange={(value) =>
            setFormData((prev) => ({
              ...prev,
              type: value as ScheduledTaskType,
            }))
          }
        />
      </ObsidianSetting>

      {formData.type === 'agent' && (
        <>
          <ObsidianSetting
            name={t('settings.scheduledTasks.fieldAssistant', 'Assistant')}
            desc={t(
              'settings.scheduledTasks.fieldAssistantDesc',
              'Which assistant configuration to run this prompt against',
            )}
          >
            <ObsidianDropdown
              value={
                formData.agentConfig?.assistantId ?? USE_DEFAULT_ASSISTANT_VALUE
              }
              options={assistantOptions}
              onChange={(value) =>
                setFormData((prev) => ({
                  ...prev,
                  agentConfig:
                    value === USE_DEFAULT_ASSISTANT_VALUE
                      ? null
                      : { assistantId: value },
                }))
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.scheduledTasks.fieldPrompt', 'Prompt')}
            required
            desc={t(
              'settings.scheduledTasks.fieldPromptDesc',
              'The message sent to the assistant each time this task runs',
            )}
          >
            <ObsidianTextArea
              value={formData.agentPrompt ?? ''}
              placeholder={t(
                'settings.scheduledTasks.promptPlaceholder',
                'Summarize what happened today...',
              )}
              onChange={(value) =>
                setFormData((prev) => ({ ...prev, agentPrompt: value }))
              }
              autoResize
              maxAutoResizeHeight={200}
            />
          </ObsidianSetting>
        </>
      )}

      {formData.type === 'script' && (
        <ObsidianSetting
          name={t('settings.scheduledTasks.fieldScriptPath', 'Script path')}
          required
          desc={t(
            'settings.scheduledTasks.fieldScriptPathDesc',
            'Vault-relative path to a .js file to run in a worker thread (desktop only)',
          )}
        >
          <ObsidianTextInput
            value={formData.scriptPath ?? ''}
            placeholder={t(
              'settings.scheduledTasks.scriptPathPlaceholder',
              'scripts/run.js',
            )}
            onChange={(value) =>
              setFormData((prev) => ({ ...prev, scriptPath: value }))
            }
          />
        </ObsidianSetting>
      )}

      <ObsidianSetting
        name={t('settings.scheduledTasks.fieldSchedule', 'Schedule')}
      >
        <ObsidianDropdown
          value={formData.scheduleType}
          options={scheduleTypeOptions}
          onChange={(value) =>
            setFormData((prev) => ({
              ...prev,
              scheduleType: value as ScheduleType,
            }))
          }
        />
      </ObsidianSetting>

      {formData.scheduleType === 'interval' && (
        <ObsidianSetting
          name={t(
            'settings.scheduledTasks.fieldIntervalSeconds',
            'Interval (seconds)',
          )}
        >
          <ObsidianTextInput
            type="number"
            value={String(formData.intervalSeconds ?? '')}
            onChange={(value) =>
              setFormData((prev) => ({
                ...prev,
                intervalSeconds: Math.max(1, Number(value) || 0),
              }))
            }
          />
        </ObsidianSetting>
      )}

      {formData.scheduleType === 'cron' && (
        <>
          <ObsidianSetting
            name={t(
              'settings.scheduledTasks.fieldCronExpression',
              'Cron expression',
            )}
            desc={t(
              'settings.scheduledTasks.cronFormatHint',
              '* * * * * (minute hour day month weekday)',
            )}
          >
            <ObsidianTextInput
              value={formData.cronExpression ?? ''}
              placeholder={t(
                'settings.scheduledTasks.cronPlaceholder',
                '0 9 * * *',
              )}
              onChange={(value) =>
                setFormData((prev) => ({ ...prev, cronExpression: value }))
              }
            />
          </ObsidianSetting>
          <ObsidianSetting
            name={t('settings.scheduledTasks.fieldTimezone', 'Timezone')}
            desc={t(
              'settings.scheduledTasks.fieldTimezoneDesc',
              'IANA timezone such as Asia/Shanghai. Leave blank to use the host timezone.',
            )}
          >
            <ObsidianTextInput
              value={formData.timezone ?? ''}
              placeholder={t(
                'settings.scheduledTasks.timezonePlaceholder',
                'Asia/Shanghai',
              )}
              onChange={(value) =>
                setFormData((prev) => ({
                  ...prev,
                  timezone: value.trim() || null,
                }))
              }
            />
          </ObsidianSetting>
        </>
      )}

      {formData.scheduleType === 'once' && (
        <div className="setting-item">
          <div className="setting-item-info">
            <div className="setting-item-name">
              {t('settings.scheduledTasks.fieldRunAt', 'Run at')}
            </div>
          </div>
          <div className="setting-item-control">
            <input
              type="datetime-local"
              value={toDatetimeLocalValue(formData.oneTimeDateTime)}
              onChange={(e) =>
                setFormData((prev) => ({
                  ...prev,
                  oneTimeDateTime: fromDatetimeLocalValue(e.target.value),
                }))
              }
            />
          </div>
        </div>
      )}

      <ObsidianSetting
        name={t('settings.scheduledTasks.fieldPriority', 'Priority')}
        desc={t(
          'settings.scheduledTasks.fieldPriorityDesc',
          '1 (lowest) to 10 (highest); higher priority tasks run first when several are due',
        )}
      >
        <ObsidianTextInput
          type="number"
          value={String(formData.priority)}
          onChange={(value) =>
            setFormData((prev) => ({
              ...prev,
              priority: Math.min(10, Math.max(1, Number(value) || 1)),
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.scheduledTasks.fieldTimeout', 'Timeout (seconds)')}
      >
        <ObsidianTextInput
          type="number"
          value={String(formData.timeoutSeconds)}
          onChange={(value) =>
            setFormData((prev) => ({
              ...prev,
              timeoutSeconds: Math.max(1, Number(value) || 0),
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.scheduledTasks.fieldMaxRetries', 'Max retries')}
      >
        <ObsidianTextInput
          type="number"
          value={String(formData.maxRetries)}
          onChange={(value) =>
            setFormData((prev) => ({
              ...prev,
              maxRetries: Math.max(0, Number(value) || 0),
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.scheduledTasks.fieldQueueGroup', 'Queue group')}
        desc={t(
          'settings.scheduledTasks.fieldQueueGroupDesc',
          'Tasks sharing the same queue group never run concurrently with each other. Leave blank to only limit concurrency by the global queue policy.',
        )}
      >
        <ObsidianTextInput
          value={formData.queueGroup ?? ''}
          placeholder={t(
            'settings.scheduledTasks.queueGroupPlaceholder',
            'e.g. reports',
          )}
          onChange={(value) =>
            setFormData((prev) => ({ ...prev, queueGroup: value || null }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.scheduledTasks.fieldDependsOn', 'Depends on')}
        desc={t(
          'settings.scheduledTasks.fieldDependsOnDesc',
          'This task only runs once every selected task has finished in the same batch',
        )}
      >
        <div className="yolo-settings-desc">
          {otherTasks.length === 0
            ? t(
                'settings.scheduledTasks.noOtherTasks',
                'No other tasks to depend on yet.',
              )
            : otherTasks.map((other) => {
                const selected = formData.dependsOn?.includes(other.id) ?? false
                return (
                  <label
                    key={other.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '6px',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={selected}
                      onChange={(e) =>
                        setFormData((prev) => {
                          const current = prev.dependsOn ?? []
                          const next = e.target.checked
                            ? [...current, other.id]
                            : current.filter((id) => id !== other.id)
                          return {
                            ...prev,
                            dependsOn: next.length ? next : null,
                          }
                        })
                      }
                    />
                    {other.name}
                  </label>
                )
              })}
        </div>
      </ObsidianSetting>

      {(formData.dependsOn?.length ?? 0) > 0 && (
        <ObsidianSetting
          name={t(
            'settings.scheduledTasks.fieldContinueOnDependencyFailure',
            'Continue if a dependency fails',
          )}
          desc={t(
            'settings.scheduledTasks.fieldContinueOnDependencyFailureDesc',
            'When off (default), this task is permanently skipped if any dependency fails or times out',
          )}
        >
          <ObsidianToggle
            value={formData.continueOnDependencyFailure}
            onChange={(value) =>
              setFormData((prev) => ({
                ...prev,
                continueOnDependencyFailure: value,
              }))
            }
          />
        </ObsidianSetting>
      )}

      <ObsidianSetting>
        <ObsidianButton
          cta
          text={task ? t('common.save', 'Save') : t('common.create', 'Create')}
          onClick={handleSubmit}
        />
        <ObsidianButton text={t('common.cancel', 'Cancel')} onClick={onClose} />
      </ObsidianSetting>
    </div>
  )
}
