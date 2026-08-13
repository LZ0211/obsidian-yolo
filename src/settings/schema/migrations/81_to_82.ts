import { SUBAGENT_RESULT_MAX_CHARS } from '../../../core/agent/subagent/result-limit'
import type { SettingMigration } from '../setting.types'

/**
 * v81→v82: seed the configurable subagent result cap
 * (`subagentResultMaxChars`).
 *
 * Additive and defensive: existing fields are preserved untouched.
 * `subagentResultMaxChars` is seeded with the built-in default only when
 * absent or not a number (a malformed value would otherwise be caught by the
 * schema's `.catch` at parse time anyway), so the result-limit settings getter
 * starts with a concrete value and pre-existing settings keep working.
 */
export const migrateFrom81To82: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 82 }
  if (typeof next.subagentResultMaxChars !== 'number') {
    next.subagentResultMaxChars = SUBAGENT_RESULT_MAX_CHARS
  }
  return next
}
