import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import { parseYoloSettings } from '../../../settings/schema/settings'
import type { Assistant } from '../../../types/assistant.types'
import type { ChatModel } from '../../../types/chat-model.types'
import { RequestContextBuilder } from '../../../utils/chat/requestContextBuilder'

import {
  type SubagentAuthorityResolverDependencies,
  type SubagentParentConversationMeta,
  resolveCurrentSubagentParentAuthority,
} from './authority-resolver'
import type { SubagentParentContext } from './parent-context'
import type { SubagentSession } from './session-types'

jest.mock('../../llm/manager', () => ({
  getChatModelClient: jest.fn(),
}))

jest.mock('../../skills/assistantSkillPaths', () => ({
  resolveAssistantSkillPaths: jest.fn(async () => ['skills/role.md']),
}))

const model: ChatModel = {
  id: 'model-1',
  providerId: 'provider-1',
  model: 'upstream-model',
  enable: true,
}

const parentAssistant: Assistant = {
  id: 'ui-assistant',
  name: 'Parent assistant',
  systemPrompt: '',
}

const role: Assistant = {
  id: 'role-1',
  name: 'Research role',
  systemPrompt: '',
  delegatable: true,
  modelId: model.id,
  enableTools: true,
  includeBuiltinTools: true,
  toolPreferences: {
    yolo_local__fs_read: { enabled: true },
    yolo_local__delegate_subagent: { enabled: true },
    yolo_local__ask_user_question: { enabled: true },
  },
}

function makeSettings(overrides: Partial<YoloSettings> = {}): YoloSettings {
  const settings = parseYoloSettings({})
  settings.currentAssistantId = 'ui-assistant'
  settings.assistants = [parentAssistant, role]
  settings.chatModels = [model]
  settings.providers = [
    {
      id: model.providerId,
      presetType: 'openai-compatible',
      apiType: 'openai-compatible',
      apiKey: 'test-key',
    },
  ]
  return { ...settings, ...overrides }
}

function makeConversationMeta(
  overrides: Partial<{
    assistantId: string
    conversationId: string
  }> = {},
): SubagentParentConversationMeta {
  const assistantId = Object.prototype.hasOwnProperty.call(
    overrides,
    'assistantId',
  )
    ? overrides.assistantId
    : 'ui-assistant'
  return {
    conversationId: overrides.conversationId ?? 'parent-conversation',
    ...(assistantId === undefined ? {} : { assistantId }),
  }
}

/** The parent runtime context stands in for the backup projection's
 * workspace/reasoning inputs (the projection does not exist on master). */
function makeParentContext(
  overrides: Partial<SubagentParentContext> = {},
): SubagentParentContext {
  return {
    providerClient: {} as never,
    model,
    conversationId: 'parent-conversation',
    loopConfig: {
      enableTools: true,
      includeBuiltinTools: true,
      maxAutoIterations: 100,
    },
    requestContextBuilder: {} as unknown as RequestContextBuilder,
    mcpManager: {} as never,
    ...overrides,
  }
}

function makeSession(
  overrides: Partial<SubagentSession> = {},
): SubagentSession {
  return {
    sessionId: 'session-1',
    parentConversationId: 'parent-conversation',
    originAssistantMessageId: 'assistant-message',
    originToolCallId: 'delegate-call',
    title: 'Child',
    mode: 'persistent',
    status: 'idle',
    revision: 1,
    nextRunSequence: 2,
    delegatedRoleId: role.id,
    memoryAssistantId: 'frozen-parent-assistant',
    createdAt: 1,
    lastActiveAt: 1,
    ...overrides,
  }
}

function makeDeps(
  settings: YoloSettings,
  conversationMeta: SubagentParentConversationMeta | null =
    makeConversationMeta(),
) {
  const providerClients: object[] = []
  const mcpManagers: object[] = []
  const deps: SubagentAuthorityResolverDependencies = {
    app: {} as App,
    getSettings: () => settings,
    loadConversationMeta: jest.fn(async () => conversationMeta),
    createProviderClient: jest.fn(() => {
      const providerClient = { provider: 'fresh-provider-client' }
      providerClients.push(providerClient)
      return providerClient as never
    }),
    createMcpManager: jest.fn(() => {
      const mcpManager = {
        listAvailableTools: jest.fn(async () => [
          { name: 'yolo_local__fs_read' },
          { name: 'yolo_local__delegate_subagent' },
          { name: 'yolo_local__ask_user_question' },
          { name: 'remote__search' },
        ]),
      }
      mcpManagers.push(mcpManager)
      return mcpManager as never
    }),
  }
  return {
    deps,
    providerClients,
    mcpManagers,
  }
}

/** The assistant identity baked into a RequestContextBuilder's settings clone
 * (master couples assistant + memory identity in `currentAssistantId`). */
function getBuilderAssistantId(
  builder: RequestContextBuilder,
): string | null | undefined {
  return (builder as unknown as { settings: YoloSettings }).settings
    .currentAssistantId
}

describe('resolveCurrentSubagentParentAuthority', () => {
  it('reloads the owning conversation meta and builds fresh authority for each run', async () => {
    const settings = makeSettings()
    const { deps, providerClients, mcpManagers } = makeDeps(settings)

    const first = await resolveCurrentSubagentParentAuthority(
      deps,
      makeSession(),
      makeParentContext(),
    )
    const second = await resolveCurrentSubagentParentAuthority(
      deps,
      makeSession(),
      makeParentContext(),
    )

    expect(deps.loadConversationMeta).toHaveBeenCalledTimes(2)
    expect(deps.loadConversationMeta).toHaveBeenLastCalledWith(
      'parent-conversation',
    )
    expect(first.conversation?.conversationId).toBe('parent-conversation')
    expect(first.providerClient).toBe(providerClients[0])
    expect(first.mcpManager).toBe(mcpManagers[0])
    expect(second.providerClient).not.toBe(first.providerClient)
    expect(second.mcpManager).not.toBe(first.mcpManager)
    expect(first.requestContextBuilder).toBeInstanceOf(RequestContextBuilder)
    expect(second.requestContextBuilder).not.toBe(first.requestContextBuilder)
    expect(JSON.parse(JSON.stringify(first.auditSnapshot))).toEqual(
      first.auditSnapshot,
    )
    expect(first.auditSnapshot).not.toHaveProperty('providerClient')
    expect(first.auditSnapshot).not.toHaveProperty('requestContextBuilder')
    expect(first.temporaryApprovedToolNames).toEqual([])
  })

  it('uses frozen memory identity when the UI assistant changes', async () => {
    const settings = makeSettings()
    const { deps } = makeDeps(settings)

    const authority = await resolveCurrentSubagentParentAuthority(
      deps,
      makeSession({ memoryAssistantId: 'frozen-parent-assistant' }),
      makeParentContext(),
    )

    expect(authority.requestContextBuilder).toBeDefined()
    expect(getBuilderAssistantId(authority.requestContextBuilder)).toBe(
      'frozen-parent-assistant',
    )
  })

  it('rejects a missing delegated role as retryable policy_unavailable', async () => {
    const settings = makeSettings({ assistants: [] })
    const { deps } = makeDeps(settings)

    await expect(
      resolveCurrentSubagentParentAuthority(
        deps,
        makeSession(),
        makeParentContext(),
      ),
    ).rejects.toMatchObject({
      accepted: false,
      errorCode: 'policy_unavailable',
      retryable: true,
    })
  })

  it('rejects a missing provider as retryable policy_unavailable', async () => {
    const settings = makeSettings({ providers: [] })
    const { deps } = makeDeps(settings)

    await expect(
      resolveCurrentSubagentParentAuthority(
        deps,
        makeSession(),
        makeParentContext(),
      ),
    ).rejects.toMatchObject({
      accepted: false,
      errorCode: 'policy_unavailable',
      retryable: true,
    })
  })

  it.each([
    ['vanished', null],
    [
      'mismatched',
      makeConversationMeta({ conversationId: 'other-conversation' }),
    ],
  ])('rejects an owning conversation meta that is %s as parent_orphaned', async (_name, conversationMeta) => {
    const settings = makeSettings()
    const { deps } = makeDeps(settings, conversationMeta)

    await expect(
      resolveCurrentSubagentParentAuthority(
        deps,
        makeSession(),
        makeParentContext(),
      ),
    ).rejects.toMatchObject({
      accepted: false,
      errorCode: 'parent_orphaned',
    })
  })

  it.each([
    ['non-delegatable', { ...role, delegatable: false }, model],
    ['disabled-model', role, { ...model, enable: false }],
  ])(
    'rejects a %s delegated role as retryable policy_unavailable',
    async (_name, unavailableRole, unavailableModel) => {
      const settings = makeSettings({
        assistants: [unavailableRole as Assistant],
        chatModels: [unavailableModel as ChatModel],
      })
      const { deps } = makeDeps(settings)

      await expect(
        resolveCurrentSubagentParentAuthority(
          deps,
          makeSession(),
          makeParentContext(),
        ),
      ).rejects.toMatchObject({
        accepted: false,
        errorCode: 'policy_unavailable',
        retryable: true,
      })
    },
  )

  it('does not widen the current conversation workspace ceiling', async () => {
    const settings = makeSettings({
      assistants: [
        {
          ...parentAssistant,
          workspaceAccessPolicy: {
            enabled: true,
            workspaceRoot: 'Projects',
            readExtraIncludes: [],
            readExcludes: [],
            writeExcludes: [],
          },
        },
        {
          ...role,
          workspaceAccessPolicy: {
            enabled: true,
            workspaceRoot: '/',
            readExtraIncludes: [],
            readExcludes: [],
            writeExcludes: [],
          },
        },
      ],
    })
    const { deps } = makeDeps(settings, makeConversationMeta())

    const authority = await resolveCurrentSubagentParentAuthority(
      deps,
      makeSession(),
      makeParentContext({
        workspaceAccessPolicy: {
          enabled: true,
          workspaceRoot: '/Projects/Parent',
          readExtraIncludes: [],
          readExcludes: [],
          writeExcludes: [],
        },
      }),
    )

    expect(authority.workspaceAccessPolicy?.workspaceRoot).toBe(
      '/Projects/Parent',
    )
  })

  it('denies recursive and interactive child tools even when role enables them', async () => {
    const settings = makeSettings()
    const { deps } = makeDeps(settings)

    const authority = await resolveCurrentSubagentParentAuthority(
      deps,
      makeSession(),
      makeParentContext(),
    )

    expect(authority.auditSnapshot.allowedToolNames).toEqual([
      'yolo_local__fs_read',
    ])
  })

  it('does not restore enabled builtin tools when the parent excludes builtins', async () => {
    const parentAssistant: Assistant = {
      id: 'ui-assistant',
      name: 'Parent',
      systemPrompt: '',
      modelId: model.id,
      enableTools: true,
      includeBuiltinTools: false,
      toolPreferences: {
        yolo_local__fs_read: { enabled: true },
        remote__search: { enabled: true },
      },
    }
    const settings = makeSettings({ assistants: [parentAssistant, role] })
    const { deps } = makeDeps(settings)

    const authority = await resolveCurrentSubagentParentAuthority(
      deps,
      makeSession({
        delegatedRoleId: undefined,
        modelPreferenceId: model.id,
      }),
      makeParentContext(),
    )

    expect(authority.auditSnapshot.allowedToolNames).toEqual(['remote__search'])
    expect(authority.requestContextBuilder).toBeInstanceOf(
      RequestContextBuilder,
    )
    expect(getBuilderAssistantId(authority.requestContextBuilder)).toBe(
      'frozen-parent-assistant',
    )
  })

  it('rejects a persisted generic model preference outside the current allowlist', async () => {
    const disallowedModel: ChatModel = {
      ...model,
      id: 'model-no-longer-allowed',
      model: 'other-upstream-model',
    }
    const settings = makeSettings({ chatModels: [model, disallowedModel] })
    settings.mcp.builtinToolOptions.delegate_subagent = {
      allowedModelIds: [model.id],
      preferredModelId: model.id,
    }
    const { deps } = makeDeps(settings)

    await expect(
      resolveCurrentSubagentParentAuthority(
        deps,
        makeSession({
          delegatedRoleId: undefined,
          modelPreferenceId: disallowedModel.id,
        }),
        makeParentContext(),
      ),
    ).rejects.toMatchObject({
      accepted: false,
      errorCode: 'policy_unavailable',
      retryable: true,
    })
  })

  it.each([undefined, 'missing-parent-assistant'])(
    'does not fall back to the current UI assistant for conversation binding %p',
    async (assistantId) => {
      const settings = makeSettings({
        currentAssistantId: parentAssistant.id,
      })
      const { deps } = makeDeps(settings, makeConversationMeta({ assistantId }))

      await expect(
        resolveCurrentSubagentParentAuthority(
          deps,
          makeSession({
            delegatedRoleId: undefined,
            modelPreferenceId: model.id,
          }),
          makeParentContext(),
        ),
      ).rejects.toMatchObject({
        accepted: false,
        errorCode: 'policy_unavailable',
        retryable: true,
      })
    },
  )

  it('reconstructs parent authority from the conversation workspace-agent binding', async () => {
    const template: Assistant = {
      id: 'workspace-template',
      name: 'Workspace Template',
      systemPrompt: 'TEMPLATE_PROMPT',
      modelId: model.id,
      enableTools: true,
      includeBuiltinTools: true,
      toolPreferences: {
        yolo_local__fs_read: { enabled: true },
        remote__search: { enabled: true },
      },
    }
    const settings = makeSettings({
      currentAssistantId: 'different-ui-assistant',
      assistants: [template, role],
      workspaceAgents: [
        {
          id: 'workspace-parent',
          name: 'Workspace Parent',
          templateId: template.id,
          behaviorOverrides: {
            systemPromptOverride: 'WORKSPACE_PROMPT',
            disabledToolNames: ['yolo_local__fs_read'],
            disabledSkillIds: [],
          },
          workspacePolicy: {
            workspaceRoot: '/Projects',
            readAllowlist: [],
            readDenylist: [],
            writeDenylist: [],
          },
          shareTokens: [],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    })
    const { deps } = makeDeps(
      settings,
      makeConversationMeta({ assistantId: 'workspace-parent' }),
    )

    const authority = await resolveCurrentSubagentParentAuthority(
      deps,
      makeSession({
        delegatedRoleId: undefined,
        modelPreferenceId: model.id,
      }),
      makeParentContext({
        workspaceAccessPolicy: {
          enabled: true,
          workspaceRoot: '/Projects/Parent',
          readExtraIncludes: [],
          readExcludes: [],
          writeExcludes: [],
        },
      }),
    )

    expect(authority.workspaceAccessPolicy?.workspaceRoot).toBe(
      '/Projects/Parent',
    )
    expect(authority.auditSnapshot.allowedToolNames).toEqual(['remote__search'])
    expect(authority.requestContextBuilder).toBeInstanceOf(
      RequestContextBuilder,
    )
    expect(getBuilderAssistantId(authority.requestContextBuilder)).toBe(
      'frozen-parent-assistant',
    )
  })
})
