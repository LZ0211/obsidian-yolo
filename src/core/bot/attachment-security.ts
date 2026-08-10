/**
 * Attachment security — runtime-independent validation shared by
 * `send_attachment`'s tool execution (basic validation, Phase 6) and
 * `BotOutputDispatcher`'s secondary validation (platform size limits /
 * mime-extension consistency, Phase 5). Bot Platform design doc,
 * "Attachment Handling" section.
 *
 * Deliberately has no Obsidian dependency (`TFile`/`Vault`) so both call
 * sites — and this test file — can exercise it as pure functions. Byte
 * content for magic-number sniffing is passed in by the caller (who already
 * has to read the file through the Vault adapter or a downloaded temp file);
 * this module never touches the filesystem itself. Path-scope gating
 * (whether `normalizedPath` is inside the bound Agent's readable workspace)
 * is likewise injected as a predicate by the caller (`localFileTools.ts`,
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

// Magic-number tables for the attachment kinds the bot platform actually
// needs to distinguish (images the platforms can render inline, plus a
// couple of common document/archive types). Extend as needed — this is
// intentionally not an exhaustive file-type sniffer.
type MagicNumberSegment = {
  bytes: readonly number[]
  /** Byte offset the signature starts at. Defaults to 0. */
  offset?: number
}

type MagicNumberRule = {
  mimeType: string
  /** All segments must match (AND) — lets e.g. WEBP require both the RIFF
   * header at offset 0 and the 'WEBP' tag at offset 8. */
  segments: readonly MagicNumberSegment[]
}

const asciiBytes = (text: string): number[] =>
  Array.from(text).map((char) => char.charCodeAt(0))

const MAGIC_NUMBER_RULES: readonly MagicNumberRule[] = [
  {
    mimeType: 'image/png',
    segments: [{ bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] }],
  },
  { mimeType: 'image/jpeg', segments: [{ bytes: [0xff, 0xd8, 0xff] }] },
  { mimeType: 'image/gif', segments: [{ bytes: [0x47, 0x49, 0x46, 0x38] }] },
  {
    mimeType: 'image/webp',
    segments: [
      { bytes: asciiBytes('RIFF') },
      { bytes: asciiBytes('WEBP'), offset: 8 },
    ],
  },
  {
    mimeType: 'application/pdf',
    segments: [{ bytes: [0x25, 0x50, 0x44, 0x46] }],
  }, // '%PDF'
  {
    mimeType: 'application/zip',
    segments: [{ bytes: [0x50, 0x4b, 0x03, 0x04] }],
  }, // covers docx/xlsx/pptx too
]

const EXTENSION_MIME_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  pdf: 'application/pdf',
  zip: 'application/zip',
  docx: 'application/zip',
  xlsx: 'application/zip',
  pptx: 'application/zip',
}

function segmentMatches(
  bytes: Uint8Array,
  segment: MagicNumberSegment,
): boolean {
  const offset = segment.offset ?? 0
  if (bytes.length < offset + segment.bytes.length) return false
  return segment.bytes.every(
    (expected, index) => bytes[offset + index] === expected,
  )
}

function ruleMatches(bytes: Uint8Array, rule: MagicNumberRule): boolean {
  return rule.segments.every((segment) => segmentMatches(bytes, segment))
}

function getExtension(filePath: string): string | undefined {
  const fileName = filePath.split('/').pop() ?? filePath
  const dotIndex = fileName.lastIndexOf('.')
  if (dotIndex === -1 || dotIndex === fileName.length - 1) return undefined
  return fileName.slice(dotIndex + 1).toLowerCase()
}

export type MimeVerificationResult = {
  ok: boolean
  mimeType?: string
  error?: string
}

/**
 * Infers the mime type from the file's magic number and cross-checks it
 * against the extension-implied mime type (when the extension is a known
 * one). Mismatches are rejected — a `.png` whose bytes are actually a ZIP
 * (or vice versa) is a red flag, not just a labeling error.
 *
 * Files whose extension isn't in our known table, or whose bytes don't match
 * any known signature, are accepted (`ok: true`, `mimeType: undefined`) —
 * this is a targeted spoofing check, not an allowlist of file types.
 */
export function inferAndVerifyMimeType(
  filePath: string,
  bytes: Uint8Array,
): MimeVerificationResult {
  const matchedRule = MAGIC_NUMBER_RULES.find((rule) =>
    ruleMatches(bytes, rule),
  )
  const inferredMimeType = matchedRule?.mimeType

  const extension = getExtension(filePath)
  const extensionMimeType = extension
    ? EXTENSION_MIME_TYPES[extension]
    : undefined

  if (
    inferredMimeType &&
    extensionMimeType &&
    inferredMimeType !== extensionMimeType
  ) {
    return {
      ok: false,
      error: `File content (${inferredMimeType}) does not match its extension (.${extension} implies ${extensionMimeType})`,
    }
  }

  return { ok: true, mimeType: inferredMimeType ?? extensionMimeType }
}
