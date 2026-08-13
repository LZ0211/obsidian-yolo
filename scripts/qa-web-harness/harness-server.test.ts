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
import { DELEGATE_SUBAGENT_TOOL_SHORT_NAME } from '../../src/core/agent/subagent/tool-name-utils'
import { callLocalFileTool } from '../../src/core/mcp/localFileTools'
import { getLocalFileToolServerName } from '../../src/core/mcp/localFileToolNames'
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
import { apiError, readJsonBody } from '../../src/core/web-server/routes/routeUtils'
import { WebHttpServer, writeJson } from '../../src/core/web-server/WebHttpServer'
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
    // durable 续跑路径（authority-resolver → deps.createProviderClient →
    // getProviderClient）也走 mock provider——缺了续跑 authority 解析直接崩
    // （"getProviderClient is not a function"）。
    getProviderClient: jest.fn(() => getHarnessMockProvider()),
  }
})

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
 * 的透传），durable spawn 全链（spawn → runSubagent → settle → 恢复扫描）
 * 由此在 harness 里走真实代码。
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
    listAvailableTools: jest.fn(async (): Promise<McpTool[]> => [
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
          'Delegate a task to a subagent (durable session when delegatedRoleId is provided).',
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
    ]),
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
          // :1201-1242）：Success 包 data.text，Aborted 透传 data，其余状态
          // 原样返回（PendingApproval 不在此路径出现——审批在 gateway 前置）。
          const localResult = await callLocalFileTool({
            app: app as never,
            settings: getSettings(),
            conversationId: params.conversationId,
            conversationMessages: params.conversationMessages as never,
            roundId: params.roundId,
            toolCallId: params.id,
            toolName,
            args: (args ?? {}) as Record<string, unknown>,
            requireReview: params.requireReview,
            signal: params.signal,
            chatModelId: params.chatModelId,
            workspaceAccessPolicy: params.workspaceAccessPolicy as never,
            allowedSkillPaths: params.allowedSkillPaths,
            runContext: params.runContext as never,
            subagentParentContext: params.subagentParentContext as never,
          })
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
          return localResult
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
  isReuse: boolean
} {
  const infoPath = path.join(baseDir, HARNESS_INFO_FILE)
  if (fs.existsSync(infoPath)) {
    const previous = JSON.parse(fs.readFileSync(infoPath, 'utf8')) as HarnessInfo
    if (previous.baseDir === baseDir && previous.shareToken) {
      return { info: previous, isReuse: true }
    }
  }
  const info: HarnessInfo = {
    baseDir,
    port: 0,
    shareToken: '',
    vaultIdentity: '',
  }
  return { info, isReuse: false }
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

  const { info, isReuse } = loadOrCreateHarnessInfo(baseDir)
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

  let settings: YoloSettings = buildSettings({
    baseDir,
    vaultIdentity,
    shareToken,
    shareTokenId,
    pepper,
    port: await findFreePort(),
  })

  const mockProvider = getHarnessMockProvider()
  // 按 user 消息内容路由的脚本流（e2e 用例依赖）：
  // - 含 'hello harness' → 文本流（三段增量，用于流式过程断言）
  // - 含 'use tool:echo' → 先 tool_call 流，随后一段文本流（审批通过后的续答）
  // - 含 'delegate a subagent please' → 父回合 delegate_subagent 工具调用
  //   （durable：delegatedRoleId 命中 settings 的 delegatable assistant）→
  //   续答文本；子代理回合按 delegate prompt 文本匹配
  // - after_run 意图文本 → 续跑 run 的回合（场景 f 快 / 场景 g 首进程慢、
  //   重启进程快——慢速制造"运行中被杀"窗口，isReuse 区分进程代次）
  mockProvider.chunkDelayMs = 60
  mockProvider.script(/hello harness/i, [
    textTurn(['Hello from ', 'the mock LLM', '!']),
  ])
  mockProvider.script(/use tool:echo/i, [
    toolCallTurn(undefined, { text: 'hello' }),
    textTurn(['Tool executed', ', answer follows', '!']),
  ])
  mockProvider.script(/delegate a subagent please/i, [
    toolCallTurn(DELEGATE_SUBAGENT_TOOL_NAME, {
      description: 'Summarize the quarterly report',
      prompt: 'Summarize the quarterly report and return a concise bullet list.',
      delegatedRoleId: 'delegated-1',
    }),
    textTurn(['Delegation accepted', ', task delegated!']),
  ])
  // after_run 意图（场景 f）：续跑 run 快速完成。⚠️ 注册顺序有讲究：
  // 续跑 run 的 user 消息 = 上个 run 的 transcriptPage（含 run 1 的 delegate
  // prompt）+ 意图文本，pickTurn 按注册序取首个命中——意图规则必须排在
  // run 1 prompt 规则之前，否则续跑请求会命中 run 1 的（快）回合。
  mockProvider.script(/Follow up with the risk section/i, [
    textTurn(['Follow-up: ', 'risk section added']),
  ])
  // after_run 意图（场景 g）：首进程慢速（长 chunk 序列 × 60ms ≈ 10s 窗口，
  // spec 在 session 置 RUNNING 后 kill），重启进程（isReuse）快速完成
  mockProvider.script(/Follow up with the compliance review/i, [
    isReuse
      ? textTurn(['Compliance follow-up ', 'completed'])
      : textTurn(
          Array.from(
            { length: 160 },
            (_, index) => `compliance chunk ${index}; `,
          ),
        ),
  ])
  // 子代理 run 1（delegate prompt 即子会话首条 user 消息）；排在意图规则
  // 之后——续跑请求若未命中意图规则（异常路径）才会落到这里
  mockProvider.script(
    /Summarize the quarterly report and return a concise bullet list/i,
    [textTurn(['Delegated result: ', 'quarterly summary done'])],
  )

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
  const harnessRootHash = hashWorkspaceRoot('/', vaultIdentity)
  const basePersist = persistence.persistConversationMessages.bind(persistence)
  const persistWithBindingGuard: typeof basePersist = async (payload) => {
    await basePersist(payload)
    await ChatManager.withConversationLock(payload.conversationId, async () => {
      const chat = (await chatManager.findById(
        payload.conversationId,
      )) as (ChatManager extends never ? never : { webBinding?: unknown }) | null
      if (chat && !chat.webBinding) {
        await chatManager.updateChat(
          payload.conversationId,
          {
            agentInstanceId: 'agent-1',
            webBinding: {
              initialAgentId: 'agent-1',
              activeAgentId: 'agent-1',
              rootHash: harnessRootHash,
            },
          } as never,
          { touchUpdatedAt: false },
        )
      }
    })
  }
  const agentService = new AgentService({
    getSettings: () => settings,
    persistConversationMessages: persistWithBindingGuard as never,
  })
  const sseHub = new WebSseHub()
  const agentEventStore = createAgentEventStore(
    path.join(baseDir, yoloBaseDir),
  )
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
  let subagentSessionReady: Promise<void> | undefined
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
      const registered = registerWebServerRoutes({
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
      subagentSessionReady = registered.subagentSessionReady

      // harness 专用测试入口（仅本测试进程；生产面不暴露 send——web 无
      // subagent chat UI，after_run 意图由 e2e spec 经此触发真实
      // SubagentSessionService.send + deliverQueuedIntents，检验 Part 1 的
      // onIntentRunRequested → runSubagentSessionContinuation 接线）。
      server.router.post(
        '/api/harness/subagent/send-and-deliver',
        async (req, res) => {
          const { getSubagentSessionService } = await import(
            '../../src/core/agent/subagent/session-service'
          )
          const service = getSubagentSessionService()
          if (!service) {
            writeJson(
              res,
              503,
              apiError(
                'subagent_unavailable',
                'The subagent session service is unavailable.',
              ),
            )
            return
          }
          const body = await readJsonBody(req)
          if (!body.ok) {
            writeJson(res, body.statusCode, body.body)
            return
          }
          const { sessionId, text } = body.value
          if (typeof sessionId !== 'string' || typeof text !== 'string') {
            writeJson(
              res,
              400,
              apiError('invalid_request', 'sessionId and text are required'),
            )
            return
          }
          const snapshot = await service.query(sessionId)
          if (!snapshot) {
            writeJson(
              res,
              404,
              apiError('session_not_found', 'The subagent session was not found.'),
            )
            return
          }
          const sent = await service.send({
            sessionId,
            messageId: `e2e-after-run-${Date.now()}`,
            text,
            delivery: 'after_run',
            expectedSessionRevision: snapshot.session.revision,
            requestId: `e2e-send-${Date.now()}`,
          })
          if (!sent.accepted) {
            writeJson(res, 409, {
              error: { code: sent.errorCode, message: 'send rejected' },
            })
            return
          }
          await service.deliverQueuedIntents(sessionId)
          writeJson(res, 200, { ok: true, sessionRevision: sent.sessionRevision })
        },
      )

      boundServer = server
      return server
    },
  })

  await lifecycle.reconcile()
  if (!boundServer) {
    throw new Error('harness: web server did not start')
  }
  // 生产接线的 subagent 运行时初始化（会话服务 + 恢复扫描）必须在 READY
  // 握手前完成：场景 g 的重启进程依赖扫描先把 RUNNING 会话置 NEEDS_RESUME，
  // 浏览器 UI 才能断言 needs_resume 状态行。
  await subagentSessionReady
  const httpServer = (
    boundServer as unknown as { server: HttpServer }
  ).server
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

function buildSettings(input: {
  baseDir: string
  vaultIdentity: string
  shareToken: string
  shareTokenId?: string
  pepper: string
  port: number
}): YoloSettings {
  const rootHash = hashWorkspaceRoot('/', input.vaultIdentity)
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
    assistants: [
      {
        id: 'template-1',
        name: 'Template One',
        agentModeAllowed: true,
        toolPreferences: {
          [HARNESS_TOOL_NAME]: { enabled: true },
          // durable delegate：full_access 免审批自动执行（mock 侧预允许），
          // enabled 使父 run 的 allowedToolNames 含该工具（gateway isToolAllowed）
          [DELEGATE_SUBAGENT_TOOL_NAME]: {
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
    ],
    currentWorkspaceAgentId: 'agent-1',
    webRuntime: {
      enabled: true,
      host: '127.0.0.1',
      port: input.port,
      token: '',
      maxConcurrentAgentRuns: 12,
    },
    advancedMemoryIndexEnabled: false,
    memoryReflectionEnabled: false,
  })
  return parsed
}

describe('web e2e harness server', () => {
  it(
    'assembles the real web runtime and serves until SIGTERM',
    async () => {
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
    },
    900_000,
  )
})
