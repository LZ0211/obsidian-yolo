import {
  type WorkflowDocument,
  parseWorkflowDocument,
} from './workflow-document'
import { isSafeWorkflowStepPath } from './workflow-model'

type Host = Pick<YoloModuleHostApiV1, 'paths' | 'vault'>

export type WorkflowListEntry = Readonly<{ path: string; title: string }>
export type WorkflowTextFile = Readonly<{
  nodeId: string
  relativePath: string
  snapshot: YoloModuleHostApiV1['vault'] extends {
    readTextSnapshot(path: string): Promise<infer Snapshot>
  }
    ? NonNullable<Snapshot>
    : never
}>
export type WorkflowBundle = Readonly<{
  path: string
  document: WorkflowDocument
  files: readonly WorkflowTextFile[]
}>
export type WorkflowWriteFailure = Readonly<{
  ok: false
  reason: 'conflict'
}>
export type RepositoryWriteResult =
  | Readonly<{ ok: true; snapshot: WorkflowTextFile['snapshot'] }>
  | WorkflowWriteFailure
export type RepositoryCreateStepResult =
  | Readonly<{ ok: true; snapshot: WorkflowTextFile['snapshot'] }>
  | Readonly<{ ok: false; reason: 'target-exists' | 'invalid-input' | 'stale' }>
export type CreateWorkflowInput = Readonly<{
  slug: string
  manifestContent: string
  stepFiles: readonly Readonly<{ relativePath: string; content: string }>[]
}>
export type CreateWorkflowResult =
  | Readonly<{ ok: true; snapshot: WorkflowTextFile['snapshot'] }>
  | Readonly<{
      ok: false
      reason: 'target-exists' | 'invalid-input' | 'stale'
    }>
export type WorkflowRepositoryEvent =
  | Readonly<{ type: 'root-changed' }>
  | Readonly<{
      type: 'vault'
      event: Parameters<Host['vault']['subscribe']>[1] extends (
        event: infer Event,
      ) => unknown
        ? Event
        : never
    }>
export type WorkflowRepository = Readonly<{
  list(): readonly WorkflowListEntry[]
  read(path: string): Promise<WorkflowBundle | null>
  create(input: CreateWorkflowInput): Promise<CreateWorkflowResult>
  importBundle(input: CreateWorkflowInput): Promise<CreateWorkflowResult>
  createStep(
    manifestPath: string,
    relativePath: string,
    content: string,
  ): Promise<RepositoryCreateStepResult>
  replaceFile(
    expected: WorkflowTextFile['snapshot'],
    content: string,
  ): Promise<RepositoryWriteResult>
  trash(path: string): Promise<boolean>
  trashStep(manifestPath: string, relativePath: string): Promise<boolean>
  subscribe(listener: (event: WorkflowRepositoryEvent) => void): () => void
}>

export function createWorkflowRepository(host: Host): WorkflowRepository {
  const root = () => host.paths.getSnapshot().contentRoot
  const list = (): readonly WorkflowListEntry[] => {
    const currentRoot = root()
    return host.vault
      .listChildren(currentRoot)
      .filter((entry) => entry.kind === 'folder' && isSlug(entry.name))
      .flatMap((folder) => {
        const manifest = host.vault
          .listChildren(folder.path)
          .find(
            (entry) => entry.kind === 'file' && entry.name === 'WORKFLOW.md',
          )
        if (!manifest || manifest.path !== at(folder.path, 'WORKFLOW.md'))
          return []
        return [{ path: `${folder.name}/WORKFLOW.md`, title: folder.name }]
      })
      .sort((left, right) => left.path.localeCompare(right.path))
  }
  const read = async (path: string): Promise<WorkflowBundle | null> => {
    if (!isManifestPath(path)) return null
    const currentRoot = root()
    const manifestPath = at(currentRoot, path)
    const manifest = await host.vault.readTextSnapshot(manifestPath)
    if (!manifest) return null
    const parsed = parseWorkflowDocument(manifest.content)
    const files: WorkflowTextFile[] = [
      { nodeId: 'workflow', relativePath: path, snapshot: manifest },
    ]
    const missing = new Set<string>()
    const seen = new Set<string>()
    for (const step of parsed.steps) {
      if (seen.has(step.stepPath)) continue
      seen.add(step.stepPath)
      const relativePath = `${path.slice(0, -'WORKFLOW.md'.length)}${step.stepPath}`
      const snapshot = await host.vault.readTextSnapshot(
        at(currentRoot, relativePath),
      )
      if (!snapshot) {
        missing.add(step.stepPath)
        continue
      }
      files.push({ nodeId: step.nodeId, relativePath, snapshot })
    }
    return Object.freeze({
      path,
      document: missing.size === 0 ? parsed : withMissingStep(parsed),
      files: Object.freeze(files),
    })
  }
  const create = (input: CreateWorkflowInput) => writeBundle(host, root, input)
  return Object.freeze({
    list,
    read,
    create,
    importBundle: create,
    createStep: (manifestPath, relativePath, content) =>
      createStepFile(host, root, manifestPath, relativePath, content),
    replaceFile: async (expected, content) => {
      const currentRoot = root()
      if (!isOwnedWorkflowPath(currentRoot, expected.path))
        return { ok: false, reason: 'conflict' }
      const snapshot = await host.vault.replaceTextIfUnchanged(
        expected,
        content,
      )
      if (root() !== currentRoot) return { ok: false, reason: 'conflict' }
      if (snapshot) return { ok: true, snapshot }
      return { ok: false, reason: 'conflict' }
    },
    trash: (path) =>
      isManifestPath(path)
        ? host.vault.trashPath(
            at(root(), path.slice(0, -'/WORKFLOW.md'.length)),
          )
        : Promise.resolve(false),
    trashStep: (manifestPath, relativePath) =>
      trashStepFile(host, root, manifestPath, relativePath),
    subscribe: (listener) => subscribeToRoot(host, root, listener),
  })
}

async function createStepFile(
  host: Host,
  root: () => string,
  manifestPath: string,
  relativePath: string,
  content: string,
): Promise<RepositoryCreateStepResult> {
  if (!isManifestPath(manifestPath) || !isSafeWorkflowStepPath(relativePath))
    return { ok: false, reason: 'invalid-input' }
  return host.paths.runExclusive('workflows', async () => {
    const operationRoot = root()
    const slug = manifestPath.slice(0, -'/WORKFLOW.md'.length)
    const target = at(at(operationRoot, slug), relativePath)
    if (root() !== operationRoot) return { ok: false, reason: 'stale' }
    const folder = target.slice(0, target.lastIndexOf('/'))
    await host.vault.ensureFolder(folder)
    const snapshot = await host.vault.createTextIfAbsent(target, content)
    if (!snapshot) return { ok: false, reason: 'target-exists' }
    if (root() !== operationRoot) {
      await host.vault.removeFileExact(target).catch(() => false)
      return { ok: false, reason: 'stale' }
    }
    return { ok: true, snapshot }
  })
}

async function trashStepFile(
  host: Host,
  root: () => string,
  manifestPath: string,
  relativePath: string,
): Promise<boolean> {
  if (!isManifestPath(manifestPath) || !isSafeWorkflowStepPath(relativePath))
    return false
  const operationRoot = root()
  const slug = manifestPath.slice(0, -'/WORKFLOW.md'.length)
  const target = at(at(operationRoot, slug), relativePath)
  if (!isOwnedWorkflowPath(operationRoot, target)) return false
  const result = await host.vault.trashPath(target)
  if (root() !== operationRoot) return false
  return result || host.vault.getEntry(target) === null
}

async function writeBundle(
  host: Host,
  root: () => string,
  input: CreateWorkflowInput,
): Promise<CreateWorkflowResult> {
  if (
    !isSlug(input.slug) ||
    !input.stepFiles.every((file) => isSafeWorkflowStepPath(file.relativePath)) ||
    new Set(input.stepFiles.map((file) => file.relativePath)).size !==
      input.stepFiles.length
  )
    return { ok: false, reason: 'invalid-input' }
  return host.paths.runExclusive('workflows', async () => {
    const operationRoot = root()
    const folder = at(operationRoot, input.slug)
    const createdPaths: string[] = []
    const cleanup = async (): Promise<void> => {
      for (const path of createdPaths.reverse())
        await host.vault.removeFileExact(path).catch(() => false)
    }
    const isStable = (): boolean => root() === operationRoot
    if (await host.vault.exists(folder))
      return { ok: false, reason: 'target-exists' }
    try {
      await host.vault.ensureFolder(folder)
      for (const file of input.stepFiles) {
        if (!isStable()) {
          await cleanup()
          return { ok: false, reason: 'stale' }
        }
        const target = at(folder, file.relativePath)
        await host.vault.ensureFolder(target.slice(0, target.lastIndexOf('/')))
        const created = await host.vault.createTextIfAbsent(target, file.content)
        if (!created) {
          await cleanup()
          return { ok: false, reason: 'target-exists' }
        }
        createdPaths.push(target)
      }
      if (!isStable()) {
        await cleanup()
        return { ok: false, reason: 'stale' }
      }
      const snapshot = await host.vault.createTextIfAbsent(
        at(folder, 'WORKFLOW.md'),
        input.manifestContent,
      )
      if (!snapshot) {
        await cleanup()
        return { ok: false, reason: 'target-exists' }
      }
      createdPaths.push(snapshot.path)
      if (!isStable()) {
        await cleanup()
        return { ok: false, reason: 'stale' }
      }
      return { ok: true, snapshot }
    } catch (error) {
      await cleanup()
      throw error
    }
  })
}

function subscribeToRoot(
  host: Host,
  root: () => string,
  listener: (event: WorkflowRepositoryEvent) => void,
): () => void {
  let disposed = false
  let currentRoot = root()
  const pendingDisposers = new Set<() => void>()
  let disposeVault: (() => void) | null = null

  const handlePathChange = (): void => {
    if (disposed) return
    const nextRoot = root()
    if (nextRoot === currentRoot) return

    if (!disposeVault) {
      currentRoot = nextRoot
      listener({ type: 'root-changed' })
      return
    }

    const nextDisposeVault = host.vault.subscribe(nextRoot, (event) =>
      listener({ type: 'vault', event }),
    )

    const previousDisposeVault = disposeVault
    disposeVault = nextDisposeVault
    currentRoot = nextRoot
    trackDisposer(pendingDisposers, previousDisposeVault)
    flushDisposers(pendingDisposers)
    listener({ type: 'root-changed' })
  }

  let disposePaths: (() => void) | null = null
  try {
    disposePaths = host.paths.subscribe(handlePathChange)
    disposeVault = host.vault.subscribe(currentRoot, (event) =>
      listener({ type: 'vault', event }),
    )
  } catch (error) {
    trackDisposer(pendingDisposers, disposePaths)
    trackDisposer(pendingDisposers, disposeVault)
    flushDisposers(pendingDisposers)
    throw error
  }

  return () => {
    if (!disposed) {
      disposed = true
      trackDisposer(pendingDisposers, disposePaths)
      trackDisposer(pendingDisposers, disposeVault)
    }
    flushDisposers(pendingDisposers)
  }
}

function trackDisposer(
  pendingDisposers: Set<() => void>,
  disposer: (() => void) | null,
): void {
  if (disposer) pendingDisposers.add(disposer)
}
function flushDisposers(pendingDisposers: Set<() => void>): void {
  for (const disposer of pendingDisposers) {
    try {
      disposer()
      pendingDisposers.delete(disposer)
    } catch {
      continue
    }
  }
}

function withMissingStep(document: WorkflowDocument): WorkflowDocument {
  const issues: WorkflowDocument['issues'] = Object.freeze([
    ...document.issues,
    'missingStep' as const,
  ])
  return Object.freeze({
    ...document,
    issues,
  })
}
function at(root: string, relative: string): string {
  return root.endsWith('/') ? `${root}${relative}` : `${root}/${relative}`
}
function isSlug(value: string): boolean {
  return (
    value.trim().length > 0 &&
    !value.includes('/') &&
    !value.includes('\\') &&
    value !== '.' &&
    value !== '..' &&
    !value.includes(':')
  )
}
function isManifestPath(value: string): boolean {
  const parts = value.split('/')
  return (
    parts.length === 2 && isSlug(parts[0] ?? '') && parts[1] === 'WORKFLOW.md'
  )
}
function isOwnedWorkflowPath(root: string, path: string): boolean {
  const prefix = root.endsWith('/') ? root : `${root}/`
  if (!path.startsWith(prefix)) return false
  const relative = path.slice(prefix.length)
  const parts = relative.split('/')
  const slug = parts.shift()
  const filePath = parts.join('/')
  return (
    isSlug(slug ?? '') &&
    (filePath === 'WORKFLOW.md' || isSafeWorkflowStepPath(filePath))
  )
}
