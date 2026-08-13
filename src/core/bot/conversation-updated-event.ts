/**
 * Bot conversation-updated event — the open chat view's bridge to bot turns.
 *
 * `BotService` fires this once per settled agent turn; `useYoloChatSession`
 * listens and reloads the current conversation from `AgentService`'s in-memory
 * state (the authoritative source — the disk write may still be coalesced).
 * A dedicated bot event (instead of reusing `yolo:chat-history-updated`,
 * which also fires for the chat UI's own writes) keeps the reload scoped to
 * turns the user's own chat surface did not produce, so it can never fight an
 * in-flight UI run.
 */

export const BOT_CONVERSATION_UPDATED_EVENT = 'yolo:bot-conversation-updated'

export function emitBotConversationUpdated(conversationId: string): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent(BOT_CONVERSATION_UPDATED_EVENT, {
      detail: { conversationId },
    }),
  )
}

export function parseBotConversationUpdatedEvent(
  event: Event,
): string | null {
  const detail = (event as CustomEvent<{ conversationId?: unknown }>).detail
  return typeof detail?.conversationId === 'string'
    ? detail.conversationId
    : null
}
