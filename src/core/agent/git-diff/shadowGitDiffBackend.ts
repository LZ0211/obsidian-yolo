import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  copyFile,
  lstat,
  mkdir,
  open,
  opendir,
  realpath,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path'

import type { WorkspaceAccessPolicy } from '../../../types/assistant.types'
import type { AgentFileChange, AgentGitFileDiff } from '../../../types/chat'
import type { ProtectedPathRule } from '../../paths/protectedPaths'
import { normalizeWorkspacePath } from '../workspaceScope'

import { type GitCommandRunner, runGitCommand } from './gitCommandRunner'
import { parseGitNumstat } from './numstat'

export type ShadowGitBaseline = {
  tree: string
  gitDir: string
  indexFile: string
  repoRoot: string
  vaultPrefix: string
}

export type AgentGitDiffBackend = {
  begin(
    policy: WorkspaceAccessPolicy | undefined,
  ): Promise<ShadowGitBaseline | null>
  discard?(baseline: ShadowGitBaseline): Promise<void> | void
  finish(
    baseline: ShadowGitBaseline,
    changes: AgentFileChange[],
  ): Promise<Map<string, AgentGitFileDiff>>
}

export type ShadowGitDiffBackendOptions = {
  vaultPath: string
  snapshotRoot?: string
  commandRunner?: GitCommandRunner
  timeoutMs?: number
  maxOutputBytes?: number
}

type ObjectFormat = 'sha1' | 'sha256'

type MetadataTextResult =
  | { state: 'missing' }
  | { state: 'invalid' }
  | { state: 'present'; value: string }

type RepositoryInfo = {
  repoRoot: string
  vaultPath: string
  sourceGitDir: string
  commonDir: string
  sourceIndexFile: string
  sourceObjectsDir: string
  objectFormat: ObjectFormat
}

type Scope = {
  vaultPrefix: string
  workspaceRoot: string
  positiveRoot: string
  writeExcludes: string[]
  /** Repo-relative glob patterns excluded from the snapshot/diff. */
  protectedGlobs?: string[]
}

type ShadowContext = {
  root: string
  gitDir: string
  runsRoot: string
}

type ManagedShadowEntry = {
  path: string
  kind: 'directory' | 'file'
}

type ActiveRun = {
  baseline: ShadowGitBaseline
  lockFile: string
  info: RepositoryInfo
  scope: Scope
}

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_GIT_METADATA_BYTES = 1024 * 1024
const MAX_OBJECT_SCAN_ENTRIES = 4_096
const SHADOW_ROOT_NAME = 'obsidian-yolo-agent-git'
const GIT_ARGUMENT_PREFIX = [
  '-c',
  'core.hooksPath=',
  '-c',
  'core.fsmonitor=false',
]

const sharedReadyByRoot = new Map<
  string,
  { repoRoot: string; promise: Promise<void> }
>()

const slashPath = (value: string): string => value.split(sep).join('/')

const comparisonPath = (value: string): string =>
  process.platform === 'win32' ? value.toLowerCase() : value

const joinSlashPath = (left: string, right: string): string => {
  if (!left) return right
  if (!right) return left
  return `${left}/${right}`
}

/**
 * Adds host-managed protected paths to a git-diff scope's exclude set. `prefix`
 * and `exact` rules map to literal repo paths; `namePrefix` rules map to a glob
 * so every file whose name starts with the prefix is excluded. Returns the glob
 * patterns (the literal ones are folded into `excludes`).
 */
function addProtectedScopeExcludes(
  rules: readonly ProtectedPathRule[] | undefined,
  vaultPrefix: string,
  excludes: Set<string>,
): string[] {
  if (!rules) return []
  const globs: string[] = []
  for (const rule of rules) {
    if (rule.kind === 'namePrefix') {
      const dir = joinSlashPath(vaultPrefix, rule.dir)
      globs.push(`${dir}/${rule.name}*`)
      continue
    }
    excludes.add(joinSlashPath(vaultPrefix, rule.path))
  }
  return globs
}

const isWithin = (candidate: string, root: string): boolean => {
  const comparableCandidate = comparisonPath(candidate)
  const comparableRoot = comparisonPath(root)
  return (
    comparableRoot === '' ||
    comparableCandidate === comparableRoot ||
    comparableCandidate.startsWith(`${comparableRoot}/`)
  )
}

const isFilesystemWithin = (candidate: string, root: string): boolean => {
  const relativePath = relative(comparisonPath(root), comparisonPath(candidate))
  return (
    relativePath === '' ||
    (relativePath !== '..' &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  )
}

const pathEntryState = async (
  path: string,
): Promise<'missing' | 'present' | 'unreadable'> => {
  try {
    await lstat(path)
    return 'present'
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'missing'
      : 'unreadable'
  }
}

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

const readMetadataText = async (path: string): Promise<MetadataTextResult> => {
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(path, 'r')
    const buffer = Buffer.alloc(MAX_GIT_METADATA_BYTES + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      )
      if (bytesRead === 0) break
      offset += bytesRead
    }
    await handle.close()
    handle = null
    if (offset > MAX_GIT_METADATA_BYTES) return { state: 'invalid' }
    try {
      return {
        state: 'present',
        value: new TextDecoder('utf-8', { fatal: true }).decode(
          buffer.subarray(0, offset),
        ),
      }
    } catch {
      return { state: 'invalid' }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'invalid' }
  }
}

function* textLines(value: string): Generator<string> {
  let start = 0
  for (let index = 0; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 10) continue
    const end =
      index > start && value.charCodeAt(index - 1) === 13 ? index - 1 : index
    yield value.slice(start, end)
    start = index + 1
  }
  if (start <= value.length) yield value.slice(start)
}

const resolveExistingDirectory = async (
  path: string,
): Promise<string | null> => {
  try {
    const resolvedPath = await realpath(path)
    const pathStat = await stat(resolvedPath)
    return pathStat.isDirectory() ? resolvedPath : null
  } catch {
    return null
  }
}

const resolveProjectedPath = async (path: string): Promise<string | null> => {
  let candidate = resolve(path)
  const missingSegments: string[] = []
  while (true) {
    try {
      return resolve(await realpath(candidate), ...missingSegments)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      const parent = dirname(candidate)
      if (parent === candidate) return null
      missingSegments.unshift(basename(candidate))
      candidate = parent
    }
  }
}

const managedShadowEntries = (
  context: ShadowContext,
  additionalFiles: string[] = [],
): ManagedShadowEntry[] => {
  const objects = join(context.gitDir, 'objects')
  const info = join(context.gitDir, 'info')
  const refs = join(context.gitDir, 'refs')
  const directories: ManagedShadowEntry[] = [
    context.gitDir,
    join(context.gitDir, 'branches'),
    join(context.gitDir, 'hooks'),
    info,
    join(context.gitDir, 'objects'),
    join(objects, 'info'),
    join(objects, 'pack'),
    refs,
    join(refs, 'heads'),
    join(refs, 'tags'),
    context.runsRoot,
  ].map((path) => ({ path, kind: 'directory' }))
  const files: ManagedShadowEntry[] = [
    join(context.gitDir, 'HEAD'),
    join(context.gitDir, 'HEAD.lock'),
    join(context.gitDir, 'config'),
    join(context.gitDir, 'config.lock'),
    join(context.gitDir, 'description'),
    join(info, 'exclude'),
    join(objects, 'info', 'alternates'),
    ...additionalFiles,
  ].map((path) => ({ path, kind: 'file' }))
  return [...directories, ...files]
}

const assertManagedShadowContainment = async (
  context: ShadowContext,
  vaultPath: string,
  additionalFiles: string[] = [],
): Promise<void> => {
  const projectedRoot = await resolveProjectedPath(context.root)
  if (!projectedRoot || isFilesystemWithin(projectedRoot, vaultPath)) {
    throw new Error('shadow repository must remain outside the Vault')
  }
  let rootStat: Awaited<ReturnType<typeof lstat>> | null = null
  try {
    rootStat = await lstat(context.root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error('shadow repository root is unreadable')
    }
  }
  if (rootStat) {
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error('shadow repository root is not a managed directory')
    }
  }
  const canonicalRoot = rootStat ? await realpath(context.root) : projectedRoot
  if (isFilesystemWithin(canonicalRoot, vaultPath)) {
    throw new Error('shadow repository must remain outside the Vault')
  }

  for (const entry of managedShadowEntries(context, additionalFiles)) {
    if (!isFilesystemWithin(entry.path, context.root)) {
      throw new Error('shadow path escaped its managed root')
    }
    let entryStat: Awaited<ReturnType<typeof lstat>> | null = null
    try {
      entryStat = await lstat(entry.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('managed shadow path is unreadable')
      }
    }
    if (entryStat) {
      if (entryStat.isSymbolicLink()) {
        throw new Error('managed shadow path is a symlink')
      }
      if (
        (entry.kind === 'directory' && !entryStat.isDirectory()) ||
        (entry.kind === 'file' && !entryStat.isFile())
      ) {
        throw new Error('managed shadow path has an invalid type')
      }
    }
    const projectedEntry = await resolveProjectedPath(entry.path)
    if (
      !projectedEntry ||
      isFilesystemWithin(projectedEntry, vaultPath) ||
      !isFilesystemWithin(projectedEntry, canonicalRoot)
    ) {
      throw new Error('managed shadow path escaped its root')
    }
  }

  const objectsPath = join(context.gitDir, 'objects')
  let scannedEntries = 0
  try {
    for await (const entry of await opendir(objectsPath)) {
      scannedEntries += 1
      if (scannedEntries > MAX_OBJECT_SCAN_ENTRIES) {
        throw new Error('managed object directory is too large')
      }
      if (/^[0-9a-f]{2}$/i.test(entry.name)) {
        const projectedEntry = join(objectsPath, entry.name)
        const entryStat = await lstat(projectedEntry)
        if (
          entryStat.isSymbolicLink() ||
          !entryStat.isDirectory() ||
          !isFilesystemWithin(await realpath(projectedEntry), canonicalRoot)
        ) {
          throw new Error('managed object directory escaped its root')
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('managed ')) {
      throw error
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw new Error('managed object directory is unreadable')
  }
}

const parseObjectId = (value: string): ObjectFormat | null => {
  const hash = value.trim().split(/\s+/, 1)[0] ?? ''
  if (/^[0-9a-f]{64}$/i.test(hash)) return 'sha256'
  if (/^[0-9a-f]{40}$/i.test(hash)) return 'sha1'
  return null
}

const detectObjectFormat = async (
  gitDir: string,
  commonDir: string,
  objectsDir: string,
): Promise<ObjectFormat | null> => {
  const headResult = await readMetadataText(join(gitDir, 'HEAD'))
  if (headResult.state === 'invalid') return null
  const head = headResult.state === 'present' ? headResult.value.trim() : ''
  const directFormat = parseObjectId(head)
  if (directFormat) return directFormat

  if (headResult.state === 'present') {
    if (!head.startsWith('ref: ')) return null
    const refName = head.slice(5).trim()
    if (
      refName === '' ||
      refName.includes('\\') ||
      isAbsolute(refName) ||
      refName
        .split('/')
        .some(
          (segment) => segment === '' || segment === '..' || segment === '.',
        )
    ) {
      return null
    }
    const refResult = await readMetadataText(
      join(commonDir, ...refName.split('/')),
    )
    if (refResult.state === 'invalid') return null
    if (refResult.state === 'present') {
      const refFormat = parseObjectId(refResult.value)
      return refFormat
    }
  }

  const packedRefsResult = await readMetadataText(
    join(commonDir, 'packed-refs'),
  )
  if (packedRefsResult.state === 'invalid') return null
  if (packedRefsResult.state === 'present') {
    for (const line of textLines(packedRefsResult.value)) {
      if (line === '' || line.startsWith('#')) continue
      const packedFormat = parseObjectId(line)
      if (packedFormat) return packedFormat
      return null
    }
  }

  let scannedEntries = 0
  try {
    for await (const directory of await opendir(objectsDir)) {
      scannedEntries += 1
      if (scannedEntries > MAX_OBJECT_SCAN_ENTRIES) return null
      if (!directory.isDirectory() || !/^[0-9a-f]{2}$/i.test(directory.name)) {
        continue
      }
      for await (const objectEntry of await opendir(
        join(objectsDir, directory.name),
      )) {
        scannedEntries += 1
        if (scannedEntries > MAX_OBJECT_SCAN_ENTRIES) return null
        if (/^[0-9a-f]{62}$/i.test(objectEntry.name)) return 'sha256'
        if (/^[0-9a-f]{38}$/i.test(objectEntry.name)) return 'sha1'
      }
    }
  } catch {
    return null
  }

  return 'sha1'
}

const resolveGitDirectory = async (
  markerPath: string,
  repoRoot: string,
): Promise<string | null> => {
  try {
    const markerStat = await stat(markerPath)
    if (markerStat.isDirectory()) return resolveExistingDirectory(markerPath)
    if (!markerStat.isFile()) return null

    const markerResult = await readMetadataText(markerPath)
    if (markerResult.state !== 'present') return null
    const marker = markerResult.value.trim()
    const match = /^gitdir:\s*(.+)$/i.exec(marker)
    if (!match) return null
    const configuredPath = match[1]?.trim()
    if (!configuredPath) return null
    return resolveExistingDirectory(
      isAbsolute(configuredPath)
        ? configuredPath
        : resolve(repoRoot, configuredPath),
    )
  } catch {
    return null
  }
}

const findRepository = async (
  vaultPath: string,
): Promise<RepositoryInfo | null> => {
  const vaultRealPath = await resolveExistingDirectory(vaultPath)
  if (!vaultRealPath) return null

  let candidateRoot = vaultRealPath
  while (true) {
    const markerPath = join(candidateRoot, '.git')
    const markerState = await pathEntryState(markerPath)
    if (markerState === 'unreadable') return null
    if (markerState === 'present') {
      const sourceGitDir = await resolveGitDirectory(markerPath, candidateRoot)
      if (!sourceGitDir) return null
      const commonDirResult = await readMetadataText(
        join(sourceGitDir, 'commondir'),
      )
      if (commonDirResult.state === 'invalid') return null
      const commonDirText =
        commonDirResult.state === 'present' ? commonDirResult.value : null
      if (commonDirText !== null && commonDirText.trim() === '') return null
      const commonDir = await resolveExistingDirectory(
        commonDirText?.trim()
          ? isAbsolute(commonDirText.trim())
            ? commonDirText.trim()
            : resolve(sourceGitDir, commonDirText.trim())
          : sourceGitDir,
      )
      if (!commonDir) return null
      const sourceObjectsDir = await resolveExistingDirectory(
        join(commonDir, 'objects'),
      )
      if (!sourceObjectsDir) return null
      const repoRoot = await realpath(candidateRoot)
      if (!isFilesystemWithin(vaultRealPath, repoRoot)) return null
      const objectFormat = await detectObjectFormat(
        sourceGitDir,
        commonDir,
        sourceObjectsDir,
      )
      if (!objectFormat) return null
      return {
        repoRoot,
        vaultPath: vaultRealPath,
        sourceGitDir,
        commonDir,
        sourceIndexFile: join(sourceGitDir, 'index'),
        sourceObjectsDir,
        objectFormat,
      }
    }

    const parent = dirname(candidateRoot)
    if (parent === candidateRoot) return null
    candidateRoot = parent
  }
}

const sanitizeGitEnvironment = (
  repoRoot: string,
  gitDir: string,
  indexFile?: string,
): NodeJS.ProcessEnv => {
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_'),
    ),
  )
  env.GIT_DIR = gitDir
  env.GIT_WORK_TREE = repoRoot
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : '/dev/null'
  env.GIT_ATTR_NOSYSTEM = '1'
  if (indexFile) env.GIT_INDEX_FILE = indexFile
  return env
}

const isSuccessful = (result: {
  code: number | null
  timedOut: boolean
  outputExceeded: boolean
}): boolean => result.code === 0 && !result.timedOut && !result.outputExceeded

const trimOutput = (value: string): string => value.trim()

const isTreeId = (value: string): boolean => /^[0-9a-f]{40,64}$/.test(value)

const isSafeRepoPath = (path: string): boolean =>
  path !== '' &&
  !isAbsolute(path) &&
  !path.startsWith('/') &&
  path
    .split('/')
    .every((segment) => segment !== '' && segment !== '.' && segment !== '..')

export class ShadowGitDiffBackend implements AgentGitDiffBackend {
  private readonly vaultPath: string
  private readonly snapshotRoot?: string
  private readonly commandRunner: GitCommandRunner
  private readonly timeoutMs: number
  private readonly maxOutputBytes: number
  private readonly activeRuns = new Map<string, ActiveRun>()

  public constructor(options: ShadowGitDiffBackendOptions) {
    this.vaultPath = resolve(options.vaultPath)
    this.snapshotRoot = options.snapshotRoot
    this.commandRunner = options.commandRunner ?? runGitCommand
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  }

  private async run(
    info: RepositoryInfo,
    gitDir: string,
    args: string[],
    options: { indexFile?: string; stdin?: string } = {},
  ) {
    const context = {
      root: dirname(gitDir),
      gitDir,
      runsRoot: options.indexFile
        ? dirname(options.indexFile)
        : join(gitDir, 'runs'),
    }
    await assertManagedShadowContainment(
      context,
      info.vaultPath,
      options.indexFile ? [options.indexFile, `${options.indexFile}.lock`] : [],
    )
    return this.commandRunner({
      args: [...GIT_ARGUMENT_PREFIX, ...args],
      cwd: info.repoRoot,
      env: sanitizeGitEnvironment(info.repoRoot, gitDir, options.indexFile),
      stdin: options.stdin,
      timeoutMs: this.timeoutMs,
      maxOutputBytes: this.maxOutputBytes,
    })
  }

  private async buildScope(
    info: RepositoryInfo,
    policy?: WorkspaceAccessPolicy,
  ) {
    try {
      const vaultRelative = slashPath(relative(info.repoRoot, info.vaultPath))
      if (vaultRelative === '..' || vaultRelative.startsWith('../')) return null
      const vaultPrefix =
        vaultRelative === '' ? '' : normalizeWorkspacePath(vaultRelative)
      const policyEnabled = Boolean(policy?.enabled)
      const workspaceRoot = policyEnabled
        ? normalizeWorkspacePath(policy?.workspaceRoot ?? '')
        : ''
      const positiveRoot = joinSlashPath(vaultPrefix, workspaceRoot)
      const positivePath = resolve(
        info.repoRoot,
        ...positiveRoot.split('/').filter(Boolean),
      )
      const positiveRealPath = await resolveExistingDirectory(positivePath)
      if (
        !positiveRealPath ||
        !isFilesystemWithin(positiveRealPath, info.vaultPath)
      ) {
        return null
      }

      const excludes = new Set<string>()
      // W7: read exclusions hide changes too — the agent cannot legitimately
      // read (readExcludes) or produce (writeExcludes) files under these
      // paths, so their changes must not surface as workspace activity.
      for (const rawRule of policyEnabled
        ? [...(policy?.writeExcludes ?? []), ...(policy?.readExcludes ?? [])]
        : []) {
        const rule = normalizeWorkspacePath(rawRule)
        const repoRule = joinSlashPath(vaultPrefix, rule)
        if (isWithin(repoRule, positiveRoot)) {
          excludes.add(repoRule)
        } else if (isWithin(positiveRoot, repoRule)) {
          excludes.add(positiveRoot)
        }
      }
      // Host-managed protected paths are always excluded from the snapshot,
      // regardless of the assistant workspaceRoot or write excludes.
      const protectedGlobs = addProtectedScopeExcludes(
        policy?.protectedPaths,
        vaultPrefix,
        excludes,
      )
      return {
        vaultPrefix,
        workspaceRoot,
        positiveRoot,
        writeExcludes: [...excludes].sort(),
        ...(protectedGlobs.length > 0 ? { protectedGlobs } : {}),
      } satisfies Scope
    } catch {
      return null
    }
  }

  private createContext(
    info: RepositoryInfo,
    policy: WorkspaceAccessPolicy | undefined,
  ): ShadowContext | null {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          repoRoot: info.repoRoot,
          vaultPath: info.vaultPath,
          workspaceRoot: normalizeWorkspacePath(policy?.workspaceRoot ?? ''),
          writeExcludes: (policy?.writeExcludes ?? [])
            .map(normalizeWorkspacePath)
            .sort(),
        }),
      )
      .digest('hex')
    const root = join(
      resolve(this.snapshotRoot ?? tmpdir()),
      SHADOW_ROOT_NAME,
      fingerprint,
    )
    if (isFilesystemWithin(root, info.vaultPath)) return null
    const gitDir = join(root, 'git')
    return {
      root,
      gitDir,
      runsRoot: join(gitDir, 'runs'),
    }
  }

  private async ensureSharedRoot(
    context: ShadowContext,
    info: RepositoryInfo,
  ): Promise<void> {
    await assertManagedShadowContainment(context, info.vaultPath)
    const contextKey = comparisonPath(context.root)
    const existing = sharedReadyByRoot.get(contextKey)
    if (existing) {
      if (comparisonPath(existing.repoRoot) !== comparisonPath(info.repoRoot)) {
        throw new Error('shadow root belongs to another repository')
      }
      return existing.promise
    }

    const promise = (async () => {
      await mkdir(context.root, { recursive: true })
      await assertManagedShadowContainment(context, info.vaultPath)
      if (!(await pathExists(join(context.gitDir, 'HEAD')))) {
        const initArgs = ['init', '--quiet']
        if (info.objectFormat === 'sha256') {
          initArgs.push('--object-format=sha256')
        }
        const initResult = await this.run(info, context.gitDir, initArgs)
        if (!isSuccessful(initResult)) {
          throw new Error('unable to initialize shadow repository')
        }
        await assertManagedShadowContainment(context, info.vaultPath)
      }
      await mkdir(context.runsRoot, { recursive: true })
      await assertManagedShadowContainment(context, info.vaultPath)

      const configValues: Array<[string, string]> = [
        ['core.bare', 'false'],
        ['core.hooksPath', ''],
        ['core.longpaths', 'true'],
        ['core.autocrlf', 'false'],
        ['core.fsmonitor', 'false'],
        ['core.untrackedCache', 'true'],
        ['feature.manyFiles', 'true'],
        ['index.version', '4'],
        ['index.threads', 'true'],
      ]
      for (const [key, value] of configValues) {
        const configResult = await this.run(info, context.gitDir, [
          'config',
          '--local',
          key,
          value,
        ])
        if (!isSuccessful(configResult)) {
          throw new Error('unable to configure shadow repository')
        }
      }
      await assertManagedShadowContainment(context, info.vaultPath)

      await mkdir(join(context.gitDir, 'objects', 'info'), { recursive: true })
      await mkdir(join(context.gitDir, 'info'), { recursive: true })
      await assertManagedShadowContainment(context, info.vaultPath)
      const alternates = new Set<string>([info.sourceObjectsDir])
      const sourceAlternatesResult = await readMetadataText(
        join(info.sourceObjectsDir, 'info', 'alternates'),
      )
      if (sourceAlternatesResult.state === 'invalid') {
        throw new Error('invalid source alternates metadata')
      }
      if (sourceAlternatesResult.state === 'present') {
        for (const line of textLines(sourceAlternatesResult.value)) {
          const configuredPath = line.trim()
          if (!configuredPath) continue
          const alternatePath = await resolveExistingDirectory(
            isAbsolute(configuredPath)
              ? configuredPath
              : resolve(info.sourceObjectsDir, configuredPath),
          )
          if (!alternatePath) {
            throw new Error('invalid source alternate path')
          }
          alternates.add(alternatePath)
        }
      }
      await writeFile(
        join(context.gitDir, 'objects', 'info', 'alternates'),
        `${[...alternates].join('\n')}\n`,
      )

      const sourceExclude = join(info.commonDir, 'info', 'exclude')
      const shadowExclude = join(context.gitDir, 'info', 'exclude')
      const sourceExcludeResult = await readMetadataText(sourceExclude)
      if (sourceExcludeResult.state === 'invalid') {
        throw new Error('invalid source exclude metadata')
      }
      if (sourceExcludeResult.state === 'present') {
        await writeFile(shadowExclude, sourceExcludeResult.value, 'utf8')
      } else {
        await rm(shadowExclude, { force: true })
      }
      await assertManagedShadowContainment(context, info.vaultPath)
    })().catch((error) => {
      sharedReadyByRoot.delete(contextKey)
      throw error
    })
    sharedReadyByRoot.set(contextKey, { repoRoot: info.repoRoot, promise })
    return promise
  }

  private async createRun(
    context: ShadowContext,
    info: RepositoryInfo,
  ): Promise<{ indexFile: string; lockFile: string }> {
    const runId = randomUUID()
    const indexFile = join(context.runsRoot, `${runId}.index`)
    const lockFile = join(context.runsRoot, `${runId}.run`)
    let lockHandle: Awaited<ReturnType<typeof open>> | null = null
    let lockCreated = false
    try {
      await assertManagedShadowContainment(context, info.vaultPath, [
        indexFile,
        `${indexFile}.lock`,
        lockFile,
      ])
      lockHandle = await open(lockFile, 'wx')
      lockCreated = true
      await lockHandle.close()
      lockHandle = null
      if (await pathExists(info.sourceIndexFile)) {
        await copyFile(info.sourceIndexFile, indexFile)
      } else {
        const emptyResult = await this.run(
          info,
          context.gitDir,
          ['read-tree', '--empty'],
          { indexFile },
        )
        if (!isSuccessful(emptyResult)) {
          throw new Error('unable to initialize empty run index')
        }
      }
      await assertManagedShadowContainment(context, info.vaultPath, [
        indexFile,
        `${indexFile}.lock`,
        lockFile,
      ])
      return { indexFile, lockFile }
    } catch (error) {
      await lockHandle?.close().catch(() => undefined)
      if (lockCreated) {
        await this.cleanupRun(indexFile, lockFile, info.vaultPath).catch(
          () => undefined,
        )
      }
      throw error
    }
  }

  private async cleanupRun(
    indexFile: string,
    lockFile: string,
    vaultPath: string,
  ): Promise<void> {
    const runsRoot = dirname(indexFile)
    const gitDir = dirname(runsRoot)
    const context: ShadowContext = {
      root: dirname(gitDir),
      gitDir,
      runsRoot,
    }
    for (const artifact of [indexFile, `${indexFile}.lock`, lockFile]) {
      try {
        await assertManagedShadowContainment(context, vaultPath, [artifact])
        await rm(artifact, { force: true })
      } catch {
        continue
      }
    }
  }

  private scopePathspecs(scope: Scope): string[] {
    const positive = scope.positiveRoot
      ? `:(top,literal)${scope.positiveRoot}`
      : ':(top)'
    return [
      positive,
      ...scope.writeExcludes.map((path) => `:(top,literal,exclude)${path}`),
      ...(scope.protectedGlobs ?? []).map(
        (path) => `:(top,glob,exclude)${path}`,
      ),
    ]
  }

  private async stage(
    run: { info: RepositoryInfo; gitDir: string; indexFile: string },
    paths: string[],
  ): Promise<boolean> {
    if (paths.length === 0) return true
    const pathspecs = paths.map((path) =>
      path.startsWith(':(') ? path : `:(top,literal)${path}`,
    )
    const stageResult = await this.run(
      run.info,
      run.gitDir,
      ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
      {
        indexFile: run.indexFile,
        stdin: `${pathspecs.join('\0')}\0`,
      },
    )
    return isSuccessful(stageResult)
  }

  private async writeTree(run: {
    info: RepositoryInfo
    gitDir: string
    indexFile: string
  }): Promise<string | null> {
    const treeResult = await this.run(run.info, run.gitDir, ['write-tree'], {
      indexFile: run.indexFile,
    })
    if (!isSuccessful(treeResult)) return null
    const tree = trimOutput(treeResult.stdout)
    return isTreeId(tree) ? tree : null
  }

  public async begin(
    policy: WorkspaceAccessPolicy | undefined,
  ): Promise<ShadowGitBaseline | null> {
    let run: { indexFile: string; lockFile: string } | null = null
    let runInfo: RepositoryInfo | null = null
    try {
      const info = await findRepository(this.vaultPath)
      if (!info) return null
      runInfo = info
      const scope = await this.buildScope(info, policy)
      if (!scope) return null
      const context = this.createContext(info, policy)
      if (!context) return null
      await this.ensureSharedRoot(context, info)
      run = await this.createRun(context, info)
      const commandContext = {
        info,
        gitDir: context.gitDir,
        indexFile: run.indexFile,
      }
      if (!(await this.stage(commandContext, this.scopePathspecs(scope)))) {
        return null
      }
      const tree = await this.writeTree(commandContext)
      if (!tree) return null
      const baseline: ShadowGitBaseline = {
        tree,
        gitDir: context.gitDir,
        indexFile: run.indexFile,
        repoRoot: info.repoRoot,
        vaultPrefix: scope.vaultPrefix,
      }
      this.activeRuns.set(run.indexFile, {
        baseline,
        lockFile: run.lockFile,
        info,
        scope,
      })
      run = null
      return baseline
    } catch {
      return null
    } finally {
      if (run) {
        await this.cleanupRun(
          run.indexFile,
          run.lockFile,
          runInfo?.vaultPath ?? this.vaultPath,
        ).catch(() => undefined)
      }
    }
  }

  public async discard(baseline: ShadowGitBaseline): Promise<void> {
    try {
      const activeRun = this.activeRuns.get(baseline.indexFile)
      if (!activeRun || activeRun.baseline !== baseline) return

      this.activeRuns.delete(baseline.indexFile)
      await this.cleanupRun(
        baseline.indexFile,
        activeRun.lockFile,
        activeRun.info.vaultPath,
      )
    } catch {
      return
    }
  }

  public async finish(
    baseline: ShadowGitBaseline,
    changes: AgentFileChange[],
  ): Promise<Map<string, AgentGitFileDiff>> {
    const emptyResult = new Map<string, AgentGitFileDiff>()
    const activeRun = this.activeRuns.get(baseline.indexFile)
    if (!activeRun) return emptyResult
    this.activeRuns.delete(baseline.indexFile)
    const expected = activeRun.baseline
    if (
      baseline.tree !== expected.tree ||
      baseline.gitDir !== expected.gitDir ||
      baseline.repoRoot !== expected.repoRoot ||
      baseline.vaultPrefix !== expected.vaultPrefix
    ) {
      await this.cleanupRun(
        baseline.indexFile,
        activeRun.lockFile,
        activeRun.info.vaultPath,
      ).catch(() => undefined)
      return emptyResult
    }

    try {
      if (changes.length === 0) return emptyResult
      const candidatePaths = new Set<string>()
      for (const change of changes) {
        for (const rawPath of [change.path, change.oldPath]) {
          if (!rawPath) continue
          try {
            const vaultPath = normalizeWorkspacePath(rawPath)
            if (!vaultPath) continue
            const repoPath = joinSlashPath(
              activeRun.scope.vaultPrefix,
              vaultPath,
            )
            if (
              isWithin(repoPath, activeRun.scope.positiveRoot) &&
              !activeRun.scope.writeExcludes.some((exclude) =>
                isWithin(repoPath, exclude),
              )
            ) {
              candidatePaths.add(repoPath)
            }
          } catch {
            continue
          }
        }
      }
      if (candidatePaths.size === 0) return emptyResult

      const commandContext = {
        info: activeRun.info,
        gitDir: baseline.gitDir,
        indexFile: baseline.indexFile,
      }
      if (!(await this.stage(commandContext, [...candidatePaths]))) {
        return emptyResult
      }
      const endTree = await this.writeTree(commandContext)
      if (!endTree) return emptyResult
      const diffResult = await this.run(
        activeRun.info,
        baseline.gitDir,
        [
          'diff',
          '--no-ext-diff',
          '--numstat',
          '-z',
          '--find-renames=20%',
          baseline.tree,
          endTree,
        ],
        { indexFile: baseline.indexFile },
      )
      if (!isSuccessful(diffResult)) return emptyResult

      const result = new Map<string, AgentGitFileDiff>()
      for (const record of parseGitNumstat(diffResult.stdout)) {
        const currentRepoPath = slashPath(record.path)
        const oldRepoPath = record.oldPath
          ? slashPath(record.oldPath)
          : undefined
        if (
          !isSafeRepoPath(currentRepoPath) ||
          (oldRepoPath !== undefined && !isSafeRepoPath(oldRepoPath))
        ) {
          continue
        }
        if (
          !isWithin(currentRepoPath, activeRun.scope.positiveRoot) ||
          activeRun.scope.writeExcludes.some((exclude) =>
            isWithin(currentRepoPath, exclude),
          ) ||
          (oldRepoPath !== undefined &&
            (!isWithin(oldRepoPath, activeRun.scope.positiveRoot) ||
              activeRun.scope.writeExcludes.some((exclude) =>
                isWithin(oldRepoPath, exclude),
              )))
        ) {
          continue
        }
        const currentPath = activeRun.scope.vaultPrefix
          ? currentRepoPath.slice(activeRun.scope.vaultPrefix.length + 1)
          : currentRepoPath
        if (!currentPath) continue
        result.set(currentPath, {
          additions: record.additions,
          deletions: record.deletions,
          ...(record.binary ? { binary: true } : {}),
        })
      }
      return result
    } catch {
      return emptyResult
    } finally {
      await this.cleanupRun(
        baseline.indexFile,
        activeRun.lockFile,
        activeRun.info.vaultPath,
      ).catch(() => undefined)
    }
  }
}
