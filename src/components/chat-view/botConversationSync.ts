/**
 * Pure derivation of a chat-view conversation update from a settled bot turn.
 *
 * `BotService` fires `yolo:bot-conversation-updated` once per settled turn;
 * the chat view pulls the authoritative in-memory messages from
 * `AgentService.getState` and applies the update through the same
 * `ChatSessionController` setters the rest of the surface uses. Keeping this
 * derivation pure lets it be unit-tested without React (see
 * `botConversationSync.test.ts`).
 */
import type { ChatConversationCompactionState, ChatMessage } from '../../types/chat'

export type BotTurnConversationUpdate = {
  chatMessages: ChatMessage[]
  assistantGroupBoundaryMessageIds: string[]
  compactionState: ChatConversationCompactionState
}

export type BotTurnConversationState = {
  messages: readonly ChatMessage[]
  compaction?: ChatConversationCompactionState
}

export type DeriveBotTurnConversationUpdateParams = {
  state: BotTurnConversationState
  existingAssistantGroupBoundaryMessageIds: readonly string[]
  normalizeAssistantGroupBoundaryMessageIds: (
    messages: readonly ChatMessage[],
    sourceIds: readonly string[],
  ) => string[]
}

/**
 * Derives the message-state update for a bot turn that just settled on the
 * currently open conversation. Returns `null` when there is nothing to apply
 * (an empty turn state — the conversation was never written), so callers can
 * skip the state churn entirely.
 */
export function deriveBotTurnConversationUpdate({
  state,
  existingAssistantGroupBoundaryMessageIds,
  normalizeAssistantGroupBoundaryMessageIds,
}: DeriveBotTurnConversationUpdateParams): BotTurnConversationUpdate | null {
  if (state.messages.length === 0) {
    return null
  }
  return {
    chatMessages: [...state.messages],
    assistantGroupBoundaryMessageIds:
      normalizeAssistantGroupBoundaryMessageIds(
        state.messages,
        existingAssistantGroupBoundaryMessageIds,
      ),
    compactionState: state.compaction ?? [],
  }
}
