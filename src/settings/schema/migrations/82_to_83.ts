import { SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT } from '../../../core/agent/subagent/constants'
import type { SettingMigration } from '../setting.types'

/**
 * v82→v83: seed the configurable subagent fork turn count
 * (`forkContextTurns`).
 *
 * Additive and defensive: existing fields are preserved untouched.
 * `forkContextTurns` is seeded with the built-in default only when absent or
 * not a number (a malformed value would otherwise be caught by the schema's
 * `.catch` at parse time anyway), so the parent-context settings getter starts
 * with a concrete value and pre-existing settings keep working.
 */
export const migrateFrom82To83: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 83 }
  if (typeof next.forkContextTurns !== 'number') {
    next.forkContextTurns = SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT
  }
  return next
}
