import type { SettingMigration } from '../setting.types'

/**
 * v84→v85: add the MinerU PDF conversion service configuration.
 *
 * `mineru` holds the enabled flag, the Gradio base URL, and the full
 * Authorization header value. Existing installs keep the service off, so it
 * defaults to disabled with empty connection settings.
 */
export const migrateFrom84To85: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 85 }

  next.mineru ??= { enabled: false, baseUrl: '', apiKey: '' }

  return next
}
