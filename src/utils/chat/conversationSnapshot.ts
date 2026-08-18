import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import type { ChatMessage } from '../../types/chat'
import type { MentionableConversation } from '../../types/mentionable'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { truncateContextText } from './contextBudget'
import { getBlockContentHash } from './mentionable'

/** Recent user turns included in a conversation mention snapshot. */
export const CONVERSATION_MENTION_MAX_TURNS = 10
/** Character budget for the rendered snapshot body. */
export const CONVERSATION_MENTION_MAX_CHARS = 8_000

const messageToText = (message: ChatMessage): string => {
  if (message.role === 'user') {
    if (message.content) {
      return editorStateToPlainText(message.content, {})
    }
    const prompt = message.promptContent
    if (typeof prompt === 'string') return prompt
    if (Array.isArray(prompt)) {
      return prompt
        .filter((part): part is { type: 'text'; text: string } =>
          part.type === 'text' && typeof part.text === 'string',
        )
        .map((part) => part.text)
        .join('\n')
    }
    return ''
  }
  if (message.role === 'assistant') {
    return typeof message.content === 'string' ? message.content : ''
  }
  if (message.role === 'tool') {
    return message.toolCalls
      .map((toolCall) => {
        const response = toolCall.response
        if (response.status !== ToolCallResponseStatus.Success) return ''
        const text = response.data.text
        return typeof text === 'string' ? text : ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Render the most recent turns of a conversation into a bounded snapshot for a
 * conversation mention. Mirrors the assistant-quote contract: content is a
 * point-in-time capture at mention time.
 */
export const buildConversationMentionSnapshot = ({
  messages,
  conversationId,
  title,
  maxTurns = CONVERSATION_MENTION_MAX_TURNS,
  maxChars = CONVERSATION_MENTION_MAX_CHARS,
}: {
  messages: readonly ChatMessage[]
  conversationId: string
  title?: string
  maxTurns?: number
  maxChars?: number
}): MentionableConversation => {
  // The last `maxTurns` user messages, plus everything after them (assistant
  // replies, tool messages, later turns) — the most continuity-relevant slice.
  let userSeen = 0
  let startIndex = 0
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue
    userSeen += 1
    if (userSeen === maxTurns) {
      startIndex = index
      break
    }
  }

  const lines: string[] = []
  for (let index = startIndex; index < messages.length; index += 1) {
    const message = messages[index]
    if (!message) continue
    const text = messageToText(message)
    if (!text.trim()) continue
    const roleLabel = message.role === 'user' ? 'user' : message.role
    lines.push(`${roleLabel}: ${text.trim()}`)
  }
  const content = truncateContextText(
    lines.join('\n'),
    maxChars,
    'conversation snapshot',
  )

  return {
    type: 'conversation',
    conversationId,
    ...(title?.trim() ? { title: title.trim() } : {}),
    content,
    contentHash: getBlockContentHash(content),
  }
}
