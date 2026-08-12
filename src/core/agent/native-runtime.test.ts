import type { ChatAssistantMessage, ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { executeSingleTurn } from '../ai/single-turn'

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

import {
  type BackgroundTaskCompletedEvent,
  backgroundTaskCompletionBus,
} from './background-task/completion-bus'
import {
  ASSISTANT_CONTINUATION_PROMPT,
  NativeAgentRuntime,
} from './native-runtime'
import {
  getParentSubagentBreakerState,
  hasParentSubagentDeadline,
  isParentSubagentToolCallTimedOut,
  markParentSubagentTimeoutSettled,
  registerParentSubagentDeadline,
  resetParentSubagentBreakers,
  resetParentSubagentDeadlines,
  resetParentSubagentTimeoutConfig,
  setParentSubagentTimeoutConfig,
} from './subagent/pending-timeout-registry'
import { subagentTaskRegistry } from './subagent/task-registry'
import type { SubagentTaskRecord } from './subagent/types'
import type { AgentToolGateway } from './tool-gateway'
import { shouldProceedToToolPhase } from './tool-phase'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from './types'

const mockedExecuteSingleTurn = jest.mocked(executeSingleTurn)

describe('shouldProceedToToolPhase', () => {
  it('returns true when tool call requests exist even if model terminated', () => {
    const turnResult = {
      toolCallRequests: [{ id: 'call-1' }],
      modelTerminated: true,
    }
    const result = shouldProceedToToolPhase(turnResult)

    expect(result).toBe(true)
  })

  it('returns false when tool call requests are empty', () => {
    const turnResult = {
      toolCallRequests: [],
      modelTerminated: false,
    }
    const result = shouldProceedToToolPhase(turnResult)

    expect(result).toBe(false)
  })
})

describe('NativeAgentRuntime tool-call helpers', () => {
  const makeLoopConfig = (): AgentRuntimeLoopConfig => ({
    enableTools: true,
    includeBuiltinTools: true,
    maxAutoIterations: 10,
  })

  const makeToolMessage = (
    toolCallId: string,
    status: ToolCallResponseStatus = ToolCallResponseStatus.PendingApproval,
  ): ChatMessage => ({
    role: 'tool',
    id: 'tool-msg-1',
    metadata: {},
    toolCalls: [
      {
        request: {
          id: toolCallId,
          name: 'yolo_local__fs_edit',
          arguments: undefined,
        },
        response:
          status === ToolCallResponseStatus.Success
            ? {
                status,
                data: { type: 'text', text: 'ok' },
              }
            : status === ToolCallResponseStatus.Error
              ? { status, error: 'boom' }
              : { status },
      },
    ],
  })

  // Cast to a structurally-equivalent shape to seed the runtime's private
  // `messages` for unit testing approval-routing helpers in isolation.
  // Production code never touches the runtime this way; everything goes
  // through `run()`.
  const seedMessages = (
    runtime: NativeAgentRuntime,
    messages: ChatMessage[],
  ): void => {
    ;(runtime as unknown as { messages: ChatMessage[] }).messages = messages
  }

  it('findToolCall locates a tool call by id', () => {
    const runtime = new NativeAgentRuntime(makeLoopConfig())
    seedMessages(runtime, [makeToolMessage('call-1')])

    const located = runtime.findToolCall('call-1')
    expect(located).not.toBeNull()
    expect(located?.toolCall.request.id).toBe('call-1')
    expect(located?.toolCall.response.status).toBe(
      ToolCallResponseStatus.PendingApproval,
    )
  })

  it('findToolCall returns null when no message contains the id', () => {
    const runtime = new NativeAgentRuntime(makeLoopConfig())
    seedMessages(runtime, [makeToolMessage('call-1')])

    expect(runtime.findToolCall('missing')).toBeNull()
  })

  it('setToolCallResponse patches the matching call and notifies subscribers', () => {
    const runtime = new NativeAgentRuntime(makeLoopConfig())
    seedMessages(runtime, [makeToolMessage('call-1')])

    const subscriber = jest.fn()
    runtime.subscribe(subscriber)

    const patched = runtime.setToolCallResponse('call-1', {
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'done' },
    })

    expect(patched).toBe(true)
    expect(subscriber).toHaveBeenCalledTimes(1)

    const after = runtime.findToolCall('call-1')
    expect(after?.toolCall.response.status).toBe(ToolCallResponseStatus.Success)
  })

  it('setToolCallResponse returns false when no message contains the id', () => {
    const runtime = new NativeAgentRuntime(makeLoopConfig())
    seedMessages(runtime, [makeToolMessage('call-1')])

    const subscriber = jest.fn()
    runtime.subscribe(subscriber)

    const patched = runtime.setToolCallResponse('missing', {
      status: ToolCallResponseStatus.Rejected,
    })

    expect(patched).toBe(false)
    expect(subscriber).not.toHaveBeenCalled()
  })
})

describe('NativeAgentRuntime assistant continuation', () => {
  beforeEach(() => {
    mockedExecuteSingleTurn.mockReset()
  })

  it('sanitizes the interrupted tool call and sends one transient continuation prompt', async () => {
    const interruptedAssistant: ChatAssistantMessage = {
      role: 'assistant',
      id: 'assistant-1',
      content: 'partial',
      toolCallRequests: [
        {
          id: 'partial-tool',
          name: 'fs_read',
          arguments: undefined,
        },
      ],
      metadata: {
        generationState: 'error',
        errorMessage: 'Premature close',
        sourceUserMessageId: 'user-1',
      },
    }
    const messages: ChatMessage[] = [
      {
        role: 'user',
        id: 'user-1',
        content: null,
        promptContent: 'question',
        mentionables: [],
      },
      interruptedAssistant,
    ]
    const generateRequestMessages = jest.fn().mockResolvedValue([
      { role: 'user', content: 'question' },
      { role: 'assistant', content: 'partial' },
    ])
    mockedExecuteSingleTurn.mockResolvedValue({
      content: ' continuation',
      reasoning: undefined,
      annotations: undefined,
      usage: undefined,
      providerMetadata: undefined,
      toolCalls: [],
    })

    const runtime = new NativeAgentRuntime({
      enableTools: false,
      includeBuiltinTools: false,
      maxAutoIterations: 1,
    })
    const snapshots: ChatMessage[][] = []
    runtime.subscribe((snapshot) => snapshots.push(snapshot.messages))

    await runtime.run({
      providerClient: {
        resolveResponseExecutionMode: () => 'incremental-streaming',
      },
      model: {
        id: 'model-1',
        model: 'model-1',
        providerId: 'provider-1',
      },
      messages,
      requestMessages: messages,
      conversationId: 'conversation-1',
      sourceUserMessageId: 'user-1',
      continueAssistantMessageId: interruptedAssistant.id,
      requestContextBuilder: { generateRequestMessages },
      mcpManager: {
        getJsSandboxSettings: () => ({}),
        getSettingsSnapshot: () => ({}),
      },
    } as unknown as AgentRuntimeRunInput)

    expect(generateRequestMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: interruptedAssistant.id,
            toolCallRequests: undefined,
          }),
        ]),
      }),
    )
    expect(mockedExecuteSingleTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          messages: expect.arrayContaining([
            {
              role: 'user',
              content: ASSISTANT_CONTINUATION_PROMPT,
            },
          ]),
        }),
      }),
    )
    expect(snapshots.at(-1)).toEqual([
      expect.objectContaining({
        id: interruptedAssistant.id,
        content: 'partial continuation',
        toolCallRequests: undefined,
        metadata: expect.objectContaining({ generationState: 'completed' }),
      }),
    ])
  })
})

describe('NativeAgentRuntime parent subagent deadline wiring', () => {
  const DELEGATE_TOOL_CALL_ID = 'subagent-tool-1'
  const CONVERSATION_ID = 'conversation-1'

  const makeRunningDelegateToolMessage = (): ChatMessage => ({
    role: 'tool',
    id: 'tool-msg-delegate',
    metadata: {},
    toolCalls: [
      {
        request: {
          id: DELEGATE_TOOL_CALL_ID,
          name: 'yolo_local__delegate_subagent',
          arguments: {
            kind: 'complete',
            value: {
              description: 'QA task',
              prompt: 'Return the QA result.',
            },
          },
        },
        response: { status: ToolCallResponseStatus.Running },
      },
    ],
  })

  // White-box seam matching the file's existing seeded-message tests: the loop
  // worker is a real `Worker` (cannot run under jest), so the deadline
  // registration + expiry handlers are exercised directly.
  const withDeadlineInternals = (runtime: NativeAgentRuntime) =>
    runtime as unknown as {
      registerSubagentDeadlines: (input: {
        toolMessage: ChatMessage
        runKey: string
        conversationId: string
        toolGateway: AgentToolGateway
      }) => Promise<void>
      reassertExpiredSubagentDeadlines: (toolMessage: ChatMessage) => void
      cleanupSettledSubagentDeadlines: (toolMessage: ChatMessage) => void
    }

  beforeEach(() => {
    setParentSubagentTimeoutConfig({ timeoutMs: 1000 })
  })

  afterEach(() => {
    resetParentSubagentDeadlines()
    resetParentSubagentBreakers()
    resetParentSubagentTimeoutConfig()
    jest.useRealTimers()
  })

  it('registers a deadline for a Running delegate_subagent call and fires the full expiry chain', async () => {
    jest.useFakeTimers()
    const runtime = new NativeAgentRuntime({
      enableTools: true,
      includeBuiltinTools: false,
      maxAutoIterations: 2,
    })
    ;(runtime as unknown as { messages: ChatMessage[] }).messages = [
      {
        role: 'assistant',
        id: 'assistant-1',
        content: '',
        metadata: { generationState: 'completed' },
        toolCallRequests: [],
      },
      makeRunningDelegateToolMessage(),
    ]
    const abortToolCall = jest.fn()
    const toolGateway = { abortToolCall } as unknown as AgentToolGateway

    // A child task is admitted for the parent tool call, so the expiry must
    // abort it through the task registry.
    const childController = new AbortController()
    const childRecord: SubagentTaskRecord = {
      taskId: 'sub-child-1',
      conversationId: CONVERSATION_ID,
      source: {
        type: 'llm_tool_call',
        toolCallId: DELEGATE_TOOL_CALL_ID,
        assistantMessageId: 'assistant-1',
      },
      title: 'QA task',
      status: 'running',
      createdAt: 1,
      prompt: 'Return the QA result.',
      abortController: childController,
    }
    subagentTaskRegistry.register(childRecord)

    const completedEvents: BackgroundTaskCompletedEvent[] = []
    const unsubscribe = backgroundTaskCompletionBus.subscribeCompleted(
      (event) => {
        completedEvents.push(event)
      },
    )

    try {
      await withDeadlineInternals(runtime).registerSubagentDeadlines({
        toolMessage: makeRunningDelegateToolMessage(),
        runKey: 'run-1',
        conversationId: CONVERSATION_ID,
        toolGateway,
      })

      expect(hasParentSubagentDeadline(DELEGATE_TOOL_CALL_ID)).toBe(true)

      // No heartbeat: past the 1000ms deadline the expiry chain fires.
      await jest.advanceTimersByTimeAsync(1001)

      // The child was aborted and the in-flight executor settled.
      expect(childController.signal.aborted).toBe(true)
      expect(abortToolCall).toHaveBeenCalledWith(DELEGATE_TOOL_CALL_ID)

      // The settlement marker survives (the service clears the deadline entry
      // when the synthetic result is consumed).
      expect(hasParentSubagentDeadline(DELEGATE_TOOL_CALL_ID)).toBe(true)
      expect(isParentSubagentToolCallTimedOut(DELEGATE_TOOL_CALL_ID)).toBe(true)

      // The tool call was settled `error` with the timeout marker (master has
      // no `timeout` response status).
      const toolMessage = runtime
        .getMessages()
        .find((message) => message.role === 'tool')
      expect(toolMessage?.toolCalls?.[0]?.response).toEqual({
        status: ToolCallResponseStatus.Error,
        error: 'subagent_timeout',
      })

      // The synthetic timeout record was pushed on the completion bus.
      expect(completedEvents).toEqual([
        expect.objectContaining({
          kind: 'subagent',
          conversationId: CONVERSATION_ID,
          record: expect.objectContaining({
            status: 'aborted',
            error: 'subagent_timeout',
            source: {
              type: 'llm_tool_call',
              toolCallId: DELEGATE_TOOL_CALL_ID,
              assistantMessageId: 'assistant-1',
            },
            result: expect.objectContaining({
              status: 'aborted',
              content: expect.stringContaining(
                'did not respond before its deadline',
              ),
            }),
          }),
        }),
      ])

      // The per-conversation breaker was incremented.
      expect(getParentSubagentBreakerState(CONVERSATION_ID)).toMatchObject({
        consecutiveTimeouts: 1,
        blocked: false,
      })
    } finally {
      unsubscribe()
    }
  })

  it('reasserts the error settlement on expired calls and drops the marker when no child task exists', () => {
    const runtime = new NativeAgentRuntime({
      enableTools: true,
      includeBuiltinTools: false,
      maxAutoIterations: 2,
    })
    const settledToolMessage: ChatMessage = {
      role: 'tool',
      id: 'tool-msg-settled',
      metadata: {},
      toolCalls: [
        {
          request: {
            id: 'settled-call',
            name: 'yolo_local__delegate_subagent',
            arguments: undefined,
          },
          response: {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: 'accepted' },
          },
        },
      ],
    }
    ;(runtime as unknown as { messages: ChatMessage[] }).messages = [
      settledToolMessage,
    ]

    // A deadline expired mid-execution; the gateway overwrote the response
    // with a late Success. The settled marker drives the re-assert.
    markParentSubagentTimeoutSettled('settled-call')

    withDeadlineInternals(runtime).reassertExpiredSubagentDeadlines(
      settledToolMessage,
    )

    const located = runtime.findToolCall('settled-call')
    expect(located?.toolCall.response).toEqual({
      status: ToolCallResponseStatus.Error,
      error: 'subagent_timeout',
    })
    // No child task was admitted: the marker is dropped immediately.
    expect(isParentSubagentToolCallTimedOut('settled-call')).toBe(false)
  })

  it('clears deadlines for dispatched-failed calls but keeps Success-settled ones', () => {
    const runtime = new NativeAgentRuntime({
      enableTools: true,
      includeBuiltinTools: false,
      maxAutoIterations: 2,
    })
    const failedToolMessage: ChatMessage = {
      role: 'tool',
      id: 'tool-msg-failed',
      metadata: {},
      toolCalls: [
        {
          request: {
            id: 'failed-call',
            name: 'yolo_local__delegate_subagent',
            arguments: undefined,
          },
          response: { status: ToolCallResponseStatus.Error, error: 'boom' },
        },
        {
          request: {
            id: 'kept-call',
            name: 'yolo_local__delegate_subagent',
            arguments: undefined,
          },
          response: {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: 'accepted' },
          },
        },
      ],
    }
    registerParentSubagentDeadline({
      toolCallId: 'failed-call',
      runKey: 'run-1',
      conversationId: CONVERSATION_ID,
      onExpire: () => undefined,
    })
    registerParentSubagentDeadline({
      toolCallId: 'kept-call',
      runKey: 'run-1',
      conversationId: CONVERSATION_ID,
      onExpire: () => undefined,
    })

    withDeadlineInternals(runtime).cleanupSettledSubagentDeadlines(
      failedToolMessage,
    )

    // The failed dispatch's deadline is gone (no child will ever heartbeat);
    // the accepted call's deadline survives for the background child.
    expect(hasParentSubagentDeadline('failed-call')).toBe(false)
    expect(hasParentSubagentDeadline('kept-call')).toBe(true)
  })
})
