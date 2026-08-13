import { SUBAGENT_RESULT_MAX_CHARS } from '../../../core/agent/subagent/result-limit'

import { migrateFrom81To82 } from './81_to_82'

import { SETTINGS_SCHEMA_VERSION, SETTING_MIGRATIONS } from './index'

describe('migrateFrom81To82', () => {
  it('seeds the default subagentResultMaxChars when absent', () => {
    expect(migrateFrom81To82({ version: 81 })).toEqual(
      expect.objectContaining({
        version: 82,
        subagentResultMaxChars: SUBAGENT_RESULT_MAX_CHARS,
      }),
    )
  })

  it('seeds the default even when subagentResultMaxChars is malformed', () => {
    expect(
      migrateFrom81To82({
        version: 81,
        subagentResultMaxChars: 'not-a-number',
      }),
    ).toEqual(
      expect.objectContaining({
        version: 82,
        subagentResultMaxChars: SUBAGENT_RESULT_MAX_CHARS,
      }),
    )
  })

  it('preserves an existing subagentResultMaxChars untouched', () => {
    expect(
      migrateFrom81To82({ version: 81, subagentResultMaxChars: 12_000 }),
    ).toEqual(
      expect.objectContaining({ version: 82, subagentResultMaxChars: 12_000 }),
    )
  })

  it('does not overwrite an existing subagentTimeout or unrelated fields', () => {
    const subagentTimeout = {
      timeoutMs: 120_000,
      maxConsecutiveTimeouts: 3,
      cooldownMs: 60_000,
    }
    expect(
      migrateFrom81To82({
        version: 81,
        chatModelId: 'chat-1',
        subagentTimeout,
      }),
    ).toEqual(
      expect.objectContaining({
        version: 82,
        chatModelId: 'chat-1',
        subagentTimeout,
        subagentResultMaxChars: SUBAGENT_RESULT_MAX_CHARS,
      }),
    )
  })

  it('is registered in the migration chain at schema version 82', () => {
    const step = SETTING_MIGRATIONS.find(
      (migration) => migration.fromVersion === 81,
    )
    expect(step?.toVersion).toBe(82)
    expect(step?.migrate).toBe(migrateFrom81To82)
    expect(SETTINGS_SCHEMA_VERSION).toBe(83)
  })
})
