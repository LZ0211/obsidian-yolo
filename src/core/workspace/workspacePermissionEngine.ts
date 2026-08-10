import path from 'path-browserify'

import type { WorkspaceAgentPolicy } from '../../settings/schema/setting.types'

export type WorkspaceIoOperation =
  | 'list'
  | 'read'
  | 'preview'
  | 'download'
  | 'search'
  | 'metadata_search'
  | 'rag_result'
  | 'skill_read'
  | 'skill_write'
  | 'create'
  | 'write'
  | 'upload'
  | 'rename'
  | 'move'
  | 'delete'

export type WorkspacePermissionDecision =
  | { ok: true; path: string }
  | {
      ok: false
      code: 'invalid_path' | 'not_found' | 'forbidden'
      message: string
    }

type DecideInput = {
  policy: WorkspaceAgentPolicy
  operation: WorkspaceIoOperation
  path: string
  targetPath?: string
  childPaths?: string[]
  recursiveDelete?: boolean
  realpath?: (path: string) => string | null
}

const READ_OPERATIONS = new Set<WorkspaceIoOperation>([
  'list',
  'read',
  'preview',
  'download',
  'search',
  'metadata_search',
  'rag_result',
  'skill_read',
])

const WRITE_OPERATIONS = new Set<WorkspaceIoOperation>([
  'create',
  'write',
  'upload',
  'rename',
  'move',
  'delete',
  'skill_write',
])

export function normalizeVaultRootPath(input: string): string {
  return normalizeVaultPath(input, { allowBlankAsRoot: false })
}

export function isHiddenSharedWebPath(input: string): boolean {
  let normalized: string
  try {
    normalized = normalizeVaultPath(input, { allowBlankAsRoot: true })
  } catch {
    return true
  }
  return normalized
    .split('/')
    .filter(Boolean)
    .some((segment) => segment.startsWith('.'))
}

export function isPathWithinSegmentAware(
  parent: string,
  child: string,
): boolean {
  const normalizedParent = normalizeVaultPath(parent, {
    allowBlankAsRoot: true,
  })
  const normalizedChild = normalizeVaultPath(child, { allowBlankAsRoot: true })
  if (normalizedParent === '/') return true
  return (
    normalizedChild === normalizedParent ||
    normalizedChild.startsWith(`${normalizedParent}/`)
  )
}

export function decideWorkspacePathAccess(
  input: DecideInput,
): WorkspacePermissionDecision {
  let root: string
  try {
    root = normalizeVaultRootPath(input.policy.workspaceRoot)
  } catch {
    return invalid()
  }

  if (input.operation === 'rename' || input.operation === 'move') {
    if (!input.targetPath) return invalid()
    return decideMoveLike(input, root)
  }

  const candidate = resolveCandidate(input.path, root, input.operation)
  if (!candidate.ok) return candidate

  const resolved = resolveRealpath(candidate.path, input.realpath)
  if (!resolved.ok) return denyForOperation(input.operation)

  if (READ_OPERATIONS.has(input.operation)) {
    return canRead(resolved.path, input.policy, root, input.operation)
  }

  if (WRITE_OPERATIONS.has(input.operation)) {
    const decision = canWrite(
      resolved.path,
      input.policy,
      root,
      input.operation,
    )
    if (!decision.ok) return decision
    const parentDecision = checkResolvedParent(
      resolved.path,
      input.realpath,
      input.policy,
      root,
      input.operation,
    )
    if (!parentDecision.ok) return parentDecision
    if (input.operation === 'delete') {
      if (!input.recursiveDelete) return { ok: true, path: resolved.path }
      return checkDeleteChildren(input, root)
    }
    return { ok: true, path: resolved.path }
  }

  return forbidden()
}

function decideMoveLike(
  input: DecideInput,
  root: string,
): WorkspacePermissionDecision {
  const source = resolveCandidate(input.path, root, input.operation)
  const target = resolveCandidate(input.targetPath ?? '', root, input.operation)
  if (!source.ok) return source
  if (!target.ok) return target

  const resolvedSource = resolveRealpath(source.path, input.realpath)
  if (!resolvedSource.ok) return forbidden()
  const resolvedTarget = resolveDestinationPath(target.path, input.realpath)
  if (!resolvedTarget.ok) return resolvedTarget

  const sourceDecision = canWrite(
    resolvedSource.path,
    input.policy,
    root,
    input.operation,
  )
  if (!sourceDecision.ok) return sourceDecision
  const targetDecision = canWrite(
    resolvedTarget.path,
    input.policy,
    root,
    input.operation,
  )
  if (!targetDecision.ok) return targetDecision
  const parentDecision = checkResolvedParent(
    resolvedTarget.path,
    input.realpath,
    input.policy,
    root,
    input.operation,
  )
  if (!parentDecision.ok) return parentDecision
  return { ok: true, path: resolvedTarget.path }
}

function canRead(
  candidate: string,
  policy: WorkspaceAgentPolicy,
  root: string,
  operation: WorkspaceIoOperation,
): WorkspacePermissionDecision {
  if (isSharedWebOperation(operation) && isHiddenSharedWebPath(candidate)) {
    return denyForOperation(operation)
  }
  const denylist = normalizeRules(policy.readDenylist)
  if (matchesAny(candidate, denylist)) return denyForOperation(operation)
  const readRoots = [root, ...normalizeRules(policy.readAllowlist)]
  if (matchesAny(candidate, readRoots)) return { ok: true, path: candidate }
  return denyForOperation(operation)
}

function canWrite(
  candidate: string,
  policy: WorkspaceAgentPolicy,
  root: string,
  operation: WorkspaceIoOperation,
): WorkspacePermissionDecision {
  if (isSharedWebOperation(operation) && isHiddenSharedWebPath(candidate)) {
    return forbidden()
  }
  if (!isPathWithinSegmentAware(root, candidate)) return forbidden()
  if (matchesAny(candidate, normalizeRules(policy.writeDenylist))) {
    return forbidden()
  }
  return { ok: true, path: candidate }
}

function checkResolvedParent(
  candidate: string,
  realpath: DecideInput['realpath'],
  policy: WorkspaceAgentPolicy,
  root: string,
  operation: WorkspaceIoOperation,
): WorkspacePermissionDecision {
  if (!realpath) return { ok: true, path: candidate }
  const parent = path.posix.dirname(candidate)
  const resolvedParent = resolveRealpath(parent, realpath)
  if (!resolvedParent.ok) return forbidden()
  return canWrite(resolvedParent.path, policy, root, operation)
}

function checkDeleteChildren(
  input: DecideInput,
  root: string,
): WorkspacePermissionDecision {
  const candidate = resolveCandidate(input.path, root, input.operation)
  if (!candidate.ok) return candidate
  if (!input.childPaths) return forbidden()
  for (const childPath of input.childPaths ?? []) {
    const childDecision = decideWorkspacePathAccess({
      policy: input.policy,
      operation: 'read',
      path: childPath,
      realpath: input.realpath,
    })
    if (!childDecision.ok) return forbidden()
    const childWriteDecision = decideWorkspacePathAccess({
      policy: input.policy,
      operation: 'write',
      path: childPath,
      realpath: input.realpath,
    })
    if (!childWriteDecision.ok) return forbidden()
  }
  return { ok: true, path: candidate.path }
}

function resolveDestinationPath(
  candidate: string,
  realpath: DecideInput['realpath'],
): WorkspacePermissionDecision {
  if (!realpath) return { ok: true, path: candidate }
  const resolved = realpath(candidate)
  if (resolved == null) return { ok: true, path: candidate }
  try {
    return {
      ok: true,
      path: normalizeVaultPath(resolved, { allowBlankAsRoot: false }),
    }
  } catch {
    return invalid()
  }
}

function resolveCandidate(
  input: string,
  root: string,
  operation: WorkspaceIoOperation,
): WorkspacePermissionDecision {
  let normalized: string
  try {
    normalized = normalizeVaultPath(input, {
      allowBlankAsRoot: operation === 'list',
    })
  } catch {
    return invalid()
  }
  if (normalized === '/') return { ok: true, path: root }
  if (input.trim().startsWith('/')) return { ok: true, path: normalized }
  if (normalized === root || normalized.startsWith(root + '/')) {
    return { ok: true, path: normalized }
  }
  return { ok: true, path: joinVaultPath(root, normalized) }
}

function normalizeVaultPath(
  input: string,
  options: { allowBlankAsRoot: boolean },
): string {
  const trimmed = input.trim()
  if (trimmed === '') {
    if (options.allowBlankAsRoot) return '/'
    throw new Error('blank path')
  }
  if (/^[a-zA-Z]:([\\/]|$)/.test(trimmed)) throw new Error('drive path')
  if (trimmed.startsWith('\\\\') || trimmed.startsWith('//')) {
    throw new Error('unc path')
  }
  let decoded: string
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    throw new Error('malformed path encoding')
  }
  if (decoded.includes('\0')) throw new Error('null byte')
  const slash = decoded.replace(/\\/g, '/')
  if (slash.split('/').some((segment) => segment === '..')) {
    throw new Error('traversal')
  }
  const absolute = slash.startsWith('/') ? slash : `/${slash}`
  const normalized = path.posix.normalize(absolute)
  return normalized.replace(/\/+$/g, '') || '/'
}

function normalizeRules(rules: readonly string[] | undefined): string[] {
  return (rules ?? []).map((rule) => normalizeVaultRootPath(rule))
}

function matchesAny(path: string, rules: readonly string[]): boolean {
  return rules.some((rule) => isPathWithinSegmentAware(rule, path))
}

function joinVaultPath(root: string, relativeAbsolutePath: string): string {
  if (root === '/') return relativeAbsolutePath
  const relative = relativeAbsolutePath.replace(/^\/+/, '')
  return normalizeVaultPath(`${root}/${relative}`, { allowBlankAsRoot: false })
}

function resolveRealpath(
  candidate: string,
  realpath: DecideInput['realpath'],
): WorkspacePermissionDecision {
  if (!realpath) return { ok: true, path: candidate }
  const resolved = realpath(candidate)
  if (resolved == null) return notFound()
  try {
    return {
      ok: true,
      path: normalizeVaultPath(resolved, { allowBlankAsRoot: false }),
    }
  } catch {
    return invalid()
  }
}

function denyForOperation(
  operation: WorkspaceIoOperation,
): WorkspacePermissionDecision {
  return READ_OPERATIONS.has(operation) ? notFound() : forbidden()
}

function isSharedWebOperation(operation: WorkspaceIoOperation): boolean {
  return operation !== 'skill_read' && operation !== 'skill_write'
}

function invalid(): WorkspacePermissionDecision {
  return {
    ok: false,
    code: 'invalid_path',
    message: 'Invalid path',
  }
}

function notFound(): WorkspacePermissionDecision {
  return {
    ok: false,
    code: 'not_found',
    message: 'Not found',
  }
}

function forbidden(): WorkspacePermissionDecision {
  return {
    ok: false,
    code: 'forbidden',
    message: 'Forbidden',
  }
}
