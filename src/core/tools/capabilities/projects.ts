import { defineCapability } from '../define'
import { projectOpsDefinition } from '../project_ops/definition'

export const projectsCapability = defineCapability({
  id: 'projects',
  label: {
    key: 'settings.agent.builtinProjectOpsLabel',
    fallback: 'Project Management Toolset',
  },
  description: {
    key: 'settings.agent.builtinProjectOpsDesc',
    fallback:
      'Manage durable project and task files: init, get, status, update, and review.',
  },
  category: 'projects',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [projectOpsDefinition],
})
