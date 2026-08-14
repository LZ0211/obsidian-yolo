/**
 * Attachment security — runtime-independent validation shared by
 * `send_attachment`'s tool execution (basic validation, Phase 6) and
 * `BotOutputDispatcher`'s secondary validation (platform size limits,
 * Phase 5). Bot Platform design doc, "Attachment Handling" section.
 *
 * Deliberately has no Obsidian dependency (`TFile`/`Vault`) so both call
 * sites — and this test file — can exercise it as pure functions. Path-scope
 * gating (whether `normalizedPath` is inside the bound Agent's readable
 * workspace) is injected as a predicate by the caller (`localFileTools.ts`,
 * which already depends on `workspaceScope.ts`'s Obsidian-aware
 * `isReadablePath`) rather than imported directly here.
 */

// Segment-based traversal + hidden/system-path checks. Deliberately does NOT
// reject legitimate filenames containing literal ".." as a substring (e.g.
// `v1..draft.md`) — only a path *segment* that is exactly ".." is rejected.
const HIDDEN_PATTERNS: RegExp[] = [
  /^\.obsidian\//,
  /^\.git\//,
  /^\.trash\//,
  /(^|\/)\.[^/]+/,
]

const SENSITIVE_PATTERNS: RegExp[] = [
  /\.env$/i,
  /credentials\./i,
  /private.*key/i,
  /\.ssh\//i,
  /secrets?\//i,
  /\.pem$/i,
  /\.pfx$/i,
]

export type AttachmentPathValidationOptions = {
  /**
   * Predicate deciding whether `normalizedPath` is allowed to be sent.
   * Omitted = nothing is allowed (fail closed). The caller supplies this
   * from the bound Agent's `workspaceAccessPolicy` (e.g.
   * `(p) => isReadablePath(p, workspaceAccessPolicy)`).
   */
  isAllowed?: (normalizedPath: string) => boolean
}

export type AttachmentPathValidationResult =
  | { ok: true; normalizedPath: string }
  | { ok: false; error: string }

/**
 * Normalizes and validates a vault-relative attachment path:
 * - rejects absolute paths (leading '/', or a Windows drive letter like
 *   `C:\`) outright rather than silently stripping the leading slash (see
 *   final report for rationale — this is stricter than the design doc's
 *   reference pseudocode, which only strips leading slashes).
 * - rejects path traversal (`..` as a path *segment*).
 * - rejects hidden/system paths (`.obsidian/`, `.git/`, `.trash/`, any
 *   dotfile/dotdir segment).
 * - rejects known-sensitive filename patterns (`.env`, `*.pem`, `.ssh/`, ...).
 * - if `options.isAllowed` is omitted, rejects everything (fail closed).
 * - otherwise requires `options.isAllowed(normalizedPath)` to return true —
 *   the caller decides scope (e.g. the bound Agent's `workspaceAccessPolicy`).
 */
export function validateAttachmentPath(
  path: string,
  options: AttachmentPathValidationOptions = {},
): AttachmentPathValidationResult {
  if (
    /^[a-zA-Z]:[\\/]/.test(path) ||
    path.startsWith('/') ||
    path.startsWith('\\')
  ) {
    return { ok: false, error: `Absolute paths are not allowed: ${path}` }
  }

  const normalized = path.replace(/\\/g, '/')
  const segments = normalized.split('/').filter((segment) => segment !== '')
  if (segments.includes('..')) {
    return { ok: false, error: `Path traversal is not allowed: ${path}` }
  }
  const normalizedPath = segments.join('/')
  if (normalizedPath === '') {
    return { ok: false, error: `Empty path is not allowed` }
  }

  if (HIDDEN_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
    return {
      ok: false,
      error: `Cannot send hidden/system files: ${normalizedPath}`,
    }
  }
  if (SENSITIVE_PATTERNS.some((pattern) => pattern.test(normalizedPath))) {
    return {
      ok: false,
      error: `Cannot send potentially sensitive file: ${normalizedPath}`,
    }
  }

  if (!options.isAllowed || !options.isAllowed(normalizedPath)) {
    return {
      ok: false,
      error: `File is outside the agent's readable workspace: ${normalizedPath}`,
    }
  }

  return { ok: true, normalizedPath }
}

export type OutgoingAttachmentSizeValidationInput = {
  kind: 'image' | 'file'
  byteLength: number
  maxBytes: number
  name: string
}

export type OutgoingAttachmentSizeValidationResult =
  | { ok: true }
  | { ok: false; error: string }

export function validateOutgoingAttachmentSize(
  input: OutgoingAttachmentSizeValidationInput,
): OutgoingAttachmentSizeValidationResult {
  if (input.byteLength <= input.maxBytes) return { ok: true }
  return {
    ok: false,
    error: `Outgoing ${input.kind} "${input.name}" exceeds the ${input.kind} size limit of ${input.maxBytes} bytes (${input.byteLength} bytes).`,
  }
}
