import { DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG } from '../../../core/agent/subagent/subagent-timeout-config'
import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v80→v81: seed the explicit `/moa` chat settings under `chatOptions.moa` and
 * the configurable parent subagent timeout + breaker settings.
 *
 * Additive and defensive: existing chat options and `subagentTimeout` fields
 * are preserved untouched. `moa` is seeded only when absent or not a record
 * (no default reference-model pool — references come from explicit `@`-mentions
 * and the aggregator is the current conversation model). `subagentTimeout` is
 * seeded with the defaults (preserving any user-supplied field) so the
 * registry's settings getter starts with concrete values.
 */
export const migrateFrom80To81: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 81 }

  const chatOptions = isRecord(next.chatOptions) ? next.chatOptions : {}
  next.chatOptions = {
    ...chatOptions,
    moa: isRecord(chatOptions.moa)
      ? chatOptions.moa
      : {
          enabled: true,
          timeoutMs: 45_000,
          maxOutputTokens: 2_048,
        },
  }

  next.subagentTimeout = isRecord(next.subagentTimeout)
    ? { ...DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG, ...next.subagentTimeout }
    : { ...DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG }

  return next
}
