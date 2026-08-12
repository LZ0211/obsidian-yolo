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
import { getYoloBaseDir } from '../../src/core/paths/yoloPaths'
import {
  hashShareToken,
  hashWorkspaceRoot,
  createShareToken,
  parsePublicTokenId,
} from '../../src/core/web-server/shareTokenCrypto'
import { loadOrCreateShareTokenPepper } from '../../src/core/web-server/shareTokenPepperStore'
import { registerWebServerRoutes } from '../../src/core/web-server/registerWebServerRoutes'
import { WebHttpServer } from '../../src/core/web-server/WebHttpServer'
import { WebServerLifecycle } from '../../src/core/web-server/WebServerLifecycle'
import { WebSseHub } from '../../src/core/web-server/WebSseHub'
import { ChatManager } from '../../src/database/json/chat/ChatManager'
import { SETTINGS_SCHEMA_VERSION } from '../../src/settings/schema/migrations'
import { parseYoloSettings } from '../../src/settings/schema/settings'
import type { YoloSettings } from '../../src/settings/schema/setting.types'
import type { McpManager } from '../../src/core/mcp/mcpManager'
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
  }
})

import {
  HARNESS_TOOL_NAME,
  getHarnessMockProvider,
  textTurn,
  toolCallTurn,
} from './llm-mock-provider'
import { createAppMock } from './fs-vault-mock'

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

function createMockMcpManager(): McpManager {
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
    ]),
    getJsSandboxSettings: jest.fn(() => ({})),
    getSettingsSnapshot: jest.fn(() => ({})),
    allowToolForConversation: jest.fn(
      (toolName: string, conversationId: string) => {
        allowedByConversation.add(`${conversationId}:${toolName}`)
      },
    ),
    isToolExecutionAllowed: jest.fn(
      ({ requestToolName, conversationId }: { requestToolName: string; conversationId?: string }) =>
        conversationId != null &&
        allowedByConversation.has(`${conversationId}:${requestToolName}`),
    ),
    callTool: jest.fn(
      async ({ name, args }: { name: string; args?: Record<string, unknown> }) => ({
        status: ToolCallResponseStatus.Success,
        data: {
          type: 'text',
          text: `[harness] ${name} called with ${JSON.stringify(args ?? {})}`,
        },
      }),
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
  mockProvider.chunkDelayMs = 60
  mockProvider.script(/hello harness/i, [
    textTurn(['Hello from ', 'the mock LLM', '!']),
  ])
  mockProvider.script(/use tool:echo/i, [
    toolCallTurn({ text: 'hello' }),
    textTurn(['Tool executed', ', answer follows', '!']),
  ])

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
  const mcpManager = createMockMcpManager()

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
      boundServer = server
      return server
    },
  })

  await lifecycle.reconcile()
  if (!boundServer) {
    throw new Error('harness: web server did not start')
  }
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
        },
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
