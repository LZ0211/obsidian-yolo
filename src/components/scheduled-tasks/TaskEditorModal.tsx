import { App, Notice } from 'obsidian'
import { useEffect, useRef, useState } from 'react'

import { useLanguage } from '../../contexts/language-context'
import { DEFAULT_ASSISTANT_ID } from '../../core/agent/default-assistant'
import { getUnifiedAgentList } from '../../core/agent/workspaceAgentResolver'
import {
  describeCronSchedule,
  describeIntervalSchedule,
  validateCronExpression,
} from '../../core/scheduler/cron-parser'
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
import { ConfirmModal } from '../modals/ConfirmModal'

type TaskEditorModalComponentProps = {
  plugin: YoloPlugin
  task: ScheduledTask | null // null when creating a new task
  onSaved?: () => void
  /**
   * Shared with the modal class so its onClose() can intercept ESC/×/Cancel
   * while the form is dirty: the component writes `dirty` on every change and
   * `settled` once the user saved (or explicitly confirmed discarding).
   */
  closeGuardRef?: { current: { dirty: boolean; settled: boolean } }
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

/** Shared close-guard state for the editor modals: dirty + settled, written by the React component, read by the modal class's onClose(). */
type CloseGuard = { current: { dirty: boolean; settled: boolean } }

const makeCloseGuard = (): CloseGuard => ({
  current: { dirty: false, settled: false },
})

export class AddScheduledTaskModal extends ReactModal<TaskEditorModalComponentProps> {
  private readonly closeGuard: CloseGuard
  private readonly hostPlugin: YoloPlugin

  constructor(app: App, plugin: YoloPlugin, onSaved?: () => void) {
    const closeGuard = makeCloseGuard()
    super({
      app,
      Component: TaskEditorModalComponent,
      props: { plugin, task: null, onSaved, closeGuardRef: closeGuard },
      options: {
        title: plugin.t(
          'settings.scheduledTasks.addTaskTitle',
          'New scheduled task',
        ),
      },
      plugin,
    })
    this.hostPlugin = plugin
    this.closeGuard = closeGuard
    this.modalEl.classList.add('yolo-modal--wide')
  }

  onClose() {
    if (this.closeGuard.current.dirty && !this.closeGuard.current.settled) {
      this.confirmDiscardChanges()
      return
    }
    super.onClose()
  }

  private confirmDiscardChanges(): void {
    new ConfirmModal(this.app, {
      title: this.hostPlugin.t(
        'settings.scheduledTasks.discardChangesTitle',
        'Discard changes?',
      ),
      message: this.hostPlugin.t(
        'settings.scheduledTasks.discardChangesMessage',
        'You have unsaved changes in this form. Discard them?',
      ),
      ctaText: this.hostPlugin.t('common.discard', 'Discard'),
      onConfirm: () => {
        this.closeGuard.current.settled = true
        this.close()
      },
    }).open()
  }
}

export class EditScheduledTaskModal extends ReactModal<TaskEditorModalComponentProps> {
  private readonly closeGuard: CloseGuard
  private readonly hostPlugin: YoloPlugin

  constructor(
    app: App,
    plugin: YoloPlugin,
    task: ScheduledTask,
    onSaved?: () => void,
  ) {
    const closeGuard = makeCloseGuard()
    super({
      app,
      Component: TaskEditorModalComponent,
      props: { plugin, task, onSaved, closeGuardRef: closeGuard },
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
    this.hostPlugin = plugin
    this.closeGuard = closeGuard
    this.modalEl.classList.add('yolo-modal--wide')
  }

  onClose() {
    if (this.closeGuard.current.dirty && !this.closeGuard.current.settled) {
      this.confirmDiscardChanges()
      return
    }
    super.onClose()
  }

  private confirmDiscardChanges(): void {
    new ConfirmModal(this.app, {
      title: this.hostPlugin.t(
        'settings.scheduledTasks.discardChangesTitle',
        'Discard changes?',
      ),
      message: this.hostPlugin.t(
        'settings.scheduledTasks.discardChangesMessage',
        'You have unsaved changes in this form. Discard them?',
      ),
      ctaText: this.hostPlugin.t('common.discard', 'Discard'),
      onConfirm: () => {
        this.closeGuard.current.settled = true
        this.close()
      },
    }).open()
  }
}

type FieldName =
  | 'name'
  | 'scriptPath'
  | 'agentPrompt'
  | 'cron'
  | 'interval'
  | 'once'
  | 'timeout'

/** Order in which the submit handler walks fields to focus the first error. */
const FIELD_FOCUS_ORDER: FieldName[] = [
  'name',
  'cron',
  'interval',
  'once',
  'scriptPath',
  'agentPrompt',
  'timeout',
]

type FieldErrors = Partial<Record<FieldName, string>>

function TaskEditorModalComponent({
  plugin,
  task,
  onSaved,
  onClose,
  closeGuardRef,
}: TaskEditorModalComponentProps & { onClose: () => void }) {
  const { t, language } = useLanguage()
  const [formData, setFormData] = useState<TaskConfig>(
    task ? taskToConfig(task) : createDefaultTaskConfig(),
  )
  const [otherTasks, setOtherTasks] = useState<ScheduledTask[]>([])
  // Blur-touched fields show their inline error immediately; untouched fields
  // only get validated (and revealed) at submit time.
  const [touched, setTouched] = useState<ReadonlySet<FieldName>>(
    () => new Set(),
  )
  const fieldRefs = useRef<Partial<Record<FieldName, HTMLDivElement | null>>>(
    {},
  )
  const savingRef = useRef(false)
  const [isSaving, setIsSaving] = useState(false)

  const initialConfigRef = useRef<TaskConfig>(
    task ? taskToConfig(task) : createDefaultTaskConfig(),
  )

  // Dirty tracking for the close guard: any difference from the initial
  // config marks the form as having unsaved changes (ESC/×/Cancel then ask
  // for confirmation in the modal class's onClose).
  useEffect(() => {
    const isDirty =
      JSON.stringify(formData) !== JSON.stringify(initialConfigRef.current)
    if (closeGuardRef) {
      closeGuardRef.current.dirty = isDirty
    }
  }, [formData, closeGuardRef])

  useEffect(() => {
    const service = plugin.getScheduledTasksService()
    if (!service) return
    void service
      .listTasks()
      .then((all) =>
        setOtherTasks(all.filter((other) => other.id !== task?.id)),
      )
  }, [plugin, task?.id])

  const touchField = (field: FieldName) => {
    setTouched((prev) => new Set(prev).add(field))
  }

  const validateFormData = (data: TaskConfig): FieldErrors => {
    const errors: FieldErrors = {}
    if (!data.name.trim()) {
      errors.name = t(
        'settings.scheduledTasks.errorNameRequired',
        'Name is required',
      )
    }
    if (data.type === 'script') {
      if (!data.scriptPath?.trim()) {
        errors.scriptPath = t(
          'settings.scheduledTasks.errorScriptPathRequired',
          'Script path is required',
        )
      }
    } else if (data.type === 'agent' && !data.agentPrompt?.trim()) {
      errors.agentPrompt = t(
        'settings.scheduledTasks.errorPromptRequired',
        'Prompt is required',
      )
    }
    if (data.scheduleType === 'cron') {
      if (!data.cronExpression?.trim()) {
        errors.cron = t(
          'settings.scheduledTasks.errorCronRequired',
          'Cron expression is required',
        )
      } else {
        const cronError = validateCronExpression(data.cronExpression)
        if (cronError) {
          errors.cron = t(
            'settings.scheduledTasks.errorCronInvalid',
            'Invalid cron expression: {error}',
          ).replace('{error}', cronError)
        }
      }
    } else if (data.scheduleType === 'interval') {
      if (!data.intervalSeconds || data.intervalSeconds <= 0) {
        errors.interval = t(
          'settings.scheduledTasks.errorIntervalRequired',
          'Interval must be greater than 0 seconds',
        )
      }
    } else if (data.scheduleType === 'once') {
      if (!data.oneTimeDateTime) {
        errors.once = t(
          'settings.scheduledTasks.errorOnceRequired',
          'Pick a run time',
        )
      } else if (data.oneTimeDateTime <= Date.now()) {
        // A past time would fire at the very next poll tick with no warning;
        // the catch-up pass deliberately skips 'once' schedules, so the run
        // would also be silently lost if the process was down at that moment.
        errors.once = t(
          'settings.scheduledTasks.errorOnceInPast',
          'The run time must be in the future',
        )
      }
    }
    if (data.timeoutSeconds <= 0) {
      errors.timeout = t(
        'settings.scheduledTasks.errorTimeoutRequired',
        'Timeout must be greater than 0 seconds',
      )
    }
    return errors
  }

  const errors = validateFormData(formData)
  const fieldError = (field: FieldName): string | undefined =>
    touched.has(field) ? errors[field] : undefined

  const assistantOptions: Record<string, string> = {
    [USE_DEFAULT_ASSISTANT_VALUE]: t(
      'settings.scheduledTasks.followCurrentAssistant',
      'Follow current default assistant',
    ),
    ...Object.fromEntries(
      getUnifiedAgentList(plugin.settings).map((assistant) => [
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
    if (savingRef.current) return
    const validationErrors = validateFormData(formData)
    const errorList = FIELD_FOCUS_ORDER.filter(
      (field) => validationErrors[field] != null,
    )

    if (errorList.length > 0) {
      // Reveal every invalid field inline, focus the first one, and keep the
      // submit-time Notice as the backstop (validation is also reachable when
      // no field has been blurred yet).
      setTouched(new Set(FIELD_FOCUS_ORDER))
      const first = errorList[0]
      const firstInput =
        fieldRefs.current[first]?.querySelector('input, textarea')
      if (firstInput instanceof HTMLElement) {
        firstInput.focus()
      }
      new Notice(
        errorList.map((field) => validationErrors[field]).join('\n') ||
          t('settings.scheduledTasks.errorNameRequired', 'Name is required'),
      )
      return
    }

    savingRef.current = true
    setIsSaving(true)
    const execute = async () => {
      try {
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
        if (task) {
          await service.updateTask(task.id, formData)
        } else {
          await service.createTask(formData)
        }
        new Notice(
          task
            ? t('settings.scheduledTasks.saveSuccessNotice', 'Task saved')
            : t('settings.scheduledTasks.createSuccessNotice', 'Task created'),
        )
        onSaved?.()
        if (closeGuardRef) {
          closeGuardRef.current.settled = true
        }
        onClose()
      } catch (error) {
        new Notice(error instanceof Error ? error.message : String(error))
      } finally {
        savingRef.current = false
        setIsSaving(false)
      }
    }
    void execute()
  }

  return (
    <div>
      <div
        className={`yolo-settings-field ${fieldError('name') ? 'is-invalid' : ''}`}
        ref={(el) => {
          fieldRefs.current.name = el
        }}
      >
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
            onBlur={() => touchField('name')}
          />
        </ObsidianSetting>
        {fieldError('name') && (
          <div className="yolo-settings-inline-error" role="alert">
            {fieldError('name')}
          </div>
        )}
      </div>

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

          <div
            className={`yolo-settings-field ${fieldError('agentPrompt') ? 'is-invalid' : ''}`}
            ref={(el) => {
              fieldRefs.current.agentPrompt = el
            }}
          >
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
                onBlur={() => touchField('agentPrompt')}
                autoResize
                maxAutoResizeHeight={200}
              />
            </ObsidianSetting>
            {fieldError('agentPrompt') && (
              <div className="yolo-settings-inline-error" role="alert">
                {fieldError('agentPrompt')}
              </div>
            )}
          </div>
        </>
      )}

      {formData.type === 'script' && (
        <div
          className={`yolo-settings-field ${fieldError('scriptPath') ? 'is-invalid' : ''}`}
          ref={(el) => {
            fieldRefs.current.scriptPath = el
          }}
        >
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
              onBlur={() => touchField('scriptPath')}
            />
          </ObsidianSetting>
          {fieldError('scriptPath') && (
            <div className="yolo-settings-inline-error" role="alert">
              {fieldError('scriptPath')}
            </div>
          )}
        </div>
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
        <div
          className={`yolo-settings-field ${fieldError('interval') ? 'is-invalid' : ''}`}
          ref={(el) => {
            fieldRefs.current.interval = el
          }}
        >
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
              onBlur={() => touchField('interval')}
            />
          </ObsidianSetting>
          {formData.intervalSeconds != null &&
            formData.intervalSeconds > 0 &&
            !errors.interval && (
              <div className="yolo-settings-desc">
                {describeIntervalSchedule(formData.intervalSeconds, t)}
              </div>
            )}
          {fieldError('interval') && (
            <div className="yolo-settings-inline-error" role="alert">
              {fieldError('interval')}
            </div>
          )}
        </div>
      )}

      {formData.scheduleType === 'cron' && (
        <>
          <div
            className={`yolo-settings-field ${fieldError('cron') ? 'is-invalid' : ''}`}
            ref={(el) => {
              fieldRefs.current.cron = el
            }}
          >
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
                onBlur={() => touchField('cron')}
              />
            </ObsidianSetting>
            {formData.cronExpression?.trim() && !errors.cron && (
              <div className="yolo-settings-desc">
                {describeCronSchedule(formData.cronExpression, t, language)}
              </div>
            )}
            {fieldError('cron') && (
              <div className="yolo-settings-inline-error" role="alert">
                {fieldError('cron')}
              </div>
            )}
          </div>
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
        <div
          className={`yolo-settings-field ${fieldError('once') ? 'is-invalid' : ''}`}
          ref={(el) => {
            fieldRefs.current.once = el
          }}
        >
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
                onBlur={() => touchField('once')}
              />
            </div>
          </div>
          {fieldError('once') && (
            <div className="yolo-settings-inline-error" role="alert">
              {fieldError('once')}
            </div>
          )}
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

      <div
        className={`yolo-settings-field ${fieldError('timeout') ? 'is-invalid' : ''}`}
        ref={(el) => {
          fieldRefs.current.timeout = el
        }}
      >
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
            onBlur={() => touchField('timeout')}
          />
        </ObsidianSetting>
        {fieldError('timeout') && (
          <div className="yolo-settings-inline-error" role="alert">
            {fieldError('timeout')}
          </div>
        )}
      </div>

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
          disabled={isSaving}
          onClick={handleSubmit}
        />
        <ObsidianButton
          text={t('common.cancel', 'Cancel')}
          disabled={isSaving}
          onClick={onClose}
        />
      </ObsidianSetting>
    </div>
  )
}
