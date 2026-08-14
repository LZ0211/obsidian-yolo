// Task 10 适配：backup 独有类型（moa/types、conversation/agentDiagnosticStore、
// conversation/types、types/agent-conversation）在 master 不存在——MoA 运行时
// 未移植（Task 6 同裁），会话网关类型收拢在 runtime/web/webConversationTypes，
// agent 状态类型改由 master 的 core/agent/service 提供。
import type { ContextBreakdownInputs } from '../components/chat-view/useContextBreakdown'
import type { ContextBreakdown } from '../core/agent/contextBreakdown'
import type {
  AgentConversationRunSummary,
  AgentConversationState,
  EnqueueUserMessageResult,
} from '../core/agent/service'
import type { CliRuntimeId } from '../core/cli-runtime/types'
import type { ChatConversationMetadata } from '../database/json/chat/types'
import type { YoloSettings } from '../settings/schema/setting.types'
import type {
  ChatConversationCompaction,
  ChatConversationCompactionLike,
  ChatMessage,
  ChatUserMessage,
} from '../types/chat'
import type { ConversationOverrideSettings } from '../types/conversation-settings.types'
import type { ReasoningLevel } from '../types/reasoning'

import type { ConversationGateway, WebChatBinding } from './web/webConversationTypes'

/** master 的 useContextBreakdown 未导出该别名（backup 有），本地补齐。 */
export type WebContextBreakdownSource = ContextBreakdownInputs | ContextBreakdown

export type YoloPluginInfo = {
  id: string
  name: string
  version: string
  dir?: string
}

export type YoloRuntimeMode = 'obsidian' | 'web'

export type YoloRuntimePlatform = {
  isMacOS: boolean
  isDesktopApp: boolean
  isPhone: boolean
  isIosApp: boolean
}

export type YoloRuntimeCompatibilityBridge = {
  app?: any
  plugin?: any
  TFile?: any
  TFolder?: any
  MarkdownView?: any
  MarkdownRenderer?: any
  platform: YoloRuntimePlatform
  keymap: {
    isModEvent(e: MouseEvent | KeyboardEvent): boolean | string
  }
  utils: {
    htmlToMarkdown(html: string): string
    normalizePath(path: string): string
  }
}

export type YoloFileStat = {
  ctime: number
  mtime: number
  size: number
}

export type YoloChatRecord = {
  id: string
  schemaVersion: number
  createdAt: number
  title: string
  messages: ChatMessage[]
  overrides?: ConversationOverrideSettings | null
  assistantId?: string
  conversationModelId?: string
  messageModelMap?: Record<string, string>
  activeBranchByUserMessageId?: Record<string, string>
  assistantGroupBoundaryMessageIds?: string[]
  reasoningLevel?: string
  compaction?: ChatConversationCompactionLike | null
  workingDirectory?: string
  fileScopeLocked?: boolean
  updatedAt: number
  isPinned?: boolean
  pinnedAt?: number
  workspaceId?: string | null
  agentInstanceId?: string | null
  webBinding?: WebChatBinding | null

  origin?: 'user' | 'external-agent'
  cliSession?: {
    runtimeId: CliRuntimeId
    nativeSessionId: string
    sessionPathHint?: string
  }
  /**
   * Web 服务端 journal 版本（backup 语义）。master ChatManager 无 revision
   * 概念（读-改-写整文件落盘），wire 上恒缺省；gateway 读 `?? 0` 回退。
   */
  revision?: number
}

export type SaveYoloChatInput = {
  id: string
  messages: ChatMessage[]
  assistantId?: string
  overrides?: ConversationOverrideSettings | null
  conversationModelId?: string
  messageModelMap?: Record<string, string>
  activeBranchByUserMessageId?: Record<string, string>
  assistantGroupBoundaryMessageIds?: string[]
  reasoningLevel?: string
  compaction?: ChatConversationCompactionLike | null
  workingDirectory?: string
  touchUpdatedAt?: boolean
  workspaceId?: string | null
  agentInstanceId?: string | null
  webBinding?: WebChatBinding | null
}

export type AppendYoloChatInput = {
  id: string
  baseCount: number
  newMessages: ChatMessage[]
  assistantId?: string
  overrides?: ConversationOverrideSettings | null
  conversationModelId?: string
  messageModelMap?: Record<string, string>
  activeBranchByUserMessageId?: Record<string, string>
  assistantGroupBoundaryMessageIds?: string[]
  reasoningLevel?: string
  compaction?: ChatConversationCompactionLike | null
}

export type EditHistoricalTurnInput = {
  conversationId: string
  expectedRevision: number
  messageId: string
  expectedGeneration: number
  replacement: ChatUserMessage
}

export type HistoricalMessageMutationInput = {
  conversationId: string
  expectedRevision: number
  messageId: string
  expectedGeneration: number
}

export type DeleteHistoricalGroupInput =
  | HistoricalMessageMutationInput
  | {
      conversationId: string
      expectedRevision: number
      messageIds: readonly string[]
      expectedGenerations: Readonly<Record<string, number>>
    }

export type RunYoloAgentInput = {
  conversationId: string
  messages: ChatMessage[]
  requestMessages?: ChatMessage[]
  conversationMessages?: ChatMessage[]
  compaction?: ChatConversationCompactionLike | null
  modelId?: string
  modelIds?: string[]
  assistantId?: string
  reasoningLevel?: ReasoningLevel
  branchTarget?: {
    branchId: string
    sourceUserMessageId: string
    branchLabel?: string
  }
  overrides?: ConversationOverrideSettings | null
}

export type YoloFileRef = {
  path: string
  name: string
  basename: string
  extension: string
  stat?: YoloFileStat
}

export type YoloVaultIndexEntry = YoloFileRef & {
  kind: 'file' | 'folder'
}

export type YoloRuntime = YoloRuntimeCompatibilityBridge & {
  mode: YoloRuntimeMode
  pluginInfo: YoloPluginInfo
  settings: {
    get(): YoloSettings
    update(next: YoloSettings): Promise<void>
    subscribe(listener: (settings: YoloSettings) => void): () => void
  }
  /** Resolved UI language — web reads from bootstrap, Obsidian reads from
   *  the app locale. Components should prefer this over calling obsidian's
   *  `getLanguage()` directly so the runtime owns the platform difference. */
  getLanguage(): import('../i18n').Language
  /** Unified agent list — merges workspace agents into templates. UI should
   *  use this instead of reading settings.assistants / settings.workspaceAgents
   *  directly. The runtime implementation handles the merge + filtering. */
  getAgents(): import('../types/assistant.types').Assistant[]
  getConversationGateway(): ConversationGateway
  chat: {
    list(options?: {
      workspaceId?: string | null
    }): Promise<ChatConversationMetadata[]>
    get(id: string): Promise<YoloChatRecord | null>
    save(input: SaveYoloChatInput): Promise<void>
    appendMessages?(input: AppendYoloChatInput): Promise<{ conflict: boolean }>
    editHistoricalTurn?(
      input: EditHistoricalTurnInput,
    ): Promise<YoloChatRecord>
    deleteHistoricalGroup?(
      input: DeleteHistoricalGroupInput,
    ): Promise<YoloChatRecord>
    claimHistoricalRetry?(
      input: HistoricalMessageMutationInput,
    ): Promise<YoloChatRecord>
    delete(id: string): Promise<void>
    togglePinned(id: string): Promise<void>
    updateTitle(
      id: string,
      title: string,
      options?: { touchUpdatedAt?: boolean },
    ): Promise<void>
    /** Web 专属：metadata-only 增量更新（不重存消息列表）。桌面端无需
     *  实现，缺失时调用方回退到 save 全量路径。 */
    patchMetadata?(
      id: string,
      patch: Record<string, unknown>,
    ): Promise<void>
    generateTitle(
      id: string,
      messages: ChatMessage[],
      options?: { force?: boolean },
    ): Promise<string | null>
    exportToVault(id: string): Promise<{ path: string }>
    retryRecovery?: () => Promise<void>
  }
  agent: {
    run(input: RunYoloAgentInput): Promise<void>
    abort(conversationId: string): Promise<void>
    subscribe(
      conversationId: string,
      listener: (state: AgentConversationState) => void,
      options?: { emitCurrent?: boolean },
    ): () => void
    getState(conversationId: string): AgentConversationState
    getConversationRunSummary(conversationId: string): AgentConversationRunSummary
    getMessages(conversationId: string): ChatMessage[]
    replaceConversationMessages(
      conversationId: string,
      messages: ChatMessage[],
      compaction?: unknown,
      options?: { persistState?: boolean },
    ): void
    approveToolCall(input: {
      conversationId: string
      toolCallId: string
      allowForConversation?: boolean
    }): Promise<boolean>
    rejectToolCall(input: {
      conversationId: string
      toolCallId: string
    }): boolean | Promise<boolean>
    abortToolCall(input: {
      conversationId: string
      toolCallId: string
    }): boolean | Promise<boolean>
    isRunning(conversationId: string): boolean
    subscribeToRunSummaries(
      callback: (summaries: Map<string, AgentConversationRunSummary>) => void,
    ): () => void
    // backup 的 getConversationActivitySnapshot/subscribeToConversationActivities
    // （conversation/types）、getConversationDiagnostics/subscribeToConversationDiagnostics
    // （conversation/agentDiagnosticStore）、editDurableQueuedMessage 等
    // durable 队列成员依赖 backup 独有 conversation 子系统，master 无——移除
    // （web 运行时也不实现这些可选成员）。
    subscribeToPendingExternalAgentResults(
      fn: (conversationId: string) => void,
    ): () => void
    peekPendingUserMessages(conversationId: string): Promise<ChatUserMessage[]>
    enqueueUserMessage(
      conversationId: string,
      message: ChatUserMessage,
    ): Promise<EnqueueUserMessageResult>
    removePendingUserMessage(
      conversationId: string,
      messageId: string,
    ): Promise<ChatUserMessage | null>
    subscribeToAbortedQueuedMessages(
      fn: (conversationId: string, messages: ChatUserMessage[]) => void,
    ): () => void
    compactConversation(input: {
      conversationId: string
      messages: ChatMessage[]
      modelId?: string
      assistantId?: string
      chatMode?: string
      overrides?: ConversationOverrideSettings | null
    }): Promise<ChatConversationCompaction | null>
    buildContextBreakdownInputs(input: {
      conversationId: string
      messages: ChatMessage[]
      modelId?: string
      assistantId?: string
      chatMode?: string
      compaction?: ChatConversationCompactionLike | null
      overrides?: ConversationOverrideSettings | null
    }): Promise<WebContextBreakdownSource | null>
  }
  vault: {
    getActiveFile(): YoloFileRef | null
    read(file: any): Promise<string>
    readBinary?(file: any): Promise<ArrayBuffer>
    search(query: string): Promise<YoloFileRef[]>
    listIndex?(): Promise<YoloVaultIndexEntry[]>
    getAbstractFileByPath(path: string): YoloFileRef | null
    getFileByPath(path: string): any
    createFolder(path: string): Promise<void>
    modify(file: any, content: string): Promise<void>
    create(path: string, content: string): Promise<void>
    trashFile(file: any): Promise<void>
    getLeavesOfType(type: string): unknown[]
    getLeaf(split: boolean): any
  }
  ui: {
    notice(message: string, timeoutMs?: number): void
    openSettings(tabId?: string): void
    openApplyReview(state: unknown): Promise<boolean>
  }
}
