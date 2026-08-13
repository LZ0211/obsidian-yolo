import {
  BOT_CONVERSATION_UPDATED_EVENT,
  parseBotConversationUpdatedEvent,
} from './conversation-updated-event'

describe('parseBotConversationUpdatedEvent', () => {
  it('extracts the conversationId from a matching event', () => {
    const event = new CustomEvent(BOT_CONVERSATION_UPDATED_EVENT, {
      detail: { conversationId: 'conv-1' },
    })
    expect(parseBotConversationUpdatedEvent(event)).toBe('conv-1')
  })

  it('returns null for events without a string conversationId', () => {
    expect(
      parseBotConversationUpdatedEvent(
        new CustomEvent(BOT_CONVERSATION_UPDATED_EVENT, { detail: {} }),
      ),
    ).toBeNull()
    expect(
      parseBotConversationUpdatedEvent(
        new CustomEvent(BOT_CONVERSATION_UPDATED_EVENT, {
          detail: { conversationId: 42 },
        }),
      ),
    ).toBeNull()
  })
})
