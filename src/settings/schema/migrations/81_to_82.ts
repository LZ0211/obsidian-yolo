import type { SettingMigration } from '../setting.types'
import { migrateLegacyBuiltinCapabilityState } from './legacy-capability-bridge'

/**
 * v81->v82: convert vaults that were already at (or past) schema 81 when the
 * 80->81 capability migration landed.
 *
 * Why this exists: the 80->81 migration batch also *rolled the schema
 * version back* from 85 to 81 (deleting the empty-ish 81..85 migrations,
 * whose field defaults were folded into 79->80/80->81). The migration guard
 * in `settings.ts` only advances `currentVersion < toVersion`, so a vault at
 * schema 81+ in the *legacy* tool shape (per-assistant group FQNs like
 * `yolo_local__memory_ops`, global `builtinToolOptions`) would never re-run
 * 80->81 — while the runtime reads only the capability-keyed shape. Every
 * such vault would silently fall back to capability defaults: per-assistant
 * memory/context grants dropped, `delegate_subagent.allowedModelIds`
 * restrictions lost.
 *
 * The legacy tool shape is identical across schema 80..85 (the former
 * 81..85 migrations only added unrelated fields), so one conversion —
 * `migrateLegacyBuiltinCapabilityState`, shared with 80->81 — covers every
 * stranded version. It is idempotent: vaults that already ran the current
 * 80->81 (non-empty `builtinCapabilityOptions` / per-assistant
 * `builtinCapabilityPreferences`) are left untouched.
 */
export const migrateFrom81To82: SettingMigration['migrate'] = (data) =>
  migrateLegacyBuiltinCapabilityState({ ...data, version: 82 })
