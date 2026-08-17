import { normalizePath } from 'obsidian'

import type {
  Assistant,
  AssistantWorkspaceScope,
  WorkspaceAccessPolicy,
} from '../../types/assistant.types'
import { normalizePathSlashes } from '../paths/normalizePath'
import type { ProtectedPathRule } from '../paths/protectedPaths'
import { isProtectedVaultPath } from '../paths/protectedPaths'
import {
  type YoloSettingsLike,
  isWithinYoloUserDataRoot,
} from '../paths/yoloPaths'

export const BUILTIN_SKILL_PATH_PREFIX = 'builtin://'
export const BROWSER_READ_PATH_PREFIX = 'browser://'

export type { WorkspaceAccessPolicy }

export function normalizeWorkspacePath(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed.includes('\\')) {
    throw new Error(`invalid workspace path: ${raw}`)
  }
  if (/^[a-zA-Z]:($|\/)/.test(trimmed)) {
    throw new Error(`invalid workspace path: ${raw}`)
  }
  // Vault paths are always vault-relative, so a leading '/' only ever means
  // "vault-root addressing" (the folder picker in AgentWorkspaceScopeEditor
  // stores every picked workspaceRoot as `/<folder>`, or exactly `/` for the
  // whole vault) — strip it instead of rejecting it. Rejecting used to force
  // every caller to pre-strip the slash themselves (see displayPath.ts's now
  // redundant `normalize` wrapper), which is exactly the kind of duplicated,
  // easy-to-miss workaround that let real workspaceRoot values like
  // `/04-专利` silently fail isReadablePath and empty out @-mention lists.
  const withoutLeadingSlash = trimmed.replace(/^\/+/, '')
  if (withoutLeadingSlash === '') return ''

  const normalized = withoutLeadingSlash
    .replace(/\/+$/g, '')
    .replace(/\/{2,}/g, '/')
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new Error(`invalid workspace path: ${raw}`)
    }
  }
  return normalized
}

function matchesRule(path: string, rule: string): boolean {
  const p = normalizePathSlashes(path)
  const r = normalizePathSlashes(rule)
  if (r === '') return true
  if (p === r) return true
  return p.startsWith(r + '/')
}

function matchesAny(path: string, rules: readonly string[]): boolean {
  for (const rule of rules) {
    if (matchesRule(path, rule)) return true
  }
  return false
}

function normalizedRules(rules: readonly string[]): string[] {
  return rules.map(normalizeWorkspacePath)
}

function isPolicyEnabled(
  policy: WorkspaceAccessPolicy | undefined,
): policy is WorkspaceAccessPolicy {
  return Boolean(policy?.enabled)
}

function isProtectedPath(
  path: string,
  rules: readonly ProtectedPathRule[] | undefined,
): boolean {
  return isProtectedVaultPath(path, rules)
}

function assertNotProtectedPath(
  path: string,
  rules: readonly ProtectedPathRule[] | undefined,
): void {
  if (isProtectedPath(path, rules)) {
    throw new Error(`Path is inside a host-managed protected zone: ${path}`)
  }
}

function readIncludes(policy: WorkspaceAccessPolicy): string[] {
  return [
    normalizeWorkspacePath(policy.workspaceRoot),
    ...normalizedRules(policy.readExtraIncludes),
  ]
}

export function isReadablePath(
  path: string,
  policy: WorkspaceAccessPolicy | undefined,
): boolean {
  if (isProtectedPath(path, policy?.protectedPaths)) return false
  if (!isPolicyEnabled(policy)) return true
  const normalizedPath = normalizeWorkspacePath(path)
  if (matchesAny(normalizedPath, normalizedRules(policy.readExcludes))) {
    return false
  }
  return matchesAny(normalizedPath, readIncludes(policy))
}

function joinWorkspacePath(root: string, relativePath: string): string {
  if (root === '') return relativePath
  if (relativePath === '') return root
  return `${root}/${relativePath}`
}

export function resolveReadablePath(
  path: string,
  policy: WorkspaceAccessPolicy | undefined,
): string {
  const normalizedInput = normalizeWorkspacePath(path)
  assertNotProtectedPath(normalizedInput, policy?.protectedPaths)
  if (!isPolicyEnabled(policy)) return normalizedInput
  const raw = path.trim()
  const root = normalizeWorkspacePath(policy.workspaceRoot)
  const candidate = raw.startsWith('/')
    ? normalizeWorkspacePath(raw.slice(1))
    : matchesRule(normalizedInput, root)
      ? normalizedInput
      : joinWorkspacePath(root, normalizedInput)
  assertNotProtectedPath(candidate, policy?.protectedPaths)
  if (!isReadablePath(candidate, policy)) {
    throw new Error(`Path is outside the workspace read policy: ${path}`)
  }
  return candidate
}

export function resolveWritablePath(
  path: string,
  policy: WorkspaceAccessPolicy | undefined,
): string {
  const raw = path.trim()
  const normalizedPath = normalizeWorkspacePath(raw)
  assertNotProtectedPath(normalizedPath, policy?.protectedPaths)
  if (!isPolicyEnabled(policy)) return normalizedPath

  const root = normalizeWorkspacePath(policy.workspaceRoot)
  const candidate = raw.startsWith('/')
    ? normalizeWorkspacePath(raw.slice(1))
    : root === '' || matchesRule(normalizedPath, root)
      ? normalizedPath
      : joinWorkspacePath(root, normalizedPath)

  assertNotProtectedPath(candidate, policy?.protectedPaths)
  if (root !== '' && !matchesRule(candidate, root)) {
    throw new Error(`Path is outside the workspace write root: ${path}`)
  }
  if (matchesAny(candidate, normalizedRules(policy.writeExcludes))) {
    throw new Error(`Path is denied by the workspace write policy: ${path}`)
  }
  return candidate
}

export function isWritablePath(
  path: string,
  policy: WorkspaceAccessPolicy | undefined,
): boolean {
  try {
    const resolved = resolveWritablePath(path, policy)
    if (!isPolicyEnabled(policy)) return true
    const root = normalizeWorkspacePath(policy.workspaceRoot)
    return root === '' || matchesRule(resolved, root)
  } catch {
    return false
  }
}

export function resolveAssistantWorkspaceAccessPolicy(
  assistant: Assistant | null | undefined,
): WorkspaceAccessPolicy | undefined {
  if (!assistant) return undefined
  return normalizeWorkspacePolicy(
    assistant.workspaceScope,
    assistant.workspaceAccessPolicy,
  )
}

/**
 * Normalize both upstream workspaceScope and our workspaceAccessPolicy into
 * a single unified WorkspaceAccessPolicy. This is the single entry point that
 * all runtime code should use — no more dual-path permission resolution.
 *
 * `WorkspaceAccessPolicy` is a strict superset of `AssistantWorkspaceScope`
 * (adds workspaceRoot, read/write excludes, protectedPaths), so the policy is
 * the canonical bottom layer: the run context carries only the policy and the
 * legacy scope shape exists solely in persisted settings, folded in here at
 * settings-init time. Nothing at runtime translates back to the scope shape.
 *
 * Precedence: workspaceAccessPolicy takes priority. If only workspaceScope
 * is present, its include/exclude lists are mapped into the richer policy
 * format (with empty workspaceRoot).
 */
export function normalizeWorkspacePolicy(
  scope: AssistantWorkspaceScope | undefined,
  accessPolicy: WorkspaceAccessPolicy | undefined,
): WorkspaceAccessPolicy | undefined {
  // Our enhanced policy takes precedence.
  if (accessPolicy?.enabled) {
    return {
      enabled: true,
      workspaceRoot: accessPolicy.workspaceRoot,
      readExtraIncludes: accessPolicy.readExtraIncludes ?? [],
      readExcludes: accessPolicy.readExcludes ?? [],
      writeExcludes: accessPolicy.writeExcludes ?? [],
      // protectedPaths are part of the policy (superset semantics): keep them
      // so `isReadablePath`'s hidden check survives normalization.
      protectedPaths: accessPolicy.protectedPaths,
    }
  }
  // Fall back to upstream workspaceScope — map include/exclude into the
  // richer policy format with empty workspaceRoot.
  if (scope?.enabled) {
    return {
      enabled: true,
      workspaceRoot: '',
      readExtraIncludes: scope.include ?? [],
      readExcludes: scope.exclude ?? [],
      writeExcludes: scope.exclude ?? [],
    }
  }
  return undefined
}

/**
 * True when `path` is a strict or equal ancestor of an included policy path
 * (`workspaceRoot` or `readExtraIncludes`). An include-scoped policy only
 * names the deepest allowed folder (e.g. `workspaceRoot: "/Projects/Client"`),
 * but a traversal operation (`ls`, `$vault.list`) needs to descend through
 * `Projects` to reach it — so ancestors of an include rule must stay listable
 * even though they fail the direct `isReadablePath` check (their own content
 * isn't in scope, only the path to reach an in-scope descendant is). Shared
 * by `vaultBashFileSystem.ts` (bash `ls`/`find`) and `jsSandboxTool.ts`
 * (`$vault.list`) — both traversal-style tools need the same carve-out.
 */
export function isAncestorOfIncludePath(
  path: string,
  policy: WorkspaceAccessPolicy | undefined,
): boolean {
  if (!policy?.enabled) return false
  const includes = [
    policy.workspaceRoot,
    ...(policy.readExtraIncludes ?? []),
  ].filter((entry) => entry !== '')
  if (includes.length === 0) return false
  const normalizedPath = normalizePathSlashes(path)
  return includes.some((rule) => {
    const normalizedRule = normalizePathSlashes(rule)
    return (
      normalizedRule === normalizedPath ||
      normalizedRule.startsWith(
        normalizedPath === '' ? '' : `${normalizedPath}/`,
      )
    )
  })
}

/**
 * Scope-only visibility for traversal operations: more permissive than
 * `resolvePathVisibility`'s direct "can the agent read this content" check,
 * because listing must be able to descend through an include rule's
 * ancestor directories to reach it (`isAncestorOfIncludePath`). Deliberately
 * does not consider `hidden` — traversal callers apply that separately
 * (typically per-entry, alongside their own listing logic), since hidden
 * paths don't get the ancestor carve-out: the YOLO user-data root must stay
 * invisible even as a bare directory entry on the way to something else.
 */
export function isVisibleForTraversal(
  path: string,
  policy: WorkspaceAccessPolicy | undefined,
): boolean {
  if (!policy?.enabled) return true
  return isReadablePath(path, policy) || isAncestorOfIncludePath(path, policy)
}

/**
 * `visible`: the agent may read/write this path outright.
 * `hidden`: the path lives inside the YOLO user-data root
 * (`isWithinYoloUserDataRoot`) and must be reported as though it doesn't
 * exist — see `describePathDenial`'s doc comment for why.
 * `out-of-scope`: the path is real and not secret, but falls outside the
 * agent's configured workspace scope — an autonomy boundary, not a
 * confidentiality one (see `isReadablePath`'s doc comment).
 */
export type PathVisibility = 'visible' | 'hidden' | 'out-of-scope'

/**
 * The single judgment every call site that decides "can the agent touch
 * this vault path" should defer to, for an already-resolved, literal vault
 * path (not a raw tool argument that might still be a wikilink — see
 * `describePathDenial`'s doc comment). Before this existed, `fs_read`,
 * `security-boundary.ts`, `vaultBashFileSystem.ts`, `vaultBashSearch.ts`,
 * and `jsSandboxTool.ts` each re-paired `isWithinYoloUserDataRoot` +
 * `isReadablePath` by hand, and the priority between them (hidden always
 * wins, unconditionally) was implicit in call order rather than enforced —
 * upstream issue #577.
 *
 * Priority is fixed: `hidden` is checked first and wins regardless of
 * whether workspace scope is even enabled, because the YOLO user-data root
 * must stay invisible unconditionally (see `isWithinYoloUserDataRoot`).
 * Only once a path clears that does workspace scope apply, with the same
 * skill-package exemption the fs_* tools already carry.
 *
 * Policy-shaped: the canonical runtime shape is `WorkspaceAccessPolicy`
 * (`AssistantWorkspaceScope` only exists in persisted settings and is folded
 * into the policy at settings-init time) — nothing here ever translates back
 * to the scope shape.
 */
export function resolvePathVisibility(
  path: string,
  options: {
    policy?: WorkspaceAccessPolicy
    settings?: YoloSettingsLike | null
    exemptPaths?: ReadonlySet<string>
  },
): PathVisibility {
  if (isWithinYoloUserDataRoot(path, options.settings)) {
    return 'hidden'
  }
  if (
    options.policy?.enabled &&
    !isReadablePath(path, options.policy) &&
    !(
      options.exemptPaths &&
      isCoveredBySkillPathExemption(path, options.exemptPaths)
    )
  ) {
    return 'out-of-scope'
  }
  return 'visible'
}

/**
 * Builds the model-facing denial message for a non-`visible` path.
 *
 * `requestedInput` MUST be the exact string the agent supplied in its tool
 * call — e.g. a still-unresolved wikilink target like `"[[Secret]]"` — and
 * NEVER a path resolved from it (e.g. the real vault path a wikilink
 * resolves to, or a `TFile.path` read off a resolved file). This is
 * issue #577's root cause: `fs_read`'s out-of-scope error used to echo the
 * *resolved* path, so an agent that had no way to know `[[Secret]]` pointed
 * outside its workspace scope learned the real path anyway, purely from
 * being told "no". Accepting only `requestedInput` here (never a resolved
 * `TFile`/path value) makes that leak impossible to reintroduce by
 * accident — there is no parameter to smuggle a resolved path through.
 */
export function describePathDenial(
  visibility: 'hidden' | 'out-of-scope',
  requestedInput: string,
  kind: 'file' | 'folder' = 'file',
): string {
  if (visibility === 'hidden') {
    // Same wording a genuine miss gets — deliberately indistinguishable
    // from "doesn't exist" so nothing about "this path is specially
    // hidden" leaks to the model (see `isWithinYoloUserDataRoot`'s callers
    // for the full rationale).
    return kind === 'folder'
      ? `Folder not found: ${requestedInput}`
      : `File not found: ${requestedInput}`
  }
  // Unlike `hidden`, workspace scope is not a confidentiality boundary
  // (user-driven access — @-references, the active file — bypasses it
  // entirely; see the module doc above). Disguising this as a missing file
  // would make the model falsely tell the user the file doesn't exist, so
  // it gets an explicit denial instead.
  return `Path "${requestedInput}" is outside this agent's workspace scope.`
}

// Top-level arg keys that may carry a vault path for a given fs_* tool.
// Value can be a string (single path) or an array of strings (e.g. fs_read.paths).
// Only live built-in tools are listed — the retired names (fs_list, fs_search,
// fs_delete, fs_create_dir, fs_move, fs_file_ops) were dropped with their
// tools; a registry tool not listed here simply contributes no path
// constraints.
const TOOL_TOP_LEVEL_PATH_KEYS: Record<string, readonly string[]> = {
  fs_read: ['paths'],
  fs_edit: ['path'],
  fs_write: ['path'],
  // mineru_convert reads the input PDF and writes converted markdown/images to
  // outputDir — both are subject to the workspace scope (see
  // TOOL_TOP_LEVEL_READ_PATH_KEYS for the read-side exception).
  mineru_convert: ['inputPath', 'outputDir'],
}

/**
 * Read-semantics path keys for write-classified tools (the first read+write
 * hybrid: `mineru_convert` reads its inputPath but is a write tool because it
 * writes outputDir). Workspace-policy gates resolve these keys with
 * `resolveReadablePath` (readExcludes/readIncludes apply) and every other key
 * of a write tool with `resolveWritablePath` — without this, a read-denied
 * PDF could be converted (write check ignores readExcludes) and its result
 * read back through outputDir, bypassing the read policy.
 */
const TOOL_TOP_LEVEL_READ_PATH_KEYS: Record<string, readonly string[]> = {
  mineru_convert: ['inputPath'],
}

function extractStringsFrom(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }
  return []
}

export type ToolCallPathMode = 'read' | 'write'

export type ToolCallPathWithMode = { path: string; mode: ToolCallPathMode }

/**
 * Collect every vault path referenced by a local fs_* tool call's args with
 * the workspace-policy resolution mode for each key. A non-write tool's keys
 * are all read; a write-classified tool's keys are write except those listed
 * in {@link TOOL_TOP_LEVEL_READ_PATH_KEYS} (read+write hybrids such as
 * `mineru_convert`, where the input must honor readExcludes/readIncludes).
 * Returns an empty array for non-local or unrecognized tools; callers may
 * treat that as "no path constraints apply".
 */
export function collectToolCallPathsWithModes(
  toolName: string,
  args: Record<string, unknown> | undefined,
  isWriteTool: boolean,
): ToolCallPathWithMode[] {
  if (!args) return []
  const paths: ToolCallPathWithMode[] = []
  const push = (key: string): void => {
    const mode: ToolCallPathMode =
      !isWriteTool || TOOL_TOP_LEVEL_READ_PATH_KEYS[toolName]?.includes(key)
        ? 'read'
        : 'write'
    for (const p of extractStringsFrom(args[key])) {
      const trimmed = p.trim()
      if (trimmed !== '') paths.push({ path: trimmed, mode })
    }
  }
  const topKeys = TOOL_TOP_LEVEL_PATH_KEYS[toolName]
  if (topKeys) {
    for (const key of topKeys) {
      push(key)
    }
  }
  return paths
}

/**
 * Collect every vault path referenced by a local fs_* tool call's args
 * (mode-less view; the resolution mode is `collectToolCallPathsWithModes`'s
 * job). Returns an empty array for non-local or unrecognized tools; callers
 * may treat that as "no path constraints apply".
 */
export function collectToolCallPaths(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string[] {
  // Mode only depends on isWriteTool; path collection is identical either way.
  return collectToolCallPathsWithModes(toolName, args, true).map(
    ({ path }) => path,
  )
}

const WORKSPACE_WRITE_TOOL_NAMES = new Set([
  'fs_edit',
  'fs_write',
  'mineru_convert',
])

export function isWorkspaceWriteToolName(toolName: string): boolean {
  return WORKSPACE_WRITE_TOOL_NAMES.has(toolName)
}

/**
 * Returns the first literal path that violates the canonical workspace
 * policy. fs_read is intentionally handled after its wikilinks resolve.
 */
export function findWorkspacePolicyViolation({
  toolName,
  args,
  policy,
  exemptPaths,
}: {
  toolName: string
  args: Record<string, unknown>
  policy: WorkspaceAccessPolicy
  exemptPaths?: ReadonlySet<string>
}): string | null {
  for (const { path, mode } of collectToolCallPathsWithModes(
    toolName,
    args,
    isWorkspaceWriteToolName(toolName),
  )) {
    if (path.startsWith(BROWSER_READ_PATH_PREFIX)) continue
    if (exemptPaths?.has(path)) continue
    try {
      if (mode === 'write') {
        resolveWritablePath(path, policy)
      } else {
        resolveReadablePath(path, policy)
      }
    } catch {
      return path
    }
  }
  return null
}

/**
 * Validate all paths referenced by a tool call against a workspace scope.
 * Returns the first out-of-scope path (for error messaging), or null if all
 * paths are allowed / scope is disabled / tool has no path args.
 */
export function normalizeSkillPathForExemption(path: string): string {
  const trimmed = path.trim()
  if (
    trimmed.startsWith(BUILTIN_SKILL_PATH_PREFIX) ||
    trimmed.startsWith(BROWSER_READ_PATH_PREFIX)
  ) {
    return trimmed
  }
  return normalizePath(trimmed)
}

export function buildAllowedSkillPathSet(
  paths: readonly string[],
): Set<string> {
  return new Set(paths.map(normalizeSkillPathForExemption))
}

export function isCoveredBySkillPathExemption(
  path: string,
  exemptPaths: ReadonlySet<string>,
): boolean {
  const normalizedPath = normalizeSkillPathForExemption(path)
  if (exemptPaths.has(normalizedPath)) return true

  for (const skillPath of exemptPaths) {
    if (!skillPath.endsWith('/SKILL.md')) continue
    const packageDir = skillPath.slice(0, -'/SKILL.md'.length)
    if (normalizedPath.startsWith(`${packageDir}/`)) return true
  }
  return false
}

/**
 * Generic version of `findPathOutsideScope` for any other reason a local
 * fs_* tool's literal path args might need to be rejected wholesale —
 * currently used to keep the YOLO user-data root (`<baseDir>/data`) invisible
 * to agent tools (see `isWithinYoloUserDataRoot` in `core/paths/yoloPaths.ts`
 * and its caller in `security-boundary.ts`). Takes a generic `isExcluded`
 * predicate rather than calling `isWithinYoloUserDataRoot` itself so callers
 * that already have their own exclusion reason can reuse the same
 * multi-arg-path iteration (this file depends on `core/paths` anyway now,
 * via `resolvePathVisibility` above).
 *
 * Like `findPathOutsideScope`, `fs_read` is out of scope here: its `paths`
 * entries may be wikilink targets rather than literal vault paths, so it
 * enforces this same exclusion itself, post-resolution (see `case 'fs_read'`
 * in `localFileTools.ts`).
 */
export function findPathWithinExcludedRoot(
  toolName: string,
  args: Record<string, unknown> | undefined,
  isExcluded: (path: string) => boolean,
): string | null {
  const paths = collectToolCallPaths(toolName, args)
  for (const path of paths) {
    const trimmed = path.trim()
    if (
      trimmed.startsWith(BUILTIN_SKILL_PATH_PREFIX) ||
      trimmed.startsWith(BROWSER_READ_PATH_PREFIX)
    ) {
      continue
    }
    if (isExcluded(path)) return path
  }
  return null
}
