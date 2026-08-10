import { normalizePath } from 'obsidian'

import type {
  Assistant,
  AssistantWorkspaceScope,
  WorkspaceAccessPolicy,
} from '../../types/assistant.types'
import { normalizePathSlashes } from '../paths/normalizePath'

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
  if (!isPolicyEnabled(policy)) return normalizeWorkspacePath(path)
  const raw = path.trim()
  const root = normalizeWorkspacePath(policy.workspaceRoot)
  const candidate = raw.startsWith('/')
    ? normalizeWorkspacePath(raw.slice(1))
    : matchesRule(normalizeWorkspacePath(raw), root)
      ? normalizeWorkspacePath(raw)
      : joinWorkspacePath(root, normalizeWorkspacePath(raw))
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
  if (!isPolicyEnabled(policy)) return normalizedPath

  const root = normalizeWorkspacePath(policy.workspaceRoot)
  const candidate = raw.startsWith('/')
    ? normalizeWorkspacePath(raw.slice(1))
    : root === '' || matchesRule(normalizedPath, root)
      ? normalizedPath
      : joinWorkspacePath(root, normalizedPath)

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

export function isPathAllowedByScope(
  path: string,
  scope: AssistantWorkspaceScope | undefined,
): boolean {
  if (!scope || !scope.enabled) return true
  if (matchesAny(path, scope.exclude)) return false
  if (scope.include.length === 0) return true
  return matchesAny(path, scope.include)
}

export function isWorkspaceScopeActive(
  scope: AssistantWorkspaceScope | undefined,
): boolean {
  if (!scope || !scope.enabled) return false
  return scope.include.length > 0 || scope.exclude.length > 0
}

/**
 * Normalize both upstream workspaceScope and our workspaceAccessPolicy into
 * a single unified WorkspaceAccessPolicy. This is the single entry point that
 * all runtime code should use — no more dual-path permission resolution.
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

// Top-level arg keys that may carry a vault path for a given fs_* tool.
// Value can be a string (single path) or an array of strings (e.g. fs_read.paths).
const TOOL_TOP_LEVEL_PATH_KEYS: Record<string, readonly string[]> = {
  fs_list: ['path'],
  fs_read: ['paths'],
  fs_search: ['path'],
  fs_edit: ['path'],
  fs_write: ['path'],
  fs_delete: ['path'],
  fs_create_dir: ['path'],
  fs_move: ['oldPath', 'newPath'],
  fs_file_ops: ['path'],
}

// The consolidated fs_file_ops tool carries a top-level `action` discriminator.
// The path keys inspected depend on the resolved action: move touches BOTH
// oldPath and newPath; delete/create_dir touch only path.
const CONSOLIDATED_FS_FILE_OPS_ACTION_PATH_KEYS: Record<
  string,
  readonly string[]
> = {
  move: ['oldPath', 'newPath'],
  delete: ['path'],
  create_dir: ['path'],
}

function extractStringsFrom(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === 'string')
  }
  return []
}

/**
 * Collect every vault path referenced by a local fs_* tool call's args.
 * Returns an empty array for non-local or unrecognized tools; callers may
 * treat that as "no path constraints apply".
 */
export function collectToolCallPaths(
  toolName: string,
  args: Record<string, unknown> | undefined,
): string[] {
  if (!args) return []
  const paths: string[] = []
  // The consolidated fs_file_ops tool is action-discriminated: resolve the
  // path keys from the action so a move inspects both oldPath and newPath and
  // delete/create_dir inspect path. Unknown/missing actions contribute nothing
  // (they are rejected by the runtime validator before any path check runs).
  if (toolName === 'fs_file_ops') {
    const actionKeys =
      CONSOLIDATED_FS_FILE_OPS_ACTION_PATH_KEYS[
        typeof args.action === 'string' ? args.action : ''
      ]
    if (actionKeys) {
      for (const key of actionKeys) {
        for (const p of extractStringsFrom(args[key])) {
          const trimmed = p.trim()
          if (trimmed !== '') paths.push(trimmed)
        }
      }
    }
    return paths
  }
  const topKeys = TOOL_TOP_LEVEL_PATH_KEYS[toolName]
  if (topKeys) {
    for (const key of topKeys) {
      for (const p of extractStringsFrom(args[key])) {
        const trimmed = p.trim()
        if (trimmed !== '') paths.push(trimmed)
      }
    }
  }
  return paths
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

export function findPathOutsideScope(
  toolName: string,
  args: Record<string, unknown> | undefined,
  scope: AssistantWorkspaceScope | undefined,
  options?: { exemptPaths?: ReadonlySet<string> },
): string | null {
  if (!scope?.enabled) return null
  const paths = collectToolCallPaths(toolName, args)
  for (const path of paths) {
    const trimmed = path.trim()
    if (
      trimmed.startsWith(BUILTIN_SKILL_PATH_PREFIX) ||
      trimmed.startsWith(BROWSER_READ_PATH_PREFIX)
    ) {
      continue
    }
    if (
      options?.exemptPaths &&
      isCoveredBySkillPathExemption(path, options.exemptPaths)
    ) {
      continue
    }
    if (!isPathAllowedByScope(path, scope)) return path
  }
  return null
}

/**
 * Generic version of `findPathOutsideScope` for any other reason a local
 * fs_* tool's literal path args might need to be rejected wholesale — kept
 * from the upstream baseline for `localFileTools`'s user-data-root guard.
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
