import { defineCapability } from '../define'
import { scheduledTaskOpsDefinition } from '../scheduled_task_ops/definition'

export const scheduledTasksCapability = defineCapability({
  id: 'scheduled_tasks',
  label: {
    key: 'settings.agent.builtinScheduledTaskOpsLabel',
    fallback: 'Scheduled Tasks Toolset',
  },
  description: {
    key: 'settings.agent.builtinScheduledTaskOpsDesc',
    fallback:
      'Grouped scheduled task operations: create, update, delete, list, get, and run tasks now.',
  },
  category: 'external',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [scheduledTaskOpsDefinition],
})
