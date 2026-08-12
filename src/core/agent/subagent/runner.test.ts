import type { ChatMessage } from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { AGENT_SESSION_MODE } from '../../state/contracts'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import type { NativeAgentRuntime } from '../native-runtime'
import type { AgentRuntimeRunInput } from '../types'

import type { ResolvedCurrentSubagentParentAuthority } from './authority-resolver'
import {
  SUBAGENT_BLOCKED_TOOL_NAMES,
  SUBAGENT_DEFAULT_SYSTEM_PROMPT,
} from './constants'
import type { DelegatedAssistantProfile } from './delegated-assistant-profile'
import type { SubagentParentContext } from './parent-context'
import {
  type RunSubagentParams,
  type SubagentSessionGatewayLike,
  autoRejectPendingApprovals,
  buildSubagentContinuationInput,
  buildSubagentInitialRunInput,
  buildSubagentSessionRunInput,
  createSubagentRuntimeLoopController,
  hasUnsettledApprovalBatch,
  resolveSubagentRunPolicy,
  runSubagent,
} from './runner'
import type { SubagentTaskRecord } from './types'

/**
 * R10：durable 测试会真实执行 `new NativeAgentRuntime()` + `runtime.run()`
 * （runner.ts runChildAgent），不 mock 会真实打模型。模块级 mock 仅影响
 * 本文件的运行时代理；现有纯函数测试（plain-object runtime 注入）不受影响。
 * （jest.mock 声明被 babel-jest 提升到 import 之上，位置无碍语义。）
 */
jest.mock('../native-runtime', () => {
  const actual = jest.requireActual('../native-runtime')
  return {
    ...actual,
    NativeAgentRuntime: jest.fn().mockImplementation(() => ({
      subscribe: jest.fn(() => () => {}),
      run: jest.fn(async () => undefined),
      getSnapshot: jest.fn().mockReturnValue({
        messages: [{ role: 'assistant', id: 'assistant-1', content: 'done' }],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      }),
      setToolCallResponse: jest.fn(),
    })),
  }
})
jest.mock('../background-task/completion-bus', () => ({
  backgroundTaskCompletionBus: { pushCompleted: jest.fn() },
}))
jest.mock('../live-stream/taskStreamBus', () => ({
  liveTaskStreamBus: { push: jest.fn() },
}))
jest.mock('../citationRegistry', () => ({
  CitationRegistry: jest.fn().mockImplementation(() => ({})),
}))

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

const makeRuntime = (
  toolMessage: {
    role: 'tool'
    toolCalls: Array<{
      request: { id: string; name: string }
      response: { status: ToolCallResponseStatus; error?: string }
    }>
  } | null,
) => {
  const setToolCallResponse = jest.fn()
  return {
    runtime: {
      getSnapshot: jest.fn().mockReturnValue({
        messages: toolMessage ? [toolMessage] : [],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      }),
      setToolCallResponse,
    } as unknown as NativeAgentRuntime,
    setToolCallResponse,
  }
}

describe('autoRejectPendingApprovals', () => {
  it('rejects only PendingApproval calls and leaves others intact', () => {
    const { runtime, setToolCallResponse } = makeRuntime({
      role: 'tool',
      toolCalls: [
        {
          request: { id: 'pending-1', name: 'tool' },
          response: { status: ToolCallResponseStatus.PendingApproval },
        },
        {
          request: { id: 'running-1', name: 'tool' },
          response: { status: ToolCallResponseStatus.Running },
        },
        {
          request: { id: 'pending-2', name: 'tool' },
          response: { status: ToolCallResponseStatus.PendingApproval },
        },
      ],
    })

    autoRejectPendingApprovals(runtime)

    expect(setToolCallResponse).toHaveBeenCalledTimes(2)
    expect(setToolCallResponse).toHaveBeenCalledWith(
      'pending-1',
      expect.objectContaining({
        status: ToolCallResponseStatus.Error,
        error: expect.stringContaining('5 minutes'),
      }),
    )
    expect(setToolCallResponse).toHaveBeenCalledWith(
      'pending-2',
      expect.any(Object),
    )
    // Running call must not be touched.
    expect(setToolCallResponse).not.toHaveBeenCalledWith(
      'running-1',
      expect.any(Object),
    )
  })

  it('is a no-op when the last message is not a tool message', () => {
    const { runtime, setToolCallResponse } = makeRuntime(null)
    autoRejectPendingApprovals(runtime)
    expect(setToolCallResponse).not.toHaveBeenCalled()
  })

  it('is a no-op when no tool calls are pending', () => {
    const { runtime, setToolCallResponse } = makeRuntime({
      role: 'tool',
      toolCalls: [
        {
          request: { id: 'done-1', name: 'tool' },
          response: { status: ToolCallResponseStatus.Success },
        },
      ],
    })
    autoRejectPendingApprovals(runtime)
    expect(setToolCallResponse).not.toHaveBeenCalled()
  })
})

describe('hasUnsettledApprovalBatch', () => {
  const messagesWithStatuses = (statuses: ToolCallResponseStatus[]) =>
    [
      {
        role: 'tool' as const,
        id: 'tool-message',
        toolCalls: statuses.map((status, index) => ({
          request: { id: `call-${index}`, name: 'tool' },
          response: { status },
        })),
      },
    ] as Parameters<typeof hasUnsettledApprovalBatch>[0]

  it.each([
    ToolCallResponseStatus.PendingApproval,
    ToolCallResponseStatus.AwaitingUserInput,
    ToolCallResponseStatus.Running,
  ])('keeps the batch paused while a call is %s', (status) => {
    expect(
      hasUnsettledApprovalBatch(
        messagesWithStatuses([ToolCallResponseStatus.Success, status]),
      ),
    ).toBe(true)
  })

  it('allows the batch to resume after every call is terminal', () => {
    expect(
      hasUnsettledApprovalBatch(
        messagesWithStatuses([
          ToolCallResponseStatus.Success,
          ToolCallResponseStatus.Rejected,
          ToolCallResponseStatus.Error,
        ]),
      ),
    ).toBe(false)
  })
})

describe('buildSubagentContinuationInput', () => {
  it('keeps the original request prefix instead of replaying runtime messages', () => {
    const requestMessages = [{ role: 'user', content: 'original prompt' }]
    const input = {
      messages: requestMessages,
      requestMessages,
      conversationId: 'sub-test',
    } as unknown as Parameters<typeof buildSubagentContinuationInput>[0]

    const continuation = buildSubagentContinuationInput(input)

    expect(continuation.messages).toBe(requestMessages)
    expect(continuation.requestMessages).toBe(requestMessages)
  })

  it('freezes messages as the request prefix when no explicit prefix exists', () => {
    const messages = [{ role: 'user', content: 'original prompt' }]
    const input = {
      messages,
      conversationId: 'sub-test',
    } as unknown as Parameters<typeof buildSubagentContinuationInput>[0]

    const continuation = buildSubagentContinuationInput(input)

    expect(continuation.requestMessages).toBe(messages)
  })
})

describe('createSubagentRuntimeLoopController', () => {
  const makeToolMessage = (statuses: ToolCallResponseStatus[]): ChatMessage =>
    ({
      role: 'tool',
      id: 'tool-message',
      toolCalls: statuses.map((status, index) => ({
        request: { id: `call-${index}`, name: 'tool' },
        response: { status },
      })),
    }) as unknown as ChatMessage

  const makeAssistantMessage = (content: string): ChatMessage => ({
    role: 'assistant',
    id: 'assistant-1',
    content,
  })

  /**
   * Controlled runtime stub: each `run()` resolves when the test releases it,
   * appending the released message to the transcript. Approvals are simulated
   * by patching the last tool message to a terminal status before `resumeRun`.
   * Releases issued before the runtime actually starts are queued and applied
   * when the run begins (the background-execution wrapper defers `run`).
   */
  const makeLoopRuntime = (initialMessages: ChatMessage[] = []) => {
    const messages: ChatMessage[] = [...initialMessages]
    const queuedReleases: ChatMessage[] = []
    let pendingRunResolve: (() => void) | undefined
    const run = jest.fn(
      () =>
        new Promise<void>((resolve) => {
          pendingRunResolve = resolve
          const next = queuedReleases.shift()
          if (next) {
            messages.push(next)
            pendingRunResolve?.()
            pendingRunResolve = undefined
          }
        }),
    )
    const runtime = {
      getSnapshot: jest.fn(() => ({
        messages: [...messages],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      })),
      run,
      setToolCallResponse: jest.fn(),
    } as unknown as NativeAgentRuntime
    return {
      runtime,
      run,
      releaseRun: (nextMessage: ChatMessage) => {
        if (pendingRunResolve) {
          messages.push(nextMessage)
          pendingRunResolve()
          pendingRunResolve = undefined
        } else {
          queuedReleases.push(nextMessage)
        }
      },
      patchLastToolStatuses: (statuses: ToolCallResponseStatus[]) => {
        const last = messages.at(-1)
        if (!last || last.role !== 'tool') return
        messages[messages.length - 1] = {
          ...last,
          toolCalls: last.toolCalls.map((toolCall, index) => ({
            request: toolCall.request,
            response: { status: statuses[index] },
          })),
        } as unknown as ChatMessage
      },
      messages,
    }
  }

  const makeRunInput = (): AgentRuntimeRunInput =>
    ({
      conversationId: 'sub-test',
      messages: [],
    }) as unknown as AgentRuntimeRunInput

  it('returns the snapshot when the run completes without pausing', async () => {
    const { runtime, run, releaseRun } = makeLoopRuntime()
    const abortController = new AbortController()
    const controller = createSubagentRuntimeLoopController({
      runtime,
      runInput: makeRunInput(),
      abortController,
    })

    const runPromise = controller.run()
    releaseRun(makeAssistantMessage('done'))
    const snapshot = await runPromise

    expect(snapshot.messages.at(-1)?.role).toBe('assistant')
    expect(run).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('resumes after an approval pause and settles', async () => {
    const { runtime, run, releaseRun, patchLastToolStatuses } =
      makeLoopRuntime()
    const abortController = new AbortController()
    const controller = createSubagentRuntimeLoopController({
      runtime,
      runInput: makeRunInput(),
      abortController,
    })

    const runPromise = controller.run()
    // First run pauses on a PendingApproval tool call.
    releaseRun(makeToolMessage([ToolCallResponseStatus.PendingApproval]))
    await flushMicrotasks()
    expect(run).toHaveBeenCalledTimes(1)

    // The user approves: the batch becomes terminal, then the gate is released.
    patchLastToolStatuses([ToolCallResponseStatus.Success])
    await controller.resumeRun()

    // Second run returns the completed snapshot.
    releaseRun(makeAssistantMessage('finished'))
    const snapshot = await runPromise

    expect(snapshot.messages.at(-1)?.role).toBe('assistant')
    expect(run).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('keeps the gate closed while the batch is still unsettled', async () => {
    const { runtime, run, releaseRun, patchLastToolStatuses } =
      makeLoopRuntime()
    const abortController = new AbortController()
    const controller = createSubagentRuntimeLoopController({
      runtime,
      runInput: makeRunInput(),
      abortController,
    })

    const runPromise = controller.run()
    releaseRun(
      makeToolMessage([
        ToolCallResponseStatus.PendingApproval,
        ToolCallResponseStatus.Running,
      ]),
    )
    await flushMicrotasks()

    // One decision alone must not release the mixed batch.
    patchLastToolStatuses([
      ToolCallResponseStatus.Success,
      ToolCallResponseStatus.Running,
    ])
    await controller.resumeRun()
    await flushMicrotasks()
    expect(run).toHaveBeenCalledTimes(1)

    patchLastToolStatuses([
      ToolCallResponseStatus.Success,
      ToolCallResponseStatus.Success,
    ])
    await controller.resumeRun()
    releaseRun(makeAssistantMessage('finished'))
    const snapshot = await runPromise

    expect(snapshot.messages.at(-1)?.role).toBe('assistant')
    expect(run).toHaveBeenCalledTimes(2)
    controller.dispose()
  })

  it('settles on abort while paused on approval', async () => {
    const { runtime, run, releaseRun } = makeLoopRuntime()
    const abortController = new AbortController()
    const controller = createSubagentRuntimeLoopController({
      runtime,
      runInput: makeRunInput(),
      abortController,
    })

    const runPromise = controller.run()
    releaseRun(makeToolMessage([ToolCallResponseStatus.PendingApproval]))
    await flushMicrotasks()

    abortController.abort()
    const snapshot = await runPromise

    // The paused transcript is returned as-is; no further runtime run occurs.
    expect(snapshot.messages.at(-1)?.role).toBe('tool')
    expect(run).toHaveBeenCalledTimes(1)
    controller.dispose()
  })

  it('dispose wakes the gate without running again', async () => {
    const { runtime, run, releaseRun } = makeLoopRuntime()
    const abortController = new AbortController()
    const controller = createSubagentRuntimeLoopController({
      runtime,
      runInput: makeRunInput(),
      abortController,
    })

    const runPromise = controller.run()
    releaseRun(makeToolMessage([ToolCallResponseStatus.PendingApproval]))
    await flushMicrotasks()

    controller.dispose()
    const snapshot = await runPromise

    expect(snapshot.messages.at(-1)?.role).toBe('tool')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('resolveSubagentRunPolicy', () => {
  const makeParent = (): SubagentParentContext =>
    ({
      conversationId: 'parent-test',
      allowedToolNames: ['parent__read', 'role__disabled'],
      toolPreferences: { parent: { enabled: true } },
      toolServerPreferences: { parent: { approvalMode: 'require_approval' } },
      allowedSkillPaths: ['parent/SKILL.md'],
      workspaceAccessPolicy: {
        workspaceRoot: '/vault',
        access: 'full_access',
      },
      loopConfig: {
        enableTools: true,
        includeBuiltinTools: true,
        maxAutoIterations: 5,
      },
      requestContextBuilder: {},
      bypassToolApproval: false,
      enableToolDisclosure: false,
      reasoningLevel: 'full',
      requestParams: {},
    }) as unknown as SubagentParentContext

  const makeDelegatedProfile = (): DelegatedAssistantProfile =>
    ({
      loopConfig: {
        enableTools: true,
        includeBuiltinTools: false,
        maxAutoIterations: 7,
      },
      allowedToolNames: ['role__search', SUBAGENT_BLOCKED_TOOL_NAMES[0]],
      toolPreferences: { role: { enabled: true } },
      toolServerPreferences: { role: { approvalMode: 'full_access' } },
      allowedSkillPaths: ['role/SKILL.md'],
      requestContextBuilder: {},
    }) as unknown as DelegatedAssistantProfile

  it('uses delegated role capabilities while preserving parent safety policy', () => {
    const parent = makeParent()
    const delegatedProfile = makeDelegatedProfile()

    const policy = resolveSubagentRunPolicy({ parent, delegatedProfile })

    expect(policy).toMatchObject({
      loopConfig: delegatedProfile.loopConfig,
      allowedToolNames: ['role__search'],
      toolPreferences: delegatedProfile.toolPreferences,
      toolServerPreferences: delegatedProfile.toolServerPreferences,
      allowedSkillPaths: delegatedProfile.allowedSkillPaths,
      requestContextBuilder: delegatedProfile.requestContextBuilder,
      workspaceAccessPolicy: parent.workspaceAccessPolicy,
      bypassToolApproval: parent.bypassToolApproval,
      systemPromptOverride: undefined,
    })
    expect(policy.allowedToolNames).not.toContain('parent__read')
    expect(policy.allowedToolNames).not.toContain('role__disabled')
    expect(policy.allowedToolNames).not.toContain(
      SUBAGENT_BLOCKED_TOOL_NAMES[0],
    )
  })

  it('keeps generic parent capabilities behind the child deny-list', () => {
    const parent = makeParent()

    const policy = resolveSubagentRunPolicy({ parent })

    expect(policy).toMatchObject({
      loopConfig: {
        enableTools: parent.loopConfig.enableTools,
        includeBuiltinTools: parent.loopConfig.includeBuiltinTools,
        maxAutoIterations: 100,
      },
      allowedToolNames: ['parent__read', 'role__disabled'],
      toolPreferences: parent.toolPreferences,
      toolServerPreferences: parent.toolServerPreferences,
      allowedSkillPaths: parent.allowedSkillPaths,
      requestContextBuilder: parent.requestContextBuilder,
      workspaceAccessPolicy: parent.workspaceAccessPolicy,
      bypassToolApproval: parent.bypassToolApproval,
      systemPromptOverride: SUBAGENT_DEFAULT_SYSTEM_PROMPT,
    })
    expect(policy.allowedToolNames).not.toContain(
      SUBAGENT_BLOCKED_TOOL_NAMES[0],
    )
  })
})

describe('buildSubagentInitialRunInput', () => {
  const makeParent = (): SubagentParentContext =>
    ({
      conversationId: 'parent-test',
      loopConfig: {
        enableTools: true,
        includeBuiltinTools: true,
        maxAutoIterations: 5,
      },
      requestContextBuilder: {},
      mcpManager: {},
      assistantId: 'assistant-parent',
      workspaceAccessPolicy: {
        workspaceRoot: '/vault',
        access: 'full_access',
      },
      allowedToolNames: ['parent__read'],
      toolPreferences: {},
      toolServerPreferences: {},
      allowedSkillPaths: [],
      bypassToolApproval: false,
    }) as unknown as SubagentParentContext

  const makeRecord = (): SubagentTaskRecord =>
    ({
      taskId: 'sub-test',
      conversationId: 'parent-test',
      prompt: 'Inspect the requested files and report findings.',
      abortController: new AbortController(),
    }) as unknown as SubagentTaskRecord

  const makeChildModel = () =>
    ({
      providerClient: {},
      model: { model: 'child-model' },
    }) as unknown as Parameters<
      typeof buildSubagentInitialRunInput
    >[0]['childModel']

  it('builds an isolated child request with the default system prompt', () => {
    const { childUserMessage, runInput, loopConfig } =
      buildSubagentInitialRunInput({
        record: makeRecord(),
        parent: makeParent(),
        childModel: makeChildModel(),
      })

    expect(runInput.systemPromptOverride).toBe(SUBAGENT_DEFAULT_SYSTEM_PROMPT)
    expect(runInput.systemPromptOverride).not.toContain(
      '<assistant_instructions',
    )
    expect(childUserMessage.promptContent).toBe(
      'Inspect the requested files and report findings.',
    )
    expect(childUserMessage).toMatchObject({
      role: 'user',
      content: null,
      mentionables: [],
    })
    expect(childUserMessage.id).toEqual(expect.any(String))
    expect(runInput.messages).toEqual([childUserMessage])
    expect(runInput.requestMessages).toEqual([childUserMessage])
    expect(runInput.conversationId).toBe('sub-test')
    expect(runInput.toolApprovalConversationId).toBe('parent-test')
    expect(loopConfig.enableTools).toBe(true)
  })

  it('uses the delegated profile policy when provided', () => {
    const delegatedProfile = {
      loopConfig: {
        enableTools: true,
        includeBuiltinTools: false,
        maxAutoIterations: 7,
      },
      allowedToolNames: ['role__search'],
      toolPreferences: { role: { enabled: true } },
      toolServerPreferences: { role: { approvalMode: 'full_access' } },
      allowedSkillPaths: ['role/SKILL.md'],
      requestContextBuilder: {},
    } as unknown as DelegatedAssistantProfile

    const { runInput } = buildSubagentInitialRunInput({
      record: makeRecord(),
      parent: makeParent(),
      childModel: makeChildModel(),
      delegatedProfile,
    })

    expect(runInput.allowedToolNames).toEqual(['role__search'])
    expect(runInput.allowedSkillPaths).toEqual(['role/SKILL.md'])
    expect(runInput.systemPromptOverride).toBeUndefined()
    expect(runInput.requestContextBuilder).toBe(
      delegatedProfile.requestContextBuilder,
    )
  })
})

describe('buildSubagentSessionRunInput', () => {
  const makeAuthority = (): ResolvedCurrentSubagentParentAuthority =>
    ({
      conversation: { conversationId: 'parent-conv', assistantId: 'parent-1' },
      providerClient: {},
      model: { model: 'child-model' },
      mcpManager: {},
      requestContextBuilder: {},
      workspaceAccessPolicy: {
        workspaceRoot: '/vault',
        access: 'full_access',
      },
      allowedToolNames: ['parent__read'],
      toolPreferences: { parent: { enabled: true } },
      toolServerPreferences: { parent: { approvalMode: 'require_approval' } },
      allowedSkillPaths: ['parent/SKILL.md'],
      enableToolDisclosure: false,
      reasoningLevel: 'full',
      requestParams: {},
      loopConfig: {
        enableTools: true,
        includeBuiltinTools: true,
        maxAutoIterations: 100,
      },
      bypassToolApproval: false,
      rejectToolApproval: false,
      temporaryApprovedToolNames: [],
      auditSnapshot: {
        modelId: 'child-model',
        allowedToolNames: [],
        allowedSkillPaths: [],
        toolApprovalMode: 'require_approval',
        resolvedAt: 1,
      },
    }) as unknown as ResolvedCurrentSubagentParentAuthority

  const canonicalMessages: ChatMessage[] = [
    {
      role: 'user',
      id: 'prompt-message',
      content: null,
      promptContent: 'Continue the investigation.',
      mentionables: [],
    },
    {
      role: 'assistant',
      id: 'assistant-1',
      content: 'Findings so far.',
    },
  ]

  it('builds an isolated child request from the canonical transcript', () => {
    const runInput = buildSubagentSessionRunInput({
      session: {
        sessionId: 'sub_session',
        parentConversationId: 'parent-conv',
      },
      run: {
        runKey: 'sub_session:2',
        runSequence: 2,
        promptMessageId: 'sub_session:2:prompt',
      },
      canonicalMessages,
      authority: makeAuthority(),
      abortController: new AbortController(),
    })

    expect(runInput.conversationId).toBe('sub_session')
    expect(runInput.runKey).toBe('sub_session:2')
    expect(runInput.sourceUserMessageId).toBe('sub_session:2:prompt')
    expect(runInput.assistantId).toBe('parent-1')
    expect(runInput.toolApprovalConversationId).toBe('parent-conv')
    expect(runInput.systemPromptOverride).toBe(SUBAGENT_DEFAULT_SYSTEM_PROMPT)
    expect(runInput.messages).toEqual(canonicalMessages)
    expect(runInput.messages).not.toBe(canonicalMessages)
    expect(runInput.requestMessages).toEqual(canonicalMessages)
    expect(runInput.requestMessages).not.toBe(canonicalMessages)
    expect(runInput.allowedToolNames).toEqual(['parent__read'])
    expect(runInput.allowedSkillPaths).toEqual(['parent/SKILL.md'])
    expect(runInput.bypassToolApproval).toBe(false)
    expect(runInput.runContext).toBeDefined()
  })

  it('drops the default system prompt when a delegated role is active', () => {
    const runInput = buildSubagentSessionRunInput({
      session: { sessionId: 'sub_session' },
      run: {
        runKey: 'sub_session:1',
        runSequence: 1,
        promptMessageId: 'sub_session:1:prompt',
      },
      canonicalMessages,
      authority: {
        ...makeAuthority(),
        delegatedProfile: {} as DelegatedAssistantProfile,
      },
      abortController: new AbortController(),
    })

    expect(runInput.systemPromptOverride).toBeUndefined()
  })
})

describe('runSubagent durable spawn', () => {
  const makeParent = (): SubagentParentContext =>
    ({
      conversationId: 'parent-test',
      allowedToolNames: ['parent__read'],
      toolPreferences: {},
      toolServerPreferences: {},
      allowedSkillPaths: [],
      workspaceAccessPolicy: {
        workspaceRoot: '/vault',
        access: 'full_access',
      },
      loopConfig: {
        enableTools: true,
        includeBuiltinTools: true,
        maxAutoIterations: 5,
      },
      requestContextBuilder: {},
      mcpManager: {},
      assistantId: 'assistant-parent',
      bypassToolApproval: false,
      enableToolDisclosure: false,
      reasoningLevel: 'full',
      requestParams: {},
    }) as unknown as SubagentParentContext

  const makeChildModel = (): RunSubagentParams['childModel'] =>
    ({
      providerClient: {},
      model: { model: 'child-model', name: 'child-name' },
      apiType: null,
    }) as unknown as RunSubagentParams['childModel']

  const makeGateway = (settleRun: jest.Mock): SubagentSessionGatewayLike =>
    ({
      settleRun,
      query: jest.fn(),
      deliverQueuedIntents: jest.fn(),
    }) as unknown as SubagentSessionGatewayLike

  const makeParams = (
    gateway: SubagentSessionGatewayLike,
    settleRun: jest.Mock,
  ): RunSubagentParams => ({
    description: 't',
    prompt: 'p',
    conversationId: 'c',
    source: {
      type: 'llm_tool_call',
      toolCallId: 'tc',
      assistantMessageId: 'm',
    },
    parent: makeParent(),
    childModel: makeChildModel(),
    sessionId: 'sub_abc',
    runSequence: 2,
    mode: AGENT_SESSION_MODE.PERSISTENT,
    sessionGateway: gateway,
    settleRun,
  })

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('spawns with session identity and settles durably', async () => {
    const settleRun = jest.fn(async () => undefined)
    const onSettleFailure = jest.fn()
    const gateway = makeGateway(settleRun)
    const result = await runSubagent({
      ...makeParams(gateway, settleRun),
      onSettleFailure,
    })

    expect(result.accepted).toBe(true)
    if (!result.accepted) return
    expect(result.sessionId).toBe('sub_abc')
    expect(result.runKey).toBe('sub_abc:2')
    expect(result.mode).toBe(AGENT_SESSION_MODE.PERSISTENT)
    // runChildAgent 完成后结算：service.settleRun 收到终态 settlement
    expect(settleRun).toHaveBeenCalledTimes(1)
    expect(settleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sub_abc',
        runKey: 'sub_abc:2',
        status: 'completed',
        result: expect.objectContaining({
          status: 'completed',
          content: 'done',
        }),
      }),
    )
    expect(onSettleFailure).not.toHaveBeenCalled()
    // R5：每次结算都推送完成事件（含 runSequence > 1 的续跑）
    const pushCompleted = (
      backgroundTaskCompletionBus as unknown as {
        pushCompleted: jest.Mock
      }
    ).pushCompleted
    expect(pushCompleted).toHaveBeenCalledTimes(1)
    expect(pushCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subagent',
        taskId: 'sub_abc',
        conversationId: 'c',
        record: expect.objectContaining({
          runKey: 'sub_abc:2',
          runSequence: 2,
        }),
      }),
    )
  })

  it('rejects a second concurrent run on the same session', async () => {
    const settleRun = jest.fn(async () => undefined)
    const gateway = makeGateway(settleRun)
    const params = makeParams(gateway, settleRun)

    // 第一次 dispatch 后立即第二次（同 sessionId）：首个 runChildAgent 已
    // register/reserve，第二次必须被拒绝（registry 活跃 run 检查或 reserve）。
    const first = runSubagent(params)
    const second = runSubagent(params)
    await expect(second).rejects.toThrow(/already has an active run/)

    await first
    expect(settleRun).toHaveBeenCalledTimes(1)
  })
})
