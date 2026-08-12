import {
  AGENT_SESSION_MODE,
  COMMAND_RESULT_STATUS,
  isAgentSessionMode,
  isEntityTitle,
} from './contracts'
import type { AgentSessionMode, CommandResult, EntityTitle } from './contracts'

const namedTitle: EntityTitle = { kind: 'named', value: 'Research' }
const acceptedResult: CommandResult<{ id: string }> = {
  status: COMMAND_RESULT_STATUS.ACCEPTED,
  sequence: 1,
  value: { id: 'conversation-1' },
}
const sessionMode: AgentSessionMode = AGENT_SESSION_MODE.PERSISTENT

describe('shared state contracts', () => {
  test('validates the serializable entity title shape', () => {
    expect(isEntityTitle({ kind: 'untitled' })).toBe(true)
    expect(isEntityTitle(namedTitle)).toBe(true)
    expect(isEntityTitle({ kind: 'named', value: 1 })).toBe(false)
    expect(isEntityTitle({ kind: 'unknown' })).toBe(false)
  })

  test('uses one command result status vocabulary', () => {
    expect(COMMAND_RESULT_STATUS).toEqual({
      ACCEPTED: 'accepted',
      ALREADY_APPLIED: 'already_applied',
      REJECTED: 'rejected',
      CONFLICT: 'conflict',
      FAILED: 'failed',
    })
    expect(acceptedResult).toEqual({
      status: 'accepted',
      sequence: 1,
      value: { id: 'conversation-1' },
    })
  })

  test('validates the shared session persistence mode', () => {
    expect(AGENT_SESSION_MODE).toEqual({
      EPHEMERAL: 'ephemeral',
      PERSISTENT: 'persistent',
    })
    expect(sessionMode).toBe('persistent')
    expect(isAgentSessionMode('ephemeral')).toBe(true)
    expect(isAgentSessionMode('unknown')).toBe(false)
  })
})
