import type { WorkspaceAgent } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'

import {
  buildWorkspaceAgentBehaviorOverrides,
  filterApprovalOptionsForWorkspaceAgent,
  getUnifiedAgentList,
  resolveActiveAssistant,
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

describe('filterApprovalOptionsForWorkspaceAgent', () => {
  const options = [
    { value: 'require_approval' as const },
    { value: 'dangerous_only' as const },
    { value: 'full_access' as const },
  ]

  it('keeps every option when editing a plain template (no template tier)', () => {
    expect(filterApprovalOptionsForWorkspaceAgent(options, undefined)).toEqual(
      options,
    )
  })

  it('filters out tiers looser than the template tier', () => {
    expect(
      filterApprovalOptionsForWorkspaceAgent(options, 'dangerous_only'),
    ).toEqual([{ value: 'require_approval' }, { value: 'dangerous_only' }])
  })

  it('keeps only the template tier itself when it is the strictest', () => {
    expect(
      filterApprovalOptionsForWorkspaceAgent(options, 'require_approval'),
    ).toEqual([{ value: 'require_approval' }])
  })

  it('keeps every option when the template tier is the loosest', () => {
    expect(filterApprovalOptionsForWorkspaceAgent(options, 'full_access')).toEqual(
      options,
    )
  })
})

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

  it('only narrows template built-in capability permissions', () => {
    const withCapabilities: Assistant = {
      ...template,
      builtinCapabilityPreferences: {
        file_editing: { enabled: true, approvalMode: 'full_access' },
        vault_shell: { enabled: true, approvalMode: 'dangerous_only' },
      },
    }
    const withOverrides = {
      ...agent,
      behaviorOverrides: {
        disabledBuiltinCapabilityIds: ['file_editing'],
        builtinCapabilityConfigOverrides: {
          file_editing: { approvalMode: 'full_access' },
          vault_shell: { approvalMode: 'require_approval' },
        },
      },
    } as WorkspaceAgent

    const resolved = resolveWorkspaceAgentAssistant(withOverrides, [
      withCapabilities,
    ])

    expect(resolved?.builtinCapabilityPreferences).toMatchObject({
      file_editing: { enabled: false, approvalMode: 'full_access' },
      vault_shell: { enabled: true, approvalMode: 'require_approval' },
    })
  })

  it('persists only explicit workspace-agent diffs from the template', () => {
    const ceiling: Assistant = {
      ...template,
      toolPreferences: {
        'tool-a': {
          enabled: true,
          approvalMode: 'full_access',
          disclosureMode: 'always',
        },
        'tool-b': { enabled: true },
      },
      builtinCapabilityPreferences: {
        file_editing: { enabled: true, approvalMode: 'full_access' },
        vault_shell: { enabled: true, approvalMode: 'dangerous_only' },
      },
      skillPreferences: {
        'skill-1': { enabled: true, loadMode: 'always' },
        'skill-2': { enabled: true, loadMode: 'always' },
      },
    }
    const effective = resolveWorkspaceAgentAssistant(agent, [ceiling])!
    const edited: Assistant = {
      ...effective,
      systemPrompt: 'workspace prompt',
      toolPreferences: {
        ...effective.toolPreferences,
        'tool-a': {
          enabled: true,
          approvalMode: 'require_approval',
          disclosureMode: 'on_demand',
        },
        'tool-b': { enabled: false },
      },
      builtinCapabilityPreferences: {
        ...effective.builtinCapabilityPreferences,
        file_editing: { enabled: false, approvalMode: 'full_access' },
        vault_shell: { enabled: true, approvalMode: 'require_approval' },
      },
      enabledSkills: ['skill-1'],
      skillPreferences: {
        ...effective.skillPreferences,
        'skill-1': { enabled: true, loadMode: 'lazy' },
        'skill-2': { enabled: false, loadMode: 'always' },
      },
    }

    expect(
      buildWorkspaceAgentBehaviorOverrides(ceiling, edited, false),
    ).toEqual({
      systemPromptOverride: 'workspace prompt',
      disabledToolNames: ['tool-b'],
      toolConfigOverrides: {
        'tool-a': {
          approvalMode: 'require_approval',
          disclosureMode: 'on_demand',
        },
      },
      disabledBuiltinCapabilityIds: ['file_editing'],
      builtinCapabilityConfigOverrides: {
        vault_shell: { approvalMode: 'require_approval' },
      },
      disabledSkillIds: ['skill-2'],
      skillConfigOverrides: {
        'skill-1': { loadMode: 'lazy' },
      },
      agentModeAllowed: false,
    })
  })

  it('keeps tools enabled when the template only enables built-in capabilities', () => {
    const builtinOnlyTemplate: Assistant = {
      ...template,
      enabledToolNames: [],
      toolPreferences: {},
      includeBuiltinTools: true,
      builtinCapabilityPreferences: {
        file_reading: { enabled: true, approvalMode: 'full_access' },
      },
    }

    const resolved = resolveWorkspaceAgentAssistant(agent, [
      builtinOnlyTemplate,
    ])

    expect(resolved?.enableTools).toBe(true)
  })

  it('returns null when the template is missing or the agent is disabled', () => {
    expect(resolveWorkspaceAgentAssistant(agent, [])).toBeNull()
    expect(
      resolveWorkspaceAgentAssistant({ ...agent, disabled: true }, [template]),
    ).toBeNull()
  })

  it('hides a template covered by a workspace agent (single entry per runnable agent)', () => {
    const settings = {
      assistants: [template],
      workspaceAgents: [agent],
    } as never

    const unified = getUnifiedAgentList(settings)

    expect(unified).toHaveLength(1)
    expect(unified[0]?.id).toBe('wa-1')
  })

  it('keeps templates not covered by any workspace agent', () => {
    const standaloneTemplate = { ...template, id: 'template-2' }
    const settings = {
      assistants: [template, standaloneTemplate],
      workspaceAgents: [agent],
    } as never

    const unified = getUnifiedAgentList(settings)

    expect(unified.map((a) => a.id)).toEqual(['template-2', 'wa-1'])
  })

  it('keeps the default assistant template visible even when a workspace agent covers it', () => {
    const defaultTemplate = { ...template, id: '__default_agent__' }
    const coveringAgent = { ...agent, templateId: '__default_agent__' }
    const settings = {
      assistants: [defaultTemplate],
      workspaceAgents: [coveringAgent],
    } as never

    const unified = getUnifiedAgentList(settings)

    expect(unified.map((a) => a.id)).toEqual([
      '__default_agent__',
      coveringAgent.id,
    ])
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

  it('resolves a workspace agent id to the merged assistant', () => {
    const settings = {
      assistants: [template],
      workspaceAgents: [agent],
    } as never

    const resolved = resolveActiveAssistant(settings, {
      assistantId: 'wa-1',
    })

    expect(resolved?.id).toBe('wa-1')
    expect(resolved?.workspaceAccessPolicy?.workspaceRoot).toBe('04-专利')
  })

  it('falls back to the default assistant when the workspace agent is orphaned (template deleted)', () => {
    const defaultTemplate = { ...template, id: '__default_agent__' }
    const orphanedAgent = {
      ...agent,
      id: 'wa-orphaned',
      templateId: 'deleted-template',
    }
    const settings = {
      assistants: [template, defaultTemplate],
      workspaceAgents: [orphanedAgent],
    } as never

    const resolved = resolveActiveAssistant(settings, {
      assistantId: 'wa-orphaned',
    })

    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe('__default_agent__')
  })

  it('falls back to the default assistant when the id matches nothing', () => {
    const defaultTemplate = { ...template, id: '__default_agent__' }
    const settings = {
      assistants: [template, defaultTemplate],
      workspaceAgents: [agent],
    } as never

    const resolved = resolveActiveAssistant(settings, {
      assistantId: 'does-not-exist',
    })

    expect(resolved).not.toBeNull()
    expect(resolved!.id).toBe('__default_agent__')
  })

  it('resolves a plain template id directly', () => {
    const settings = {
      assistants: [template],
      workspaceAgents: [],
    } as never

    const resolved = resolveActiveAssistant(settings, {
      assistantId: 'template-1',
    })

    expect(resolved?.id).toBe('template-1')
  })
})
