jest.mock('../../components/chat-view/chat-runtime-profiles', () => ({
  resolveChatModeRuntime: jest.fn(() => ({
    loopConfig: {
      enableTools: true,
      includeBuiltinTools: true,
      maxAutoIterations: 100,
    },
    allowedToolNames: ['server__search'],
    toolPreferences: undefined,
    toolServerPreferences: undefined,
    toolCapabilityMode: 'agent',
    bypassToolApproval: true,
  })),
}))

jest.mock('../llm/manager', () => ({
  getChatModelClient: jest.fn(() => ({
    providerClient: { id: 'provider-client' },
    model: {
      id: 'mock-model',
      providerId: 'mock-provider',
      model: 'mock-model',
      name: 'Mock Model',
      modalities: [],
      temperature: undefined,
      topP: undefined,
      maxOutputTokens: undefined,
    },
  })),
}))

jest.mock('../skills/liteSkills', () => ({
  listLiteSkillEntries: jest.fn(async () => []),
}))

jest.mock('../../utils/chat/requestContextBuilder', () => ({
  RequestContextBuilder: jest.fn().mockImplementation(() => ({
    generateRequestMessages: jest.fn(async () => []),
  })),
}))

jest.mock('../agent/tool-selection', () => ({
  selectAllowedTools: jest.fn(async () => ({
    filteredTools: [],
    hasTools: true,
    hasMemoryTools: false,
    hasOnDemandTools: false,
    requestTools: [{ type: 'function', function: { name: 'server__search' } }],
  })),
}))

jest.mock('../agent/compaction', () => ({
  ...jest.requireActual('../agent/compaction'),
  createConversationCompactionSummary: jest.fn(async () => 'summary text'),
}))

jest.mock('../agent/requestContextEstimate', () => ({
  estimateContinuationRequestContextTokens: jest.fn(async () => undefined),
}))

jest.mock('../agent/contextBreakdown', () => ({
  estimateContextBreakdown: jest.fn(async () => ({
    buckets: [],
    total: 100,
    max: 1000,
    computedAt: 0,
  })),
}))

import type { App } from 'obsidian'

import { resolveChatModeRuntime } from '../../components/chat-view/chat-runtime-profiles'
import type { ChatManager } from '../../database/json/chat/ChatManager'
import type { ChatConversation as StoredChatConversation } from '../../database/json/chat/types'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { ChatConversation } from '../../types/chat'
import type { ChatMessage } from '../../types/chat'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { estimateContextBreakdown } from '../agent/contextBreakdown'
import { estimateContinuationRequestContextTokens } from '../agent/requestContextEstimate'
import type { AgentService } from '../agent/service'
import { getChatModelClient } from '../llm/manager'
import type { McpManager } from '../mcp/mcpManager'

import type { EffectiveWorkspaceAgent } from './webAgentTypes'
import {
  WebChatRuntimeAdapter,
  workspaceAgentPolicyToRuntimeAccessPolicy,
} from './WebChatRuntimeAdapter'

describe('workspaceAgentPolicyToRuntimeAccessPolicy', () => {
  it('maps the runnable Workspace Agent policy into the existing tool sandbox policy shape', () => {
    expect(
      workspaceAgentPolicyToRuntimeAccessPolicy({
        workspaceRoot: '/Project',
        readAllowlist: ['/Shared'],
        readDenylist: ['/Project/Private'],
        writeDenylist: ['/Project/Locked'],
      }),
    ).toEqual({
      enabled: true,
      workspaceRoot: '/Project',
      readExtraIncludes: ['/Shared'],
      readExcludes: ['/Project/Private'],
      writeExcludes: ['/Project/Locked'],
    })
  })
})

function makeActiveAgent(
  overrides: Partial<EffectiveWorkspaceAgent> = {},
): EffectiveWorkspaceAgent {
  return {
    id: 'agent-1',
    name: 'Agent One',
    templateId: 'template-1',
    createdAt: 0,
    updatedAt: 0,
    workspacePolicy: {
      workspaceRoot: '/Project',
      readAllowlist: [],
      readDenylist: [],
      writeDenylist: [],
    },
    modelId: 'mock-model',
    toolPreferences: {},
    enabledToolNames: [],
    includeBuiltinTools: true,
    enabledSkills: [],
    skillPreferences: {},
    agentModeAllowed: true,
    ...overrides,
  } as unknown as EffectiveWorkspaceAgent
}

function makeSettings(overrides: Partial<YoloSettings> = {}): YoloSettings {
  return {
    chatModelId: 'mock-model',
    chatModels: [],
    providers: [{ id: 'mock-provider', apiType: 'openai-compatible' }],
    assistants: [],
    workspaceAgents: [],
    mcp: { enableToolDisclosure: false, builtinToolOptions: {} },
    chatOptions: {},
    continuationOptions: {
      primaryRequestTimeoutMs: 30000,
      streamFallbackRecoveryEnabled: true,
    },
    skills: {},
    ...overrides,
  } as unknown as YoloSettings
}

function makeConversationBackend(
  conversation: StoredChatConversation | null = null,
): {
  chatManager: ChatManager
  loadConversation: () => Promise<StoredChatConversation | null>
} {
  let current = conversation
  return {
    loadConversation: jest.fn(async () => current),
    chatManager: {
      createChat: jest.fn(
        async (initialData: Partial<StoredChatConversation>) => {
          const created = {
            id: initialData.id ?? 'conv-1',
            title: initialData.title ?? 'New chat',
            messages: initialData.messages ?? [],
            createdAt: initialData.createdAt ?? 0,
            updatedAt: initialData.updatedAt ?? 0,
            schemaVersion: 1,
            origin: initialData.origin,
          } as StoredChatConversation
          current = created
          return created
        },
      ),
    } as unknown as ChatManager,
  }
}

type RunCallArgs = {
  conversationId: string
  persistState?: boolean
  input: {
    toolCapabilityMode?: string
    bypassToolApproval?: boolean
    rejectToolApproval?: boolean
    branchId?: string
    sourceUserMessageId?: string
    branchLabel?: string
    workspaceAccessPolicy?: WorkspaceAccessPolicy
    model?: { id?: string }
  }
}

function makeAgentService(): {
  agentService: AgentService
  runCalls: RunCallArgs[]
} {
  const runCalls: RunCallArgs[] = []
  const run = jest.fn(async (args: RunCallArgs) => {
    runCalls.push(args)
  })
  const agentService = {
    run,
    replaceConversationMessages: jest.fn(),
    subscribe: jest.fn(() => () => {}),
    abortConversation: jest.fn(() => true),
    getSystemPromptSnapshotStore: jest.fn(() => null),
    getPromptSourceWatcher: jest.fn(() => ({
      getRevision: jest.fn(() => 1),
      setWatchedPaths: jest.fn(),
    })),
  } as unknown as AgentService
  return { agentService, runCalls }
}

function makeMcpManager(): McpManager {
  return {
    listAvailableTools: jest.fn(async () => []),
    getJsSandboxSettings: jest.fn(() => ({})),
  } as unknown as McpManager
}

function makeMessage(
  id: string,
  role: 'user' | 'assistant',
  content: string,
): ChatMessage {
  return { role, id, content } as unknown as ChatMessage
}

function makeAssistantMessageWithPromptTokens(
  id: string,
  promptTokens: number,
): ChatMessage {
  return {
    role: 'assistant',
    id,
    content: 'reply',
    metadata: { usage: { prompt_tokens: promptTokens } },
  } as unknown as ChatMessage
}

function makeAdapter(
  options: {
    conversation?: ChatConversation | null
    settings?: YoloSettings
    agentService?: AgentService
    mcpManager?: McpManager
  } = {},
): WebChatRuntimeAdapter {
  const { agentService } = options.agentService
    ? { agentService: options.agentService }
    : makeAgentService()
  const backend = makeConversationBackend(options.conversation)
  return new WebChatRuntimeAdapter({
    app: {} as unknown as App,
    chatManager: backend.chatManager,
    loadConversation: backend.loadConversation,
    getSettings: () => options.settings ?? makeSettings(),
    getAgentService: () => agentService,
    getMcpManager: async () => options.mcpManager ?? makeMcpManager(),
  })
}

const resolveChatModeRuntimeMock = resolveChatModeRuntime as jest.Mock
const RequestContextBuilderMock = RequestContextBuilder as unknown as jest.Mock
const estimateContinuationRequestContextTokensMock =
  estimateContinuationRequestContextTokens as jest.Mock
const estimateContextBreakdownMock = estimateContextBreakdown as jest.Mock
const getChatModelClientMock = getChatModelClient as jest.Mock
const defaultGetChatModelClientImpl =
  getChatModelClientMock.getMockImplementation()

beforeEach(() => {
  resolveChatModeRuntimeMock.mockClear()
  RequestContextBuilderMock.mockClear()
  estimateContinuationRequestContextTokensMock.mockClear()
  estimateContinuationRequestContextTokensMock.mockResolvedValue(undefined)
  estimateContextBreakdownMock.mockClear()
  getChatModelClientMock.mockClear()
})

afterEach(() => {
  getChatModelClientMock.mockImplementation(
    defaultGetChatModelClientImpl ??
      (() => ({ providerClient: {}, model: {} })),
  )
})

describe('WebChatRuntimeAdapter.compactConversation', () => {
  it('returns null immediately without resolving shared context when there are no messages', async () => {
    const { agentService } = makeAgentService()
    const adapter = makeAdapter({ agentService })

    const result = await adapter.compactConversation(
      { conversationId: 'conv-1', messages: [] },
      makeActiveAgent(),
    )

    expect(result).toBeNull()
    expect(resolveChatModeRuntimeMock).not.toHaveBeenCalled()
  })

  it('derives a different runtimeModePrompt for ask vs. agent toolCapabilityMode', async () => {
    const messages = [makeMessage('user-1', 'user', 'hi')]

    async function runWithMode(mode: 'ask' | 'agent') {
      resolveChatModeRuntimeMock.mockReturnValueOnce({
        loopConfig: {
          enableTools: true,
          includeBuiltinTools: true,
          maxAutoIterations: 100,
        },
        allowedToolNames: ['server__search'],
        toolPreferences: undefined,
        toolServerPreferences: undefined,
        toolCapabilityMode: mode,
        bypassToolApproval: true,
      })
      const { agentService } = makeAgentService()
      const adapter = makeAdapter({ agentService })
      await adapter.compactConversation(
        { conversationId: 'conv-1', messages },
        makeActiveAgent(),
      )
      const instance = RequestContextBuilderMock.mock.results.at(-1)?.value
      return instance.generateRequestMessages.mock.calls.at(-1)?.[0]
        .runtimeModePrompt as string
    }

    const askPrompt = await runWithMode('ask')
    const agentPrompt = await runWithMode('agent')

    expect(askPrompt).not.toBe(agentPrompt)
  })

  it('sets estimatedTokensSaved only when the continuation estimate is lower than the pre-compaction prompt tokens', async () => {
    const messages = [
      makeMessage('user-1', 'user', 'hi'),
      makeAssistantMessageWithPromptTokens('assistant-1', 1000),
    ]

    estimateContinuationRequestContextTokensMock.mockResolvedValueOnce(400)
    const savedResult = await makeAdapter().compactConversation(
      { conversationId: 'conv-1', messages },
      makeActiveAgent(),
    )
    expect(savedResult?.estimatedTokensSaved).toBe(600)

    estimateContinuationRequestContextTokensMock.mockResolvedValueOnce(1500)
    const notSavedResult = await makeAdapter().compactConversation(
      { conversationId: 'conv-1', messages },
      makeActiveAgent(),
    )
    expect(notSavedResult?.estimatedTokensSaved).toBeUndefined()
  })

  it('swallows errors from the continuation token estimate and logs a warning instead of throwing', async () => {
    estimateContinuationRequestContextTokensMock.mockRejectedValueOnce(
      new Error('boom'),
    )
    const consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {})

    const messages = [
      makeMessage('user-1', 'user', 'hi'),
      makeMessage('assistant-1', 'assistant', 'hello'),
    ]

    const result = await makeAdapter().compactConversation(
      { conversationId: 'conv-1', messages },
      makeActiveAgent(),
    )

    expect(result).not.toBeNull()
    expect(result?.estimatedNextContextTokens).toBeUndefined()
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      '[YOLO][Web] failed to estimate continuation context tokens',
      expect.any(Error),
    )
    consoleWarnSpy.mockRestore()
  })
})

describe('WebChatRuntimeAdapter.buildContextBreakdown', () => {
  it('returns the empty breakdown shape without resolving shared context when there are no messages', async () => {
    const result = await makeAdapter().buildContextBreakdown(
      { conversationId: 'conv-1', messages: [] },
      makeActiveAgent(),
    )

    expect(result).toEqual({
      buckets: [],
      total: 0,
      max: null,
      computedAt: expect.any(Number),
    })
    expect(resolveChatModeRuntimeMock).not.toHaveBeenCalled()
  })

  it('forwards chatModeRuntime.toolCapabilityMode into estimateContextBreakdown', async () => {
    const messages = [makeMessage('user-1', 'user', 'hi')]

    await makeAdapter().buildContextBreakdown(
      { conversationId: 'conv-1', messages },
      makeActiveAgent(),
    )

    expect(estimateContextBreakdownMock).toHaveBeenCalledWith(
      expect.objectContaining({ toolCapabilityMode: 'agent' }),
    )
  })
})

describe('WebChatRuntimeAdapter.prepareRun', () => {
  it('composes the stored working directory with the current Agent policy', async () => {
    const conversation = {
      id: 'conv-1',
      title: 'Scoped',
      messages: [],
      workingDirectory: '/Projects/Exam',
      createdAt: 0,
      updatedAt: 0,
      schemaVersion: 1,
    } as ChatConversation
    const { agentService, runCalls } = makeAgentService()
    const adapter = makeAdapter({
      agentService,
      conversation,
    })

    const prepared = await adapter.prepareRun(
      {
        conversationId: 'conv-1',
        messages: [makeMessage('user-1', 'user', 'hi')],
      },
      makeActiveAgent({
        workspacePolicy: {
          workspaceRoot: '/Projects',
          readAllowlist: ['/References'],
          readDenylist: ['/Projects/secret'],
          writeDenylist: ['/Projects/locked'],
        },
      }),
    )
    await prepared.execute({
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    })

    expect(runCalls).toHaveLength(1)
    expect(runCalls[0].input.workspaceAccessPolicy).toEqual({
      enabled: true,
      workspaceRoot: '/Projects/Exam',
      readExtraIncludes: ['/Projects', '/References'],
      readExcludes: ['/Projects/secret'],
      writeExcludes: ['/Projects/locked'],
    })
  })

  it('rejects an incompatible stored working directory before starting a run', async () => {
    const conversation = {
      id: 'conv-1',
      title: 'Scoped',
      messages: [],
      workingDirectory: '/Archive',
      createdAt: 0,
      updatedAt: 0,
      schemaVersion: 1,
    } as ChatConversation
    const { agentService, runCalls } = makeAgentService()
    const adapter = makeAdapter({
      agentService,
      conversation,
    })

    await expect(
      adapter.prepareRun(
        {
          conversationId: 'conv-1',
          messages: [makeMessage('user-1', 'user', 'hi')],
        },
        makeActiveAgent(),
      ),
    ).rejects.toThrow('Conversation working directory is not writable')
    expect(runCalls).toEqual([])
  })

  it('constructs an AgentRuntimeRunInput with toolCapabilityMode taken from chatModeRuntime', async () => {
    const { agentService, runCalls } = makeAgentService()
    const adapter = makeAdapter({ agentService })

    const prepared = await adapter.prepareRun(
      {
        conversationId: 'conv-1',
        messages: [makeMessage('user-1', 'user', 'hi')],
      },
      makeActiveAgent(),
    )
    const abortController = new AbortController()
    await prepared.execute({
      abortSignal: abortController.signal,
      onEvent: () => {},
    })

    expect(runCalls).toHaveLength(1)
    expect(runCalls[0].input.toolCapabilityMode).toBe('agent')
  })

  it('forwards runtime approval flags without forcing background rejection', async () => {
    const { agentService, runCalls } = makeAgentService()
    const adapter = makeAdapter({ agentService })

    const prepared = await adapter.prepareRun(
      {
        conversationId: 'conv-1',
        messages: [makeMessage('user-1', 'user', 'hi')],
      },
      makeActiveAgent(),
    )
    await prepared.execute({
      abortSignal: new AbortController().signal,
      onEvent: () => {},
    })

    expect(runCalls[0].input.bypassToolApproval).toBe(true)
    expect(runCalls[0].input.rejectToolApproval).toBeUndefined()
  })

  it('forwards branchId, sourceUserMessageId, and branchLabel on a branch-target run', async () => {
    const { agentService, runCalls } = makeAgentService()
    const adapter = makeAdapter({ agentService })

    const prepared = await adapter.prepareRun(
      {
        conversationId: 'conv-1',
        messages: [makeMessage('user-1', 'user', 'hi')],
        branchTarget: {
          branchId: 'branch-1',
          sourceUserMessageId: 'user-1',
          branchLabel: 'Branch A',
        },
      },
      makeActiveAgent(),
    )
    const abortController = new AbortController()
    await prepared.execute({
      abortSignal: abortController.signal,
      onEvent: () => {},
    })

    expect(runCalls).toHaveLength(1)
    expect(runCalls[0].persistState).toBe(true)
    expect(runCalls[0].input.branchId).toBe('branch-1')
    expect(runCalls[0].input.sourceUserMessageId).toBe('user-1')
    expect(runCalls[0].input.branchLabel).toBe('Branch A')
    expect(runCalls[0].input.toolCapabilityMode).toBe('agent')
  })
})
