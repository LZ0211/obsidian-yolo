import type {
  AgentShareTokenScope,
  WorkspaceAgent,
} from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'

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
