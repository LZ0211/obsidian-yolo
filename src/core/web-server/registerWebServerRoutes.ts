import { type App, FileSystemAdapter, TFolder, getLanguage } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { ChatManager } from '../../database/json/chat/ChatManager'
import {
  deserializeChatMessage,
  serializeChatMessage,
} from '../../hooks/useChatHistory'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ApplyViewState } from '../../types/apply-view.types'
import { isUntitledConversationTitle } from '../../utils/chat/conversationTitle'
import { exportChatConversationToVault } from '../../utils/chat/exportConversation'
import { generateConversationTitleText } from '../../utils/chat/generateConversationTitle'
import { loadDesktopNodeModuleSync } from '../../utils/platform/desktopNodeModule'
import type { AgentEventStore } from '../agent/agentEventStore'
import type { AgentConversationState, AgentService } from '../agent/service'
import type { SubagentAuthorityResolverDependencies } from '../agent/subagent/authority-resolver'
import { getSubagentSessionService } from '../agent/subagent/session-service'
import { createCliChatRuntime } from '../chat-runtime/cli/createCliChatRuntime'
import type { CliRuntimeScope } from '../cli-runtime/coordinator'
import type { McpManager } from '../mcp/mcpManager'
import { getYoloBaseDir } from '../paths/yoloPaths'

import { registerAgentRoutes } from './routes/agentRoutes'
import { registerApplyRoutes } from './routes/applyRoutes'
import { registerAuthRoutes } from './routes/authRoutes'
import { registerBootstrapRoutes } from './routes/bootstrapRoutes'
import { registerChatRoutes } from './routes/chatRoutes'
import { registerChatRuntimeRoutes } from './routes/chatRuntimeRoutes'
import { registerCitationRoutes } from './routes/citationRoutes'
import { registerMcpRoutes } from './routes/mcpRoutes'
import { apiError } from './routes/routeUtils'
import { registerSettingsRoutes } from './routes/settingsRoutes'
import { registerSkillRoutes } from './routes/skillRoutes'
import { registerStaticWebRoutes } from './routes/staticWebRoutes'
import { registerSubagentRoutes } from './routes/subagentRoutes'
import { registerVaultRoutes } from './routes/vaultRoutes'
import { loadOrCreateShareTokenPepper } from './shareTokenPepperStore'
import { createWebAgentContextResolver } from './webAgentContextResolver'
import { WebAgentLifecycleService } from './webAgentLifecycleService'
import { WebAgentRunBridge } from './WebAgentRunBridge'
import type {
  WebChatConversation,
  WebChatConversationMetadata,
} from './webAgentTypes'
import {
  WebChatRuntimeAdapter,
  workspaceAgentPolicyToRuntimeAccessPolicy,
} from './WebChatRuntimeAdapter'
import type { WebHttpServer } from './WebHttpServer'
import { WebRunScheduler } from './WebRunScheduler'
import { WebSessionStore } from './webSessionStore'
import type { WebSseHub } from './WebSseHub'

export type RegisterWebServerRoutesOptions = {
  server: WebHttpServer
  app: App
  /**
   * 结构化的 host 插件视图（backup 直接引用 YoloPlugin 类型；此处只声明
   * 组合器实际消费的成员，避免 core 层对 main.ts 的静态类型依赖）。
   */
  plugin: {
    app: App
    manifest: { dir?: string }
    setSettings: (settings: YoloSettings) => Promise<boolean>
    openApplyReview: (state: ApplyViewState) => Promise<boolean>
  }
  chatManager: ChatManager
  agentEventStore: AgentEventStore
  sseHub: WebSseHub
  getSettings: () => YoloSettings
  host: string
  port: number
  getServerUrl?: () => string
  getAgentService: () => AgentService
  getMcpManager: () => Promise<McpManager>
  /**
   * 桌面 CLI 运行时 scope 的惰性获取器（main.ts 经 createCliRuntimeScope 提供）。
   * 未提供或返回 null 时，CLI 面（claude-code/codex）的 chat-runtime 端点回
   * 404 runtime_unavailable；yolo 分支恒 null（native 走 /api/agent/*）。
   */
  getCliRuntimeScope?: () => Promise<CliRuntimeScope | null> | CliRuntimeScope | null
  now?: () => number
}

export type RegisteredWebServerRoutes = {
  bridge: WebAgentRunBridge
  lifecycleService: WebAgentLifecycleService
  /**
   * Task 11 web 接线：subagent durable session 运行时初始化（会话服务单例 +
   * 恢复扫描 + after_run 续跑回调）的完成信号。失败已 .catch 记录，promise
   * 总是 resolve——harness 用它保证 READY 握手前恢复扫描已跑完（e2e 场景 g
   * 依赖重启进程内先完成扫描再断言 needs_resume UI）。
   */
  subagentSessionReady?: Promise<void>
}

const DEFAULT_WEB_AGENT_MAX_CONCURRENT = 12

const getPath = () =>
  loadDesktopNodeModuleSync<typeof import('node:path')>('node:path')

/**
 * Resolve the on-disk plugin directory (absolute) so static asset serving
 * looks in `web-ui` next to the plugin's own files, not the Obsidian
 * process cwd. Falls back to `process.cwd()` only if neither vault path nor
 * manifest dir is available, matching the test environment.
 */
function resolvePluginAbsoluteDir(
  app: App,
  plugin: { manifest: { dir?: string } },
): string {
  const adapter = app.vault.adapter
  const vaultBasePath =
    adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null
  const manifestDir = plugin.manifest.dir
  if (vaultBasePath && manifestDir) {
    return getPath().join(vaultBasePath, manifestDir)
  }
  return process.cwd()
}

/**
 * master 的 ChatManager 会话类型没有 webBinding 字段（Task 8 评审披露的
 * 接缝）。落库方式：在 updateChat 的 updates 上做类型扩展 cast——ChatManager
 * 是读-改-写整文件落盘，多余字段原样保留，重启后跨 root 访问控制不失效。
 */
type ChatManagerUpdatePatch = Parameters<ChatManager['updateChat']>[1]

export function registerWebServerRoutes(
  options: RegisterWebServerRoutesOptions,
): RegisteredWebServerRoutes {
  const sessionStore = new WebSessionStore({ now: options.now })
  sessionStore.onSessionClosed((event) => {
    options.sseHub.closeSession(event.sessionId, event.code)
  })
  const pepper = loadOrCreateShareTokenPepper(
    resolveAbsoluteYoloBaseDir(options.app, options.getSettings()),
  )
  const vaultIdentity = options.app.vault.getName()
  const resolver = createWebAgentContextResolver({
    getSettings: options.getSettings,
    getSession: (sessionId) => {
      const session = sessionId ? sessionStore.resolve(sessionId) : null
      if (!session) {
        return null
      }

      return {
        id: session.id,
        tokenRecordId: session.tokenRecordId,
        tokenScope: session.tokenScope,
        activeAgentId: session.activeAgentId,
        rootHash: session.rootHash,
        createdAt: session.createdAt,
        lastUsedAt: session.lastSeenAt,
        expiresAt: session.absoluteExpiresAt,
      }
    },
    vaultIdentity,
  })
  const bridge = new WebAgentRunBridge({
    eventStore: options.agentEventStore,
    sseHub: options.sseHub,
    now: options.now,
  })
  const runScheduler = new WebRunScheduler({
    maxConcurrent: DEFAULT_WEB_AGENT_MAX_CONCURRENT,
    now: options.now,
  })
  const adapter = new WebChatRuntimeAdapter({
    app: options.app,
    chatManager: options.chatManager,
    loadConversation: (conversationId) =>
      options.chatManager.findById(conversationId),
    getSettings: options.getSettings,
    getAgentService: options.getAgentService,
    getMcpManager: options.getMcpManager,
  })
  const lifecycleService = new WebAgentLifecycleService({
    getSettings: options.getSettings,
    saveSettings: async (settings) => {
      await options.plugin.setSettings(settings as YoloSettings)
    },
    sessionStore,
    orphanConversations: async (agentId, reason) => {
      const conversations = await options.chatManager.listChats()
      let updatedCount = 0
      for (const metadata of conversations) {
        const current = (await options.chatManager.findById(
          metadata.id,
        )) as WebChatConversation | null
        const binding = current?.webBinding
        if (!current || !binding) continue
        if (
          binding.initialAgentId !== agentId &&
          binding.activeAgentId !== agentId
        ) {
          continue
        }
        if (binding.accessState === 'orphaned') continue
        await options.chatManager.updateChat(
          current.id,
          {
            webBinding: {
              ...binding,
              accessState: 'orphaned',
              orphanedReason: reason,
              updatedAt: Date.now(),
            },
          } as unknown as ChatManagerUpdatePatch,
          { touchUpdatedAt: false },
        )
        updatedCount += 1
      }
      return updatedCount
    },
    agentEventStore: options.agentEventStore,
    abortAgentRuns: async (agentId) => {
      for (const run of options.agentEventStore.listRunsByAgent(agentId)) {
        if (run.status === 'running') {
          bridge.abort(run.runId)
          options.sseHub.clearRun(run.runId)
        }
      }
    },
  })

  // Static assets sit under the *plugin* dir (web-ui), not the Obsidian
  // process cwd. Without this, GET / returns "Not found" because the default
  // cwd lookup misses every candidate path.
  registerStaticWebRoutes(options.server.router, {
    cwd: resolvePluginAbsoluteDir(options.app, options.plugin),
  })
  registerAuthRoutes(options.server.router, {
    getSettings: options.getSettings,
    pepper,
    sessionStore,
    resolver,
    vaultIdentity,
    now: options.now,
  })

  const getChat = async (
    conversationId: string,
  ): Promise<WebChatConversation | null> =>
    (await options.chatManager.findById(
      conversationId,
    )) as WebChatConversation | null

  const patchConversation = async (
    conversationId: string,
    patch: Record<string, unknown>,
    touchUpdatedAt?: boolean,
  ): Promise<WebChatConversation | null> => {
    // master 无 backup 的 gateway revision 冲突检测；桌面单进程下读-改-写
    // 由 ChatManager 整文件落盘保证。webBinding 经类型扩展 cast 落库。
    // 与 persistConversationMessages 共享会话级锁，避免跨 ChatManager 实例
    // 的读-改-写竞态把 webBinding 补丁覆盖掉（过期读晚落盘）。
    return ChatManager.withConversationLock(conversationId, async () => {
      const current = await getChat(conversationId)
      if (!current) return null
      await options.chatManager.updateChat(
        conversationId,
        patch as unknown as ChatManagerUpdatePatch,
        { touchUpdatedAt: touchUpdatedAt === true },
      )
      return getChat(conversationId)
    })
  }

  const registerChatRoutesContext: Parameters<typeof registerChatRoutes>[1] = {
    // ChatManager.listChats() 的 metadata 不带 webBinding（toMetadata 剥离），
    // 而 /api/chat/list 的 canAccessConversation 又必须按 webBinding 过滤——
    // 直接透传会让 web 历史列表永远为空。逐条补回 webBinding/实例字段。
    listChats: async () => {
      const metadata = await options.chatManager.listChats()
      const enriched = await Promise.all(
        metadata.map(async (meta): Promise<WebChatConversationMetadata> => {
          const chat = (await options.chatManager.findById(
            meta.id,
          )) as WebChatConversation | null
          return {
            ...meta,
            workspaceId: chat?.workspaceId ?? null,
            agentInstanceId: chat?.agentInstanceId ?? null,
            webBinding: chat?.webBinding ?? null,
          }
        }),
      )
      return enriched
    },
    getChat,
    findById: getChat,
    createChat: async (
      chat: Partial<WebChatConversation>,
    ): Promise<WebChatConversation> => {
      const conversationId = chat.id ?? uuidv4()
      const createdAt = Date.now()
      await options.chatManager.createChat({
        id: conversationId,
        title: chat.title?.trim() ? chat.title : 'New chat',
        messages: (chat.messages ?? []) as never,
        createdAt,
        updatedAt: createdAt,
        origin: 'external-agent',
        assistantId: chat.assistantId,
        overrides: chat.overrides,
        conversationModelId: chat.conversationModelId,
        messageModelMap: chat.messageModelMap,
        activeBranchByUserMessageId: chat.activeBranchByUserMessageId,
        assistantGroupBoundaryMessageIds: chat.assistantGroupBoundaryMessageIds,
        reasoningLevel: chat.reasoningLevel,
        compaction: chat.compaction,
        workingDirectory: chat.workingDirectory,
        webBinding: chat.webBinding,
      } as never)
      const created = await getChat(conversationId)
      if (!created) throw new Error('conversation_create_failed:not_found')
      return created
    },
    updateChat: async (conversationId, updates, updateOptions) => {
      if ('messages' in updates) return null
      const current = await getChat(conversationId)
      if (!current) return null
      const updateRecord = updates as Record<string, unknown>
      if (typeof updateRecord.title === 'string') {
        await options.chatManager.updateChat(
          conversationId,
          { title: updateRecord.title },
          updateOptions,
        )
      }
      const patch = { ...updateRecord }
      delete patch.title
      if (Object.keys(patch).length > 0) {
        return patchConversation(
          conversationId,
          patch,
          updateOptions?.touchUpdatedAt,
        )
      }
      return getChat(conversationId)
    },
    deleteChat: async (conversationId) => {
      const current = await getChat(conversationId)
      if (!current) return false
      await options.chatManager.deleteChat(conversationId)
      return true
    },
    saveChat: async (request) => {
      const patch: Record<string, unknown> = {
        messages: request.messages,
        overrides: request.overrides,
        conversationModelId: request.conversationModelId,
        messageModelMap: request.messageModelMap,
        activeBranchByUserMessageId: request.activeBranchByUserMessageId,
        assistantGroupBoundaryMessageIds:
          request.assistantGroupBoundaryMessageIds,
        reasoningLevel: request.reasoningLevel,
        compaction: request.compaction,
        workingDirectory: request.workingDirectory,
      }
      // ChatManager.updateChat 是 spread 合并：客户端对象里 webBinding 通常
      // 是 undefined（web 会话绑定由服务端维护），直接写入会把 run 时打上的
      // webBinding 抹掉，导致后续审批/访问控制 404。undefined 时保留现状。
      if (request.webBinding !== undefined) {
        patch.webBinding = request.webBinding
      }
      await options.chatManager.updateChat(
        request.id,
        patch as unknown as ChatManagerUpdatePatch,
        { touchUpdatedAt: request.touchUpdatedAt === true },
      )
      return getChat(request.id)
    },
    generateTitle: async ({ conversationId, messages, force }) => {
      const current = await getChat(conversationId)
      if (!current) return
      if (!force && !isUntitledConversationTitle(current.title)) return
      const firstUserMessage = messages.find(
        (message) => message.role === 'user',
      )
      if (!firstUserMessage) return
      const result = await generateConversationTitleText({
        settings: options.getSettings(),
        language: resolveWebLanguage(),
        messages: messages.map((message) =>
          deserializeChatMessage(message as never, options.app),
        ),
      })
      if (!result.ok) return
      await options.chatManager.updateChat(
        conversationId,
        { title: result.title },
        { touchUpdatedAt: false },
      )
    },
    exportToVault: (conversationId) =>
      exportChatConversationToVault({
        app: options.app,
        chatManager: options.chatManager,
        conversationId,
        settings: options.getSettings(),
      }),
    appendMessages: async (id, baseCount, newMessages, metadata) => {
      const current = await getChat(id)
      if (!current || current.messages.length !== baseCount) {
        return { ok: false, conflict: true }
      }
      const updated = await options.chatManager.updateChat(
        id,
        {
          ...metadata,
          messages: [...current.messages, ...newMessages],
        } as unknown as ChatManagerUpdatePatch,
        { touchUpdatedAt: true },
      )
      if (!updated) return { ok: false, conflict: true }
      return { ok: true, updatedAt: updated.updatedAt }
    },
    resolveChatBinding: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: 401,
          body: apiError('session_expired', 'The web session has expired.'),
        }
      }

      return {
        ok: true as const,
        binding: {
          activeAgentId: resolved.context.activeAgent.id,
          rootHash: resolved.context.rootHash,
          allowedAgentIds: resolved.context.allowedAgents.map(
            (agent) => agent.id,
          ),
          workspaceAccessPolicy: workspaceAgentPolicyToRuntimeAccessPolicy(
            resolved.context.activeAgent.workspacePolicy,
          ),
        },
      }
    },
    isVaultFolder: (canonicalPath) => {
      const folder =
        canonicalPath === '/'
          ? options.app.vault.getRoot()
          : options.app.vault.getAbstractFileByPath(canonicalPath.slice(1))
      return folder instanceof TFolder
    },
  }

  registerChatRoutes(options.server.router, registerChatRoutesContext)

  registerChatRuntimeRoutes(options.server.router, {
    getChatRuntime: async (runtimeId, _conversationId) => {
      // 决策：native 分支不移植——Web 主面（yolo）已走 /api/agent/* 直驱
      // AgentService，此处恒返回 null（路由回 404 runtime_unavailable）。
      if (runtimeId === 'yolo') {
        return null
      }
      // CLI 面（claude-code/codex）：桌面协调器 scope 可用时按实例创建
      // CLI 契约 runtime；scope 不可用（移动端/未接线）回 404。
      const scope = await (options.getCliRuntimeScope?.() ?? null)
      return scope
        ? await createCliChatRuntime(scope, runtimeId, {
            app: options.app,
            settings: options.getSettings(),
            getMcpManager: options.getMcpManager,
          })
        : null
    },
  })

  registerCitationRoutes(options.server.router, {
    getChat,
    resolveCitationBinding: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: resolved.code === 'unauthenticated' ? 401 : 403,
          body:
            resolved.code === 'unauthenticated'
              ? apiError('session_expired', 'The web session has expired.')
              : apiError(resolved.code, resolved.message),
        }
      }

      return {
        ok: true as const,
        binding: {
          activeAgentId: resolved.context.activeAgent.id,
          allowedAgentIds: resolved.context.allowedAgents.map(
            (agent) => agent.id,
          ),
          rootHash: resolved.context.rootHash,
          policy: resolved.context.activeAgent.workspacePolicy,
        },
      }
    },
  })

  registerAgentRoutes(options.server.router, {
    getRun: (runId) => {
      const scheduled = runScheduler.getRun(runId)
      if (scheduled) {
        return {
          runId: scheduled.runId,
          conversationId: scheduled.conversationId,
          status: scheduled.status,
        }
      }
      const run = options.agentEventStore.getRun(runId)
      return run
        ? {
            runId: run.runId,
            conversationId: run.conversationId,
            status: run.status,
          }
        : null
    },
    getRunEvents: (runId, afterSequence) => {
      const scheduled = runScheduler.getRun(runId)
      if (scheduled?.status === 'queued' && afterSequence < 1) {
        return [
          {
            sequence: 0,
            eventType: 'queue',
            eventJson: {
              type: 'queue',
              position: runScheduler.getQueuePosition(runId),
              activeRuns: runScheduler.getActiveCount(),
            },
            createdAtMs: scheduled.queuedAtMs,
          },
        ]
      }
      return options.agentEventStore
        .getRunEvents(runId, afterSequence)
        .map((event) => ({
          sequence: event.sequence,
          eventType: event.eventType,
          eventJson: event.eventJson,
          createdAtMs: event.createdAtMs,
        }))
    },
    getAgentState: (conversationId) => {
      const state = options.getAgentService().getState(conversationId)
      return {
        ...state,
        messages: state.messages.map((message) =>
          serializeChatMessage(message),
        ),
      } as never
    },
    sseHub: options.sseHub,
    abortRun: (runId) => {
      const scheduled = runScheduler.getRun(runId)
      return scheduled ? runScheduler.abort(runId) : bridge.abort(runId)
    },
    runAgent: async ({ input, binding }) => {
      runScheduler.setMaxConcurrent(
        options.getSettings().webRuntime.maxConcurrentAgentRuns,
      )
      // rootHash 一并传入：新会话创建时即带 webBinding，避免补丁写入与
      // persist 的读-改-写竞态把 binding 覆盖掉（见 WebChatRuntimeAdapter
      // ensureConversation 注释）。
      const prepared = await adapter.prepareRun(
        input,
        binding.activeAgent,
        binding.rootHash,
      )
      const latest = await getChat(prepared.conversationId)
      if (latest) {
        const patch = {
          agentInstanceId: binding.activeAgentId,
          webBinding: {
            initialAgentId:
              latest.webBinding?.initialAgentId ?? binding.activeAgentId,
            activeAgentId: binding.activeAgentId,
            rootHash: binding.rootHash,
          },
        }
        await patchConversation(prepared.conversationId, patch)
      }
      const runId = uuidv4()
      runScheduler.enqueue({
        runId,
        conversationId: prepared.conversationId,
        execute: () =>
          bridge.start({
            runId,
            conversationId: prepared.conversationId,
            workspaceId: null,
            agentInstanceId: binding.activeAgentId,
            execute: prepared.execute,
            abort: prepared.abort,
          }),
        abort: () => {
          bridge.abort(runId)
        },
      })
      return {
        conversationId: prepared.conversationId,
        runId,
      }
    },
    compactConversation: ({ input, binding }) =>
      adapter.compactConversation(input, binding.activeAgent),
    buildContextBreakdown: ({ input, binding }) =>
      adapter.buildContextBreakdown(input, binding.activeAgent),
    approveToolCall: async (input) => {
      const agentService = options.getAgentService()
      const approved = await agentService.approveToolCall(input)
      const state = agentService.getState(input.conversationId)
      return {
        approved,
        state: {
          ...state,
          messages: state.messages.map((message) =>
            serializeChatMessage(message),
          ),
        } as AgentConversationState,
      }
    },
    rejectToolCall: (input) => options.getAgentService().rejectToolCall(input),
    abortToolCall: (input) => options.getAgentService().abortToolCall(input),
    peekPendingUserMessages: (conversationId) =>
      options
        .getAgentService()
        .peekPendingUserMessages(conversationId)
        .map((message) => serializeChatMessage(message) as never),
    enqueueUserMessage: ({ conversationId, message }) =>
      options
        .getAgentService()
        .enqueueUserMessage(
          conversationId,
          deserializeChatMessage(message as never, options.app) as never,
        ),
    removePendingUserMessage: ({ conversationId, messageId }) => {
      const removed = options
        .getAgentService()
        .removePendingUserMessage(conversationId, messageId)
      return removed ? (serializeChatMessage(removed) as never) : null
    },
    subscribeToPendingBackgroundTaskResults: (callback) =>
      options
        .getAgentService()
        .subscribeToPendingBackgroundTaskResults(callback),
    subscribeToAbortedQueuedMessages: (callback) =>
      options
        .getAgentService()
        .subscribeToAbortedQueuedMessages((conversationId, messages) => {
          callback(
            conversationId,
            messages.map((message) => serializeChatMessage(message) as never),
          )
        }),
    resolveAgentRouteBinding: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: resolved.code === 'unauthenticated' ? 401 : 403,
          body:
            resolved.code === 'unauthenticated'
              ? apiError('session_expired', 'The web session has expired.')
              : apiError(resolved.code, resolved.message),
        }
      }

      return {
        ok: true as const,
        binding: {
          activeAgentId: resolved.context.activeAgent.id,
          rootHash: resolved.context.rootHash,
          activeAgent: resolved.context.activeAgent,
        },
      }
    },
    canAccessConversation: async (conversationId, binding) => {
      const conversation = await getChat(conversationId)
      return canUseWebConversation(conversation, binding)
    },
    canStartConversation: async (conversationId, binding) => {
      const conversation = await getChat(conversationId)
      if (!conversation) {
        return true
      }
      return canUseWebConversation(conversation, binding)
    },
    canAccessRun: async (runId, binding) => {
      const scheduled = runScheduler.getRun(runId)
      const run = scheduled ?? options.agentEventStore.getRun(runId)
      if (!run) {
        return false
      }
      const conversation = await getChat(run.conversationId)
      return canUseWebConversation(conversation, binding)
    },
  })

  // /api/mcp/* is intentionally absent from isSharedWebSessionRoute and isPublicSharedWebRoute
  // (WebHttpServer.ts), so a non-loopback binding requires BOTH the Bearer token
  // (WebHttpServer.isAuthorizedRequest) AND a valid session via resolveMcpAccess — a deliberate
  // dual gate. Loopback binding skips the HTTP gate but the session check still applies.
  registerMcpRoutes(options.server.router, {
    app: options.app,
    getSettings: options.getSettings,
    getMcpManager: options.getMcpManager,
    resolveMcpAccess: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: resolved.code === 'unauthenticated' ? 401 : 403,
          body:
            resolved.code === 'unauthenticated'
              ? apiError('session_expired', 'The web session has expired.')
              : apiError(resolved.code, resolved.message),
        }
      }
      return { ok: true as const, context: resolved.context }
    },
  })

  registerBootstrapRoutes(options.server.router, {
    host: options.host,
    port: options.port,
    getSettings: () => options.getSettings(),
    getServerUrl: options.getServerUrl,
    getSessionContext: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      return resolved.ok ? resolved.context : null
    },
    getLanguage: () => resolveWebLanguage(),
  })
  registerSettingsRoutes(options.server.router, {
    getSettings: options.getSettings,
    getSessionContext: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      return resolved.ok ? resolved.context : null
    },
    resolveSettingsAccess: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: resolved.code === 'unauthenticated' ? 401 : 403,
          body:
            resolved.code === 'unauthenticated'
              ? apiError('session_expired', 'The web session has expired.')
              : apiError(resolved.code, resolved.message),
        }
      }
      return { ok: true as const }
    },
  })
  registerSkillRoutes(options.server.router, {
    app: options.app,
    getSettings: options.getSettings,
    resolveSkillsAccess: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: resolved.code === 'unauthenticated' ? 401 : 403,
          body:
            resolved.code === 'unauthenticated'
              ? apiError('session_expired', 'The web session has expired.')
              : apiError(resolved.code, resolved.message),
        }
      }
      return { ok: true as const }
    },
  })
  registerVaultRoutes(options.server.router, {
    vault: options.app.vault,
    workspace: options.app.workspace,
    fileManager: options.app.fileManager,
    resolveActiveAgentPolicy: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: resolved.code === 'unauthenticated' ? 401 : 403,
          body: {
            error: {
              code:
                resolved.code === 'unauthenticated'
                  ? 'session_expired'
                  : resolved.code,
              message:
                resolved.code === 'unauthenticated'
                  ? 'The web session has expired.'
                  : resolved.message,
            },
          },
        }
      }
      return {
        ok: true as const,
        policy: resolved.context.activeAgent.workspacePolicy,
      }
    },
  })
  // /api/ui/apply-review is likewise absent from the isSharedWebSessionRoute whitelist, so under a
  // non-loopback binding it requires both the Bearer token (WebHttpServer.isAuthorizedRequest) and a
  // valid session via resolveApplyAccess — the same intentional dual gate as /api/mcp/*.
  registerApplyRoutes(options.server.router, {
    openApplyReview: (state) => options.plugin.openApplyReview(state),
    resolveApplyAccess: (sessionId) => {
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: resolved.code === 'unauthenticated' ? 401 : 403,
          body:
            resolved.code === 'unauthenticated'
              ? apiError('session_expired', 'The web session has expired.')
              : apiError(resolved.code, resolved.message),
        }
      }
      return { ok: true as const }
    },
  })

  // Task 11 web 接线：subagent durable session 控制面（浏览器 UI 的
  // query/recover/queue-recovery/deliver-queued-intents）。鉴权 = 有效 web
  // session + 父会话可被当前 binding 访问（canUseWebConversation 与
  // /api/agent/* 同款，防止跨会话操作猜测的 sessionId）。
  registerSubagentRoutes(options.server.router, {
    getSessionService: () => getSubagentSessionService(),
    resolveSubagentAccess: async (sessionId, parentConversationId) => {
      if (!sessionId) {
        return {
          ok: false as const,
          statusCode: 401,
          body: apiError('unauthenticated', 'No active web session.'),
        }
      }
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) {
        return {
          ok: false as const,
          statusCode: resolved.code === 'unauthenticated' ? 401 : 403,
          body:
            resolved.code === 'unauthenticated'
              ? apiError('session_expired', 'The web session has expired.')
              : apiError(resolved.code, resolved.message),
        }
      }
      if (parentConversationId) {
        const conversation = await getChat(parentConversationId)
        if (
          !canUseWebConversation(conversation, {
            activeAgentId: resolved.context.activeAgent.id,
            rootHash: resolved.context.rootHash,
          })
        ) {
          return {
            ok: false as const,
            statusCode: 403,
            body: apiError(
              'forbidden',
              'The subagent session is not accessible from this web session.',
            ),
          }
        }
      }
      return { ok: true as const }
    },
  })

  // Task 11 web 接线：镜像 main.ts initSubagentSessionRuntime——会话服务单例 +
  // 恢复扫描 + after_run 意图续跑回调。initSubagentSessionService 是进程级
  // 单例：桌面宿主（main.ts onload）已初始化时此处直接复用其既有接线
  // （onIntentRunRequested 已绑定桌面 deps），仅 harness/无宿主环境由 web 侧
  // 完成接线。失败只诊断不阻断（与桌面一致）。
  const subagentSessionReady = initWebSubagentSessionRuntime({
    app: options.app,
    getSettings: options.getSettings,
    chatManager: options.chatManager,
    getMcpManager: options.getMcpManager,
  }).catch((error) => {
    console.error('[YOLO] Failed to recover web subagent sessions', error)
  })

  return { bridge, lifecycleService, subagentSessionReady }
}

/**
 * Task 11 web 接线：initSubagentSessionRuntime 的 web 形态（main.ts:4914 镜像）。
 * 差异点只有 deps 来源——web 侧 ChatManager 是 registerWebServerRoutes 的
 * options.chatManager（桌面 getChatManager 等价物），mcp manager 走
 * options.getMcpManager，settings/app 同为路由装配面。语义与桌面一致：
 * - isSessionActive 恒 false（装配时进程内注册表为空，恢复扫描处理全部残留
 *   RUNNING/NEEDS_RESUME 会话）；
 * - resolveDelegatedRole：角色仍可解析（未删除/仍可委托）即可，模型/工具等
 *   运行期校验留给续跑路径的 authority 解析；
 * - onIntentRunRequested：after_run 意图 settle 后 → runSubagentSessionContinuation
 *   （deps 缺省会直接抛错，fail-fast——续跑表现为"会话永不续跑"）。
 */
async function initWebSubagentSessionRuntime({
  app,
  getSettings,
  chatManager,
  getMcpManager,
}: {
  app: App
  getSettings: () => YoloSettings
  chatManager: ChatManager
  getMcpManager: () => Promise<McpManager>
}): Promise<void> {
  const [
    { initSubagentSessionService, getSubagentSessionService },
    { runSubagentSessionContinuation },
    { resolveDelegatableAssistant },
    { getProviderClient },
  ] = await Promise.all([
    import('../agent/subagent/session-service'),
    import('../agent/subagent/runner'),
    import('../agent/subagent/delegatable-assistant'),
    import('../llm/manager'),
  ])
  const deps: SubagentAuthorityResolverDependencies = {
    app,
    getSettings,
    // 注意：web 会话的归属 agent 落在 agentInstanceId / webBinding.activeAgentId
    // （WebChatRuntimeAdapter.ensureConversation 不写 ChatManager 的 assistantId
    // 字段）——authority 解析用 conversationMeta.assistantId 在 unified agent
    // 列表里找父 assistant，缺了会报 "parent assistant is unavailable"。
    loadConversationMeta: async (conversationId) => {
      const chat = await chatManager.findById(conversationId)
      return chat
        ? {
            conversationId: chat.id,
            assistantId: resolveWebConversationAssistantId(chat),
          }
        : null
    },
    // 父会话消息时间线用于 origin 上下文校验（origin 消息存在性/delegate
    // 工具调用归属/branch 匹配），与桌面 loadParentConversation 同构。
    loadParentConversation: async (conversationId) => {
      const chat = await chatManager.findById(conversationId)
      return chat
        ? {
            conversationId: chat.id,
            assistantId: resolveWebConversationAssistantId(chat),
            messages: chat.messages,
          }
        : null
    },
    createProviderClient: ({ settings, model }) =>
      getProviderClient({ settings, providerId: model.providerId }),
    createMcpManager: async () => getMcpManager(),
  }
  initSubagentSessionService(app, getSettings, {
    isSessionActive: () => false,
    resolveDelegatedRole: (delegatedRoleId) => {
      try {
        resolveDelegatableAssistant(getSettings(), delegatedRoleId)
        return true
      } catch {
        return false
      }
    },
    onIntentRunRequested: (sessionId) => {
      void runSubagentSessionContinuation(sessionId, deps).catch((error) => {
        console.error(
          '[YOLO][Web] Subagent session continuation failed',
          { sessionId },
          error,
        )
      })
    },
  })
  const service = getSubagentSessionService()
  await service?.recoverInterruptedSessions()
}

/**
 * web 会话的归属 agent id：assistantId（桌面 ChatManager 语义）→
 * agentInstanceId → webBinding.activeAgentId 依次回退。结构子集声明
 * （ChatManager.findById 返回基础 ChatConversation，web 扩展字段在运行时
 * 存在但不在基础类型上）。
 */
function resolveWebConversationAssistantId(
  chat: {
    assistantId?: string | null
    agentInstanceId?: string | null
    webBinding?: { activeAgentId?: string } | null
  },
): string | undefined {
  return (
    chat.assistantId ??
    chat.agentInstanceId ??
    chat.webBinding?.activeAgentId ??
    undefined
  )
}

function canUseWebConversation(
  conversation: Pick<WebChatConversation, 'webBinding'> | null | undefined,
  binding: { activeAgentId: string; rootHash: string },
): boolean {
  return (
    conversation?.webBinding?.rootHash === binding.rootHash &&
    conversation.webBinding.accessState !== 'orphaned' &&
    conversation.webBinding.activeAgentId === binding.activeAgentId
  )
}

function resolveAbsoluteYoloBaseDir(app: App, settings: YoloSettings): string {
  const adapter = app.vault.adapter
  const basePath =
    adapter instanceof FileSystemAdapter
      ? adapter.getBasePath()
      : typeof (adapter as unknown as { getBasePath?: unknown }).getBasePath ===
          'function'
        ? (adapter as unknown as { getBasePath: () => string }).getBasePath()
        : typeof (adapter as unknown as { basePath?: unknown }).basePath ===
            'string'
          ? (adapter as unknown as { basePath: string }).basePath
          : process.cwd()

  return `${basePath}/${getYoloBaseDir(settings)}`
}

function resolveWebLanguage(): string {
  const raw = String(getLanguage() ?? '')
    .trim()
    .toLowerCase()
  if (raw.startsWith('zh')) return 'zh'
  if (raw.startsWith('it')) return 'it'
  return 'en'
}
