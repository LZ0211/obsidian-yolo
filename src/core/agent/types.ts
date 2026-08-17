import type { ChatContextPolicy } from '../../components/chat-view/chat-runtime-profiles'
import type {
  AssistantToolApprovalMode,
  WorkspaceAccessPolicy,
} from '../../types/assistant.types'
import {
  ChatConversationCompactionLike,
  ChatConversationCompactionState,
  ChatMessage,
  ChatUserMessage,
} from '../../types/chat'
import { ChatModel } from '../../types/chat-model.types'
import { LLMProvider, LLMProviderApiType } from '../../types/provider.types'
import { ReasoningLevel } from '../../types/reasoning'
import type { ContextualInjection } from '../../utils/chat/contextual-injections'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { BaseLLMProvider } from '../llm/base'
import type { ResponseDeliveryMode } from '../llm/responseDeliveryMode'
import { McpManager } from '../mcp/mcpManager'

import type { AutoContextCompactionChatOptions } from './compaction'
import type { AgentLoopPolicy } from './loop-policy'
import type { ToolCapabilityMode } from './tool-capability-prompt'

export type AgentRuntimeSnapshot = {
  messages: ChatMessage[]
  compaction: ChatConversationCompactionState
  pendingCompactionAnchorMessageId: string | null
}

export type AgentRuntimeSubscribe = (snapshot: AgentRuntimeSnapshot) => void

export type AgentPendingUserMessageDrain = {
  messages: ChatUserMessage[]
  sourceUserMessageId: string
}

/** Payload handed to the memory extraction queue after a run settles. */
export type MemoryExtractionRequest = {
  messages: ChatMessage[]
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  assistantId?: string
  requestContextBuilder: RequestContextBuilder
  signal: AbortSignal
}

export type AgentRuntimeRunInput = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  /**
   * API protocol of the active provider. Used by the tool stub builder to
   * pick a schema that the provider accepts (Gemini's restricted OpenAPI
   * subset vs. the open `additionalProperties` form used by everyone else).
   */
  apiType?: LLMProviderApiType | null
  messages: ChatMessage[]
  requestMessages?: ChatMessage[]
  conversationId: string
  assistantId?: string
  branchId?: string
  sourceUserMessageId?: string
  branchLabel?: string
  /** Resume an interrupted assistant message during the first LLM turn. */
  continueAssistantMessageId?: string
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  compaction?: ChatConversationCompactionLike | null
  abortSignal?: AbortSignal
  reasoningLevel?: ReasoningLevel
  requestParams?: {
    deliveryMode?: ResponseDeliveryMode
    temperature?: number
    top_p?: number
    max_tokens?: number
    primaryRequestTimeoutMs?: number
    streamFallbackRecoveryEnabled?: boolean
  }
  allowedToolNames?: string[]
  enableToolDisclosure?: boolean
  toolPreferences?: Record<
    string,
    {
      enabled?: boolean
      approvalMode?: AssistantToolApprovalMode
    }
  >
  /**
   * Per-capability enabled/approval state for built-in tools (D9,
   * docs/plans/2026-08-15-tool-registry/phase2-migration.md D9). Sibling to
   * `toolPreferences` above, which as of that migration only carries remote
   * MCP tool state — built-in tool approval/enablement resolution
   * (`AgentToolGateway.resolveApprovalMode`/`isToolAllowed`) needs both.
   */
  builtinCapabilityPreferences?: Record<
    string,
    {
      enabled?: boolean
      approvalMode?: AssistantToolApprovalMode
    }
  >
  toolServerPreferences?: Record<
    string,
    {
      approvalMode?: AssistantToolApprovalMode
      disclosureMode?: 'always' | 'on_demand'
    }
  >
  /**
   * Enhanced workspace access policy (home directory + read/write rules).
   * The canonical workspace-confinement shape for the whole runtime: the
   * legacy upstream `workspaceScope` is folded into this at settings-init
   * time and never carried through the run context.
   */
  workspaceAccessPolicy?: WorkspaceAccessPolicy
  allowedSkillPaths?: string[]
  contextualInjections?: ContextualInjection[]
  toolCapabilityMode?: ToolCapabilityMode
  /** Module chat mode persona, injected in place of assistant instructions. */
  modePersonaPrompt?: string
  /** The owning module id, for the persona injection's `module="..."` attribute. */
  modePersonaModuleId?: string
  /** Full running mode id (`module:<moduleId>:<modeId>`) — scopes skill
   * resolution to the mode's own declared skills. See
   * `ChatModeRuntime.moduleChatModeId`. Undefined for built-in modes. */
  moduleChatModeId?: string
  /**
   * Explicit context-assembly policy from `resolveChatModeRuntime`. Absent
   * (built-in modes) is equivalent to `{ useAssistant: true }` — every
   * consumer defaults accordingly, so omitting it never changes existing
   * behavior.
   */
  contextPolicy?: ChatContextPolicy
  geminiTools?: {
    useWebSearch?: boolean
    useUrlContext?: boolean
  }
  autoContextCompaction?: {
    chatOptions: AutoContextCompactionChatOptions
    maxContextTokens?: number
  }
  /**
   * Optional hook called at every `llm_request` boundary inside the runtime
   * loop. Returns user messages that should be merged into the response stream
   * before the next LLM turn together with the visual-turn anchor they create.
   * Used to inject mid-run user messages enqueued by the service layer.
   * Returning null is a no-op.
   *
   * Not invoked by the single-turn fast path (single LLM call, no boundary).
   */
  drainPendingUserMessages?: () => AgentPendingUserMessageDrain | null
  /** Isolated subagent runs: replace the normal system prompt assembly. */
  systemPromptOverride?: string
  /** Conversation whose approval state should be used for tool auto-execution. */
  toolApprovalConversationId?: string
  /** Terminal command prefixes rejected before execution or approval. */
  blockedCommandPrefixes?: string[]
  /**
   * When true, auto-execute all allowed tools without per-tool approval.
   * Dangerous command prefix blocklist and global tool enable gates still apply.
   */
  bypassToolApproval?: boolean
  /**
   * When true, the bash tool for this entire run is the structurally
   * read-only variant: mkdir/mv/rm/rmdir are unavailable (command not found)
   * regardless of approval tier. Set by callers that only granted a
   * read-only capability (see `src/core/modules/moduleAgent.ts`'s
   * `vault-read` module agent capability). Defaults to false.
   */
  bashReadOnly?: boolean
  /**
   * Optional per-run memory extraction hook. Invoked after the run settles
   * (hidden LLM extraction of durable user facts/preferences). Provided by
   * the service layer; subagent child runs never set it.
   */
  enqueueMemoryExtraction?: (input: MemoryExtractionRequest) => void
}

export type AgentRuntimeLoopConfig = {
  enableTools: boolean
  maxAutoIterations: number
  includeBuiltinTools: boolean
  /**
   * When true, the loop worker issues exactly one tools-disabled LLM request
   * after the iteration budget is exhausted so the turn can summarize/close
   * without tools. Defaults to OFF: per spec §6 the graceful close call stays
   * disabled until telemetry demonstrates abrupt max-iteration endings are a
   * real user problem.
   */
  graceEnabled?: boolean
  /**
   * Optional main-thread loop policy. Runs before the runtime acts on a
   * continuing decision (`llm_request`/`tool_phase`); can only turn a
   * continuing decision into a terminal stop, never bypass approval or raise
   * budgets.
   */
  policy?: AgentLoopPolicy
}

export type AgentWorkerInbound =
  | {
      type: 'start'
      runId: string
      maxIterations: number
      /**
       * Consecutive identical tool-call threshold for the exact duplicate-call
       * guard. Defaults to 3 when omitted.
       */
      maxRepeatedToolCalls?: number
      /**
       * When true, the worker issues exactly one tools-disabled request after
       * the iteration budget is exhausted. Defaults to OFF when omitted.
       */
      graceEnabled?: boolean
    }
  | {
      type: 'llm_result'
      runId: string
      hasToolCalls: boolean
      hasAssistantOutput: boolean
    }
  | {
      type: 'tool_result'
      runId: string
      hasPendingTools: boolean
      forceStopReason?: 'repeated_tool_failure' | 'repeated_read_call'
      /**
       * Fully-qualified name of the executed tool, used to derive the duplicate
       * guard signature. Omitted when no tool actually executed this round
       * (e.g. the message only carries approval placeholders).
       */
      toolName?: string
      /** Arguments of the executed tool, canonicalized for the signature. */
      toolArgs?: unknown
    }
  | {
      type: 'abort'
      runId: string
    }
  | {
      /** Main-thread loop policy asked to stop; settles the run as completed. */
      type: 'stop'
      runId: string
    }

export type AgentWorkerOutbound =
  | {
      type: 'llm_request'
      runId: string
      iteration: number
      /**
       * Set exactly once for the single tools-disabled grace request issued
       * past the iteration budget (see `graceEnabled` on start).
       */
      toolsDisabled?: boolean
    }
  | {
      type: 'tool_phase'
      runId: string
    }
  | {
      type: 'done'
      runId: string
      reason:
        | 'completed'
        | 'max_iterations'
        | 'repeated_tool_failure'
        | 'repeated_read_call'
        | 'repeated_tool_call'
        | 'aborted'
    }
  | {
      type: 'error'
      runId: string
      error: string
    }
