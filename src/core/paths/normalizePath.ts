/**
 * Normalize a filesystem path for comparison / display: convert backslashes
 * to forward slashes, strip leading and trailing slashes. The empty string
 * represents the vault root (no restriction).
 */
export function normalizePathSlashes(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '')
}
