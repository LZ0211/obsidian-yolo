import type { ChatMessage } from '../../types/chat'
import { deriveBotTurnConversationUpdate } from './botConversationSync'

function userMessage(id: string, text: string): ChatMessage {
  return {
    role: 'user',
    id,
    content: null,
    promptContent: text,
    mentionables: [],
  } as unknown as ChatMessage
}

function assistantMessage(id: string, text: string): ChatMessage {
  return {
    role: 'assistant',
    id,
    content: text,
    metadata: { generationState: 'completed' },
  } as unknown as ChatMessage
}

const normalize = (
  messages: readonly ChatMessage[],
  sourceIds: readonly string[],
): string[] =>
  sourceIds.filter(
    (id) =>
      messages.some(
        (m) => (m.role === 'assistant' || m.role === 'tool') && m.id === id,
      ),
    // keep non-user ids only
  )

describe('deriveBotTurnConversationUpdate', () => {
  it('derives messages, boundaries and compaction from the settled turn state', () => {
    const messages = [userMessage('u1', 'hi'), assistantMessage('a1', 'yo')]
    const update = deriveBotTurnConversationUpdate({
      state: {
        messages,
        compaction: [
          {
            anchorMessageId: 'a1',
            summary: 'sum',
            compactedAt: 0,
          },
        ],
      },
      existingAssistantGroupBoundaryMessageIds: ['a1', 'gone'],
      normalizeAssistantGroupBoundaryMessageIds: normalize,
    })
    expect(update).toEqual({
      chatMessages: messages,
      assistantGroupBoundaryMessageIds: ['a1'],
      compactionState: [
        {
          anchorMessageId: 'a1',
          summary: 'sum',
          compactedAt: 0,
        },
      ],
    })
  })

  it('returns null for an empty turn state (nothing was written)', () => {
    expect(
      deriveBotTurnConversationUpdate({
        state: { messages: [] },
        existingAssistantGroupBoundaryMessageIds: [],
        normalizeAssistantGroupBoundaryMessageIds: normalize,
      }),
    ).toBeNull()
  })

  it('copies the messages array so the applied state owns its reference', () => {
    const messages = [userMessage('u1', 'hi')]
    const update = deriveBotTurnConversationUpdate({
      state: { messages },
      existingAssistantGroupBoundaryMessageIds: [],
      normalizeAssistantGroupBoundaryMessageIds: normalize,
    })
    expect(update?.chatMessages).not.toBe(messages)
    expect(update?.chatMessages).toEqual(messages)
  })

  it('defaults compaction to an empty list when the state carries none', () => {
    const update = deriveBotTurnConversationUpdate({
      state: { messages: [userMessage('u1', 'hi')] },
      existingAssistantGroupBoundaryMessageIds: [],
      normalizeAssistantGroupBoundaryMessageIds: normalize,
    })
    expect(update?.compactionState).toEqual([])
  })
})
