import { migrateFrom80To81 } from './80_to_81'
import { SETTINGS_SCHEMA_VERSION, SETTING_MIGRATIONS } from './index'

const MOA_DEFAULTS = {
  enabled: true,
  timeoutMs: 45_000,
  maxOutputTokens: 2_048,
}

describe('migrateFrom80To81', () => {
  it('adds only the MoA defaults while preserving existing chat options', () => {
    const result = migrateFrom80To81({
      version: 80,
      chatOptions: {
        includeCurrentFileContent: true,
        mentionDisplayMode: 'inline',
        chatFontScale: 1.1,
      },
    })

    expect(result).toMatchObject({
      version: 81,
      chatOptions: {
        includeCurrentFileContent: true,
        mentionDisplayMode: 'inline',
        chatFontScale: 1.1,
        moa: MOA_DEFAULTS,
      },
    })
  })

  it('never seeds a default reference-model pool', () => {
    const result = migrateFrom80To81({
      version: 80,
      chatOptions: { includeCurrentFileContent: true },
    })
    const moa = (result.chatOptions as Record<string, unknown>).moa as Record<
      string,
      unknown
    >

    expect(moa).not.toHaveProperty('allowedReferenceModelIds')
    expect(moa).not.toHaveProperty('defaultReferenceModelIds')
  })

  it('preserves an existing MoA block untouched', () => {
    const existingMoa = {
      enabled: false,
      allowedReferenceModelIds: ['ref-a', 'ref-b'],
      timeoutMs: 12_000,
      maxOutputTokens: 3_000,
    }
    const result = migrateFrom80To81({
      version: 80,
      chatOptions: { includeCurrentFileContent: true, moa: existingMoa },
    })

    expect((result.chatOptions as Record<string, unknown>).moa).toEqual(
      existingMoa,
    )
  })

  it('seeds MoA defaults even when chatOptions is missing or malformed', () => {
    const missing = migrateFrom80To81({ version: 80 })
    const malformed = migrateFrom80To81({
      version: 80,
      chatOptions: 'not-an-object',
    })

    expect(missing).toMatchObject({
      version: 81,
      chatOptions: { moa: MOA_DEFAULTS },
    })
    expect(malformed).toMatchObject({
      version: 81,
      chatOptions: { moa: MOA_DEFAULTS },
    })
  })

  it('is registered in the migration chain at schema version 81', () => {
    const step = SETTING_MIGRATIONS.find(
      (migration) => migration.fromVersion === 80,
    )
    expect(step?.toVersion).toBe(81)
    expect(step?.migrate).toBe(migrateFrom80To81)
    expect(SETTINGS_SCHEMA_VERSION).toBe(83)
  })

  it('advances the schema version without changing unrelated fields', () => {
    expect(
      migrateFrom80To81({ version: 80, chatModelId: 'chat-1' }),
    ).toEqual(
      expect.objectContaining({
        version: 81,
        chatModelId: 'chat-1',
      }),
    )
  })

  it('seeds the default subagent timeout + breaker config when absent', () => {
    expect(migrateFrom80To81({ version: 80 })).toEqual(
      expect.objectContaining({
        version: 81,
        subagentTimeout: {
          timeoutMs: 5 * 60 * 1000,
          maxConsecutiveTimeouts: 2,
          cooldownMs: 5 * 60 * 1000,
        },
      }),
    )
  })

  it('preserves existing subagentTimeout fields and fills only the missing ones', () => {
    expect(
      migrateFrom80To81({
        version: 80,
        subagentTimeout: { timeoutMs: 120_000 },
      }),
    ).toEqual(
      expect.objectContaining({
        version: 81,
        subagentTimeout: {
          timeoutMs: 120_000,
          maxConsecutiveTimeouts: 2,
          cooldownMs: 5 * 60 * 1000,
        },
      }),
    )
  })

  it('seeds webRuntime defaults while preserving user-supplied fields', () => {
    expect(
      migrateFrom80To81({
        version: 80,
        webRuntime: { port: 18900, token: 'abc' },
      }),
    ).toMatchObject({
      version: 81,
      webRuntime: {
        enabled: false,
        port: 18900,
        host: '127.0.0.1',
        token: 'abc',
        maxConcurrentAgentRuns: 12,
      },
    })
  })

  it('coerces invalid webRuntime values back to safe defaults', () => {
    expect(
      migrateFrom80To81({
        version: 80,
        webRuntime: {
          port: 0,
          token: 123,
          maxConcurrentAgentRuns: 0,
        },
      }),
    ).toMatchObject({
      version: 81,
      webRuntime: {
        port: 18900,
        token: '123',
        maxConcurrentAgentRuns: 12,
      },
    })
  })

  it('leaves a malformed webRuntime block untouched for the schema to catch', () => {
    expect(migrateFrom80To81({ version: 80, webRuntime: 'oops' })).toEqual(
      expect.objectContaining({ webRuntime: 'oops' }),
    )
  })
})
