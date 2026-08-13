import type { ChatConversationCompactionState } from '../../types/chat'

import { deriveChatCompactionStatus } from './chatCompactionStatus'

describe('deriveChatCompactionStatus', () => {
  const compacted = (
    overrides: Partial<ChatConversationCompactionState[number]> = {},
  ): ChatConversationCompactionState => [
    {
      anchorMessageId: 'a1',
      summary: 's',
      compactedAt: 1,
      compactedMessageCount: 42,
      ...overrides,
    },
  ]

  it('reports compacting while the summary generation is pending', () => {
    expect(
      deriveChatCompactionStatus({
        compactionState: [],
        pendingCompactionAnchorMessageId: 'tool-msg-1',
      }),
    ).toEqual({ kind: 'compacting' })
  })

  it('prefers the compacting state over a previous compaction result', () => {
    expect(
      deriveChatCompactionStatus({
        compactionState: compacted(),
        pendingCompactionAnchorMessageId: 'tool-msg-2',
      }),
    ).toEqual({ kind: 'compacting' })
  })

  it('reports the compacted message count from the latest compaction entry', () => {
    expect(
      deriveChatCompactionStatus({
        compactionState: compacted(),
        pendingCompactionAnchorMessageId: null,
      }),
    ).toEqual({ kind: 'compacted', messageCount: 42 })
  })

  it('uses the latest entry of the append-only state', () => {
    expect(
      deriveChatCompactionStatus({
        compactionState: [
          ...compacted(),
          {
            anchorMessageId: 'a2',
            summary: 's2',
            compactedAt: 2,
            compactedMessageCount: 99,
          },
        ],
        pendingCompactionAnchorMessageId: null,
      }),
    ).toEqual({ kind: 'compacted', messageCount: 99 })
  })

  it('returns null when there is no compaction and nothing pending', () => {
    expect(
      deriveChatCompactionStatus({
        compactionState: [],
        pendingCompactionAnchorMessageId: null,
      }),
    ).toBeNull()
  })

  it('returns null when the latest compaction reports no message count', () => {
    expect(
      deriveChatCompactionStatus({
        compactionState: compacted({ compactedMessageCount: undefined }),
        pendingCompactionAnchorMessageId: null,
      }),
    ).toBeNull()
  })
})
