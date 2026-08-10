import type { Assistant } from '../../types/assistant.types'
import type { WorkspaceAgent } from '../../settings/schema/setting.types'

import {
  getUnifiedAgentList,
  resolveWorkspaceAgentAssistant,
  toWorkspaceAccessPolicy,
} from './workspaceAgentResolver'

const template: Assistant = {
  id: 'template-1',
  name: 'Template',
  systemPrompt: 'base prompt',
  description: 'base',
  enableTools: true,
  enabledToolNames: ['tool-a', 'tool-b'],
  toolPreferences: {
    'tool-a': { enabled: true, approvalMode: 'require_approval' },
    'tool-b': { enabled: true },
  },
  enabledSkills: ['skill-1', 'skill-2'],
  skillPreferences: {
    'skill-1': { enabled: true },
    'skill-2': { enabled: true },
  },
}

const agent: WorkspaceAgent = {
  id: 'wa-1',
  name: 'Workspace Agent',
  templateId: 'template-1',
  workspacePolicy: {
    workspaceRoot: '04-专利',
    readAllowlist: ['00-Email'],
    readDenylist: ['04-专利/secret'],
    writeDenylist: ['04-专利/archive'],
  },
  createdAt: 1,
  updatedAt: 1,
}

describe('workspaceAgentResolver', () => {
  it('inherits template fields and injects the workspace access policy', () => {
    const resolved = resolveWorkspaceAgentAssistant(agent, [template])

    expect(resolved).not.toBeNull()
    expect(resolved!.name).toBe('Workspace Agent')
    expect(resolved!.systemPrompt).toBe('base prompt')
    expect(resolved!.modelId).toBe(template.modelId)
    expect(resolved!.toolPreferences).toEqual(template.toolPreferences)
    expect(resolved!.workspaceAccessPolicy).toEqual({
      enabled: true,
      workspaceRoot: '04-专利',
      readExtraIncludes: ['00-Email'],
      readExcludes: ['04-专利/secret'],
      writeExcludes: ['04-专利/archive'],
    })
  })

  it('applies behavior overrides on top of the template', () => {
    const withOverrides: WorkspaceAgent = {
      ...agent,
      behaviorOverrides: {
        name: 'Renamed',
        systemPromptOverride: 'overridden prompt',
        disabledToolNames: ['tool-b'],
        disabledSkillIds: ['skill-2'],
        agentModeAllowed: false,
      },
    }

    const resolved = resolveWorkspaceAgentAssistant(withOverrides, [template])

    expect(resolved!.name).toBe('Renamed')
    expect(resolved!.systemPrompt).toBe('overridden prompt')
    expect(resolved!.enabledToolNames).toEqual(['tool-a'])
    expect(resolved!.toolPreferences?.['tool-b']).toEqual({ enabled: false })
    expect(resolved!.enabledSkills).toEqual(['skill-1'])
    expect(resolved!.skillPreferences?.['skill-2']).toEqual({ enabled: false })
  })

  it('returns null when the template is missing or the agent is disabled', () => {
    expect(resolveWorkspaceAgentAssistant(agent, [])).toBeNull()
    expect(
      resolveWorkspaceAgentAssistant({ ...agent, disabled: true }, [template]),
    ).toBeNull()
  })

  it('merges templates and workspace agents into the unified list', () => {
    const settings = {
      assistants: [template],
      workspaceAgents: [agent],
    } as never

    const unified = getUnifiedAgentList(settings)

    expect(unified).toHaveLength(2)
    expect(unified[0]!.id).toBe('template-1')
    expect(unified[1]!.id).toBe('wa-1')
  })

  it('maps the workspace policy to a workspace access policy', () => {
    expect(toWorkspaceAccessPolicy(agent)).toEqual({
      enabled: true,
      workspaceRoot: '04-专利',
      readExtraIncludes: ['00-Email'],
      readExcludes: ['04-专利/secret'],
      writeExcludes: ['04-专利/archive'],
    })
  })
})
