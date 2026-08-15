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
import { createCliChatRuntime } from '../chat-runtime/cli/createCliChatRuntime'
import type { CliRuntimeScope } from '../cli-runtime/coordinator'
import { detectCliRuntimeAvailability } from '../cli-runtime/desktop'
import type { McpManager } from '../mcp/mcpManager'
import { getYoloBaseDir } from '../paths/yoloPaths'
import { normalizeConversationWorkingDirectory } from '../workspace/conversationFileScope'

import { registerAgentRoutes } from './routes/agentRoutes'
import { registerApplyRoutes } from './routes/applyRoutes'
import { registerAuthRoutes } from './routes/authRoutes'
import { registerBootstrapRoutes } from './routes/bootstrapRoutes'
import { registerChatRoutes } from './routes/chatRoutes'
import {
  closeChatRuntimeSessionStreams,
  invalidateChatRuntimeConversation,
  registerChatRuntimeRoutes,
} from './routes/chatRuntimeRoutes'
import { registerCitationRoutes } from './routes/citationRoutes'
import { registerMcpRoutes } from './routes/mcpRoutes'
import { apiError } from './routes/routeUtils'
import { registerSettingsRoutes } from './routes/settingsRoutes'
import { registerSkillRoutes } from './routes/skillRoutes'
import { registerStaticWebRoutes } from './routes/staticWebRoutes'
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
import { writeJson } from './WebHttpServer'
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
  getCliRuntimeScope?: () =>
    | Promise<CliRuntimeScope | null>
    | CliRuntimeScope
    | null
  now?: () => number
}

export type RegisteredWebServerRoutes = {
  bridge: WebAgentRunBridge
  lifecycleService: WebAgentLifecycleService
  dispose: () => Promise<void>
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
    closeChatRuntimeSessionStreams(event.sessionId, event.code)
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
    onTerminal: (run) => {
      options.sseHub.clearRun(run.runId)
    },
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
        const updated = await patchConversation(
          conversationId,
          patch,
          updateOptions?.touchUpdatedAt,
        )
        if (updated && updated.workingDirectory !== current.workingDirectory) {
          await invalidateChatRuntimeConversation(conversationId)
        }
        return updated
      }
      return getChat(conversationId)
    },
    deleteChat: async (conversationId) => {
      const current = await getChat(conversationId)
      if (!current) return false
      await options.chatManager.deleteChat(conversationId)
      await invalidateChatRuntimeConversation(conversationId)
      return true
    },
    saveChat: async (request) => {
      const current = await getChat(request.id)
      if (!current) {
        return registerChatRoutesContext.createChat(request)
      }
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
      }
      if (request.workingDirectory !== undefined) {
        patch.workingDirectory = request.workingDirectory
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
      const saved = await getChat(request.id)
      if (saved && saved.workingDirectory !== current?.workingDirectory) {
        await invalidateChatRuntimeConversation(request.id)
      }
      return saved
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
            options.getSettings(),
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
    authorizeChatRuntime: async (sessionId, conversationId) => {
      if (!conversationId) return true
      const resolved = resolver.resolve({ sessionId })
      if (!resolved.ok) return false
      const conversation = await getChat(conversationId)
      return canUseWebConversation(conversation, {
        activeAgentId: resolved.context.activeAgent.id,
        rootHash: resolved.context.rootHash,
      })
    },
    getChatRuntime: async (runtimeId, conversationId) => {
      // 决策：native 分支不移植——Web 主面（yolo）已走 /api/agent/* 直驱
      // AgentService，此处恒返回 null（路由回 404 runtime_unavailable）。
      if (runtimeId === 'yolo') {
        return null
      }
      const conversation = conversationId ? await getChat(conversationId) : null
      if (conversationId && !conversation) return null
      let workingDirectory: string
      try {
        workingDirectory = normalizeConversationWorkingDirectory(
          conversation?.workingDirectory ?? '/',
        )
      } catch {
        return null
      }
      const folder =
        workingDirectory === '/'
          ? options.app.vault.getRoot()
          : options.app.vault.getAbstractFileByPath(workingDirectory.slice(1))
      if (!(folder instanceof TFolder)) return null
      // CLI 面（claude-code/codex）：桌面协调器 scope 可用时按实例创建
      // CLI 契约 runtime；scope 不可用（移动端/未接线）回 404。
      const scope = await (options.getCliRuntimeScope?.() ?? null)
      return scope
        ? await createCliChatRuntime(scope, runtimeId, {
            app: options.app,
            settings: options.getSettings(),
            getMcpManager: options.getMcpManager,
            workingDirectory,
          })
        : null
    },
  })

  // Web 端 CLI 入口可见性探测。浏览器里 Platform.isDesktop 为 false 且
  // adapter 不是 FileSystemAdapter，Chat 的桌面探测逻辑永远判定 CLI 不可用，
  // 但服务端（桌面宿主）实际可以承载 CLI 契约 runtime——这里把宿主侧的探测
  // 结果暴露给浏览器。
  options.server.router.get('/api/cli/availability', async (req, res) => {
    const scope = await (options.getCliRuntimeScope?.() ?? null)
    if (!scope) {
      writeJson(res, 200, { 'claude-code': false, codex: false })
      return
    }
    writeJson(res, 200, await detectCliRuntimeAvailability(options.app))
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

  return {
    bridge,
    lifecycleService,
    dispose: async () => {
      runScheduler.dispose()
      await bridge.dispose()
      sessionStore.dispose()
      options.sseHub.clear()
    },
  }
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
