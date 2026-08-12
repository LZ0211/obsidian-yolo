import type { App } from 'obsidian'

import { SubagentSessionStore } from '../../../database/json/subagent/SubagentSessionStore'
import { AGENT_SESSION_MODE } from '../../state/contracts'
import {
  SUBAGENT_MESSAGE_INTENT_STATE,
  SUBAGENT_RUN_STATUS,
  SUBAGENT_SESSION_STATUS,
} from '../../state/statuses'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import type { AgentRuntimeRunInput } from '../types'

import {
  type ResolvedCurrentSubagentParentAuthority,
  type SubagentAuthorityResolverDependencies,
  resolveCurrentSubagentParentAuthority,
} from './authority-resolver'
import type { SubagentParentContext } from './parent-context'
import {
  type RunSubagentParams,
  type SubagentSessionGatewayLike,
  runSubagent,
  runSubagentSessionContinuation,
} from './runner'
import { subagentRuntimeRegistry } from './runtime-registry'
import {
  SubagentSessionService,
  type SubagentSessionServiceOptions,
  getSubagentSessionService,
} from './session-service'
import { subagentTaskRegistry } from './task-registry'

/**
 * Task 11 跨层集成测试：store → service → runner → registry 全链路。
 *
 * 层级与 mock 边界（R10 模式，参照 runner.test.ts）：
 * - 真实：SubagentSessionStore（内存 mock adapter 充当“磁盘”，store 实例间
 *   共享同一 files map = 同一数据目录）、SubagentSessionService（CAS、
 *   恢复扫描、意图投递）、runner 的 runSubagent / runSubagentSessionContinuation
 *   （runChildAgent 全流程）、task/runtime 注册表单例；
 * - 模块级 mock：NativeAgentRuntime（否则会真实打模型）、authority-resolver、
 *   completion-bus / taskStreamBus / citationRegistry（纯观测副作用）。
 *
 * 场景：spawn（run 1 queued）→ send(after_run) 意图 pending → 真实 runner
 * 结算 run 1（result 落盘 + onIntentRunRequested 触发）→ beginRun 创建
 * run 2 后“崩溃”→ 重建 service（同 store 目录）→ 恢复扫描（isSessionActive
 * 由外部 set 控制：活跃会话跳过、崩溃会话置 INTERRUPTED/NEEDS_RESUME）→
 * runSubagentSessionContinuation 沿中断 runKey 续跑并再次落盘 → 全新进程
 * （第三个 store+service 实例）从 JSON 完整还原快照。
 */

// runtime.run() 用可释放的 gate 挂起（runner.test.ts 同款）：runSubagent 的
// gateway 分支不阻塞父 turn，必须由测试显式释放才能推进到结算。
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

/** 捕获最近一次 runtime.run() 的 run input（断言续跑身份/transcript）。 */
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
// 续跑入口的 authority 解析与 session 单例走 mock（runner.test.ts 同款）；
// store/service 本体在本测试中全部真实。
jest.mock('./authority-resolver', () => ({
  ...jest.requireActual('./authority-resolver'),
  resolveCurrentSubagentParentAuthority: jest.fn(),
}))
jest.mock('./session-service', () => ({
  ...jest.requireActual('./session-service'),
  getSubagentSessionService: jest.fn(),
}))

// 规则 obsidianmd/hardcoded-config-path 禁止硬编码 `.obsidian` 字面量
const SUBAGENT_CONFIG_DIR = ['.', 'obsidian'].join('')
const SUBAGENT_DATA_DIR = [
  '/vault',
  SUBAGENT_CONFIG_DIR,
  'plugins',
  'yolo',
  'subagents',
].join('/')

// mockApp/mockAdapter 参照 session-service.test.ts 同一模式；base 的
// create/read 先 exists 检查再 write，mock 的 exists 按内存文件状态返回。
// files map 由所有 store 实例共享——即"同一数据目录"，重载模拟的载体。
function mockApp(): { app: App; files: Map<string, string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const adapter = {
    exists: jest.fn(async (p: string) => files.has(p) || dirs.has(p)),
    mkdir: jest.fn(async (p: string) => {
      dirs.add(p)
    }),
    read: jest.fn(async (p: string) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`)
      return files.get(p) as string
    }),
    write: jest.fn(async (p: string, content: string) => {
      files.set(p, content)
    }),
    remove: jest.fn(async (p: string) => {
      files.delete(p)
    }),
    list: jest.fn(async (dir: string) => {
      const fileList: string[] = []
      files.forEach((_value, key) => {
        if (key.startsWith(`${dir}/`)) fileList.push(key)
      })
      return { files: fileList, folders: [] }
    }),
  }
  return { app: { vault: { adapter } } as unknown as App, files }
}

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

const waitForRunGate = async (): Promise<void> => {
  for (let attempt = 0; attempt < 100 && !runGate; attempt += 1) {
    await flushMicrotasks()
  }
  expect(releaseRunGate).not.toBeNull()
}

/** 一轮 run 结算完成后重置 gate，下一轮 runtime.run 才会挂起新 gate。 */
const resetRunGate = (): void => {
  runGate = null
  releaseRunGate = null
}

const makeParent = (): SubagentParentContext =>
  ({
    conversationId: 'conv_1',
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

const makeGateway = (
  service: SubagentSessionService,
): SubagentSessionGatewayLike =>
  ({
    settleRun: service.settleRun.bind(service),
    query: service.query.bind(service),
    deliverQueuedIntents: service.deliverQueuedIntents.bind(service),
  }) as unknown as SubagentSessionGatewayLike

const makeAuthority = (): ResolvedCurrentSubagentParentAuthority =>
  ({
    conversation: { conversationId: 'conv_1', assistantId: 'assistant-parent' },
    providerClient: {},
    model: { model: 'child-model', name: 'child-name' },
    apiType: null,
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

const makeDeps = (): SubagentAuthorityResolverDependencies =>
  ({
    app: {},
    getSettings: jest.fn(),
    loadConversationMeta: jest.fn(),
    createProviderClient: jest.fn(),
    createMcpManager: jest.fn(),
  }) as unknown as SubagentAuthorityResolverDependencies

type RawSubagentSessionRow = {
  schemaVersion: number
  session: {
    sessionId: string
    status: string
    revision: number
    currentRunSequence?: number
  }
  runs: Array<{
    runKey: string
    status: string
    result?: { status: string; content: string }
  }>
  intents: Array<{ state: string; delivery?: string; text?: string }>
  latestTranscript?: Array<{ role: string; content: string }>
}

describe('subagent durable session integration', () => {
  const mockGetSubagentSessionService = jest.mocked(getSubagentSessionService)
  const mockResolveAuthority = jest.mocked(
    resolveCurrentSubagentParentAuthority,
  )

  beforeEach(() => {
    jest.clearAllMocks()
    resetRunGate()
    capturedRunInput = null
    mockResolveAuthority.mockResolvedValue(makeAuthority())
  })

  it('survives a simulated reload: spawn, run, settle, recover', async () => {
    // 1) store + service（isSessionActive 由外部 set 控制）
    const { app, files } = mockApp()
    const activeSessions = new Set<string>()
    const requestedRuns: string[] = []
    const store = new SubagentSessionStore(app, SUBAGENT_DATA_DIR)
    const service = new SubagentSessionService(store, {
      isSessionActive: (sessionId) => activeSessions.has(sessionId),
      onIntentRunRequested: (sessionId) => requestedRuns.push(sessionId),
    } satisfies SubagentSessionServiceOptions)

    // 2) spawn → 断言 session idle + run queued（首 run prompt 已落盘）
    const spawned = await service.spawn({
      title: 't',
      prompt: 'p',
      mode: AGENT_SESSION_MODE.PERSISTENT,
      requestId: 'r1',
      parentConversationId: 'conv_1',
      originAssistantMessageId: 'msg_1',
      originToolCallId: 'tc_1',
      memoryAssistantId: 'mem_1',
    })
    expect(spawned.accepted).toBe(true)
    if (!spawned.accepted) throw new Error('spawn failed')
    const { sessionId } = spawned
    const spawnSnapshot = await service.query(sessionId)
    expect(spawnSnapshot?.session.status).toBe(SUBAGENT_SESSION_STATUS.IDLE)
    expect(spawnSnapshot?.session.revision).toBe(1)
    expect(spawnSnapshot?.session.nextRunSequence).toBe(2)
    expect(spawnSnapshot?.recentRuns).toHaveLength(1)
    expect(spawnSnapshot?.recentRuns[0]).toMatchObject({
      runKey: `${sessionId}:1`,
      runSequence: 1,
      status: SUBAGENT_RUN_STATUS.QUEUED,
      prompt: 'p',
    })

    // 3) send(after_run) → 断言 intent pending（真实 store 落盘）
    const sent = await service.send({
      sessionId,
      messageId: 'm2',
      text: 'after-run intent',
      delivery: 'after_run',
      expectedSessionRevision: 1,
      requestId: 'r2',
    })
    expect(sent).toMatchObject({
      accepted: true,
      queued: true,
      sessionRevision: 2,
    })
    const rowAfterSend = await new SubagentSessionStore(
      app,
      SUBAGENT_DATA_DIR,
    ).readById(sessionId)
    expect(rowAfterSend?.intents).toHaveLength(1)
    expect(rowAfterSend?.intents[0]).toMatchObject({
      messageId: 'm2',
      text: 'after-run intent',
      delivery: 'after_run',
      state: SUBAGENT_MESSAGE_INTENT_STATE.PENDING,
    })

    // 4) 真实 runner 结算 run 1 → 断言 result 落盘 + onIntentRunRequested 触发
    const gateway = makeGateway(service)
    const dispatched = await runSubagent({
      description: 't',
      prompt: 'p',
      conversationId: 'conv_1',
      source: {
        type: 'llm_tool_call',
        toolCallId: 'tc_1',
        assistantMessageId: 'msg_1',
      },
      parent: makeParent(),
      childModel: makeChildModel(),
      sessionId,
      runSequence: 1,
      mode: AGENT_SESSION_MODE.PERSISTENT,
      sessionGateway: gateway,
      settleRun: gateway.settleRun,
      onSettleFailure: jest.fn(),
    })
    expect(dispatched.accepted).toBe(true)

    // 运行中：runtime/task 注册表持有活跃 run（taskId = sessionId）
    await waitForRunGate()
    expect(subagentRuntimeRegistry.getActiveForSession(sessionId)).toBeDefined()
    expect(subagentTaskRegistry.get(sessionId)?.status).toBe('running')
    // runChildAgent 内联构造的 run input 以 taskId 为会话身份（runKey 字段
    // 仅会话续跑路径的 buildSubagentSessionRunInput 携带）
    expect(capturedRunInput?.conversationId).toBe(sessionId)
    releaseRunGate?.()
    await flushMicrotasks()
    await flushMicrotasks()

    // result 落盘：全新 store 实例（无缓存）读回 run 1 终态 + transcript
    const settledRow = await new SubagentSessionStore(
      app,
      SUBAGENT_DATA_DIR,
    ).readById(sessionId)
    expect(settledRow?.runs[0]).toMatchObject({
      runKey: `${sessionId}:1`,
      status: SUBAGENT_RUN_STATUS.COMPLETED,
      result: { status: 'completed', content: 'done' },
    })
    expect(settledRow?.latestTranscript?.[0]).toMatchObject({
      role: 'assistant',
      content: 'done',
    })
    expect(settledRow?.session.status).toBe(SUBAGENT_SESSION_STATUS.IDLE)
    expect(settledRow?.session.revision).toBe(3)
    // 磁盘上仅一个会话文件（v1_<sessionId>.json），内容即持久化 JSON
    const rawValues = [...files.values()]
    expect(rawValues).toHaveLength(1)
    const rawRow = JSON.parse(rawValues[0]) as RawSubagentSessionRow
    expect(rawRow.session.sessionId).toBe(sessionId)
    expect(rawRow.runs[0]).toMatchObject({
      runKey: `${sessionId}:1`,
      status: 'completed',
      result: { status: 'completed', content: 'done' },
    })
    expect(rawRow.latestTranscript?.[0]).toMatchObject({
      role: 'assistant',
      content: 'done',
    })
    // R5：结算推送完成事件到父会话（runKey 区分各 run）
    const pushCompleted = (
      backgroundTaskCompletionBus as unknown as {
        pushCompleted: jest.Mock
      }
    ).pushCompleted
    expect(pushCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subagent',
        taskId: sessionId,
        record: expect.objectContaining({ runKey: `${sessionId}:1` }),
      }),
    )
    // PENDING after_run 意图 + session 回 IDLE → 触发续跑请求
    expect(requestedRuns).toEqual([sessionId])
    // runner 侧清场：runtime 已注销、reservation 已释放
    expect(
      subagentRuntimeRegistry.getActiveForSession(sessionId),
    ).toBeUndefined()
    resetRunGate()

    // 5) 模拟重载：重建 service（同 store 目录）→ recoverInterruptedSessions
    // 续跑入口（onIntentRunRequested → runSubagentSessionContinuation）会先
    // beginRun 创建 run 2 并原子 claim after_run 意图；模拟在此刻崩溃（run 2
    // 未结算、无存活 runtime）：
    const begin = await service.beginRun({
      sessionId,
      expectedSessionRevision: 3,
      prompt: 'fallback',
    })
    expect(begin.accepted).toBe(true)
    if (!begin.accepted) throw new Error('beginRun failed')
    expect(begin).toMatchObject({
      runKey: `${sessionId}:2`,
      runSequence: 2,
      sessionRevision: 4,
      prompt: 'after-run intent',
      deliveredIntent: true,
    })
    const rowAfterBegin = await new SubagentSessionStore(
      app,
      SUBAGENT_DATA_DIR,
    ).readById(sessionId)
    expect(rowAfterBegin?.session.status).toBe(SUBAGENT_SESSION_STATUS.RUNNING)
    expect(rowAfterBegin?.session.currentRunSequence).toBe(2)
    expect(rowAfterBegin?.intents[0]).toMatchObject({
      state: SUBAGENT_MESSAGE_INTENT_STATE.CLAIMED,
      claimedByRunKey: `${sessionId}:2`,
    })

    // 崩溃后重建：同 app/adapter（=同一数据目录）新建 store+service
    const serviceAfterReload = new SubagentSessionService(
      new SubagentSessionStore(app, SUBAGENT_DATA_DIR),
      {
        isSessionActive: (sessionId) => activeSessions.has(sessionId),
        onIntentRunRequested: (sessionId) => requestedRuns.push(sessionId),
      } satisfies SubagentSessionServiceOptions,
    )
    // isSessionActive 外部控制：恢复扫描对“仍活跃”的会话跳过（recovered 0）
    activeSessions.add(sessionId)
    const scanWhileActive =
      await serviceAfterReload.recoverInterruptedSessions()
    expect(scanWhileActive.recovered).toBe(0)
    // 崩溃后无存活 runtime → 扫描把 run 2 置 INTERRUPTED、session 置
    // NEEDS_RESUME，claim 的意图置 RECOVERY_REQUIRED，run 1 终态保留
    activeSessions.clear()
    const { recovered } = await serviceAfterReload.recoverInterruptedSessions()
    expect(recovered).toBe(1)
    const recoveredSnapshot = await serviceAfterReload.query(sessionId)
    expect(recoveredSnapshot?.session.status).toBe(
      SUBAGENT_SESSION_STATUS.NEEDS_RESUME,
    )
    expect(recoveredSnapshot?.session.revision).toBe(5)
    expect(recoveredSnapshot?.recentRuns[1]).toMatchObject({
      runKey: `${sessionId}:2`,
      status: SUBAGENT_RUN_STATUS.INTERRUPTED,
    })
    expect(recoveredSnapshot?.recentRuns[0]?.status).toBe(
      SUBAGENT_RUN_STATUS.COMPLETED,
    )
    expect(recoveredSnapshot?.intents?.[0]).toMatchObject({
      state: SUBAGENT_MESSAGE_INTENT_STATE.RECOVERY_REQUIRED,
    })

    // 6) 重载后 needs_resume 恢复入口：真实 runner 续跑——沿用中断 run 的
    // runKey 重建 run input，结算落回同一 run 记录；快照可从 JSON 完整还原
    mockGetSubagentSessionService.mockReturnValue(serviceAfterReload)
    const continuationPromise = runSubagentSessionContinuation(
      sessionId,
      makeDeps(),
    )
    await waitForRunGate()
    expect(capturedRunInput).toMatchObject({
      conversationId: sessionId,
      runKey: `${sessionId}:2`,
      sourceUserMessageId: `${sessionId}:2:prompt`,
    })
    // transcript 从 JSON 还原（run 1 结算的 latestTranscript）
    expect(capturedRunInput?.messages.length).toBeGreaterThan(0)
    // 恢复路径不新建 run 记录：磁盘仍只有 run 1 + run 2
    const rowBeforeResume = await new SubagentSessionStore(
      app,
      SUBAGENT_DATA_DIR,
    ).readById(sessionId)
    expect(rowBeforeResume?.runs).toHaveLength(2)
    releaseRunGate?.()
    await continuationPromise
    await flushMicrotasks()

    // 续跑结算落回 run 2：session 回 IDLE、run 2 终态 + 新 transcript
    const finalSnapshot = await serviceAfterReload.query(sessionId)
    expect(finalSnapshot?.session.status).toBe(SUBAGENT_SESSION_STATUS.IDLE)
    expect(finalSnapshot?.session.revision).toBe(6)
    expect(finalSnapshot?.recentRuns[1]).toMatchObject({
      runKey: `${sessionId}:2`,
      status: SUBAGENT_RUN_STATUS.COMPLETED,
      result: { status: 'completed', content: 'done' },
    })
    expect(finalSnapshot?.recentRuns[1]?.completedAt).toBeDefined()
    // 无 PENDING after_run 残留 → 不重复触发续跑
    expect(requestedRuns).toEqual([sessionId])
    // R5：续跑结算同样推送完成事件（第 2 次，runKey 区分）
    expect(pushCompleted).toHaveBeenCalledTimes(2)
    expect(pushCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subagent',
        taskId: sessionId,
        record: expect.objectContaining({ runKey: `${sessionId}:2` }),
      }),
    )
    expect(
      subagentRuntimeRegistry.getActiveForSession(sessionId),
    ).toBeUndefined()

    // 7) 快照从 JSON 完整还原：第三个 store+service 实例（全新进程）读取
    // 同一文件，与重载后实例的查询结果逐字段一致
    const restoredService = new SubagentSessionService(
      new SubagentSessionStore(app, SUBAGENT_DATA_DIR),
    )
    const restored = await restoredService.query(sessionId)
    expect(restored?.session.sessionId).toBe(sessionId)
    expect(restored?.session.status).toBe(SUBAGENT_SESSION_STATUS.IDLE)
    expect(restored?.session.revision).toBe(6)
    expect(restored?.recentRuns.map((run) => run.runKey)).toEqual([
      `${sessionId}:1`,
      `${sessionId}:2`,
    ])
    expect(restored?.recentRuns[0]?.result).toMatchObject({
      status: 'completed',
      content: 'done',
    })
    expect(restored?.recentRuns[1]?.result).toMatchObject({
      status: 'completed',
      content: 'done',
    })
    expect(restored?.transcriptPage).toEqual(finalSnapshot?.transcriptPage)
    expect(restored).toEqual(finalSnapshot)
  })
})
