/**
 * Web 端 e2e harness 服务器（jest 进程内装配，长驻等待 SIGTERM）。
 *
 * 装配（对齐 src/main.ts getWebServerLifecycle）：真实 WebServerLifecycle +
 * WebHttpServer + WebSseHub + AgentEventStore(sqlite) + ChatManager +
 * AgentService + registerWebServerRoutes 全路由；仅 LLM（getChatModelClient
 * → MockProvider）与 Obsidian 接口（fs-vault-mock + obsidian-stub）被 mock。
 *
 * 启动方式（由 scripts/qa-web-harness/e2e.spec.ts 以子进程拉起）：
 *   npx jest -c scripts/qa-web-harness/jest.config.js \
 *     scripts/qa-web-harness/harness-server.test.ts --runInBand
 *
 * 握手：stdout 输出一行 `E2E_HARNESS_READY <json>`（process.stdout.write，
 * 绕开 jest 的 console 缓冲），同时把同一份信息写到临时目录的
 * harness-info.json。重启持久化场景：设置环境变量 E2E_HARNESS_TMPDIR 指向
 * 同一临时目录，harness 会复用 harness-info.json 里的 baseDir 与 shareToken
 * （pepper / 会话 JSON / agent.sqlite 都在该目录，天然跨进程持久）。
 */
/* eslint-disable import/no-nodejs-modules -- harness 就是 Node 进程，直接使用 node 内置模块 */
/* eslint-disable @typescript-eslint/no-require-imports -- jest.mock 工厂内 require */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createServer as createNetServer } from 'node:net'
import type { Server as HttpServer } from 'node:http'

import { AgentService } from '../../src/core/agent/service'
import { createAgentConversationPersistence } from '../../src/core/agent/conversationPersistence'
import { createAgentEventStore } from '../../src/core/agent/agentEventStore'
import {
  buildMemoryPartition,
  type MemoryIndexMaintenanceStore,
} from '../../src/core/memory/memoryIndex'
import { getMemoryIndexRuntimeHandle } from '../../src/core/memory/memoryIndexRuntime'
import { loadMemorySourceSnapshot } from '../../src/core/memory/memoryManager'
import { DELEGATE_SUBAGENT_TOOL_SHORT_NAME } from '../../src/core/agent/subagent/tool-name-utils'
import { getLocalFileToolServerName } from '../../src/core/mcp/localFileToolNames'
import { executeBuiltinTool } from '../../src/core/tools/dispatcher'
import type { ToolContext } from '../../src/core/tools/types'
import type { McpManager } from '../../src/core/mcp/mcpManager'
import { getToolName, parseToolName } from '../../src/core/mcp/tool-name-utils'
import { getYoloBaseDir } from '../../src/core/paths/yoloPaths'
import {
  hashShareToken,
  hashWorkspaceRoot,
  createShareToken,
  parsePublicTokenId,
} from '../../src/core/web-server/shareTokenCrypto'
import { loadOrCreateShareTokenPepper } from '../../src/core/web-server/shareTokenPepperStore'
import { registerWebServerRoutes } from '../../src/core/web-server/registerWebServerRoutes'
import {
  WebHttpServer,
  writeJson,
} from '../../src/core/web-server/WebHttpServer'
import { WebServerLifecycle } from '../../src/core/web-server/WebServerLifecycle'
import { WebSseHub } from '../../src/core/web-server/WebSseHub'
import { ChatManager } from '../../src/database/json/chat/ChatManager'
import { SETTINGS_SCHEMA_VERSION } from '../../src/settings/schema/migrations'
import { parseYoloSettings } from '../../src/settings/schema/settings'
import type { YoloSettings } from '../../src/settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../src/types/tool-call.types'
import type { McpTool } from '../../src/types/mcp.types'

jest.mock('../../src/core/llm/manager', () => {
  const { getHarnessMockProvider, TEST_MODEL } =
    require('./llm-mock-provider') as typeof import('./llm-mock-provider')
  return {
    getChatModelClient: jest.fn(() => ({
      providerClient: getHarnessMockProvider(),
      model: TEST_MODEL,
    })),
    // 全量 mock：任何经 llm/manager 解析 provider 的路径（chat / embedding /
    // rerank）都落到 mock provider，不触真实网络。
    getProviderClient: jest.fn(() => getHarnessMockProvider()),
  }
})

// 记忆索引（sqlite + 向量召回）的确定性嵌入：文本含「数据库/迁移」形态映射
// [0,1,…]，其余（含「极简」形态）映射 [1,0,…]——与
// memoryProductionWiring.integration.test.ts 同款接缝，让 C4 动态召回按查询
// 稳定排序（回合 1 极简条目在前，回合 2 数据库迁移条目在前）。
jest.mock('../../src/core/rag/embedding', () => {
  const vectorForRecallText = (text: string): number[] => {
    if (text.includes('数据库') || text.includes('迁移')) {
      return [0, 1, 0, 0, 0, 0, 0, 0]
    }
    return [1, 0, 0, 0, 0, 0, 0, 0]
  }
  return {
    getEmbeddingModelClient: jest.fn(() => ({
      getEmbedding: jest.fn(async (text: string) => vectorForRecallText(text)),
    })),
    withEmbeddingTimeout: jest.fn(
      async (
        client: { getEmbedding: (text: string) => Promise<number[]> },
        text: string,
      ) => client.getEmbedding(text),
    ),
  }
})

// 查询相关关键词的确定性 jieba（同款接缝）：含「数据库/迁移」→
// ['数据库','迁移']，否则 ['极简']。避免依赖真实 jieba-engine 运行时组件
// 的可用性，保证 C4 词法召回按最新查询稳定排序。
jest.mock('../../src/core/memory/memoryJiebaTokenizer', () => ({
  cutForSearchWithJieba: jest.fn(async (text: string) => {
    if (text.includes('数据库') || text.includes('迁移')) {
      return ['数据库', '迁移']
    }
    return ['极简']
  }),
}))

import {
  HARNESS_TOOL_NAME,
  getHarnessMockProvider,
  textTurn,
  toolCallTurn,
} from './llm-mock-provider'
import { createAppMock, type AppMock } from './fs-vault-mock'

// conversationPersistence 会 `window.dispatchEvent(...)`——Node/jest 环境没有
// window，补一个最小事件分发替身。
;(globalThis as Record<string, unknown>).window = {
  dispatchEvent: () => undefined,
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
}

export type HarnessInfo = {
  baseDir: string
  port: number
  shareToken: string
  shareTokenId?: string
  /** 第二个 workspace agent（agent-2，根 '/work'）的 share token——场景 e
   *  （不同 agent 会话隔离）用它开第二个浏览器会话。 */
  shareToken2?: string
  shareTokenId2?: string
  vaultIdentity: string
}

const HARNESS_INFO_FILE = 'harness-info.json'

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address && typeof address === 'object') {
        const port = address.port
        server.close(() => resolve(port))
      } else {
        server.close(() => reject(new Error('no address')))
      }
    })
  })
}

const DELEGATE_SUBAGENT_TOOL_NAME = getToolName(
  getLocalFileToolServerName(),
  DELEGATE_SUBAGENT_TOOL_SHORT_NAME,
)

/**
 * mock McpManager：远程工具（harness__echo）保持桩响应；本地工具
 * （yolo_local__*，含 delegate_subagent）转发到真实 callLocalFileTool——
 * 与生产 mcpManager.callTool 的本地分支同构（app/settings/conversationId/
 * conversationMessages/subagentParentContext 等参数全部来自真实 tool-gateway
 * 的透传），ephemeral 派发全链（callLocalFileTool → runSubagent → 子 run →
 * pushCompleted → AgentService 注入父会话 subagent_result）由此在 harness
 * 里走真实代码。
 */
function createMockMcpManager({
  app,
  getSettings,
}: {
  app: AppMock
  getSettings: () => YoloSettings
}): McpManager {
  const allowedByConversation = new Set<string>()
  return {
    TOOL_NAME_DELIMITER: '__',
    listAvailableTools: jest.fn(
      async (): Promise<McpTool[]> => [
        {
          name: HARNESS_TOOL_NAME,
          description: 'Harness echo tool: echoes the provided text.',
          inputSchema: {
            type: 'object',
            properties: { text: { type: 'string' } },
            additionalProperties: false,
          },
        },
        {
          name: DELEGATE_SUBAGENT_TOOL_NAME,
          description:
            'Delegate a task to a subagent (ephemeral child run; delegatedRoleId selects the assistant role).',
          inputSchema: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              prompt: { type: 'string' },
              delegatedRoleId: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
      ],
    ),
    getJsSandboxSettings: jest.fn(() => ({})),
    // 真实 settings 快照：selectAllowedTools → applyDynamicToolDescriptions 对
    // delegate_subagent 工具调 resolveSubagentModelConfig（读 settings.chatModels），
    // 空对象会崩（TypeError: reading 'map'）——mock 必须与真实 manager 一致。
    getSettingsSnapshot: jest.fn(() => getSettings()),
    allowToolForConversation: jest.fn(
      (toolName: string, conversationId: string) => {
        allowedByConversation.add(`${conversationId}:${toolName}`)
      },
    ),
    // 保持既有 harness 契约（场景 c 依赖）：未经 allowToolForConversation
    // 显式允许的工具一律挂起审批——web 会话的 YOLO 模式带 bypassToolApproval
    // （真实 manager 会 honor requireAutoExecution 直接放行），mock 若也放行
    // 则审批 UI 永不出现在 harness 里。显式 allow 后放行（审批点击路径）。
    // ⚠️ 必须同步返回 boolean：真实 manager 的 isToolExecutionAllowed 是同步
    // 方法，gateway 的 shouldAutoExecuteTool 直接 `if (this.mcpManager
    // .isToolExecutionAllowed(...))` 判定——async mock 返回 Promise 会被当
    // truthy 恒真（工具全部自动执行，审批 UI 永不出现）。
    isToolExecutionAllowed: jest.fn(
      ({
        requestToolName,
        conversationId,
      }: {
        requestToolName: string
        conversationId?: string
      }) =>
        conversationId != null &&
        allowedByConversation.has(`${conversationId}:${requestToolName}`),
    ),
    callTool: jest.fn(
      async (params: {
        name: string
        args?: Record<string, unknown>
        id?: string
        conversationId?: string
        roundId?: string
        conversationMessages?: unknown[]
        signal?: AbortSignal
        requireReview?: boolean
        chatModelId?: string
        workspaceAccessPolicy?: unknown
        allowedSkillPaths?: readonly string[]
        runContext?: unknown
        subagentParentContext?: unknown
      }) => {
        const { name, args } = params
        let serverName = ''
        let toolName = ''
        try {
          const parsed = parseToolName(name)
          serverName = parsed.serverName
          toolName = parsed.toolName
        } catch {
          // 保留空串：非本地工具走桩响应
        }
        if (serverName === getLocalFileToolServerName()) {
          // 与生产 mcpManager.callTool 的本地分支逐字段同构（mcpManager.ts
          // :1288-1380）：D9 重构后本地工具经注册表 dispatcher
          // （executeBuiltinTool）执行，旧 callLocalFileTool 分派已删除——
          // Success 包 data.text，Aborted 透传 data，Rejected 透传 reason，
          // 其余状态转 Error（PendingApproval 不在此路径出现——审批在
          // gateway 前置）。
          const localResult = await executeBuiltinTool(
            toolName,
            (args ?? {}) as Record<string, unknown>,
            {
              app: app as never,
              settings: getSettings(),
              openApplyReview: async () => true,
              conversationId: params.conversationId,
              conversationMessages: params.conversationMessages as never,
              roundId: params.roundId,
              toolCallId: params.id,
              requireReview: params.requireReview,
              signal: params.signal,
              chatModelId: params.chatModelId,
              workspaceAccessPolicy: params.workspaceAccessPolicy as never,
              allowedSkillPaths: params.allowedSkillPaths,
              // 与 mcpManager 同款注入：delegate_subagent 经 ToolContext
              // 的 runSubagent 懒加载 runner（动态 import 避开模块初始化
              // 顺序隐患——runner.ts 传递到达 tool-preferences.ts 的
              // TOOL_NAME_DELIMITER 读取）。
              runSubagent: async (input) => {
                const { runSubagent } = await import(
                  '../../src/core/agent/subagent/runner'
                )
                return (runSubagent as ToolContext['runSubagent'])!(input)
              },
              subagentParentContext: params.subagentParentContext,
            },
          )
          if (localResult.status === ToolCallResponseStatus.Success) {
            return {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: localResult.text,
                contentParts: localResult.contentParts,
                metadata: localResult.metadata,
              },
            }
          }
          if (localResult.status === ToolCallResponseStatus.Aborted) {
            return {
              status: ToolCallResponseStatus.Aborted,
              ...(localResult.data !== undefined && {
                data: localResult.data,
              }),
            }
          }
          if (localResult.status === ToolCallResponseStatus.Rejected) {
            return {
              status: ToolCallResponseStatus.Rejected,
              ...(localResult.reason !== undefined && {
                reason: localResult.reason,
              }),
            }
          }
          return {
            status: ToolCallResponseStatus.Error,
            error: localResult.error,
          }
        }
        return {
          status: ToolCallResponseStatus.Success,
          data: {
            type: 'text',
            text: `[harness] ${name} called with ${JSON.stringify(args ?? {})}`,
          },
        }
      },
    ),
    abortToolCall: jest.fn(() => true),
  } as unknown as McpManager
}

function loadOrCreateHarnessInfo(baseDir: string): {
  info: HarnessInfo
} {
  const infoPath = path.join(baseDir, HARNESS_INFO_FILE)
  if (fs.existsSync(infoPath)) {
    const previous = JSON.parse(
      fs.readFileSync(infoPath, 'utf8'),
    ) as HarnessInfo
    if (previous.baseDir === baseDir && previous.shareToken) {
      return { info: previous }
    }
  }
  const info: HarnessInfo = {
    baseDir,
    port: 0,
    shareToken: '',
    vaultIdentity: '',
  }
  return { info }
}

async function startHarnessServer(): Promise<{
  lifecycle: WebServerLifecycle<YoloSettings>
  server: WebHttpServer
  info: HarnessInfo
}> {
  // 重启场景：E2E_HARNESS_TMPDIR 指向既有临时目录则复用（shareToken 必须
  // 一致，否则登录会失败）。
  const baseDir =
    process.env.E2E_HARNESS_TMPDIR && process.env.E2E_HARNESS_TMPDIR.length > 0
      ? path.resolve(process.env.E2E_HARNESS_TMPDIR)
      : fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-web-e2e-'))
  fs.mkdirSync(baseDir, { recursive: true })

  const { info } = loadOrCreateHarnessInfo(baseDir)
  const app = createAppMock(baseDir)
  const vaultIdentity = app.vault.getName()

  const yoloBaseDir = getYoloBaseDir({ yolo: { baseDir: 'YOLO' } })
  const pepper = loadOrCreateShareTokenPepper(path.join(baseDir, yoloBaseDir))

  let shareToken = info.shareToken
  let shareTokenId = info.shareTokenId
  if (!shareToken) {
    const created = createShareToken()
    shareToken = created.plaintext
    shareTokenId = created.publicTokenId
    info.shareToken = shareToken
    info.shareTokenId = shareTokenId
  }
  // 第二个 workspace agent（agent-2，根 '/work'）的独立 share token——与
  // agent-1 的 token 一样持久化进 harness-info.json（重启复用同一装配）。
  let shareToken2 = info.shareToken2
  let shareTokenId2 = info.shareTokenId2
  if (!shareToken2) {
    const created = createShareToken()
    shareToken2 = created.plaintext
    shareTokenId2 = created.publicTokenId
    info.shareToken2 = shareToken2
    info.shareTokenId2 = shareTokenId2
  }

  let settings: YoloSettings = buildSettings({
    baseDir,
    vaultIdentity,
    shareToken,
    shareTokenId,
    shareToken2,
    shareTokenId2,
    pepper,
    port: await findFreePort(),
  })

  const mockProvider = getHarnessMockProvider()
  // 按 user 消息内容路由的脚本流（e2e 用例依赖）：
  // - 含 'hello harness' → 文本流（三段增量，用于流式过程断言）
  // - 含 'use tool:echo' → 先 tool_call 流，随后一段文本流（审批通过后的续答）
  // - 含 'delegate a subagent please' → 父回合 delegate_subagent 工具调用
  //   （ephemeral：delegatedRoleId 命中 settings 的 delegatable assistant）→
  //   续答文本；子代理回合按 delegate prompt 文本匹配
  mockProvider.chunkDelayMs = 60
  // 标题生成请求（服务端 /api/chat/generate-title → generateConversationTitleText
  // → 标题模型）的 user 消息以 'User first message:' 开头——必须先于普通文本
  // 规则注册，否则 'hello harness' 等标题输入会命中文本流规则。标题来自
  // mock provider 的脚本文本（不是 A4 截断兜底）。
  mockProvider.script(/^User first message:/i, [
    textTurn(['Mock LLM generated title']),
  ])
  mockProvider.script(/hello harness/i, [
    textTurn(['Hello from ', 'the mock LLM', '!']),
  ])
  // 场景 e（agent-2 会话）：与 'hello harness' 区分开的第二个文本流规则。
  mockProvider.script(/agent two hello/i, [
    textTurn(['Agent two reply', ' complete']),
  ])
  mockProvider.script(/use tool:echo/i, [
    toolCallTurn(undefined, { text: 'hello' }),
    textTurn(['Tool executed', ', answer follows', '!']),
  ])
  mockProvider.script(/delegate a subagent please/i, [
    toolCallTurn(DELEGATE_SUBAGENT_TOOL_NAME, {
      description: 'Summarize the quarterly report',
      prompt:
        'Summarize the quarterly report and return a concise bullet list.',
      delegatedRoleId: 'delegated-1',
    }),
    textTurn(['Delegation accepted', ', task delegated!']),
  ])
  // 子代理回合：delegate prompt 即子 run 首条 user 消息，命中即完成
  mockProvider.script(
    /Summarize the quarterly report and return a concise bullet list/i,
    [textTurn(['Delegated result: ', 'quarterly summary done'])],
  )
  // 记忆分层场景（C4）：回合 2 的请求带回合 1 全文历史（user 消息拼接后同时
  // 命中两个查询文本），规则按消费顺序匹配——「数据库迁移」规则必须先注册，
  // 否则回合 2 会误命中「极简」规则。
  mockProvider.script(/请推荐数据库迁移方案/i, [
    textTurn(['数据库迁移方案：', '分阶段执行', '完成']),
  ])
  mockProvider.script(/我喜欢极简设计/i, [
    textTurn(['简约设计建议：', '遵循极简原则', '完成']),
  ])

  // 记忆分层（C4）e2e 数据：真实 fs 上先种好 YOLO/memory/global.md（生产
  // markdown 格式，见 parseMemorySourceEntries），再经生产快照加载器 +
  // 真实 sqlite 记忆索引做一次 reconcile——两个条目（极简设计偏好 + 数据库
  // 迁移项目）落索引后，回合级动态召回才能按查询稳定排序。
  await seedAndReconcileGlobalMemory(app, () => settings)

  const chatManager = new ChatManager(app, settings)
  const persistence = createAgentConversationPersistence(
    app as never,
    () => settings,
  )
  // webBinding 守卫：persist 管道（每次调用新建 ChatManager + 独立写队列，
  // findById+compact+updateChat 读-改-写）可能用过期读把 runAgent 维护的
  // webBinding 覆盖掉（真实生产竞态，见 e2e-report）。harness 在每次
  // persist 后校验并恢复 binding，确保审批/访问控制/历史列表读到的文件
  // 始终带 binding。
  //
  // 双 agent 装配下绝不能盖章错误的绑定（会把会话泄漏进另一个 agent 的
  // 可见列表）：优先恢复 persist 前已有的 binding；其次按会话的
  // agentInstanceId 派生（ensureConversation 创建会话时即带）；两者都没有
  // 时保持原状——后续访问经 canUseOrRepairWebConversation 或路由补丁修复。
  const harnessRootHash = hashWorkspaceRoot('/', vaultIdentity)
  const agentTwoRootHash = hashWorkspaceRoot('/work', vaultIdentity)
  const rootHashByAgentId: Record<string, string> = {
    'agent-1': harnessRootHash,
    'agent-2': agentTwoRootHash,
  }
  const basePersist = persistence.persistConversationMessages.bind(persistence)
  const persistWithBindingGuard: typeof basePersist = async (payload) => {
    const before = (await chatManager.findById(payload.conversationId)) as
      | (ChatManager extends never
          ? never
          : { webBinding?: unknown; agentInstanceId?: unknown })
      | null
    await basePersist(payload)
    await ChatManager.withConversationLock(payload.conversationId, async () => {
      const chat = (await chatManager.findById(payload.conversationId)) as
        | (ChatManager extends never
            ? never
            : { webBinding?: unknown; agentInstanceId?: unknown })
        | null
      if (!chat || chat.webBinding) return
      const restoredBinding = before?.webBinding
        ? (before.webBinding as {
            initialAgentId: string
            activeAgentId: string
            rootHash: string
          })
        : typeof chat.agentInstanceId === 'string' &&
            rootHashByAgentId[chat.agentInstanceId]
          ? {
              initialAgentId: chat.agentInstanceId,
              activeAgentId: chat.agentInstanceId,
              rootHash: rootHashByAgentId[chat.agentInstanceId],
            }
          : null
      if (!restoredBinding) return
      await chatManager.updateChat(
        payload.conversationId,
        {
          agentInstanceId: restoredBinding.activeAgentId,
          webBinding: restoredBinding,
        } as never,
        { touchUpdatedAt: false },
      )
    })
  }
  const agentService = new AgentService({
    getSettings: () => settings,
    persistConversationMessages: persistWithBindingGuard as never,
  })
  // 镜像 main.ts 的主机接线：ephemeral subagent 完成经
  // backgroundTaskCompletionBus → AgentService 结算 → 父会话注入
  // subagent_result 消息（场景 f 的结算路径，缺了它结果永远不会落会话）。
  agentService.startBackgroundTaskResultListener()
  const sseHub = new WebSseHub()
  const agentEventStore = createAgentEventStore(path.join(baseDir, yoloBaseDir))
  const mcpManager = createMockMcpManager({
    app,
    getSettings: () => settings,
  })

  const plugin = {
    app: app as never,
    manifest: {} as { dir?: string },
    setSettings: async (next: YoloSettings): Promise<boolean> => {
      settings = next
      return true
    },
    openApplyReview: async () => true,
  }

  let boundServer: WebHttpServer | null = null
  const lifecycle = new WebServerLifecycle<YoloSettings>({
    getSettings: () => settings,
    saveSettings: async (next) => {
      settings = next
    },
    createServer: (runtime) => {
      const server = new WebHttpServer({
        host: runtime.host,
        port: runtime.port,
        token: runtime.token,
      })
      registerWebServerRoutes({
        server,
        app: app as never,
        plugin,
        chatManager,
        agentEventStore,
        sseHub,
        getSettings: () => settings,
        host: runtime.host,
        port: runtime.port,
        getAgentService: () => agentService,
        getMcpManager: async () => mcpManager,
      })
      // harness 专属调试路由：暴露 MockProvider 收到的 LLM 请求（含 C4 记忆
      // 分层后的 system/user 消息），供 e2e 场景 g 断言稳定 <global> 快照与
      // 查询相关的 <recalled_memory> 动态块。仅 loopback 可及，非生产路由。
      server.router.get('/api/harness/mock-requests', async (_req, res) => {
        writeJson(
          res,
          200,
          getHarnessMockProvider().streamCalls.map((entry) => ({
            requestMessages: entry.request.messages,
          })),
        )
      })

      boundServer = server
      return server
    },
  })

  await lifecycle.reconcile()
  if (!boundServer) {
    throw new Error('harness: web server did not start')
  }
  const httpServer = (boundServer as unknown as { server: HttpServer }).server
  const address = httpServer.address()
  if (!address || typeof address === 'string') {
    throw new Error('harness: no listening address')
  }

  info.port = address.port
  info.vaultIdentity = vaultIdentity
  fs.writeFileSync(
    path.join(baseDir, HARNESS_INFO_FILE),
    JSON.stringify(info, null, 2),
    'utf8',
  )

  return { lifecycle, server: boundServer, info }
}

/**
 * 真实生产 memory markdown 格式（与 memoryProductionWiring.integration.test.ts
 * 的 TWO_ENTRY_GLOBAL_MEMORY 同构）：# Preferences 分节 + 行内 keywords。
 */
const GLOBAL_MEMORY_MARKDOWN = `# User Profile

# Preferences
- Preference_1: 用户偏好极简风格的设计 <!-- keywords: 极简风格,设计 -->
- Preference_2: 用户负责数据库迁移项目 <!-- keywords: 数据库迁移 -->

# Other Memory
`

/**
 * 在 harness vault 的真实 fs 上种记忆文件并做一次生产路径 reconcile：
 * getMemoryIndexRuntimeHandle（与 WebChatRuntimeAdapter 的 RCB 共享同一
 * 单例）→ sqlite store → loadMemorySourceSnapshot（经 fs-vault-mock 的真实
 * adapter 读盘）→ store.reconcilePartition（写 memory_index 行 + 确定性
 * 嵌入向量）。reconcile 是同步等待的，浏览器回合开始前索引已就绪。
 *
 * 两个作用域都种：
 * - global：稳定 <global> 快照（getMemoryPromptContext 无条件读 global.md）；
 * - assistant（agent-1，记忆文件 YOLO/memory/Agent One.md，按 workspace
 *   agent 显示名命名）：web 运行的 currentAssistantId 是会话绑定的
 *   workspace agent id，C4 动态召回走 assistant 作用域（memoryManager 的
 *   getAssistantById 已能解析 workspace agent）。
 */
async function seedAndReconcileGlobalMemory(
  app: AppMock,
  getSettings: () => YoloSettings,
): Promise<void> {
  const basePath = (
    app.vault.adapter as { getBasePath(): string }
  ).getBasePath()
  const seedFile = (vaultRelativePath: string, content: string): string => {
    const absolutePath = path.join(basePath, ...vaultRelativePath.split('/'))
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true })
    fs.writeFileSync(absolutePath, content, 'utf8')
    return vaultRelativePath
  }
  const globalMemoryVaultPath = seedFile(
    'YOLO/memory/global.md',
    GLOBAL_MEMORY_MARKDOWN,
  )
  const agentMemoryVaultPath = seedFile(
    'YOLO/memory/Agent One.md',
    GLOBAL_MEMORY_MARKDOWN,
  )

  const handle = getMemoryIndexRuntimeHandle(app as never, getSettings)
  const store = await handle.getStore()
  if (store.capability !== 'sqlite') {
    throw new Error(
      'harness: memory index store is not sqlite — C4 memory e2e cannot rank recall',
    )
  }

  const reconcileSource = async (
    scope: 'global' | 'assistant',
    assistantId: string | undefined,
    expectedSourcePath: string,
  ): Promise<void> => {
    const snapshot = await loadMemorySourceSnapshot({
      app: app as never,
      settings: getSettings(),
      scope,
      ...(scope === 'assistant' ? { assistantId } : {}),
    })
    if (snapshot.sourcePath !== expectedSourcePath) {
      throw new Error(
        `harness: memory snapshot resolved to ${snapshot.sourcePath}, expected ${expectedSourcePath}`,
      )
    }
    if (snapshot.entries.length !== 2) {
      throw new Error(
        `harness: expected 2 memory entries for ${expectedSourcePath}, got ${snapshot.entries.length}`,
      )
    }
    await (store as MemoryIndexMaintenanceStore).reconcilePartition({
      partition: snapshot.partition,
      sourcePath: snapshot.sourcePath,
      sourceFileFingerprint: snapshot.sourceFileFingerprint,
      parserVersion: snapshot.parserVersion,
      entries: snapshot.entries,
    } as never)
  }

  await reconcileSource('global', undefined, globalMemoryVaultPath)
  await reconcileSource('assistant', 'agent-1', agentMemoryVaultPath)
}

function buildSettings(input: {
  baseDir: string
  vaultIdentity: string
  shareToken: string
  shareTokenId?: string
  shareToken2: string
  shareTokenId2?: string
  pepper: string
  port: number
}): YoloSettings {
  const rootHash = hashWorkspaceRoot('/', input.vaultIdentity)
  // agent-2 的 workspace 根 '/work'——与 agent-1 的 '/' 不同 rootHash，
  // 会话绑定（webBinding.rootHash）据此隔离。
  const rootHash2 = hashWorkspaceRoot('/work', input.vaultIdentity)
  const parsed = parseYoloSettings({
    version: SETTINGS_SCHEMA_VERSION,
    yolo: { baseDir: 'YOLO' },
    providers: [
      {
        id: 'harness-provider',
        name: 'Harness Provider',
        presetType: 'openai',
        apiType: 'openai-responses',
        apiKey: 'harness-key',
        baseUrl: 'http://127.0.0.1:1/v1',
      },
    ],
    chatModels: [
      {
        id: 'harness-model',
        providerId: 'harness-provider',
        model: 'harness-model',
        name: 'Harness Model',
      },
    ],
    chatModelId: 'harness-model',
    chatTitleModelId: 'harness-model',
    embeddingModels: [
      {
        id: 'harness-embedding',
        providerId: 'harness-provider',
        model: 'harness-embedding',
        name: 'Harness Embedding',
        // 8 维（与 embedding mock 的确定性向量同维）。
        dimension: 8,
      },
    ],
    embeddingModelId: 'harness-embedding',
    assistants: [
      {
        id: 'template-1',
        name: 'Template One',
        agentModeAllowed: true,
        // D9（2026-08-15 工具注册表重构）之后，内置工具（含
        // delegate_subagent）的启用/审批档位只读
        // `builtinCapabilityPreferences`（capability 键），
        // `toolPreferences` 仅承载远程 MCP 工具——harness 若仍把
        // delegate_subagent 写在 toolPreferences，isAssistantToolEnabled /
        // getEnabledAssistantToolNames 会按 capability 默认值
        // （subagent_delegation defaultEnabled: false）解析，工具被 gateway
        // 拒绝（Tool not available），场景 f 审批 UI 永不出现。
        // delegate_subagent：full_access 免审批自动执行（mock 侧预允许），
        // enabled 使父 run 的 allowedToolNames 含该工具（gateway isToolAllowed）
        toolPreferences: {
          [HARNESS_TOOL_NAME]: { enabled: true },
        },
        builtinCapabilityPreferences: {
          subagent_delegation: {
            enabled: true,
            approvalMode: 'full_access',
          },
        },
      },
      // Task 2 resolveDelegatableAssistantRoles 判定条件：settings.assistants
      // 中 delegatable === true 的角色可被 delegate_subagent 解析（无
      // modelId 时回落 preferredModelId = chatModelId = harness-model）。
      {
        id: 'delegated-1',
        name: 'Delegated One',
        agentModeAllowed: true,
        delegatable: true,
      },
    ],
    workspaceAgents: [
      {
        id: 'agent-1',
        name: 'Agent One',
        templateId: 'template-1',
        workspacePolicy: {
          workspaceRoot: '/',
          readAllowlist: [],
          readDenylist: [],
          writeDenylist: [],
        },
        shareTokens: [
          {
            // authRoutes.findMatchingShareToken 要求 token.id === publicTokenId
            id:
              input.shareTokenId ??
              parsePublicTokenId(input.shareToken) ??
              'harness-share-token',
            tokenHash: hashShareToken(input.shareToken, input.pepper),
            tokenHashVersion: 'hmac-sha256-v1',
            scope: {
              kind: 'workspaceRoot',
              rootHash,
              issuedForAgentId: 'agent-1',
            },
            createdAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
      // 场景 e（会话过滤/不同 agent 隔离）：第二个 workspace agent，根
      // '/work'（rootHash 与 agent-1 不同）→ 两个会话的 webBinding 互不可见。
      {
        id: 'agent-2',
        name: 'Agent Two',
        templateId: 'template-1',
        workspacePolicy: {
          workspaceRoot: '/work',
          readAllowlist: [],
          readDenylist: [],
          writeDenylist: [],
        },
        shareTokens: [
          {
            id:
              input.shareTokenId2 ??
              parsePublicTokenId(input.shareToken2) ??
              'harness-share-token-2',
            tokenHash: hashShareToken(input.shareToken2, input.pepper),
            tokenHashVersion: 'hmac-sha256-v1',
            scope: {
              kind: 'workspaceRoot',
              rootHash: rootHash2,
              issuedForAgentId: 'agent-2',
            },
            createdAt: 1,
          },
        ],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    currentWorkspaceAgentId: 'agent-1',
    webRuntime: {
      enabled: true,
      host: '127.0.0.1',
      port: input.port,
      token: '',
      maxConcurrentAgentRuns: 12,
    },
    // 记忆分层（C4）e2e 需要 sqlite 记忆索引：advancedMemoryIndexEnabled
    // 打开后 getStore() 才返回 sqlite store，稳定 <global> 快照与查询相关
    // 的 <recalled_memory> 动态块才走生产索引路径（否则回退 markdown 兜底，
    // 块内容不随查询排序，场景 g 的断言不成立）。reflection 保持关闭
    // （反射需要真实模型 runner，非本场景目标）。
    advancedMemoryIndexEnabled: true,
    memoryReflectionEnabled: false,
  })
  return parsed
}

describe('web e2e harness server', () => {
  it('assembles the real web runtime and serves until SIGTERM', async () => {
    const { lifecycle, info } = await startHarnessServer()

    const readyPayload = JSON.stringify(info)
    process.stdout.write(`E2E_HARNESS_READY ${readyPayload}\n`)

    await new Promise<void>((resolve) => {
      const shutdown = (): void => {
        process.off('SIGTERM', shutdown)
        process.off('SIGINT', shutdown)
        void lifecycle.stop().then(resolve)
      }
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)
    })
  }, 900_000)
})
