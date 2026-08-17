import { createWorkflowRepository } from './domain/workflow-repository'
import { createWorkflowChatTools } from './domain/workflow-tools'
import {
  createWorkflowCopy,
  createWorkflowLocalizedText,
} from './i18n'

const MODULE_ID = 'workflow'

yolo.registerModule({
  id: MODULE_ID,
  activate(host) {
    const repository = createWorkflowRepository(host)
    const getCopy = () =>
      createWorkflowCopy(host.i18n.getSnapshot().locale)
    const copy = getCopy()
    const tools = createWorkflowChatTools(repository, getCopy)
    host.chat.registerMode({
      id: 'workflow',
      label: createWorkflowLocalizedText('module.name'),
      description: createWorkflowLocalizedText('mode.description'),
      icon: 'workflow',
      personaPrompt: copy.mode.persona,
      capability: 'none',
      skills: ['skills/workflow/SKILL.md'],
      tools: [tools.read, tools.create],
    })
  },
})
