import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import { parseYoloSettings } from '../../../settings/schema/settings'
import type {
  Assistant,
  WorkspaceAccessPolicy,
} from '../../../types/assistant.types'
import type { ChatModel } from '../../../types/chat-model.types'
import { RequestContextBuilder } from '../../../utils/chat/requestContextBuilder'
import { resolveAssistantSkillPaths } from '../../skills/assistantSkillPaths'

import {
  SUBAGENT_BLOCKED_TOOL_NAMES,
  SUBAGENT_MAX_AUTO_ITERATIONS,
} from './constants'
import { resolveDelegatedAssistantProfile } from './delegated-assistant-profile'

jest.mock('../../skills/assistantSkillPaths', () => ({
  resolveAssistantSkillPaths: jest.fn(async () => ['skills/research/SKILL.md']),
}))

const resolveAssistantSkillPathsMock =
  resolveAssistantSkillPaths as jest.MockedFunction<
    typeof resolveAssistantSkillPaths
  >

const ROLE_MODEL: ChatModel = {
  id: 'role-model',
  providerId: 'provider',
  model: 'role-model-upstream',
  enable: true,
}

const GENERIC_MODEL: ChatModel = {
  id: 'generic-model',
  providerId: 'provider',
  model: 'generic-model-upstream',
  enable: true,
}

function makeRole(overrides: Partial<Assistant> = {}): Assistant {
  return {
    id: 'research-role',
    name: 'Research Role',
    systemPrompt: 'Research carefully.',
    delegatable: true,
    ...overrides,
  }
}

function makeSettings(role: Assistant): YoloSettings {
  const settings = parseYoloSettings({})
  settings.assistants = [role]
  settings.chatModels = [ROLE_MODEL, GENERIC_MODEL]
  settings.chatModelId = GENERIC_MODEL.id
  settings.mcp.builtinToolOptions.delegate_subagent = {
    allowedModelIds: [GENERIC_MODEL.id],
    preferredModelId: GENERIC_MODEL.id,
  }
  return settings
}

function makeParentBuilder() {
  return {
    parentRequestContextBuilder: {} as unknown as RequestContextBuilder,
  }
}

/** The assistant identity the profile baked into the delegated builder's
 * settings clone (master couples assistant + memory identity in
 * `currentAssistantId`). */
function getBuilderAssistantId(
  builder: RequestContextBuilder,
): string | null | undefined {
  return (builder as unknown as { settings: YoloSettings }).settings
    .currentAssistantId
}

function resolveProfile({
  role,
  settings = makeSettings(role),
  parentWorkspacePolicy,
  memoryAssistantIdOverride,
  availableToolNames,
}: {
  role: Assistant
  settings?: YoloSettings
  parentWorkspacePolicy?: WorkspaceAccessPolicy
  memoryAssistantIdOverride?: string
  availableToolNames?: string[]
}) {
  const { parentRequestContextBuilder } = makeParentBuilder()
  const promise = resolveDelegatedAssistantProfile({
    app: {} as App,
    settings,
    assistantId: role.id,
    parentWorkspacePolicy,
    memoryAssistantIdOverride,
    availableToolNames,
    parentRequestContextBuilder,
  })

  return { parentRequestContextBuilder, promise }
}

describe('resolveDelegatedAssistantProfile', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    resolveAssistantSkillPathsMock.mockResolvedValue([
      'skills/research/SKILL.md',
    ])
  })

  it('uses an available explicit role model outside the generic model pool', async () => {
    const [delegateTool, askUserTool] = SUBAGENT_BLOCKED_TOOL_NAMES
    const roleTool = 'research__search'
    const role = makeRole({
      modelId: ROLE_MODEL.id,
      enableTools: true,
      includeBuiltinTools: true,
      workspaceAccessPolicy: {
        enabled: true,
        workspaceRoot: 'RoleOnly',
        readExtraIncludes: [],
        readExcludes: [],
        writeExcludes: [],
      },
      toolPreferences: {
        [roleTool]: {
          enabled: true,
          approvalMode: 'full_access',
          disclosureMode: 'on_demand',
        },
        [delegateTool]: { enabled: true },
        [askUserTool]: { enabled: true },
      },
      toolServerPreferences: {
        research: { approvalMode: 'full_access' },
      },
    })
    const parentWorkspacePolicy: WorkspaceAccessPolicy = {
      enabled: true,
      workspaceRoot: 'Parent',
      readExtraIncludes: ['Shared'],
      readExcludes: ['Private'],
      writeExcludes: ['Archive'],
    }
    const { promise, parentRequestContextBuilder } = resolveProfile({
      role,
      parentWorkspacePolicy,
    })

    const profile = await promise

    expect(profile.assistant).toBe(role)
    expect(profile.modelId).toBe(ROLE_MODEL.id)
    expect(profile.allowedToolNames).toEqual([roleTool])
    expect(profile.toolPreferences).toEqual(role.toolPreferences)
    expect(profile.toolServerPreferences).toBe(role.toolServerPreferences)
    expect(profile.allowedSkillPaths).toEqual(['skills/research/SKILL.md'])
    expect(profile.workspaceAccessPolicy).toBe(parentWorkspacePolicy)
    expect(profile.loopConfig).toEqual({
      enableTools: true,
      includeBuiltinTools: true,
      maxAutoIterations: SUBAGENT_MAX_AUTO_ITERATIONS,
    })
    // R9: the profile derives a fresh RequestContextBuilder for the delegated
    // role (agent-api.ts construction path) instead of a parent-derived one.
    expect(profile.requestContextBuilder).toBeInstanceOf(RequestContextBuilder)
    expect(profile.requestContextBuilder).not.toBe(parentRequestContextBuilder)
    expect(getBuilderAssistantId(profile.requestContextBuilder)).toBe(role.id)
    expect(profile.delegatedRole).toEqual({
      id: role.id,
      name: role.name,
    })
    expect(Object.keys(profile.delegatedRole)).toEqual(['id', 'name'])
    expect(Object.isFrozen(profile.delegatedRole)).toBe(true)
    expect(resolveAssistantSkillPathsMock).toHaveBeenCalledWith({
      app: expect.any(Object),
      settings: expect.any(Object),
      assistant: role,
    })
  })

  it('falls back to the preferred generic model when the role model is blank', async () => {
    const role = makeRole({ modelId: '   ' })

    await expect(resolveProfile({ role }).promise).resolves.toMatchObject({
      modelId: GENERIC_MODEL.id,
    })
  })

  it('uses frozen parent memory identity and current global tool availability', async () => {
    const role = makeRole({
      modelId: ROLE_MODEL.id,
      enableTools: true,
      toolPreferences: {
        research__available: { enabled: true },
        research__removed: { enabled: true },
      },
    })
    const { promise } = resolveProfile({
      role,
      memoryAssistantIdOverride: 'frozen-parent-assistant',
      availableToolNames: ['research__available'],
    })

    const profile = await promise
    expect(profile.allowedToolNames).toEqual(['research__available'])
    // The frozen parent memory identity wins over the role id in the derived
    // builder's settings clone (master couples both in `currentAssistantId`).
    expect(getBuilderAssistantId(profile.requestContextBuilder)).toBe(
      'frozen-parent-assistant',
    )
  })

  it('rejects a missing explicit role model without using the generic fallback', async () => {
    const role = makeRole({ modelId: 'missing-role-model' })

    await expect(resolveProfile({ role }).promise).rejects.toThrow(
      'Assistant role "research-role" selects chat model "missing-role-model", but it is not registered. Choose a registered model for this role.',
    )
  })

  it('rejects a disabled explicit role model without using the generic fallback', async () => {
    const role = makeRole({ modelId: ROLE_MODEL.id })
    const settings = makeSettings(role)
    settings.chatModels = [{ ...ROLE_MODEL, enable: false }, GENERIC_MODEL]

    await expect(resolveProfile({ role, settings }).promise).rejects.toThrow(
      'Assistant role "research-role" selects chat model "role-model", but that model is disabled. Enable it or choose another model for this role.',
    )
  })

  it('allows a text-only role and passes an explicit undefined workspace override', async () => {
    const roleTool = 'research__search'
    const role = makeRole({
      enableTools: false,
      includeBuiltinTools: true,
      toolPreferences: {
        [roleTool]: { enabled: true },
      },
    })
    const { promise } = resolveProfile({ role })

    await expect(promise).resolves.toMatchObject({
      allowedToolNames: [],
      workspaceAccessPolicy: undefined,
      loopConfig: {
        enableTools: false,
        includeBuiltinTools: false,
        maxAutoIterations: SUBAGENT_MAX_AUTO_ITERATIONS,
      },
    })
  })

  it('rejects a template that is not opted in for delegation', async () => {
    const role = makeRole({ delegatable: false })

    await expect(resolveProfile({ role }).promise).rejects.toThrow(
      'Assistant role "research-role" is not available for delegation.',
    )
  })
})
