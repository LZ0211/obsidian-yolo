import type { ChatAssistantMessage, ChatMessage } from '../../types/chat'
import {
  CitationRegistry,
  attachSourcesToLatestAssistant,
} from './citationRegistry'

describe('CitationRegistry', () => {
  it('assigns ordinals starting at 1', () => {
    const registry = new CitationRegistry()
    const ordinal = registry.assign('content:a.md:1:2', {
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 'hello',
      source: 'rag',
    })
    expect(ordinal).toBe(1)
    expect(registry.size).toBe(1)
  })

  it('dedupes by key and returns the same ordinal', () => {
    const registry = new CitationRegistry()
    const first = registry.assign('content:a.md:1:2', {
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 'first',
      source: 'rag',
    })
    const second = registry.assign('content:a.md:1:2', {
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 'second',
      source: 'keyword',
    })
    expect(second).toBe(first)
    expect(registry.size).toBe(1)
    expect(registry.toArray()[0].snippet).toBe('first')
  })

  it('assigns distinct ordinals for distinct keys', () => {
    const registry = new CitationRegistry()
    const ord1 = registry.assign('content:a.md:1:2', {
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 's1',
      source: 'rag',
    })
    const ord2 = registry.assign('content:b.md:3:4', {
      path: 'b.md',
      startLine: 3,
      endLine: 4,
      snippet: 's2',
      source: 'hybrid',
    })
    const ord3 = registry.assign('content:a.md:5:6', {
      path: 'a.md',
      startLine: 5,
      endLine: 6,
      snippet: 's3',
      source: 'rag',
    })
    expect([ord1, ord2, ord3]).toEqual([1, 2, 3])
    expect(registry.size).toBe(3)
  })

  it('toArray returns entries sorted by ordinal', () => {
    const registry = new CitationRegistry()
    registry.assign('k1', {
      path: 'a.md',
      startLine: 1,
      endLine: 1,
      snippet: 's1',
      source: 'rag',
    })
    registry.assign('k2', {
      path: 'b.md',
      startLine: 2,
      endLine: 2,
      snippet: 's2',
      source: 'keyword',
    })
    registry.assign('k1', {
      path: 'a.md',
      startLine: 1,
      endLine: 1,
      snippet: 's1-dup',
      source: 'rag',
    })
    const arr = registry.toArray()
    expect(arr.map((entry) => entry.ordinal)).toEqual([1, 2])
    expect(arr.map((entry) => entry.snippet)).toEqual(['s1', 's2'])
  })
})

describe('attachSourcesToLatestAssistant', () => {
  const userMessage: ChatMessage = {
    role: 'user',
    id: 'u1',
    content: null,
    promptContent: 'hi',
    mentionables: [],
  }
  const assistantMessage = (
    id: string,
    metadata?: ChatAssistantMessage['metadata'],
  ): ChatMessage => ({
    role: 'assistant',
    id,
    content: 'answer',
    metadata,
  })
  const metadataOf = (
    message: ChatMessage,
  ): ChatAssistantMessage['metadata'] | undefined =>
    message.role === 'assistant' ? message.metadata : undefined

  it('writes registry sources into the latest assistant message metadata', () => {
    const registry = new CitationRegistry()
    registry.assign('content:a.md:1:2', {
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 'hit',
      source: 'hybrid',
    })
    const messages = [userMessage, assistantMessage('a1'), assistantMessage('a2')]

    const next = attachSourcesToLatestAssistant(messages, registry)

    expect(next).not.toBe(messages)
    expect(metadataOf(next[2])?.sources).toHaveLength(1)
    expect(metadataOf(next[2])?.sources?.[0]).toEqual({
      ordinal: 1,
      path: 'a.md',
      startLine: 1,
      endLine: 2,
      snippet: 'hit',
      source: 'hybrid',
    })
    // The older assistant message must stay untouched; input array unchanged.
    expect(metadataOf(next[1])).toBeUndefined()
    expect(metadataOf(messages[2])).toBeUndefined()
  })

  it('merges into existing metadata without clobbering other keys', () => {
    const registry = new CitationRegistry()
    registry.assign('content:b.md:3:3', {
      path: 'b.md',
      startLine: 3,
      endLine: 3,
      snippet: 's',
      source: 'keyword',
    })
    const messages = [
      assistantMessage('a1', {
        fileChanges: [{ kind: 'modified', path: 'x' }],
      }),
    ]

    const next = attachSourcesToLatestAssistant(messages, registry)

    expect(metadataOf(next[0])?.sources).toHaveLength(1)
    expect(metadataOf(next[0])?.fileChanges).toEqual([
      { kind: 'modified', path: 'x' },
    ])
  })

  it('returns the same array when the registry is empty', () => {
    const messages = [assistantMessage('a1')]
    expect(attachSourcesToLatestAssistant(messages, new CitationRegistry())).toBe(
      messages,
    )
  })

  it('returns the same array when there is no assistant message', () => {
    const registry = new CitationRegistry()
    registry.assign('content:a.md:1:1', {
      path: 'a.md',
      startLine: 1,
      endLine: 1,
      snippet: 's',
      source: 'rag',
    })
    const messages = [userMessage]
    expect(attachSourcesToLatestAssistant(messages, registry)).toBe(messages)
  })
})
