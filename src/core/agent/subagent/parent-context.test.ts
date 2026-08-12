import type { ChatMessage } from '../../../types/chat'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'

import {
  SUBAGENT_FORK_CONTEXT_MAX_CHARS,
  SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT,
  composeParentContextPrompt,
  getForkContextTurns,
  resetForkContextTurnsSettingsGetter,
  setForkContextTurnsSettingsGetter,
} from './parent-context'

const makeAssistantMessages = (count: number): ChatMessage[] =>
  Array.from({ length: count }, (_, index) => ({
    role: 'assistant' as const,
    id: `assistant-${index + 1}`,
    content: `Message ${index + 1}`,
  }))

describe('composeParentContextPrompt', () => {
  beforeEach(() => {
    resetForkContextTurnsSettingsGetter()
  })

  it('returns the prompt byte-identical for forkContext none', () => {
    const prompt = 'Finish the refactor described above.'
    const result = composeParentContextPrompt({
      prompt,
      parentMessages: makeAssistantMessages(20),
      forkContext: 'none',
    })
    expect(result).toBe(prompt)
  })

  it('treats undefined forkContext the same as none (byte-identical)', () => {
    const prompt = 'Finish the refactor described above.'
    const result = composeParentContextPrompt({
      prompt,
      parentMessages: makeAssistantMessages(20),
      forkContext: undefined,
    })
    expect(result).toBe(prompt)
  })

  it('composes the last 10 parent messages for last_turns', () => {
    const prompt = 'Finish the refactor described above.'
    const result = composeParentContextPrompt({
      prompt,
      parentMessages: makeAssistantMessages(25),
      forkContext: 'last_turns',
    })
    expect(result.startsWith(`${prompt}\n\n`)).toBe(true)
    // The 11th-from-last message ("Message 15") is outside the window.
    expect(result).not.toContain('Message 15')
    // The last 10 messages ("Message 16".."Message 25") are composed, in order.
    for (let index = 16; index <= 25; index++) {
      expect(result).toContain(`Message ${index}`)
    }
    expect(result.indexOf('Message 16')).toBeLessThan(
      result.indexOf('Message 25'),
    )
  })

  it('uses the configured forkContextTurns live (no restart needed)', () => {
    setForkContextTurnsSettingsGetter(() => 3)
    const result = composeParentContextPrompt({
      prompt: 'Do the task.',
      parentMessages: makeAssistantMessages(25),
      forkContext: 'last_turns',
    })
    expect(result).toContain('Message 25')
    expect(result).toContain('Message 23')
    expect(result).not.toContain('Message 22')
  })

  it('defaults forkContextTurns to 10 when no getter is wired', () => {
    expect(SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT).toBe(10)
    expect(getForkContextTurns()).toBe(10)
  })

  it('size-caps the whole history for forkContext full', () => {
    const prompt = 'Do the task.'
    const oversized: ChatMessage[] = Array.from({ length: 50 }, (_, index) => ({
      role: 'assistant' as const,
      id: `assistant-${index}`,
      content: `Message ${index}: ${'x'.repeat(1_000)}`,
    }))
    const result = composeParentContextPrompt({
      prompt,
      parentMessages: oversized,
      forkContext: 'full',
    })
    expect(result).toContain(prompt)
    // The serialized whole history (~50k chars) exceeds the cap, so the
    // context block is truncated to a head+tail window.
    expect(result).toContain('…[truncated]…')
    expect(result.length).toBeLessThan(
      prompt.length + SUBAGENT_FORK_CONTEXT_MAX_CHARS + 128,
    )
  })

  it('exposes only a string snapshot: parent messages stay write-safe', () => {
    const prompt = 'Do the task.'
    const messages = makeAssistantMessages(12)
    const frozen = Object.freeze(
      messages.map((message) => Object.freeze({ ...message })),
    )
    // Reading from a deeply frozen parent transcript must not throw, which
    // proves composition never mutates parent state.
    const result = composeParentContextPrompt({
      prompt,
      parentMessages: frozen as unknown as ChatMessage[],
      forkContext: 'last_turns',
    })
    expect(result).toContain('Message 12')
    // The parent transcript is unchanged after composition.
    expect(frozen.length).toBe(messages.length)
    frozen.forEach((message, index) => {
      expect(message.id).toBe(messages[index].id)
      expect(message.role).toBe(messages[index].role)
    })
    // The child receives only a string — no reference to parent message
    // objects, so it has no write access to the parent transcript.
    expect(typeof result).toBe('string')
  })

  it('serializes user and tool messages into the composed snapshot', () => {
    const prompt = 'Summarise the parent work.'
    const parentMessages: ChatMessage[] = [
      {
        role: 'user',
        id: 'user-1',
        content: null,
        promptContent: 'User instruction text',
        mentionables: [],
      },
      {
        role: 'tool',
        id: 'tool-1',
        toolCalls: [
          {
            request: { id: 'call-1', name: 'fs_read' },
            response: {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: 'File contents' },
            },
          },
        ],
      },
    ]
    const result = composeParentContextPrompt({
      prompt,
      parentMessages,
      forkContext: 'last_turns',
    })
    expect(result).toContain('User instruction text')
    expect(result).toContain('fs_read')
  })
})
