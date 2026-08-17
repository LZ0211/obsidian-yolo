import type {
  AssistantToolPreference,
  AssistantToolServerPreference,
  AssistantWorkspaceScope,
} from '../../../types/assistant.types'
import type { ChatMessage } from '../../../types/chat'
import type { ChatModel } from '../../../types/chat-model.types'
import type {
  LLMProvider,
  LLMProviderApiType,
} from '../../../types/provider.types'
import type { ReasoningLevel } from '../../../types/reasoning'
import type { RequestContextBuilder } from '../../../utils/chat/requestContextBuilder'
import type { BaseLLMProvider } from '../../llm/base'
import type { McpManager } from '../../mcp/mcpManager'
import type { AgentRuntimeLoopConfig, AgentRuntimeRunInput } from '../types'

import { SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT } from './constants'
import { truncateSubagentResult } from './result-limit'
import type { ForkContext } from './types'

export type SubagentParentContext = {
  providerClient: BaseLLMProvider<LLMProvider>
  model: ChatModel
  apiType?: LLMProviderApiType | null
  conversationId: string
  /**
   * Read-only snapshot of the parent transcript as of the CURRENT run input
   * (`input.messages`), captured when the parent's run started — NOT a
   * dispatch-time snapshot. A parent that delegates late in its run (after
   * earlier turns already advanced the transcript) forks messages that are
   * stale relative to the moment `delegate_subagent` is dispatched. Kept off
   * the child prompt unless a fork is requested (`forkContext`), so the default
   * path stays byte-identical to today. The snapshot is only ever serialized
   * to text for the child — message objects never cross the boundary, so a
   * child cannot write parent state.
   */
  parentMessages?: readonly ChatMessage[]
  /**
   * Optional read-only parent-context fork requested for this dispatch
   * (master adaptation: the fork choice rides on the parent context instead of
   * a top-level `runSubagent` param as in the backup). `undefined`/`none` keep
   * the child prompt byte-identical; `last_turns`/`full` compose
   * `parentMessages` into it when the child's initial run input is built.
   */
  forkContext?: ForkContext
  allowedToolNames?: string[]
  toolPreferences?: Record<string, AssistantToolPreference>
  builtinCapabilityPreferences?: Record<string, AssistantToolPreference>
  toolServerPreferences?: Record<string, AssistantToolServerPreference>
  workspaceAccessPolicy?: import('../../../types/assistant.types').WorkspaceAccessPolicy
  allowedSkillPaths?: string[]
  enableToolDisclosure?: boolean
  reasoningLevel?: ReasoningLevel
  requestParams?: AgentRuntimeRunInput['requestParams']
  loopConfig: AgentRuntimeLoopConfig
  requestContextBuilder: RequestContextBuilder
  mcpManager: McpManager
  assistantId?: string
  bypassToolApproval?: boolean
}

/**
 * Cap for the composed whole-history text of the `full` fork. Mirrors the
 * result-cap pattern: the context block keeps a head+tail window joined by a
 * truncation marker so a long parent transcript cannot bloat the child prompt.
 */
export const SUBAGENT_FORK_CONTEXT_MAX_CHARS = 24_000

const PARENT_CONTEXT_FORK_MARKER =
  '==== Parent context (read-only snapshot) ===='

type ForkContextTurnsSettingsGetter = () => number | undefined

let forkContextTurnsGetter: ForkContextTurnsSettingsGetter | undefined

/**
 * Optional live read of the configured fork-context turn count. The host wires
 * this once at startup to the current run settings (via a getter that re-reads
 * the settings object each call), so changing `forkContextTurns` in settings
 * takes effect without a restart. `undefined` falls back to the built-in
 * default (10).
 */
export function setForkContextTurnsSettingsGetter(
  getter: ForkContextTurnsSettingsGetter,
): void {
  forkContextTurnsGetter = getter
}

/** Test/teardown hook: drop the settings getter, falling back to the default. */
export function resetForkContextTurnsSettingsGetter(): void {
  forkContextTurnsGetter = undefined
}

/** The effective turn count: the settings getter wins over the built-in default. */
export function getForkContextTurns(): number {
  return forkContextTurnsGetter?.() ?? SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT
}

function messageToText(message: ChatMessage): string {
  switch (message.role) {
    case 'user': {
      const promptContent = message.promptContent
      if (
        typeof promptContent === 'string' &&
        promptContent.trim().length > 0
      ) {
        return promptContent
      }
      return '[user message]'
    }
    case 'assistant': {
      return message.content.trim().length > 0
        ? message.content
        : '[assistant message]'
    }
    case 'tool': {
      return message.toolCalls
        .map(
          (toolCall) =>
            `[tool] ${toolCall.request.name}: ${toolCall.response.status}`,
        )
        .join('\n')
    }
    default:
      return `[${message.role} message]`
  }
}

function serializeMessages(messages: readonly ChatMessage[]): string {
  return messages
    .map((message) => `[${message.role}] ${messageToText(message)}`)
    .join('\n')
}

/**
 * Compose an optional read-only parent-context fork into a child prompt.
 *
 * - `none` / `undefined`: returns `prompt` unchanged — byte-identical to today.
 * - `last_turns`: serializes the parent's last `getForkContextTurns()` messages.
 * - `full`: serializes the whole parent history, capped to
 *   `SUBAGENT_FORK_CONTEXT_MAX_CHARS` (head+tail window + truncation marker).
 *
 * The fork is a read-only snapshot: parent message objects are only read (never
 * mutated) and only serialized to text, so the child receives a plain string
 * with no reference (and therefore no write access) to parent state.
 */
export function composeParentContextPrompt(input: {
  prompt: string
  parentMessages: readonly ChatMessage[]
  forkContext: ForkContext | undefined
}): string {
  const { prompt, parentMessages, forkContext } = input
  // 'none' and `undefined` are equivalent: the child sees only the prompt.
  if (forkContext === undefined || forkContext === 'none') {
    return prompt
  }
  if (parentMessages.length === 0) {
    return prompt
  }

  let contextText: string
  if (forkContext === 'last_turns') {
    const turns = Math.max(1, getForkContextTurns())
    contextText = serializeMessages(parentMessages.slice(-turns))
  } else {
    // `full`: serialize the whole history, then bound it to the size cap.
    contextText = truncateSubagentResult(
      serializeMessages(parentMessages),
      SUBAGENT_FORK_CONTEXT_MAX_CHARS,
    ).text
  }

  return `${prompt}\n\n${PARENT_CONTEXT_FORK_MARKER}\n${contextText}`
}

export function buildSubagentParentContext(
  input: AgentRuntimeRunInput,
  loopConfig: AgentRuntimeLoopConfig,
): SubagentParentContext {
  return {
    providerClient: input.providerClient,
    model: input.model,
    apiType: input.apiType,
    conversationId: input.conversationId,
    // Read-only parent transcript snapshot from the run input, captured at
    // run start (NOT dispatch time — stale relative to a late delegate).
    // Consumed only when a fork is requested; kept out of the child prompt by
    // default.
    parentMessages: input.messages,
    allowedToolNames: input.allowedToolNames,
    toolPreferences: input.toolPreferences,
    builtinCapabilityPreferences: input.builtinCapabilityPreferences,
    toolServerPreferences: input.toolServerPreferences,
    workspaceAccessPolicy: input.workspaceAccessPolicy,
    allowedSkillPaths: input.allowedSkillPaths,
    enableToolDisclosure: input.enableToolDisclosure,
    reasoningLevel: input.reasoningLevel,
    requestParams: input.requestParams,
    loopConfig,
    requestContextBuilder: input.requestContextBuilder,
    mcpManager: input.mcpManager,
    assistantId: input.assistantId,
    bypassToolApproval: input.bypassToolApproval,
  }
}
