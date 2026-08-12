import type { ChatMessage } from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { AGENT_SESSION_MODE } from '../../state/contracts'
import { SUBAGENT_RUN_STATUS } from '../../state/statuses'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import type { NativeAgentRuntime } from '../native-runtime'
import type { AgentRuntimeRunInput } from '../types'

import {
  type ResolvedCurrentSubagentParentAuthority,
  SubagentAuthorityResolutionError,
  type SubagentAuthorityResolverDependencies,
  resolveCurrentSubagentParentAuthority,
} from './authority-resolver'
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
  runSubagentSessionContinuation,
} from './runner'
import { getSubagentSessionService } from './session-service'
import type { SubagentSessionSnapshot } from './session-types'
import { subagentTaskRegistry } from './task-registry'
import type { SubagentTaskRecord } from './types'

/**
 * R10：durable 测试会真实执行 `new NativeAgentRuntime()` + `runtime.run()`
 * （runner.ts runChildAgent），不 mock 会真实打模型。模块级 mock 仅影响
 * 本文件的运行时代理；现有纯函数测试（plain-object runtime 注入）不受影响。
 * （jest.mock 声明被 babel-jest 提升到 import 之上，位置无碍语义。）
 *
 * runtime.run() 用可释放的 gate 挂起：gateway 不阻塞测试（Task 7 审查 #3）
 * 依赖"runSubagent 返回 accepted 时子 run 仍在跑"这一确定性时序。
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

/** Task 9：捕获续跑 run input（断言意图文本/drain 钩子接线）。 */
let capturedRunInput: AgentRuntimeRunInput | null = null

jest.mock('../native-runtime', () => {
  const actual = jest.requireActual('../native-runtime')
  return {
    ...actual,
    NativeAgentRuntime: jest.fn().mockImplementation(() => ({
      subscribe: jest.fn(() => () => {}),
      run: jest.fn((input: AgentRuntimeRunInput) => {
        capturedRunInput = input
        return gateRuntimeRun()
      }),
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
// 续跑测试（Task 7 审查 #1/#2）：service 与 authority-resolver 走 mock，
// 聚焦 runner 侧的分支/时序；resolver 本体已由 authority-resolver.test.ts 覆盖。
jest.mock('./session-service', () => ({
  ...jest.requireActual('./session-service'),
  getSubagentSessionService: jest.fn(),
}))
jest.mock('./authority-resolver', () => ({
  ...jest.requireActual('./authority-resolver'),
  resolveCurrentSubagentParentAuthority: jest.fn(),
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
    runGate = null
    releaseRunGate = null
  })

  it('spawns with session identity and settles durably without blocking the caller', async () => {
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
    // Task 7 审查 #3：gateway 分支不阻塞父 turn——runSubagent 已返回 accepted，
    // 子 run 挂在 runtime gate 上尚未结算。
    expect(settleRun).not.toHaveBeenCalled()
    await waitForRunGate()
    expect(settleRun).not.toHaveBeenCalled()

    // 释放子 run：runChildAgent 完成后结算——service.settleRun 收到终态 settlement
    releaseRunGate?.()
    await flushMicrotasks()
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

    const settleRun = jest.fn(async () => undefined)
    const gateway = makeGateway(settleRun)
    const result = await runSubagent({
      ...makeParams(gateway, settleRun),
      onSettleFailure: jest.fn(),
    })
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
        taskId: 'sub_abc',
        conversationId: 'c',
        usage: { inputTokens: 150, outputTokens: 30 },
      }),
    )
  })

  it('keeps the in-memory state consistent when settleRun fails', async () => {
    const settleError = new Error('store write failed')
    const settleRun = jest.fn(async () => {
      throw settleError
    })
    const onSettleFailure = jest.fn()
    const gateway = makeGateway(settleRun)
    const result = await runSubagent({
      ...makeParams(gateway, settleRun),
      onSettleFailure,
    })
    expect(result.accepted).toBe(true)

    await waitForRunGate()
    releaseRunGate?.()
    await flushMicrotasks()

    // settle 失败 → onSettleFailure 收到 { settlement, error }，内存态照常更新
    expect(onSettleFailure).toHaveBeenCalledTimes(1)
    expect(onSettleFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        settlement: expect.objectContaining({
          sessionId: 'sub_abc',
          runKey: 'sub_abc:2',
        }),
        error: settleError,
      }),
    )
    const record = subagentTaskRegistry.get('sub_abc')
    expect(record?.status).toBe('completed')
    expect(record?.result?.status).toBe('completed')
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

    // 首轮结算后 reservation 释放，第二轮才能正常推进
    await waitForRunGate()
    releaseRunGate?.()
    await first
    await flushMicrotasks()
    expect(settleRun).toHaveBeenCalledTimes(1)
  })
})

describe('runSubagentSessionContinuation', () => {
  const mockGetSubagentSessionService = jest.mocked(getSubagentSessionService)
  const mockResolveAuthority = jest.mocked(
    resolveCurrentSubagentParentAuthority,
  )

  const makeDeps = (): SubagentAuthorityResolverDependencies =>
    ({
      app: {},
      getSettings: jest.fn(),
      loadConversationMeta: jest.fn(),
      createProviderClient: jest.fn(),
      createMcpManager: jest.fn(),
    }) as unknown as SubagentAuthorityResolverDependencies

  const makeAuthority = (): ResolvedCurrentSubagentParentAuthority =>
    ({
      conversation: { conversationId: 'c', assistantId: 'assistant-parent' },
      providerClient: {},
      model: { model: 'child-model', name: 'child-name' },
      apiType: null,
      mcpManager: {},
      requestContextBuilder: {},
      allowedToolNames: [],
      toolPreferences: {},
      toolServerPreferences: {},
      allowedSkillPaths: [],
      enableToolDisclosure: false,
      reasoningLevel: 'full',
      requestParams: {},
      loopConfig: {
        enableTools: true,
        includeBuiltinTools: true,
        maxAutoIterations: 5,
      },
      bypassToolApproval: false,
    }) as unknown as ResolvedCurrentSubagentParentAuthority

  const makeSessionSnapshot = (
    overrides: Partial<SubagentSessionSnapshot> & {
      session: SubagentSessionSnapshot['session']
    },
  ): SubagentSessionSnapshot =>
    ({
      recentRuns: [],
      ...overrides,
    }) as SubagentSessionSnapshot

  beforeEach(() => {
    jest.clearAllMocks()
    runGate = null
    releaseRunGate = null
    capturedRunInput = null
    mockResolveAuthority.mockResolvedValue(makeAuthority())
  })

  it('throws when authority deps are missing (fail-fast, review #4)', async () => {
    await expect(runSubagentSessionContinuation('sub_abc')).rejects.toThrow(
      /authority resolver dependencies/,
    )
  })

  it('continues a NEEDS_RESUME session with the interrupted run key (review #2b)', async () => {
    const settleRun = jest.fn(async () => undefined)
    const beginRun = jest.fn()
    const query = jest.fn().mockResolvedValue(
      makeSessionSnapshot({
        session: {
          sessionId: 'sub_abc',
          parentConversationId: 'c',
          originAssistantMessageId: 'm',
          originToolCallId: 'tc',
          title: 't',
          mode: AGENT_SESSION_MODE.PERSISTENT,
          status: 'needs_resume',
          revision: 3,
          nextRunSequence: 2,
          memoryAssistantId: 'mem_1',
          createdAt: 1,
          lastActiveAt: 2,
        },
        recentRuns: [
          {
            sessionId: 'sub_abc',
            runSequence: 1,
            runKey: 'sub_abc:1',
            promptMessageId: 'sub_abc:1:prompt',
            prompt: 'p',
            status: SUBAGENT_RUN_STATUS.INTERRUPTED,
            basedOnSessionRevision: 1,
          },
        ],
        transcriptPage: [],
      }),
    )
    mockGetSubagentSessionService.mockReturnValue({
      query,
      beginRun,
      settleRun,
      claimNextBoundaryIntents: jest.fn().mockResolvedValue(null),
    } as unknown as Awaited<ReturnType<typeof getSubagentSessionService>>)

    const deps = makeDeps()
    const continuationPromise = runSubagentSessionContinuation('sub_abc', deps)
    await waitForRunGate() // 让子 run 到达 runtime gate
    releaseRunGate?.()
    await continuationPromise

    // 恢复路径沿用被中断 run 的既有 runKey，不误用 nextRunSequence(2)
    expect(beginRun).not.toHaveBeenCalled()
    expect(settleRun).toHaveBeenCalledTimes(1)
    expect(settleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sub_abc',
        runKey: 'sub_abc:1',
      }),
    )
    expect(subagentTaskRegistry.get('sub_abc')?.runKey).toBe('sub_abc:1')
    expect(mockResolveAuthority).toHaveBeenCalledWith(
      deps,
      expect.objectContaining({ sessionId: 'sub_abc' }),
      expect.anything(),
    )
  })

  it('begins a new run record for an IDLE continuation and settles with the new run key (review #2a)', async () => {
    const settleRun = jest.fn(async () => undefined)
    const beginRun = jest.fn().mockResolvedValue({
      accepted: true,
      runKey: 'sub_abc:2',
      runSequence: 2,
      sessionRevision: 3,
      prompt: 'p1',
      deliveredIntent: false,
    })
    const query = jest.fn().mockResolvedValue(
      makeSessionSnapshot({
        session: {
          sessionId: 'sub_abc',
          parentConversationId: 'c',
          originAssistantMessageId: 'm',
          originToolCallId: 'tc',
          title: 't',
          mode: AGENT_SESSION_MODE.PERSISTENT,
          status: 'idle',
          revision: 2,
          nextRunSequence: 2,
          memoryAssistantId: 'mem_1',
          createdAt: 1,
          lastActiveAt: 2,
        },
        recentRuns: [
          {
            sessionId: 'sub_abc',
            runSequence: 1,
            runKey: 'sub_abc:1',
            promptMessageId: 'sub_abc:1:prompt',
            prompt: 'p1',
            status: SUBAGENT_RUN_STATUS.COMPLETED,
            basedOnSessionRevision: 1,
          },
        ],
        transcriptPage: [],
      }),
    )
    mockGetSubagentSessionService.mockReturnValue({
      query,
      beginRun,
      settleRun,
      claimNextBoundaryIntents: jest.fn().mockResolvedValue(null),
    } as unknown as Awaited<ReturnType<typeof getSubagentSessionService>>)

    const continuationPromise = runSubagentSessionContinuation(
      'sub_abc',
      makeDeps(),
    )
    await waitForRunGate()
    releaseRunGate?.()
    await continuationPromise

    // IDLE 续跑先经 service 创建新 run 记录（beginRun 推进 nextRunSequence），
    // 结算落点是新 runKey——run 1 的结算记录不被覆写
    expect(beginRun).toHaveBeenCalledWith({
      sessionId: 'sub_abc',
      expectedSessionRevision: 2,
      prompt: 'p1',
    })
    expect(settleRun).toHaveBeenCalledTimes(1)
    expect(settleRun).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'sub_abc',
        runKey: 'sub_abc:2',
      }),
    )
    expect(subagentTaskRegistry.get('sub_abc')?.runKey).toBe('sub_abc:2')
  })

  it('resolves authority before beginning the run and marks the session orphaned on parent_orphaned (Task 9)', async () => {
    const query = jest.fn().mockResolvedValue(
      makeSessionSnapshot({
        session: {
          sessionId: 'sub_abc',
          parentConversationId: 'c',
          originAssistantMessageId: 'm',
          originToolCallId: 'tc',
          title: 't',
          mode: AGENT_SESSION_MODE.PERSISTENT,
          status: 'idle',
          revision: 2,
          nextRunSequence: 2,
          memoryAssistantId: 'mem_1',
          createdAt: 1,
          lastActiveAt: 2,
        },
        recentRuns: [
          {
            sessionId: 'sub_abc',
            runSequence: 1,
            runKey: 'sub_abc:1',
            promptMessageId: 'sub_abc:1:prompt',
            prompt: 'p1',
            status: SUBAGENT_RUN_STATUS.COMPLETED,
            basedOnSessionRevision: 1,
          },
        ],
        transcriptPage: [],
      }),
    )
    const beginRun = jest.fn()
    const markOrphaned = jest.fn().mockResolvedValue({ accepted: true })
    mockGetSubagentSessionService.mockReturnValue({
      query,
      beginRun,
      settleRun: jest.fn(),
      claimNextBoundaryIntents: jest.fn().mockResolvedValue(null),
      markOrphaned,
    } as unknown as Awaited<ReturnType<typeof getSubagentSessionService>>)
    mockResolveAuthority.mockRejectedValue(
      new SubagentAuthorityResolutionError(
        'parent_orphaned',
        false,
        'The owning conversation is unavailable.',
      ),
    )

    // 续跑解析父上下文失败（origin 上下文失效）→ 不 beginRun、会话置
    // ORPHANED（Task 3 Important / R13 同款语义），续跑正常返回（会话已死）
    await runSubagentSessionContinuation('sub_abc', makeDeps())
    expect(beginRun).not.toHaveBeenCalled()
    expect(markOrphaned).toHaveBeenCalledWith({
      sessionId: 'sub_abc',
      expectedSessionRevision: 2,
    })
  })

  it('does not begin a run when authority resolution fails retryably (review #3)', async () => {
    const query = jest.fn().mockResolvedValue(
      makeSessionSnapshot({
        session: {
          sessionId: 'sub_abc',
          parentConversationId: 'c',
          originAssistantMessageId: 'm',
          originToolCallId: 'tc',
          title: 't',
          mode: AGENT_SESSION_MODE.PERSISTENT,
          status: 'idle',
          revision: 2,
          nextRunSequence: 2,
          memoryAssistantId: 'mem_1',
          createdAt: 1,
          lastActiveAt: 2,
        },
        recentRuns: [
          {
            sessionId: 'sub_abc',
            runSequence: 1,
            runKey: 'sub_abc:1',
            promptMessageId: 'sub_abc:1:prompt',
            prompt: 'p1',
            status: SUBAGENT_RUN_STATUS.COMPLETED,
            basedOnSessionRevision: 1,
          },
        ],
        transcriptPage: [],
      }),
    )
    const beginRun = jest.fn()
    mockGetSubagentSessionService.mockReturnValue({
      query,
      beginRun,
      settleRun: jest.fn(),
      claimNextBoundaryIntents: jest.fn().mockResolvedValue(null),
    } as unknown as Awaited<ReturnType<typeof getSubagentSessionService>>)
    mockResolveAuthority.mockRejectedValue(
      new SubagentAuthorityResolutionError(
        'policy_unavailable',
        true,
        'The selected subagent model is unavailable.',
      ),
    )

    // policy_unavailable（retryable）→ 抛给调用方诊断；会话保持 IDLE（无
    // RUNNING+QUEUED 悬挂态），意图保持 PENDING 等待下一次触发
    await expect(
      runSubagentSessionContinuation('sub_abc', makeDeps()),
    ).rejects.toThrow(/model is unavailable/)
    expect(beginRun).not.toHaveBeenCalled()
  })

  it('uses the claimed after_run intent text as the new user message (review #1)', async () => {
    const settleRun = jest.fn(async () => undefined)
    const beginRun = jest.fn().mockResolvedValue({
      accepted: true,
      runKey: 'sub_abc:2',
      runSequence: 2,
      sessionRevision: 3,
      prompt: 'intent-1 text',
      deliveredIntent: true,
    })
    const query = jest.fn().mockResolvedValue(
      makeSessionSnapshot({
        session: {
          sessionId: 'sub_abc',
          parentConversationId: 'c',
          originAssistantMessageId: 'm',
          originToolCallId: 'tc',
          title: 't',
          mode: AGENT_SESSION_MODE.PERSISTENT,
          status: 'idle',
          revision: 2,
          nextRunSequence: 2,
          memoryAssistantId: 'mem_1',
          createdAt: 1,
          lastActiveAt: 2,
        },
        recentRuns: [
          {
            sessionId: 'sub_abc',
            runSequence: 1,
            runKey: 'sub_abc:1',
            promptMessageId: 'sub_abc:1:prompt',
            prompt: 'old prompt',
            status: SUBAGENT_RUN_STATUS.COMPLETED,
            basedOnSessionRevision: 1,
          },
        ],
        // transcriptPage 非空：旧 prompt 不得被重复追加为合成 user 消息
        transcriptPage: [
          { role: 'assistant', id: 'a1', content: 'previous result' },
        ] as unknown as ChatMessage[],
      }),
    )
    mockGetSubagentSessionService.mockReturnValue({
      query,
      beginRun,
      settleRun,
      claimNextBoundaryIntents: jest.fn().mockResolvedValue(null),
    } as unknown as Awaited<ReturnType<typeof getSubagentSessionService>>)

    const continuationPromise = runSubagentSessionContinuation(
      'sub_abc',
      makeDeps(),
    )
    await waitForRunGate()
    releaseRunGate?.()
    await continuationPromise

    // 新 user 消息 = 意图文本（beginRun 返回的 prompt），非旧 run prompt
    expect(capturedRunInput?.messages.at(-1)).toMatchObject({
      role: 'user',
      id: 'sub_abc:2:prompt',
      promptContent: 'intent-1 text',
    })
    const prompts = capturedRunInput?.messages
      .filter((message) => message.role === 'user')
      .map((message) => message.promptContent)
    expect(prompts).not.toContain('old prompt')
  })

  it('drains next_boundary intents once at the run boundary (Task 9, F1)', async () => {
    const settleRun = jest.fn(async () => undefined)
    const beginRun = jest.fn().mockResolvedValue({
      accepted: true,
      runKey: 'sub_abc:2',
      runSequence: 2,
      sessionRevision: 3,
      prompt: 'intent-1 text',
      deliveredIntent: true,
    })
    const claimNextBoundaryIntents = jest.fn().mockResolvedValue({
      messages: [
        {
          role: 'user',
          id: 'm-boundary',
          content: null,
          promptContent: 'mid-run steer',
          mentionables: [],
        },
      ],
      sourceUserMessageId: 'm-boundary',
    })
    const query = jest.fn().mockResolvedValue(
      makeSessionSnapshot({
        session: {
          sessionId: 'sub_abc',
          parentConversationId: 'c',
          originAssistantMessageId: 'm',
          originToolCallId: 'tc',
          title: 't',
          mode: AGENT_SESSION_MODE.PERSISTENT,
          status: 'idle',
          revision: 2,
          nextRunSequence: 2,
          memoryAssistantId: 'mem_1',
          createdAt: 1,
          lastActiveAt: 2,
        },
        recentRuns: [
          {
            sessionId: 'sub_abc',
            runSequence: 1,
            runKey: 'sub_abc:1',
            promptMessageId: 'sub_abc:1:prompt',
            prompt: 'p1',
            status: SUBAGENT_RUN_STATUS.COMPLETED,
            basedOnSessionRevision: 1,
          },
        ],
        transcriptPage: [],
      }),
    )
    mockGetSubagentSessionService.mockReturnValue({
      query,
      beginRun,
      settleRun,
      claimNextBoundaryIntents,
    } as unknown as Awaited<ReturnType<typeof getSubagentSessionService>>)

    const continuationPromise = runSubagentSessionContinuation(
      'sub_abc',
      makeDeps(),
    )
    await waitForRunGate()
    releaseRunGate?.()
    await continuationPromise

    expect(claimNextBoundaryIntents).toHaveBeenCalledWith('sub_abc', {
      runKey: 'sub_abc:2',
      expectedSessionRevision: 3,
    })
    const drain = capturedRunInput?.drainPendingUserMessages?.()
    expect(drain?.messages[0]).toMatchObject({
      role: 'user',
      promptContent: 'mid-run steer',
    })
    expect(drain?.sourceUserMessageId).toBe('m-boundary')
    // 一次性：第二次调用返回 null
    expect(capturedRunInput?.drainPendingUserMessages?.()).toBeNull()
  })
})
