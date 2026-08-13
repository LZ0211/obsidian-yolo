import {
  type ChatConversationCompactionState,
  getLatestChatConversationCompaction,
} from '../../types/chat'

/**
 * Derived chat-header compaction status. Kept as a pure function so the
 * header line renders without owning any compaction lifecycle:
 * - `compacting` while the runtime is generating the summary
 *   (`pendingCompactionAnchorMessageId` is set by the native runtime between
 *   the compact tool call and the summary completion/failure).
 * - `compacted` after the latest compaction reports how many messages were
 *   folded into the summary.
 * - `null` when there is nothing to show.
 */
export type ChatCompactionStatus =
  | { kind: 'compacting' }
  | { kind: 'compacted'; messageCount: number }

export const deriveChatCompactionStatus = ({
  compactionState,
  pendingCompactionAnchorMessageId,
}: {
  compactionState: ChatConversationCompactionState
  pendingCompactionAnchorMessageId: string | null
}): ChatCompactionStatus | null => {
  if (pendingCompactionAnchorMessageId !== null) {
    return { kind: 'compacting' }
  }

  const latest = getLatestChatConversationCompaction(compactionState)
  if (!latest) {
    return null
  }
  const messageCount = latest.compactedMessageCount
  return messageCount !== undefined && messageCount > 0
    ? { kind: 'compacted', messageCount }
    : null
}
