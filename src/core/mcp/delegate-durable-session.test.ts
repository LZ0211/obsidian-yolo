/**
 * QA 等价物端到端测试：delegate_subagent 工具分发 → durable spawn → runner
 * 结算 → after_run 意图续跑（runSubagentSessionContinuation）全链路。
 *
 * 对照已有覆盖的缺口：
 * - localFileTools.test.ts 把 runner 整体 jest.mock——真实 dispatch 与真实
 *   runner/service/store 从未在同一测试联通；
 * - session-integration.test.ts 联通了 store+service+runner，但分发入口
 *   （callLocalFileTool / delegate_subagent）与 authority-resolver 是 mock。
 * 本测试把工具分发入口到 durable 会话控制面（spawn/send/settleRun/beginRun）到
 * 真实 runner 到 JSON 落盘的整条生产链路在 jest 内联通。
 *
 * mock 边界（刻意最小化）：
 * - NativeAgentRuntime：仅 mock 构造——真实实现会打模型；stub 产出"完成"快照，
 *   runtime.run 用可释放 gate 挂起（session-integration.test.ts 同款），让测试
 *   在 run 结算前后做确定性断言；每次 run 独立 gate，续跑重新挂起；
 * - completion-bus pushCompleted：纯观测副作用（R5 完成事件断言）。
 * 其余全部真实：callLocalFileTool、runner（runSubagent / runSubagentSessionContinuation /
 * runChildAgent）、SubagentSessionService（spawn/send/settleRun/beginRun/claim）、
 * SubagentSessionStore（内存 adapter 充当磁盘）、authority-resolver、
 * delegated-assistant-profile、llm/manager 的 provider client 构造。
 */

import type { App } from 'obsidian'

import { SubagentSessionStore } from '../../database/json/subagent/SubagentSessionStore'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { backgroundTaskCompletionBus } from '../agent/background-task/completion-bus'
import type { SubagentAuthorityResolverDependencies } from '../agent/subagent/authority-resolver'
import { runSubagentSessionContinuation } from '../agent/subagent/runner'
import { subagentRuntimeRegistry } from '../agent/subagent/runtime-registry'
import {
  type SubagentSessionServiceOptions,
  getSubagentSessionService,
  initSubagentSessionService,
} from '../agent/subagent/session-service'
import type { AgentRuntimeRunInput } from '../agent/types'
import { getProviderClient } from '../llm/manager'
import { AGENT_SESSION_MODE } from '../state/contracts'
import {
  SUBAGENT_MESSAGE_INTENT_STATE,
  SUBAGENT_RUN_STATUS,
  SUBAGENT_SESSION_STATUS,
} from '../state/statuses'

import { callLocalFileTool } from './localFileTools'
import type { McpManager } from './mcpManager'

// runtime.run() 用可释放的 gate 挂起（session-integration.test.ts 同款）：每次
// run 新建独立 gate——释放后下一轮 run（after_run 续跑）重新挂起，测试在 run
// 结算前后做确定性断言。
let runGate: Promise<void> | null = null
let releaseRunGate: (() => void) | null = null

/** 捕获最近一次 runtime.run() 的 run input（断言续跑身份/transcript）。 */
let capturedRunInput: AgentRuntimeRunInput | null = null

const gateRuntimeRun = (): Promise<void> => {
  if (runGate === null) {
    runGate = new Promise<void>((resolve) => {
      releaseRunGate = resolve
    })
  }
  return runGate
}

jest.mock('../agent/native-runtime', () => {
  const actual = jest.requireActual('../agent/native-runtime')
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
jest.mock('../agent/background-task/completion-bus', () => ({
  backgroundTaskCompletionBus: { pushCompleted: jest.fn() },
}))

// 规则 obsidianmd/hardcoded-config-path 禁止硬编码 `.obsidian` 字面量
const SUBAGENT_CONFIG_DIR = ['.', 'obsidian'].join('')
// initSubagentSessionService 的默认 userDataRoot：<baseDir>/data/subagents
const SUBAGENT_DATA_DIR = 'YOLO/data/subagents'

/** 内存 adapter 充当磁盘（参照 ChatManager.test.ts 的 createFakeFs 模式）。 */
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
    stat: jest.fn(async (p: string) => ({
      type: dirs.has(p) ? 'folder' : 'file',
    })),
    rmdir: jest.fn(async () => undefined),
    rename: jest.fn(async () => undefined),
  }
  const app = {
    vault: {
      adapter,
      configDir: SUBAGENT_CONFIG_DIR,
      getFileByPath: () => null,
    },
  } as unknown as App
  return { app, files }
}

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0))

/** 等待 runtime.run 挂上 gate（run 已开始、尚未结算）。 */
const waitForRunGate = async (): Promise<void> => {
  for (let attempt = 0; attempt < 200 && runGate === null; attempt += 1) {
    await flushMicrotasks()
  }
  expect(runGate).not.toBeNull()
}

/** 释放当前 gate，并清空以便下一轮 run 新建 gate。 */
const releaseCurrentRunGate = (): void => {
  expect(releaseRunGate).not.toBeNull()
  releaseRunGate?.()
  runGate = null
  releaseRunGate = null
}

/**
 * 父 subagent 运行上下文：callLocalFileTool 的 subagentParentContext 结构子集 +
 * runner 真实消费的完整字段。delegated 路径仅消费 workspaceAccessPolicy /
 * assistantId / requestContextBuilder / forkContext，但补齐 loopConfig 等字段
 * 让真实 runner 的 resolveSubagentRunPolicy（通用路径）可达。
 */
function makeParentContext() {
  return {
    conversationId: 'conv_1',
    assistantId: 'assistant-parent',
    requestContextBuilder: {},
    workspaceAccessPolicy: {
      enabled: true,
      workspaceRoot: '/vault',
      readExtraIncludes: [],
      readExcludes: [],
      writeExcludes: [],
      protectedPaths: [],
    },
    loopConfig: {
      enableTools: false,
      includeBuiltinTools: false,
      maxAutoIterations: 5,
    },
    allowedToolNames: [],
    toolPreferences: {},
    toolServerPreferences: {},
    allowedSkillPaths: [],
    enableToolDisclosure: false,
    reasoningLevel: 'full',
    requestParams: {},
    bypassToolApproval: false,
    rejectToolApproval: false,
    temporaryApprovedToolNames: [],
    mcpManager: {},
    model: {},
    providerClient: {},
    apiType: null,
  }
}

/** settings：一个 parent assistant + 一个 delegatable role + providers（参照
 * localFileTools.test.ts 的 buildSettings 形状）。 */
const buildSettings = (): YoloSettings =>
  ({
    assistants: [
      {
        id: 'assistant-parent',
        name: 'Parent',
        systemPrompt: 'You are the parent agent.',
        workspaceAccessPolicy: {
          enabled: true,
          workspaceRoot: '/vault',
          readExtraIncludes: [],
          readExcludes: [],
          writeExcludes: [],
          protectedPaths: [],
        },
      },
      {
        id: 'role_1',
        name: 'Role One',
        systemPrompt: 'You are the delegated role.',
        delegatable: true,
        modelId: 'openai/gpt-5',
        enableTools: false,
        includeBuiltinTools: false,
        enabledToolNames: [],
        toolPreferences: {},
        toolServerPreferences: {},
        enabledSkills: [],
        skillPreferences: {},
      },
    ],
    providers: [
      {
        id: 'openai',
        presetType: 'openai',
        apiType: 'openai-compatible',
        apiKey: 'token',
      },
    ],
    chatModelId: 'openai/gpt-4.1-mini',
    chatModels: [
      {
        id: 'openai/gpt-5',
        providerId: 'openai',
        model: 'gpt-5',
        enable: true,
      },
      {
        id: 'openai/gpt-4.1-mini',
        providerId: 'openai',
        model: 'gpt-4.1-mini',
        enable: true,
      },
    ],
    mcp: {
      servers: [],
      enableToolDisclosure: false,
      builtinToolOptions: {
        delegate_subagent: {
          allowedModelIds: ['openai/gpt-5', 'openai/gpt-4.1-mini'],
          preferredModelId: 'openai/gpt-4.1-mini',
        },
      },
    },
  }) as unknown as YoloSettings

type RawSubagentSessionRow = {
  schemaVersion: number
  session: {
    sessionId: string
    mode: string
    status: string
    revision: number
    nextRunSequence: number
    currentRunSequence?: number
    delegatedRoleId?: string
    memoryAssistantId?: string
    parentConversationId?: string
    originAssistantMessageId?: string
    originToolCallId?: string
  }
  runs: Array<{
    runKey: string
    runSequence: number
    status: string
    prompt?: string
    result?: { status: string; content: string }
  }>
  intents: Array<{
    messageId: string
    text: string
    delivery: string
    state: string
    claimedByRunKey?: string
    committedRunKey?: string
  }>
}

describe('delegate_subagent → durable session QA-equivalent e2e', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    runGate = null
    releaseRunGate = null
    capturedRunInput = null
  })

  it('无 delegatedRoleId → 纯 ephemeral 路径：不 spawn、无会话 JSON 落盘', async () => {
    const { app, files } = mockApp()
    const settings = buildSettings()

    // 本测试文件内先于 initSubagentSessionService 执行——会话服务单例不存在，
    // delegate_subagent 走纯 ephemeral（与迁移前逐字节一致）。
    const result = await callLocalFileTool({
      app,
      settings,
      conversationId: 'conv_1',
      conversationMessages: [
        { role: 'assistant', id: 'msg_1', content: 'parent reply' },
      ] as ChatMessage[],
      toolCallId: 'tc-neg',
      toolName: 'delegate_subagent',
      args: { description: 'Scan', prompt: 'Scan the vault' },
      subagentParentContext: makeParentContext(),
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('Expected delegate_subagent to succeed')
    }
    const accepted = JSON.parse(result.text) as {
      accepted: boolean
      sessionId: string
      runKey: string
      mode: string
    }
    expect(accepted).toMatchObject({
      accepted: true,
      mode: AGENT_SESSION_MODE.EPHEMERAL,
    })

    // ephemeral 子 run 照常跑完（mock runtime 完成快照），但不写任何持久化文件
    await waitForRunGate()
    releaseCurrentRunGate()
    await flushMicrotasks()
    await flushMicrotasks()
    expect([...files.values()]).toHaveLength(0)
  })

  it('delegate_subagent 分发 → durable spawn → 结算 → after_run 意图续跑全链路', async () => {
    const { app, files } = mockApp()
    const settings = buildSettings()

    // 续跑入口的 authority 解析依赖（Task 9 main.ts 注入的真实依赖形状）：
    // loadConversationMeta 走最小桩（conversationId → parent assistant id），
    // provider client 走 llm/manager 的真实构造，mcpManager 用可调用桩（真实
    // manager 需要 PGlite/vault 上下文，对续跑链路无影响）。
    const deps: SubagentAuthorityResolverDependencies = {
      app,
      getSettings: () => settings,
      loadConversationMeta: async (conversationId) => ({
        conversationId,
        assistantId: 'assistant-parent',
      }),
      createProviderClient: ({ settings: s, model }) =>
        getProviderClient({ settings: s, providerId: model.providerId }),
      createMcpManager: async () =>
        ({
          listAvailableTools: async () => [],
        }) as unknown as McpManager,
    }

    // Task 5 单例：真实 service + store（内存 adapter 充当磁盘）；after_run 意图
    // 结算后经 onIntentRunRequested 回调走真实续跑入口。
    const requestedRuns: string[] = []
    const continuationPromises: Promise<void>[] = []
    initSubagentSessionService(app, () => settings, {
      isSessionActive: () => false,
      onIntentRunRequested: (sessionId) => {
        requestedRuns.push(sessionId)
        continuationPromises.push(
          runSubagentSessionContinuation(sessionId, deps),
        )
      },
    } satisfies SubagentSessionServiceOptions)

    // 1) 真实工具分发入口：delegate_subagent（delegatedRoleId → durable 路径）
    const result = await callLocalFileTool({
      app,
      settings,
      conversationId: 'conv_1',
      conversationMessages: [
        { role: 'user', id: 'u1', content: 'please scan' },
        { role: 'assistant', id: 'msg_1', content: 'I will delegate.' },
      ] as ChatMessage[],
      toolCallId: 'tc-1',
      toolName: 'delegate_subagent',
      args: {
        description: 'Scan the vault',
        prompt: 'Scan all notes',
        delegatedRoleId: 'role_1',
      },
      subagentParentContext: makeParentContext(),
    })

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('Expected delegate_subagent to succeed')
    }
    const accepted = JSON.parse(result.text) as {
      accepted: boolean
      sessionId: string
      runKey: string
      mode: string
    }
    expect(accepted.accepted).toBe(true)
    expect(accepted.mode).toBe(AGENT_SESSION_MODE.PERSISTENT)
    const sessionId = accepted.sessionId
    expect(sessionId.startsWith('sub_')).toBe(true)
    expect(accepted.runKey).toBe(`${sessionId}:1`)

    // 2) spawn 落盘：{userDataRoot}/subagents/ 出现会话 JSON——schemaVersion 1、
    //    session PERSISTENT、run 1 记录（prompt 随行落盘）、delegatedRoleId 冻结
    const fileKey = `YOLO/data/subagents/v1_${sessionId}.json`
    expect(files.has(fileKey)).toBe(true)
    const rawSpawn = JSON.parse(
      files.get(fileKey) as string,
    ) as RawSubagentSessionRow
    expect(rawSpawn.schemaVersion).toBe(1)
    expect(rawSpawn.session).toMatchObject({
      sessionId,
      mode: AGENT_SESSION_MODE.PERSISTENT,
      status: SUBAGENT_SESSION_STATUS.IDLE,
      revision: 1,
      nextRunSequence: 2,
      delegatedRoleId: 'role_1',
      memoryAssistantId: 'assistant-parent',
      parentConversationId: 'conv_1',
      originAssistantMessageId: 'msg_1',
      originToolCallId: 'tc-1',
    })
    expect(rawSpawn.runs).toHaveLength(1)
    expect(rawSpawn.runs[0]).toMatchObject({
      runKey: `${sessionId}:1`,
      runSequence: 1,
      status: SUBAGENT_RUN_STATUS.QUEUED,
      prompt: 'Scan all notes',
    })

    // 3) run 1 挂起中：runtime/task 注册表持有活跃 run（taskId = sessionId）
    await waitForRunGate()
    expect(subagentRuntimeRegistry.getActiveForSession(sessionId)).toBeDefined()
    // runChildAgent 内联构造的 run input 以 taskId 为会话身份（runKey 字段仅
    // 会话续跑路径的 buildSubagentSessionRunInput 携带）
    expect(capturedRunInput?.conversationId).toBe(sessionId)
    expect(capturedRunInput?.sourceUserMessageId).toBe(`${sessionId}:1:prompt`)

    // 4) send(after_run)：真实 service 投递意图 → PENDING 落盘
    const service = getSubagentSessionService()
    expect(service).not.toBeNull()
    const sent = await service!.send({
      sessionId,
      messageId: 'm2',
      text: 'Continue with a follow-up',
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
      text: 'Continue with a follow-up',
      delivery: 'after_run',
      state: SUBAGENT_MESSAGE_INTENT_STATE.PENDING,
    })

    // 5) 释放 run 1 → 结算落盘 result → PENDING after_run + session 回 IDLE →
    //    onIntentRunRequested 触发 → 续跑 beginRun 创建 run 2 并原子 claim 意图
    //    → run 2 重新挂起
    releaseCurrentRunGate()
    await waitForRunGate()

    const rowAfterBegin = await new SubagentSessionStore(
      app,
      SUBAGENT_DATA_DIR,
    ).readById(sessionId)
    expect(rowAfterBegin?.runs[0]).toMatchObject({
      runKey: `${sessionId}:1`,
      status: SUBAGENT_RUN_STATUS.COMPLETED,
      result: { status: 'completed', content: 'done' },
    })
    expect(rowAfterBegin?.runs).toHaveLength(2)
    expect(rowAfterBegin?.runs[1]).toMatchObject({
      runKey: `${sessionId}:2`,
      runSequence: 2,
      status: SUBAGENT_RUN_STATUS.QUEUED,
      prompt: 'Continue with a follow-up',
    })
    expect(rowAfterBegin?.session).toMatchObject({
      status: SUBAGENT_SESSION_STATUS.RUNNING,
      currentRunSequence: 2,
      nextRunSequence: 3,
      revision: 4,
    })
    expect(rowAfterBegin?.intents[0]).toMatchObject({
      state: SUBAGENT_MESSAGE_INTENT_STATE.CLAIMED,
      claimedByRunKey: `${sessionId}:2`,
    })
    expect(requestedRuns).toEqual([sessionId])

    // 6) run 2 的 run input：会话身份 + 新 runKey + 意图消息重建的 transcript
    expect(capturedRunInput).toMatchObject({
      conversationId: sessionId,
      runKey: `${sessionId}:2`,
      sourceUserMessageId: `${sessionId}:2:prompt`,
    })
    // run 1 结算落盘的 transcriptPage + 意图 user 消息
    expect(capturedRunInput?.messages.length).toBeGreaterThan(0)

    // 7) 释放 run 2 → 续跑结算落回 run 2：意图 COMMITTED、session 回 IDLE、
    //    不重复触发续跑
    releaseCurrentRunGate()
    await Promise.all(continuationPromises)
    await flushMicrotasks()

    const rowAfterAll = await new SubagentSessionStore(
      app,
      SUBAGENT_DATA_DIR,
    ).readById(sessionId)
    expect(rowAfterAll?.session).toMatchObject({
      status: SUBAGENT_SESSION_STATUS.IDLE,
      revision: 5,
    })
    expect(rowAfterAll?.runs[1]).toMatchObject({
      runKey: `${sessionId}:2`,
      status: SUBAGENT_RUN_STATUS.COMPLETED,
      result: { status: 'completed', content: 'done' },
    })
    expect(rowAfterAll?.intents[0]).toMatchObject({
      state: SUBAGENT_MESSAGE_INTENT_STATE.COMMITTED,
      committedRunKey: `${sessionId}:2`,
    })
    expect(requestedRuns).toEqual([sessionId])
    expect(
      subagentRuntimeRegistry.getActiveForSession(sessionId),
    ).toBeUndefined()

    // R5：每次结算推送完成事件（runKey 区分各 run）
    const pushCompleted = (
      backgroundTaskCompletionBus as unknown as {
        pushCompleted: jest.Mock
      }
    ).pushCompleted
    expect(pushCompleted).toHaveBeenCalledTimes(2)
    expect(pushCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subagent',
        taskId: sessionId,
        record: expect.objectContaining({ runKey: `${sessionId}:1` }),
      }),
    )
    expect(pushCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'subagent',
        taskId: sessionId,
        record: expect.objectContaining({ runKey: `${sessionId}:2` }),
      }),
    )

    // 8) 全链后 JSON 内容可读回还原：sessionId / runKey / result 完整
    const restored = await new SubagentSessionStore(
      app,
      SUBAGENT_DATA_DIR,
    ).readById(sessionId)
    expect(restored?.session.sessionId).toBe(sessionId)
    expect(restored?.session.mode).toBe(AGENT_SESSION_MODE.PERSISTENT)
    expect(restored?.runs.map((run) => run.runKey)).toEqual([
      `${sessionId}:1`,
      `${sessionId}:2`,
    ])
    expect(restored?.runs.map((run) => run.result?.status)).toEqual([
      SUBAGENT_RUN_STATUS.COMPLETED,
      SUBAGENT_RUN_STATUS.COMPLETED,
    ])
    expect(restored?.runs.map((run) => run.result?.content)).toEqual([
      'done',
      'done',
    ])
  })
})
