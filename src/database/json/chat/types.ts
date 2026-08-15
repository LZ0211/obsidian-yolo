import {
  ChatConversationCompactionLike,
  SerializedChatMessage,
} from '../../../types/chat'
import { ConversationOverrideSettings } from '../../../types/conversation-settings.types'

export const CHAT_SCHEMA_VERSION = 1

export type ChatConversationOrigin = 'user' | 'external-agent'

export type ChatConversationCliSession = {
  runtimeId: 'claude-code' | 'codex' | 'hermes' | 'pi'
  nativeSessionId: string
  sessionPathHint?: string
}

export const getChatConversationOrigin = (
  conversation: Pick<ChatConversation, 'origin'>,
): ChatConversationOrigin => conversation.origin ?? 'user'

export type ChatConversation = {
  id: string
  title: string
  messages: SerializedChatMessage[]
  createdAt: number
  updatedAt: number
  schemaVersion: number
  isPinned?: boolean
  pinnedAt?: number
  // Optional per-conversation overrides (temperature, top_p, stream)
  overrides?: ConversationOverrideSettings | null
  /** Pre-rollback 会话顶层持久化的工作目录（backup 格式，读取兼容）。 */
  workingDirectory?: string
  fileScopeLocked?: boolean
  conversationModelId?: string
  assistantId?: string
  messageModelMap?: Record<string, string>
  activeBranchByUserMessageId?: Record<string, string>
  assistantGroupBoundaryMessageIds?: string[]
  reasoningLevel?: string
  compaction?: ChatConversationCompactionLike | null
  origin?: ChatConversationOrigin
  /**
   * Native runtime binding for a CLI conversation created by YOLO.
   * The native transcript remains provider-owned; YOLO persists only this
   * stable reference and its own conversation metadata.
   */
  cliSession?: ChatConversationCliSession
}

export type ChatConversationMetadata = {
  id: string
  title: string
  updatedAt: number
  schemaVersion: number
  isPinned?: boolean
  pinnedAt?: number
  origin?: ChatConversationOrigin
  cliSession?: ChatConversationCliSession
  /**
   * Web 会话绑定（web-server 的 ChatWebBinding 结构等价物，数据库层不
   * 反向依赖 web-server）。写入 chat_index.json 后，web 列表不必逐会话
   * 读全文件来补全绑定字段——索引行缺该键（undefined）视为旧行，回退
   * 读文件自愈。
   */
  workspaceId?: string | null
  agentInstanceId?: string | null
  webBinding?: ChatConversationWebBinding | null
}

export type ChatConversationWebBinding = {
  initialAgentId: string
  activeAgentId: string
  rootHash: string
  accessState?: 'active' | 'orphaned'
  orphanedReason?:
    | 'agent_deleted'
    | 'template_deleted'
    | 'root_unavailable'
    | 'agent_invalid'
  updatedAt?: number
}
