import type {
  ChatCommandResult,
  ChatRuntime,
} from '../../core/chat-runtime/contract'
import type { ChatRuntimeActions } from '../../core/cli-runtime'

import { adaptContractRuntimeToActions } from './chat-runtime-contract-actions-bridge'

const ok = (): ChatCommandResult => ({ ok: true })
const rejected = (): ChatCommandResult => ({
  ok: false,
  error: { kind: 'rejected', reason: 'stale request', retryable: false },
})

const conversation = {
  runtimeId: 'yolo',
  conversationId: 'conversation-1',
} as const

type MockedContractRuntime = jest.Mocked<
  Pick<
    ChatRuntime,
    'cancel' | 'respondApproval' | 'respondQuestion' | 'dispose'
  >
>

const createRuntime = (): MockedContractRuntime =>
  ({
    cancel: jest.fn(async () => ok()),
    respondApproval: jest.fn(async () => ok()),
    respondQuestion: jest.fn(async () => ok()),
    dispose: jest.fn(async () => undefined),
  }) as unknown as MockedContractRuntime

const getActions = (runtime: MockedContractRuntime): ChatRuntimeActions =>
  adaptContractRuntimeToActions(runtime as unknown as ChatRuntime)

describe('adaptContractRuntimeToActions', () => {
  it('maps cancelRun to the conversation-bound cancel() (no requestId)', async () => {
    const runtime = createRuntime()
    const actions = getActions(runtime)

    await actions.cancelRun(conversation)

    expect(runtime.cancel).toHaveBeenCalledTimes(1)
    expect(runtime.cancel).toHaveBeenCalledWith()
  })

  it('maps approveTool once/session to respondApproval decisions', async () => {
    const runtime = createRuntime()
    const actions = getActions(runtime)

    await actions.approveTool({
      conversation,
      toolCallId: 'tool-1',
    })
    await actions.approveTool({
      conversation,
      toolCallId: 'tool-2',
      allowForConversation: true,
    })

    expect(runtime.respondApproval.mock.calls).toEqual([
      [{ requestId: 'tool-1', decision: 'approve_once' }],
      [{ requestId: 'tool-2', decision: 'approve_for_session' }],
    ])
  })

  it('maps rejectTool to respondApproval reject and abortTool to scoped cancel(requestId)', async () => {
    const runtime = createRuntime()
    const actions = getActions(runtime)

    await actions.rejectTool({ conversation, toolCallId: 'tool-1' })
    await actions.abortTool({ conversation, toolCallId: 'tool-2' })

    expect(runtime.respondApproval).toHaveBeenCalledWith({
      requestId: 'tool-1',
      decision: 'reject',
    })
    expect(runtime.cancel).toHaveBeenCalledWith('tool-2')
  })

  it('maps answerQuestion/cancelQuestion to contract commands with toolCallId as requestId', async () => {
    const runtime = createRuntime()
    const actions = getActions(runtime)

    const result = await actions.answerQuestion({
      conversation,
      toolCallId: 'question-1',
      payload: { answer: 42 },
    })
    await actions.cancelQuestion({
      conversation,
      toolCallId: 'question-2',
    })

    expect(runtime.respondQuestion).toHaveBeenCalledWith({
      requestId: 'question-1',
      answer: { answer: 42 },
    })
    expect(runtime.cancel).toHaveBeenCalledWith('question-2')
    expect(result).toEqual({ kind: 'handled' })
  })

  it('normalizes failed contract commands to stale action results', async () => {
    const runtime = createRuntime()
    runtime.respondApproval.mockResolvedValue(rejected())
    runtime.cancel.mockResolvedValue(rejected())
    const actions = getActions(runtime)

    await expect(
      actions.approveTool({ conversation, toolCallId: 'tool-1' }),
    ).resolves.toEqual({ kind: 'stale' })
    await expect(
      actions.abortTool({ conversation, toolCallId: 'tool-1' }),
    ).resolves.toEqual({ kind: 'stale' })
  })
})
