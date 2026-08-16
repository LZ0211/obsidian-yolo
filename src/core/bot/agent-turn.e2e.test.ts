// End-to-end for the merged upstream render-stream pipeline (0ba94dbf8):
// a REAL AgentService (mock native-runtime emitting streaming snapshots) + a
// REAL runBotAgentTurn + the real streamResolvedAgentRunEvents consumer —
// the exact chain the merge's render-stream routing must not break for the
// fork's bot path. The fake-agentService tests in agent-runner.test.ts
// bypass this chain entirely.
import { ChatMessage } from '../../types/chat'
import type { AgentRuntimeRunInput } from '../agent/types'

import { runBotAgentTurn } from './agent-runner'
import { BotSentMessageRegistry } from './bot-sent-registry'
import type { PlatformAdapter, StreamReplyHandle } from './types'

type MockRuntimeInstance = {
  emitSnapshot: (messages: ChatMessage[]) => void
  resolveRun: () => void
  rejectRun: (error: Error) => void
}

const runtimeInstances: MockRuntimeInstance[] = []

// The LLM client construction is out of scope for this chain — the native
// runtime (which would make the actual model calls) is mocked below.
jest.mock('../llm/manager', () => ({
  getChatModelClient: jest.fn(() => ({
    providerClient: { id: 'provider-client' },
    model: { id: 'mock-model', providerId: 'mock-provider' },
  })),
}))

jest.mock('../../components/chat-view/chat-runtime-inputs', () => ({
  resolveWorkspaceScopeForRuntimeInput: jest.fn(() => undefined),
  resolveWorkspaceAccessPolicyForRuntimeInput: jest.fn(() => undefined),
}))

jest.mock('../../components/chat-view/chat-runtime-profiles', () => ({
  resolveChatModeRuntime: jest.fn(() => ({
    loopConfig: {
      enableTools: true,
      maxAutoIterations: 100,
      includeBuiltinTools: true,
    },
  })),
}))

jest.mock('../skills/liteSkills', () => ({
  listLiteSkillEntries: jest.fn(async () => []),
}))

jest.mock('../../utils/chat/requestContextBuilder', () => ({
  RequestContextBuilder: jest.fn().mockImplementation(() => ({})),
}))

jest.mock('../agent/native-runtime', () => ({
  NativeAgentRuntime: jest.fn().mockImplementation(() => {
    let subscriber: ((snapshot: { messages: ChatMessage[] }) => void) | null =
      null
    let resolveRun: (() => void) | null = null
    let rejectRun: ((error: Error) => void) | null = null
    const runPromise = new Promise<void>((resolve, reject) => {
      resolveRun = resolve
      rejectRun = reject
    })
    const instance: MockRuntimeInstance = {
      emitSnapshot: (messages) => {
        subscriber?.({ messages })
      },
      resolveRun: () => {
        resolveRun?.()
      },
      rejectRun: (error: Error) => {
        rejectRun?.(error)
      },
    }
    runtimeInstances.push(instance)
    return {
      abort: jest.fn(),
      run: jest.fn(() => runPromise),
      subscribe: jest.fn((callback: (snapshot: { messages: ChatMessage[] }) => void) => {
        subscriber = callback
        return () => {
          subscriber = null
        }
      }),
      notifyUserInputAvailable: jest.fn(),
      applyToolCallDecision: jest.fn(),
      getRunSnapshot: jest.fn(),
    }
  }),
}))

import { AgentService } from '../agent/service'

const makeSettings = (): Record<string, unknown> =>
  ({
    currentAssistantId: 'assistant-1',
    chatModelId: 'mock-model',
    chatTitleModelId: 'mock-model',
    assistants: [
      {
        id: 'assistant-1',
        modelId: 'mock-model',
        toolPreferences: {},
        enabledToolNames: [],
        includeBuiltinTools: true,
        enabledSkills: [],
        skillPreferences: {},
      },
    ],
    workspaceAgents: [],
    providers: [{ id: 'mock-provider', apiType: 'openai' }],
    chatModels: [{ id: 'mock-model', providerId: 'mock-provider' }],
    mcp: { enableToolDisclosure: false },
    continuationOptions: {
      primaryRequestTimeoutMs: 30000,
      streamFallbackRecoveryEnabled: true,
    },
    skills: {},
    bots: {
      enabled: true,
      whitelistEnabled: true,
      groupChatEnabled: true,
      adminUsers: [],
      platforms: [],
      sessionMappings: [],
    },
  }) as Record<string, unknown>

const makeFakeAdapter = (
  streaming: boolean,
): PlatformAdapter & {
  sendMessage: jest.Mock
  sendStreamingMessage: jest.Mock
} =>
  ({
    meta: {
      name: 'telegram',
      displayName: 'Telegram',
      description: '',
      version: '1.0.0',
    },
    capabilities: {
      markdownMode: 'none',
      supportsImage: true,
      supportsFile: true,
      supportsStreaming: streaming,
      maxMessageLength: 4096,
      maxImageSize: 1,
      maxFileSize: 1,
    },
    start: jest.fn(),
    stop: jest.fn(),
    health: jest.fn(() => 'running'),
    sendMessage: jest.fn(async () => []),
    sendStreamingMessage: jest.fn(),
    downloadFile: jest.fn(),
    onMessage: jest.fn(() => () => {}),
    onError: jest.fn(() => () => {}),
  }) as unknown as PlatformAdapter & {
    sendMessage: jest.Mock
    sendStreamingMessage: jest.Mock
  }

const makeAssistant = (content: string): ChatMessage => ({
  role: 'assistant',
  id: 'assistant-streaming',
  content,
  metadata: { generationState: 'streaming' },
})

const makeUserMessage = (id: string, text: string): ChatMessage => ({
  role: 'user',
  id,
  content: null,
  promptContent: text,
  mentionables: [],
})

async function driveBotTurn(params: {
  streaming: boolean
  drive: (runtime: MockRuntimeInstance) => void
}): Promise<{
  adapter: ReturnType<typeof makeFakeAdapter>
  sentMessageRegistry: BotSentMessageRegistry
}> {
  const service = new AgentService()
  const adapter = makeFakeAdapter(params.streaming)
  if (params.streaming) {
    const handle: StreamReplyHandle = {
      update: jest.fn(async () => undefined),
      finish: jest.fn(async () => []),
      abort: jest.fn(),
    }
    ;(adapter.sendStreamingMessage as jest.Mock).mockReturnValue(handle)
  }
  const sentMessageRegistry = new BotSentMessageRegistry()
  const mcpManager = {
    registerInProcessServer: jest.fn(() => jest.fn()),
  } as never

  const runPromise = runBotAgentTurn({
    app: {} as never,
    settings: makeSettings() as never,
    agentService: service,
    mcpManager,
    loadConversation: jest.fn(async () => null),
    adapter,
    sentMessageRegistry,
    conversationId: 'conv-1',
    sessionKey: 'telegram:private:u1',
    chatType: 'private',
    platformConfig: { id: 'bot-1' } as never,
    promptContent: 'hello bot',
    mentionables: [],
  })

  // The turn enqueues the user message and starts the agent run
  // asynchronously; wait for the runtime to spin up, then drive it.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  const runtime = runtimeInstances[0]
  expect(runtime).toBeDefined()
  params.drive(runtime)
  await runPromise

  return { adapter, sentMessageRegistry }
}

describe('bot turn over the real agent run + render-stream pipeline, e2e', () => {
  beforeEach(() => {
    runtimeInstances.length = 0
  })

  it('routes streaming snapshots through the render stream into a streaming adapter', async () => {
    const { adapter } = await driveBotTurn({
      streaming: true,
      drive: (runtime) => {
        const user = makeUserMessage('u1', 'hello bot')
        runtime.emitSnapshot([user, makeAssistant('a')])
        runtime.emitSnapshot([user, makeAssistant('ab')])
        runtime.emitSnapshot([user, makeAssistant('abc')])
        runtime.resolveRun()
      },
    })

    const sendStreamingMessage = adapter.sendStreamingMessage as jest.Mock
    expect(sendStreamingMessage).toHaveBeenCalledTimes(1)
    const handle = sendStreamingMessage.mock.results[0]
      .value as never as {
      update: jest.Mock
      finish: jest.Mock
      abort: jest.Mock
    }
    // Render-stream deltas arrive as full-text updates (the merge's
    // pushAssistantText contract); the adapter's handle never sees stale
    // snapshot-only folds.
    expect(handle.update).toHaveBeenCalledWith('abc')
    expect(handle.finish).toHaveBeenCalled()
  })

  it('buffers for a non-streaming adapter and sends once on completion', async () => {
    const { adapter } = await driveBotTurn({
      streaming: false,
      drive: (runtime) => {
        const user = makeUserMessage('u1', 'hello bot')
        runtime.emitSnapshot([user, makeAssistant('a')])
        runtime.emitSnapshot([user, makeAssistant('ab')])
        runtime.emitSnapshot([user, makeAssistant('abc')])
        runtime.resolveRun()
      },
    })

    const sendMessage = adapter.sendMessage as jest.Mock
    expect(adapter.sendStreamingMessage as jest.Mock).not.toHaveBeenCalled()
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1]).toMatchObject({ text: 'abc' })
  })

  it('surfaces a runtime failure as an error reply', async () => {
    const { adapter } = await driveBotTurn({
      streaming: false,
      drive: (runtime) => {
        runtime.rejectRun(new Error('model exploded'))
      },
    })

    const sendMessage = adapter.sendMessage as jest.Mock
    expect(sendMessage).toHaveBeenCalledTimes(1)
    expect(sendMessage.mock.calls[0][1].text).toContain(
      'Sorry, something went wrong',
    )
  })
})
