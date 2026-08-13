import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import type { NativeAgentRuntime } from '../native-runtime'

import {
  isParentSubagentDeadlineExpired,
  registerParentSubagentDeadline,
  resetParentSubagentDeadlines,
  resetParentSubagentTimeoutConfig,
  setParentSubagentTimeoutConfig,
} from './pending-timeout-registry'
import { SUBAGENT_DEFAULT_SYSTEM_PROMPT } from './constants'
import type { DelegatedAssistantProfile } from './delegated-assistant-profile'
import type { SubagentParentContext } from './parent-context'
import {
  type RunSubagentParams,
  autoRejectPendingApprovals,
  buildSubagentContinuationInput,
  buildSubagentInitialRunInput,
  hasUnsettledApprovalBatch,
  resolveSubagentRunPolicy,
  runSubagent,
} from './runner'
import { subagentTaskRegistry } from './task-registry'
import { SUBAGENT_BLOCKED_TOOL_NAMES } from './tool-name-utils'
import type { SubagentTaskRecord } from './types'

/**
 * runSubagent 测试会真实执行 `new NativeAgentRuntime()` + `runtime.run()`
 * （runner.ts runChildAgent），不 mock 会真实打模型。模块级 mock 仅影响
 * 本文件的运行时代理；现有纯函数测试（plain-object runtime 注入）不受影响。
 * （jest.mock 声明被 babel-jest 提升到 import 之上，位置无碍语义。）
 *
 * runtime.run() 用可释放的 gate 挂起：fire-and-forget 不阻塞测试（Task 7
 * 审查 #3）依赖"runSubagent 返回 accepted 时子 run 仍在跑"这一确定性时序。
 */
let runGate: Promise<void> | null = null
let releaseRunGate: (() => void) | null = null
const gateRuntimeRun = (): Promise<void> => {
  if (!runGate) {
    runGate = new Promise<void>((resolve) => {
      releaseRunGate = resolve
    })
  }
  return runGate
}

jest.mock('../native-runtime', () => {
  const actual = jest.requireActual('../native-runtime')
  return {
    ...actual,
    NativeAgentRuntime: jest.fn().mockImplementation(() => ({
      subscribe: jest.fn(() => () => {}),
      run: jest.fn(() => gateRuntimeRun()),
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
  liveTaskStreamBus: {
    push: jest.fn(),
    // F5 test registers a parent deadline, which subscribes to the stream as
    // its heartbeat source; the mock must expose the subscription surface.
    subscribe: jest.fn(() => () => {}),
    getSnapshot: jest.fn(() => null),
  },
}))
jest.mock('../citationRegistry', () => ({
  CitationRegistry: jest.fn().mockImplementation(() => ({
    size: 0,
    assign: jest.fn(),
    toArray: jest.fn(() => []),
  })),
  attachSourcesToLatestAssistant: jest.fn((messages) => messages),
}))

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

/**
 * 等子 run 真正到达 runtime gate（runChildAgent → runWithBackgroundExecution →
 * runtime.run() 是多次 await 的链；在 gate 创建前 release 会永久漏掉释放，
 * 且 registrar 是跨测试单例——泄漏会污染后续测试）。
 */
const waitForRunGate = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !runGate; attempt += 1) {
    await flushMicrotasks()
  }
  expect(releaseRunGate).not.toBeNull()
}

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

const makeRunSubagentParent = (): SubagentParentContext =>
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

const makeParams = (): RunSubagentParams => ({
  description: 't',
  prompt: 'p',
  conversationId: 'c',
  source: {
    type: 'llm_tool_call',
    toolCallId: 'tc',
    assistantMessageId: 'm',
  },
  parent: makeRunSubagentParent(),
  childModel: makeChildModel(),
})

describe('runSubagent ephemeral dispatch', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    runGate = null
    releaseRunGate = null
  })

  it('returns accepted immediately and pushes a completion event when the child settles', async () => {
    const result = await runSubagent(makeParams())

    expect(result.accepted).toBe(true)
    if (!result.accepted) return
    expect(result.taskId).toMatch(/^sub_/)
    // Task 7 审查 #3：fire-and-forget 不阻塞父 turn——runSubagent 已返回
    // accepted，子 run 挂在 runtime gate 上尚未结算。
    await waitForRunGate()

    // 释放子 run：runChildAgent 完成 → 终态记录 + 完成事件
    releaseRunGate?.()
    await flushMicrotasks()
    const pushCompleted = (
      backgroundTaskCompletionBus as unknown as {
        pushCompleted: jest.Mock
      }
    ).pushCompleted
    expect(pushCompleted).toHaveBeenCalledTimes(1)
    expect(pushCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subagent',
        taskId: result.taskId,
        conversationId: 'c',
        record: expect.objectContaining({
          taskId: result.taskId,
          status: 'completed',
        }),
      }),
    )
    expect(subagentTaskRegistry.get(result.taskId)?.status).toBe('completed')
  })

  it('pushes a completion event with status failed when the child run throws', async () => {
    const nativeRuntimeModule = jest.requireMock<{
      NativeAgentRuntime: jest.Mock
    }>('../native-runtime')
    nativeRuntimeModule.NativeAgentRuntime.mockImplementationOnce(() => ({
      subscribe: jest.fn(() => () => {}),
      run: jest.fn(async () => {
        throw new Error('provider down')
      }),
      getSnapshot: jest.fn().mockReturnValue({
        messages: [],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      }),
      setToolCallResponse: jest.fn(),
    }))

    const result = await runSubagent(makeParams())
    if (!result.accepted) return
    await flushMicrotasks()
    const pushCompleted = (
      backgroundTaskCompletionBus as unknown as {
        pushCompleted: jest.Mock
      }
    ).pushCompleted
    expect(pushCompleted).toHaveBeenCalledTimes(1)
    expect(pushCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subagent',
        taskId: result.taskId,
        record: expect.objectContaining({ status: 'failed' }),
      }),
    )
    expect(subagentTaskRegistry.get(result.taskId)?.status).toBe('failed')
  })

  it('reports cumulative input/output tokens on a multi-turn child completion', async () => {
    // Override the module-level NativeAgentRuntime mock for this run only:
    // the child transcript has two assistant turns whose per-turn usage sums
    // to the cumulative projection expected on the completion event.
    const nativeRuntimeModule = jest.requireMock<{
      NativeAgentRuntime: jest.Mock
    }>('../native-runtime')
    nativeRuntimeModule.NativeAgentRuntime.mockImplementationOnce(() => ({
      subscribe: jest.fn(() => () => {}),
      run: jest.fn(() => gateRuntimeRun()),
      getSnapshot: jest.fn().mockReturnValue({
        messages: [
          {
            role: 'assistant',
            id: 'child-assistant-1',
            content: 'I will inspect the files first.',
            metadata: {
              usage: {
                prompt_tokens: 100,
                completion_tokens: 20,
                total_tokens: 120,
              },
            },
          },
          {
            role: 'assistant',
            id: 'child-assistant-2',
            content: 'Child result',
            metadata: {
              usage: {
                prompt_tokens: 50,
                completion_tokens: 10,
                total_tokens: 60,
              },
            },
          },
        ],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
      }),
      setToolCallResponse: jest.fn(),
    }))

    const result = await runSubagent(makeParams())
    expect(result.accepted).toBe(true)

    await waitForRunGate()
    releaseRunGate?.()
    await flushMicrotasks()

    const pushCompleted = (
      backgroundTaskCompletionBus as unknown as {
        pushCompleted: jest.Mock
      }
    ).pushCompleted
    expect(pushCompleted).toHaveBeenCalledTimes(1)
    expect(pushCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subagent',
        taskId: result.taskId,
        conversationId: 'c',
        usage: { inputTokens: 150, outputTokens: 30 },
      }),
    )
  })

})

describe('approval pause parent deadline renewal (F5)', () => {
  afterEach(() => {
    resetParentSubagentDeadlines()
    resetParentSubagentTimeoutConfig()
    jest.useRealTimers()
  })

  it('keeps the parent deadline alive while paused on approval so the child autoReject fires first', async () => {
    jest.useFakeTimers().setSystemTime(0)
    // Real-world overlap: parent deadline (default 5min) == child autoReject
    // window (5min). Without the runner's renewal the parent deadline trips at
    // the same moment and aborts the whole child + increments the breaker.
    setParentSubagentTimeoutConfig({ timeoutMs: 5 * 60 * 1000 })
    const onExpire = jest.fn()
    registerParentSubagentDeadline({
      toolCallId: 'tc',
      runKey: 'c',
      conversationId: 'c',
      onExpire,
    })

    // Runtime pauses on a PendingApproval tool call: run() resolves, the
    // snapshot holds a pending call, and setToolCallResponse patches the
    // snapshot (the way AgentService.approveToolCall/rejectToolCall and the
    // autoReject fallback do in production).
    const nativeRuntimeModule = jest.requireMock<{
      NativeAgentRuntime: jest.Mock
    }>('../native-runtime')
    let runCount = 0
    let snapshot = {
      messages: [
        {
          role: 'tool',
          id: 'tool-1',
          toolCalls: [
            {
              request: { id: 'pending-call', name: 'fs_edit' },
              response: { status: ToolCallResponseStatus.PendingApproval },
            },
          ],
        },
      ],
      compaction: [],
      pendingCompactionAnchorMessageId: null,
    }
    nativeRuntimeModule.NativeAgentRuntime.mockImplementationOnce(() => ({
      subscribe: jest.fn(() => () => {}),
      run: jest.fn(async () => {
        runCount += 1
      }),
      getSnapshot: jest.fn(() => snapshot),
      setToolCallResponse: jest.fn((toolCallId, response) => {
        snapshot = {
          ...snapshot,
          messages: snapshot.messages.map((message) =>
            message.role === 'tool'
              ? {
                  ...message,
                  toolCalls: message.toolCalls.map((toolCall) =>
                    toolCall.request.id === toolCallId
                      ? { ...toolCall, response }
                      : toolCall,
                  ),
                }
              : message,
          ),
        }
      }),
    }))

    const result = await runSubagent(makeParams())
    if (!result.accepted) return
    // Wait for the child to enter the approval gate (first runtime.run()).
    for (let attempt = 0; attempt < 50 && runCount === 0; attempt += 1) {
      await jest.advanceTimersByTimeAsync(0)
    }
    expect(runCount).toBe(1)

    // Past the 5-minute mark: the child's autoReject must fire, while the
    // parent deadline (renewed every 60s during the pause) must not.
    await jest.advanceTimersByTimeAsync(5 * 60 * 1000)

    const setToolCallResponse = (
      nativeRuntimeModule.NativeAgentRuntime as jest.Mock
    ).mock.results.at(-1)?.value.setToolCallResponse as jest.Mock
    expect(setToolCallResponse).toHaveBeenCalledWith(
      'pending-call',
      expect.objectContaining({
        status: ToolCallResponseStatus.Error,
        error: expect.stringContaining('5 minutes'),
      }),
    )
    expect(onExpire).not.toHaveBeenCalled()
    expect(isParentSubagentDeadlineExpired('tc')).toBe(false)

    // The child then resumes with the auto-rejected batch and settles.
    await jest.advanceTimersByTimeAsync(0)
    expect(subagentTaskRegistry.get(result.taskId)?.status).toBe('completed')
  })
})
