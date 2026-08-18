import type { ChatMessage } from '../../types/chat'

import { buildConversationMentionSnapshot } from './conversationSnapshot'

const userMsg = (id: string, text: string): ChatMessage =>
  ({
    role: 'user',
    id,
    content: null,
    promptContent: text,
    mentionables: [],
  }) as unknown as ChatMessage

const assistantMsg = (id: string, text: string): ChatMessage =>
  ({
    role: 'assistant',
    id,
    content: text,
  }) as unknown as ChatMessage

const toolMsg = (id: string, text: string): ChatMessage =>
  ({
    role: 'tool',
    id,
    toolCalls: [
      {
        request: { id: 'tc-1', name: 'fs_read', arguments: undefined },
        response: { status: 'success', data: { type: 'text', text } },
      },
    ],
  }) as unknown as ChatMessage

describe('buildConversationMentionSnapshot', () => {
  it('renders the most recent N user turns with their replies', () => {
    const messages = [
      userMsg('u1', '早期任务问题'),
      assistantMsg('a1', '早期回复'),
      userMsg('u2', '当前任务问题'),
      assistantMsg('a2', '当前回复'),
      toolMsg('t1', '工具输出'),
      userMsg('u3', '最新问题'),
      assistantMsg('a3', '最新回复'),
    ]

    const snapshot = buildConversationMentionSnapshot({
      messages,
      conversationId: 'conv-2',
      title: '另一个会话',
      maxTurns: 2,
    })

    expect(snapshot.type).toBe('conversation')
    expect(snapshot.conversationId).toBe('conv-2')
    expect(snapshot.title).toBe('另一个会话')
    // 早期轮次被排除。
    expect(snapshot.content).not.toContain('早期任务问题')
    expect(snapshot.content).not.toContain('早期回复')
    // 最近 2 轮（u2..a3）包含在内，工具消息在保留窗口内也保留。
    expect(snapshot.content).toContain('当前任务问题')
    expect(snapshot.content).toContain('当前回复')
    expect(snapshot.content).toContain('工具输出')
    expect(snapshot.content).toContain('最新问题')
    expect(snapshot.content).toContain('最新回复')
    expect(snapshot.contentHash).toBeDefined()
  })

  it('bounds the snapshot to the character budget', () => {
    const messages = [
      userMsg('u1', 'x'.repeat(5_000)),
      assistantMsg('a1', 'y'.repeat(5_000)),
    ]

    const snapshot = buildConversationMentionSnapshot({
      messages,
      conversationId: 'conv-2',
      maxTurns: 1,
      maxChars: 800,
    })

    expect(snapshot.content.length).toBeLessThanOrEqual(800)
    expect(snapshot.content).toContain('truncated')
  })

  it('renders an empty conversation as empty content', () => {
    const snapshot = buildConversationMentionSnapshot({
      messages: [],
      conversationId: 'conv-3',
    })
    expect(snapshot.content).toBe('')
  })
})
