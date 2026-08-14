import type { SettingMigration } from '../setting.types'

/**
 * v83→v84: add the update-notice preference (upstream #571, adapted from the
 * upstream 79→80 migration).
 *
 * `pluginUpdateNoticeEnabled` gates the update toast for both the plugin and
 * modules, and with it the background download. Existing installs keep today's
 * behaviour, so it defaults to true.
 */
export const migrateFrom83To84: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 84 }

  next.pluginUpdateNoticeEnabled ??= true

  return next
}
