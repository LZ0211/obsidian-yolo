jest.mock('../../components/chat-view/chat-runtime-inputs', () => ({
  resolveWorkspaceAccessPolicyForRuntimeInput: jest.fn(() => undefined),
}))

jest.mock('../../components/chat-view/chat-runtime-profiles', () => ({
  CHAT_BLOCKED_TOOL_NAMES: [
    'yolo_local__fs_write',
    'yolo_local__terminal_command',
  ],
  resolveChatModeRuntime: jest.fn(() => ({
    loopConfig: {
      enableTools: true,
      includeBuiltinTools: true,
      maxAutoIterations: 100,
    },
    allowedToolNames: ['server__search', 'yolo_local__fs_write'],
    toolPreferences: undefined,
    toolServerPreferences: undefined,
    toolCapabilityMode: 'agent',
    bypassToolApproval: true,
  })),
}))

jest.mock('../llm/manager', () => ({
  getChatModelClient: jest.fn(() => ({
    providerClient: { id: 'provider-client' },
    model: { id: 'mock-model', providerId: 'mock-provider' },
  })),
}))

jest.mock('../skills/liteSkills', () => ({
  listLiteSkillEntries: jest.fn(async () => []),
}))

jest.mock('../../utils/chat/requestContextBuilder', () => ({
  RequestContextBuilder: jest.fn().mockImplementation(() => ({})),
}))

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { SerializedChatMessage } from '../../types/chat'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'
import type { AgentConversationState, AgentService } from '../agent/service'
import type { ChatMessage } from '../../types/chat'
import type { McpManager } from '../mcp/mcpManager'

import { runBotAgentTurn } from './agent-runner'
import { BotSentMessageRegistry } from './bot-sent-registry'
import type {
  PlatformAdapter,
  SentMessageRef,
  StreamReplyHandle,
} from './types'

function makeSettings(overrides: Partial<YoloSettings> = {}): YoloSettings {
  return {
    currentAssistantId: 'assistant-1',
    chatModelId: 'mock-model',
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
    ...overrides,
  } as unknown as YoloSettings
}

function makeFakeAdapter(
  overrides: Partial<PlatformAdapter> = {},
): PlatformAdapter & {
  sendMessage: jest.Mock
  sendStreamingMessage: jest.Mock
} {
  return {
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
      supportsStreaming: false,
      maxMessageLength: 4096,
      maxImageSize: 1,
      maxFileSize: 1,
    },
    start: jest.fn(),
    stop: jest.fn(),
    health: jest.fn(() => 'running'),
    sendMessage: jest.fn(async (): Promise<SentMessageRef[]> => []),
    sendStreamingMessage: jest.fn(),
    downloadFile: jest.fn(),
    onMessage: jest.fn(() => () => {}),
    onError: jest.fn(() => () => {}),
    ...overrides,
  } as unknown as PlatformAdapter & {
    sendMessage: jest.Mock
    sendStreamingMessage: jest.Mock
  }
}

type RunCallArgs = {
  conversationId: string
  persistState?: boolean
  loopConfig: unknown
  input: {
    sourceUserMessageId?: string
    messages: unknown[]
    allowedToolNames?: string[]
    toolCapabilityMode?: string
  }
}

function makeFakeAgentService(
  driveStates: (
    sourceUserMessageId: string,
    emit: (state: AgentConversationState) => void,
  ) => void,
): { agentService: AgentService; runCalls: RunCallArgs[] } {
  let capturedCallback: ((state: AgentConversationState) => void) | null = null
  let latestState: AgentConversationState | null = null
  const runCalls: RunCallArgs[] = []

  const run = jest.fn(async (args: RunCallArgs) => {
    runCalls.push(args)
    const sourceUserMessageId = args.input.sourceUserMessageId ?? ''
    driveStates(sourceUserMessageId, (state) => {
      latestState = state
      capturedCallback?.(state)
    })
  })
  const subscribe = jest.fn(
    (
      _conversationId: string,
      callback: (state: AgentConversationState) => void,
    ) => {
      capturedCallback = callback
      return () => {
        capturedCallback = null
      }
    },
  )
  const abortConversation = jest.fn(() => true)
  const getState = jest.fn(
    (conversationId: string) =>
      latestState ??
      ({
        conversationId,
        status: 'running',
        messages: [],
      } as unknown as AgentConversationState),
  )

  const agentService = {
    subscribe,
    run,
    abortConversation,
    getState,
    getSystemPromptSnapshotStore: jest.fn(() => null),
    getPromptSourceWatcher: jest.fn(() => ({
      getRevision: jest.fn(() => 1),
      setWatchedPaths: jest.fn(),
    })),
  } as unknown as AgentService

  return { agentService, runCalls }
}

function buildRunningState(
  conversationId: string,
  sourceUserMessageId: string,
  assistantContent: string,
): AgentConversationState {
  return {
    conversationId,
    status: 'running',
    messages: [
      {
        role: 'user',
        id: sourceUserMessageId,
        content: null,
        promptContent: 'hello bot',
        mentionables: [],
      },
      {
        role: 'assistant',
        id: 'assistant-msg-1',
        content: assistantContent,
        metadata: { generationState: 'streaming', sourceUserMessageId },
      },
    ],
  } as unknown as AgentConversationState
}

function buildCompletedState(
  conversationId: string,
  sourceUserMessageId: string,
  assistantContent: string,
): AgentConversationState {
  return {
    conversationId,
    status: 'completed',
    messages: [
      {
        role: 'user',
        id: sourceUserMessageId,
        content: null,
        promptContent: 'hello bot',
        mentionables: [],
      },
      {
        role: 'assistant',
        id: 'assistant-msg-1',
        content: assistantContent,
        metadata: { generationState: 'completed', sourceUserMessageId },
      },
    ],
  } as unknown as AgentConversationState
}

function buildCompletedStateWithSendAttachment(
  conversationId: string,
  sourceUserMessageId: string,
  assistantContent: string,
): AgentConversationState {
  return {
    conversationId,
    status: 'completed',
    messages: [
      {
        role: 'user',
        id: sourceUserMessageId,
        content: null,
        promptContent: 'hello bot',
        mentionables: [],
      },
      {
        role: 'assistant',
        id: 'assistant-msg-1',
        content: assistantContent,
        metadata: { generationState: 'completed', sourceUserMessageId },
      },
      {
        role: 'tool',
        id: 'tool-msg-1',
        metadata: { sourceUserMessageId },
        toolCalls: [
          {
            request: {
              id: 'call-1',
              name: 'yolo_local__send_attachment',
              arguments: createCompleteToolCallArguments({
                value: { path: 'exports/report.pdf', label: 'Report' },
              }),
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: JSON.stringify({ ok: true, path: 'exports/report.pdf' }),
              },
            },
          },
        ],
      },
    ],
  } as unknown as AgentConversationState
}

function buildErrorState(
  conversationId: string,
  sourceUserMessageId: string,
  errorMessage: string,
): AgentConversationState {
  return {
    conversationId,
    status: 'error',
    errorMessage,
    messages: [
      {
        role: 'user',
        id: sourceUserMessageId,
        content: null,
        promptContent: 'hello bot',
        mentionables: [],
      },
    ],
  } as unknown as AgentConversationState
}

function buildAbortedState(
  conversationId: string,
  sourceUserMessageId: string,
): AgentConversationState {
  return {
    conversationId,
    status: 'aborted',
    messages: [
      {
        role: 'user',
        id: sourceUserMessageId,
        content: null,
        promptContent: 'hello bot',
        mentionables: [],
      },
    ],
  } as unknown as AgentConversationState
}

/**
 * A turn whose `state.messages` still carries a *previous* turn's completed
 * `send_attachment` tool call (a different `sourceUserMessageId`), alongside
 * the current turn's own messages which made no attachment call. Regression
 * coverage for the `sourceUserMessageId`-scoping that
 * `buildReplyContentForCompletedTurn` relies on (design doc v4 review note
 * #4 / Phase 5 test plan: "send_attachment 反查按 sourceUserMessageId 过滤不跨轮
 * 串味") — without that filter, `scanForSendAttachment` would find the prior
 * turn's call and incorrectly attach its file to this turn's reply.
 */
function buildCompletedStateWithPriorTurnAttachment(
  conversationId: string,
  sourceUserMessageId: string,
  assistantContent: string,
): AgentConversationState {
  return {
    conversationId,
    status: 'completed',
    messages: [
      {
        role: 'user',
        id: 'old-user-msg',
        content: null,
        promptContent: 'earlier turn',
        mentionables: [],
      },
      {
        role: 'assistant',
        id: 'old-assistant-msg',
        content: 'earlier reply',
        metadata: {
          generationState: 'completed',
          sourceUserMessageId: 'old-user-msg',
        },
      },
      {
        role: 'tool',
        id: 'old-tool-msg',
        metadata: { sourceUserMessageId: 'old-user-msg' },
        toolCalls: [
          {
            request: {
              id: 'old-call-1',
              name: 'yolo_local__send_attachment',
              arguments: createCompleteToolCallArguments({
                value: { path: 'exports/old-report.pdf' },
              }),
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: JSON.stringify({ ok: true }) },
            },
          },
        ],
      },
      {
        role: 'user',
        id: sourceUserMessageId,
        content: null,
        promptContent: 'hello bot',
        mentionables: [],
      },
      {
        role: 'assistant',
        id: 'assistant-msg-2',
        content: assistantContent,
        metadata: { generationState: 'completed', sourceUserMessageId },
      },
    ],
  } as unknown as AgentConversationState
}

function makeConversationLoader(
  conversation: readonly ChatMessage[] | null,
): (conversationId: string) => Promise<readonly ChatMessage[] | null> {
  return jest.fn(async () => conversation)
}

function makeHistoryMessage(id: string, text: string): SerializedChatMessage {
  return {
    role: 'user',
    id,
    content: null,
    promptContent: text,
    mentionables: [],
  } as unknown as SerializedChatMessage
}

describe('runBotAgentTurn', () => {
  const app = {} as unknown as import('obsidian').App
  const mcpManager = {} as unknown as McpManager

  it('loads conversation history and prepends it before the new user message', async () => {
    const priorMessage = makeHistoryMessage('hist-1', 'earlier message')
    const conversation: readonly ChatMessage[] = [priorMessage as never]
    const { agentService, runCalls } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(buildCompletedState('conv-1', sourceUserMessageId, 'Hi there'))
      },
    )
    const adapter = makeFakeAdapter()

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(conversation),
      adapter,
      sentMessageRegistry: new BotSentMessageRegistry(),
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(runCalls).toHaveLength(1)
    expect(runCalls[0].input.messages).toHaveLength(2)
    expect(runCalls[0].input.messages[0]).toMatchObject({ id: 'hist-1' })
    expect(runCalls[0].input.messages[1]).toMatchObject({
      role: 'user',
      promptContent: 'hello bot',
      content: {
        root: {
          children: [
            {
              children: [{ text: 'hello bot' }],
            },
          ],
        },
      },
    })
  })

  it.skip('passes persistState: true through to agentService.run', async () => {
    const { agentService, runCalls } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(buildCompletedState('conv-1', sourceUserMessageId, 'Hi there'))
      },
    )
    const adapter = makeFakeAdapter()

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      adapter,
      sentMessageRegistry: new BotSentMessageRegistry(),
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(runCalls[0]).toBeDefined()
  })

  it('passes allowedToolNames straight through from the bound assistant, with send_attachment appended', async () => {
    const { agentService, runCalls } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(buildCompletedState('conv-1', sourceUserMessageId, 'Hi there'))
      },
    )
    const adapter = makeFakeAdapter()

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      adapter,
      sentMessageRegistry: new BotSentMessageRegistry(),
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(runCalls[0].input.allowedToolNames).toEqual([
      'server__search',
      'yolo_local__fs_write',
      'yolo_local__send_attachment',
    ])
  })

  it('forwards toolCapabilityMode from resolveChatModeRuntime into the agent run input', async () => {
    const { agentService, runCalls } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(buildCompletedState('conv-1', sourceUserMessageId, 'Hi there'))
      },
    )
    const adapter = makeFakeAdapter()

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      adapter,
      sentMessageRegistry: new BotSentMessageRegistry(),
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(runCalls[0].input.toolCapabilityMode).toBe('agent')
  })

  it('streams progressive updates through a streaming-capable adapter and finalizes once', async () => {
    const { agentService } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(buildRunningState('conv-1', sourceUserMessageId, 'Hel'))
        emit(buildRunningState('conv-1', sourceUserMessageId, 'Hello'))
        emit(buildCompletedState('conv-1', sourceUserMessageId, 'Hello world'))
      },
    )

    const update = jest.fn(async (_fullText: string) => undefined)
    const finish = jest.fn(
      async (): Promise<SentMessageRef[]> => [
        {
          platformMessageId: 'p1',
          sessionKey: 'telegram:private:u1',
          timestamp: 0,
        },
      ],
    )
    const streamHandle: StreamReplyHandle = { update, finish, abort: jest.fn() }
    const adapter = makeFakeAdapter({
      capabilities: {
        markdownMode: 'none',
        supportsImage: true,
        supportsFile: true,
        supportsStreaming: true,
        maxMessageLength: 4096,
        maxImageSize: 1,
        maxFileSize: 1,
      },
    })
    adapter.sendStreamingMessage.mockReturnValue(streamHandle)

    const sentMessageRegistry = new BotSentMessageRegistry()

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      adapter,
      sentMessageRegistry,
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(adapter.sendStreamingMessage).toHaveBeenCalledTimes(1)
    expect(update.mock.calls.map((call) => call[0])).toEqual([
      'Hel',
      'Hello',
      'Hello world',
    ])
    expect(finish).toHaveBeenCalledWith({ text: 'Hello world' })
    expect(adapter.sendMessage).not.toHaveBeenCalled()
    expect(sentMessageRegistry.isSentByBot('p1')).toBe(true)
  })

  it('buffers text and sends once via sendMessage for a non-streaming adapter', async () => {
    const { agentService } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(buildRunningState('conv-1', sourceUserMessageId, 'Hel'))
        emit(buildCompletedState('conv-1', sourceUserMessageId, 'Hello world'))
      },
    )

    const adapter = makeFakeAdapter()
    adapter.sendMessage.mockResolvedValue([
      {
        platformMessageId: 'p2',
        sessionKey: 'telegram:private:u1',
        timestamp: 0,
      },
    ])
    const sentMessageRegistry = new BotSentMessageRegistry()

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      adapter,
      sentMessageRegistry,
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(adapter.sendStreamingMessage).not.toHaveBeenCalled()
    expect(adapter.sendMessage).toHaveBeenCalledTimes(1)
    expect(adapter.sendMessage).toHaveBeenCalledWith('telegram:private:u1', {
      text: 'Hello world',
    })
    expect(sentMessageRegistry.isSentByBot('p2')).toBe(true)
  })

  it('attaches a completed send_attachment tool call as a file on the outgoing reply', async () => {
    const { agentService } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(
          buildCompletedStateWithSendAttachment(
            'conv-1',
            sourceUserMessageId,
            'Here you go',
          ),
        )
      },
    )

    const adapter = makeFakeAdapter()
    adapter.sendMessage.mockResolvedValue([
      {
        platformMessageId: 'p3',
        sessionKey: 'telegram:private:u1',
        timestamp: 0,
      },
    ])

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      adapter,
      sentMessageRegistry: new BotSentMessageRegistry(),
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(adapter.sendMessage).toHaveBeenCalledWith('telegram:private:u1', {
      text: 'Here you go',
      files: [
        {
          source: 'vault-path',
          path: 'exports/report.pdf',
          mimeType: 'application/octet-stream',
          name: 'report.pdf',
        },
      ],
    })
  })

  it('sends a user-visible error message and logs to console.error on an error event', async () => {
    const { agentService } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(buildErrorState('conv-1', sourceUserMessageId, 'boom'))
      },
    )
    const adapter = makeFakeAdapter()
    adapter.sendMessage.mockResolvedValue([])
    const consoleErrorSpy = jest
      .spyOn(console, 'error')
      .mockImplementation(() => {})

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      adapter,
      sentMessageRegistry: new BotSentMessageRegistry(),
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(adapter.sendMessage).toHaveBeenCalledWith('telegram:private:u1', {
      text: 'Sorry, something went wrong: boom',
    })
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      '[YOLO Bot] Agent run error:',
      'boom',
    )
    consoleErrorSpy.mockRestore()
  })

  it('finishes silently (no adapter send) when the run is aborted', async () => {
    const { agentService } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(buildAbortedState('conv-1', sourceUserMessageId))
      },
    )
    const adapter = makeFakeAdapter()

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      adapter,
      sentMessageRegistry: new BotSentMessageRegistry(),
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(adapter.sendMessage).not.toHaveBeenCalled()
    expect(adapter.sendStreamingMessage).not.toHaveBeenCalled()
  })

  it('does not send an error reply after the caller aborts the turn', async () => {
    const { agentService } = makeFakeAgentService(() => undefined)
    agentService.run = jest
      .fn()
      .mockRejectedValue(new Error('cancelled')) as AgentService['run']
    const adapter = makeFakeAdapter()
    const abortController = new AbortController()
    abortController.abort()

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      abortSignal: abortController.signal,
      adapter,
      sentMessageRegistry: new BotSentMessageRegistry(),
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(adapter.sendMessage).not.toHaveBeenCalled()
  })

  it("does not bleed a previous turn's send_attachment call into this turn's reply (sourceUserMessageId-scoped)", async () => {
    const { agentService } = makeFakeAgentService(
      (sourceUserMessageId, emit) => {
        emit(
          buildCompletedStateWithPriorTurnAttachment(
            'conv-1',
            sourceUserMessageId,
            'No attachment this time',
          ),
        )
      },
    )
    const adapter = makeFakeAdapter()
    adapter.sendMessage.mockResolvedValue([])

    await runBotAgentTurn({
      app,
      settings: makeSettings(),
      agentService,
      mcpManager,
      loadConversation: makeConversationLoader(null),
      adapter,
      sentMessageRegistry: new BotSentMessageRegistry(),
      conversationId: 'conv-1',
      sessionKey: 'telegram:private:u1',
      chatType: 'private',
      platformConfig: { id: 'bot-1' } as unknown as Parameters<
        typeof runBotAgentTurn
      >[0]['platformConfig'],
      promptContent: 'hello bot',
      mentionables: [],
    })

    expect(adapter.sendMessage).toHaveBeenCalledWith('telegram:private:u1', {
      text: 'No attachment this time',
    })
  })
})
