import type {
  ChatConversation,
  ChatConversationMetadata,
} from '../../database/json/chat/types'
import type {
  AgentShareTokenScope,
  WorkspaceAgent,
} from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'

/**
 * Web 会话对会话的绑定（backup 的 types/chat.ts 定义，master 会话类型无此
 * 字段，由 web 层携带以保留备份的会话访问控制语义）。
 */
export type ChatWebBinding = {
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

/** web 层视角的会话：master ChatConversation + backup 的 web 专属字段。 */
export type WebChatConversation = ChatConversation & {
  workspaceId?: string | null
  agentInstanceId?: string | null
  webBinding?: ChatWebBinding | null
}

/** web 层视角的会话元数据：master ChatConversationMetadata + web 专属字段。 */
export type WebChatConversationMetadata = ChatConversationMetadata & {
  workspaceId?: string | null
  agentInstanceId?: string | null
  webBinding?: ChatWebBinding | null
}

export type EffectiveWorkspaceAgent = WorkspaceAgent &
  Pick<
    Assistant,
    | 'systemPrompt'
    | 'description'
    | 'modelId'
    | 'persona'
    | 'enableTools'
    | 'includeBuiltinTools'
    | 'enabledToolNames'
    | 'toolPreferences'
    | 'builtinCapabilityPreferences'
    | 'toolServerPreferences'
    | 'enabledSkills'
    | 'skillPreferences'
    | 'enableProjectInstructions'
    | 'includeCurrentFileContent'
    | 'timeContextEnabled'
  > & {
    /** Whether this workspace agent exposes Agent mode in the chat input. */
    agentModeAllowed: boolean
  }

export type PublicWorkspaceAgentSummary = {
  id: string
  name: string
  agentModeAllowed: boolean
  unavailable?: boolean
}

export type WebSession = {
  id: string
  tokenRecordId: string
  tokenScope: AgentShareTokenScope
  activeAgentId: string
  rootHash: string
  createdAt: number
  lastUsedAt: number
  expiresAt: number
}

export type ResolvedWebAgentContext = {
  sessionId: string
  tokenScope: AgentShareTokenScope
  activeAgent: EffectiveWorkspaceAgent
  template: Assistant
  rootHash: string
  allowedAgents: PublicWorkspaceAgentSummary[]
}

export type WebAgentContextErrorCode =
  | 'unauthenticated'
  | 'agent_unavailable'
  | 'forbidden'
  | 'invalid_request'

export type ResolveWebAgentContextResult =
  | {
      ok: true
      context: ResolvedWebAgentContext
    }
  | {
      ok: false
      code: WebAgentContextErrorCode
      message: string
    }
