import { normalizeWorkspacePath as normalize } from '../agent/workspaceScope'

/**
 * Converts a vault-absolute path into the user-facing form for the given
 * workspace home. Emits the same `~/` marker as stripHomePrefix so all
 * surfaces (mention picker subtitle, message rendering) display home-relative
 * paths consistently and click handlers can reverse them via fromDisplayPath.
 *
 *   At home itself → "~"
 *   Inside home    → "~/subdir/file.md"
 *   Outside home   → absolute path verbatim (file tree / mention picker
 *                    filter these out before display anyway)
 *   Empty home     → absolute path passes through unchanged
 */
export function toDisplayPath(absPath: string, home: string): string {
  const normalizedHome = home === '' ? '' : normalize(home)
  const normalizedAbs = absPath === '' ? '' : normalize(absPath)
  if (normalizedHome === '') return normalizedAbs
  if (normalizedAbs === normalizedHome) return '~'
  const prefix = normalizedHome + '/'
  if (normalizedAbs.startsWith(prefix)) {
    return '~/' + normalizedAbs.slice(prefix.length)
  }
  return normalizedAbs
}

/**
 * Inverse of stripHomePrefix: turns a user-facing display path back into the
 * vault-absolute form. **Only `~/`-marked paths are resolved against home**;
 * everything else passes through as-is (after normalizing the leading slash).
 *
 * This conservative behavior is what makes the round-trip safe even when
 * the original was outside home — stripHomePrefix never emits `~/` for those,
 * so fromDisplayPath never mis-resolves them.
 *
 *   "~/foo.md"     → "<home>/foo.md"
 *   "~"            → "<home>"
 *   "/foo.md"      → "foo.md"          (leading-slash absolute, stripped)
 *   "Other/foo.md" → "Other/foo.md"    (as-is, click handler decides)
 *   "foo.md"       → "foo.md"          (as-is, no auto home-prepending)
 *   ""             → "<home>"          (empty = home itself)
 *
 * Empty home means no scoping; inputs pass through after normalization.
 */
export function fromDisplayPath(displayPath: string, home: string): string {
  const normalizedHome = home === '' ? '' : normalize(home)
  const trimmed = displayPath.trim()
  if (trimmed === '') return normalizedHome
  if (trimmed === '~') return normalizedHome
  if (trimmed.startsWith('~/')) {
    const rest = trimmed.slice(2)
    if (normalizedHome === '') return normalize(rest)
    return `${normalizedHome}/${normalize(rest)}`
  }
  return normalize(trimmed)
}

/**
 * True iff the given vault-absolute path is inside the workspace home (or home
 * is empty, in which case everything is "inside"). Used by mention pickers and
 * file-tree filters to drop entries the user shouldn't see.
 */
export function isInsideHome(absPath: string, home: string): boolean {
  const normalizedHome = home === '' ? '' : normalize(home)
  if (normalizedHome === '') return true
  const normalizedAbs = absPath === '' ? '' : normalize(absPath)
  return (
    normalizedAbs === normalizedHome ||
    normalizedAbs.startsWith(normalizedHome + '/')
  )
}

/**
 * Brute-force string-level stripping of the workspace home prefix so any
 * path-shaped string inside rendered message content collapses to its
 * home-relative form, marked with `~/` so the inverse direction can recover
 * the original absolute path unambiguously.
 *
 * Intentionally NAIVE: we only match `home/` (with trailing slash) so
 * non-path tokens that merely start with the home name
 * (e.g. "Notes about RAG" when home is "Notes") are untouched. Both the
 * leading-slash and bare forms collapse to the same `~/` form:
 *
 *   "/Notes/Project/foo.md" → "~/foo.md"
 *   "Notes/Project/foo.md"  → "~/foo.md"
 *   "Notes/Project_old/x"   → unchanged (no trailing slash boundary match)
 *   "Notes about RAG"       → unchanged
 *   "Other/foo.md"          → unchanged (outside home, no marker added)
 *
 * The `~/` marker is what makes recovery safe in `fromDisplayPath`: a click
 * handler reading `~/foo.md` knows for sure the original was inside home;
 * a click handler reading `Other/foo.md` knows the original was elsewhere.
 *
 * This is a render-only transform — storage, tool payloads, LLM history, and
 * citations are NEVER mutated.
 */
export function stripHomePrefix(text: string, home: string): string {
  if (home === '') return text
  const normalizedHome = normalize(home)
  if (normalizedHome === '') return text
  return text
    .split('/' + normalizedHome + '/')
    .join('~/')
    .split(normalizedHome + '/')
    .join('~/')
}
