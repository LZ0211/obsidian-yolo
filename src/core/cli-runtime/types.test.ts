import { CLI_RUNTIME_IDS, isCliSessionRef } from './types'

describe('CLI runtime conversation references', () => {
  it('includes OpenCode in the shared runtime identity list', () => {
    expect(CLI_RUNTIME_IDS).toEqual([
      'claude-code',
      'codex',
      'hermes',
      'opencode',
      'pi',
    ])
  })

  it('discriminates YOLO conversations from native CLI sessions', () => {
    expect(
      isCliSessionRef({ runtimeId: 'yolo', conversationId: 'chat-1' }),
    ).toBe(false)
    expect(
      isCliSessionRef({
        runtimeId: 'claude-code',
        nativeSessionId: 'session-1',
      }),
    ).toBe(true)
    expect(
      isCliSessionRef({
        runtimeId: 'opencode',
        nativeSessionId: 'session-2',
      }),
    ).toBe(true)
  })
})
