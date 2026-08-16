import type { SettingMigration } from '../setting.types'
import { migrateLegacyBuiltinCapabilityState } from './legacy-capability-bridge'

/**
 * v80->v81: collapse the pre-capability persistence shape (short tool/group
 * names) into the capability-keyed shape everywhere built-in tool
 * enablement/approval is stored (docs/plans/2026-08-15-tool-registry, D9).
 *
 * The conversion logic lives in `legacy-capability-bridge.ts` and is shared
 * with the `81_to_82` migration, which converts the same legacy shape for
 * vaults that were already past schema 81 when this migration batch landed.
 */
export const migrateFrom80To81: SettingMigration['migrate'] = (data) =>
  migrateLegacyBuiltinCapabilityState({ ...data, version: 81 })
