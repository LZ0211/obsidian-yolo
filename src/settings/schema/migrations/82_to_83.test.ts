import { SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT } from '../../../core/agent/subagent/parent-context'

import { migrateFrom82To83 } from './82_to_83'

import { SETTINGS_SCHEMA_VERSION, SETTING_MIGRATIONS } from './index'

describe('migrateFrom82To83', () => {
  it('seeds the default forkContextTurns when absent', () => {
    expect(migrateFrom82To83({ version: 82 })).toEqual(
      expect.objectContaining({
        version: 83,
        forkContextTurns: SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT,
      }),
    )
  })

  it('seeds the default even when forkContextTurns is malformed', () => {
    expect(
      migrateFrom82To83({ version: 82, forkContextTurns: 'not-a-number' }),
    ).toEqual(
      expect.objectContaining({
        version: 83,
        forkContextTurns: SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT,
      }),
    )
  })

  it('preserves an existing forkContextTurns untouched', () => {
    expect(
      migrateFrom82To83({ version: 82, forkContextTurns: 20 }),
    ).toEqual(
      expect.objectContaining({ version: 83, forkContextTurns: 20 }),
    )
  })

  it('does not overwrite existing subagent fields or unrelated fields', () => {
    const subagentTimeout = {
      timeoutMs: 120_000,
      maxConsecutiveTimeouts: 3,
      cooldownMs: 60_000,
    }
    expect(
      migrateFrom82To83({
        version: 82,
        chatModelId: 'chat-1',
        subagentTimeout,
        subagentResultMaxChars: 12_000,
      }),
    ).toEqual(
      expect.objectContaining({
        version: 83,
        chatModelId: 'chat-1',
        subagentTimeout,
        subagentResultMaxChars: 12_000,
        forkContextTurns: SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT,
      }),
    )
  })

  it('is registered in the migration chain at schema version 83', () => {
    const step = SETTING_MIGRATIONS.find(
      (migration) => migration.fromVersion === 82,
    )
    expect(step?.toVersion).toBe(83)
    expect(step?.migrate).toBe(migrateFrom82To83)
    expect(SETTINGS_SCHEMA_VERSION).toBe(83)
  })
})
