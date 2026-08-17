import { type WorkflowCopy, en } from '../i18n'
import {
  type WorkflowDocument,
  parseWorkflowDocument,
  updateWorkflowManagedBlocks,
} from '../domain/workflow-document'
import {
  type CreateWorkflowInput,
  type CreateWorkflowResult,
  type WorkflowBundle,
  type WorkflowRepository,
  type WorkflowRepositoryEvent,
  type WorkflowTextFile,
} from '../domain/workflow-repository'
import {
  type WorkflowIssue,
  type WorkflowTopology,
  layoutWorkflowNodes,
  validateWorkflowTopology,
} from '../domain/workflow-model'

const HISTORY_LIMIT = 50

export type WorkflowEditorStatus =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'conflict'

export type WorkflowEditorSnapshot = Readonly<{
  status: WorkflowEditorStatus
  workflows: readonly Readonly<{ path: string; title: string }>[]
  path: string | null
  bundle: WorkflowBundle | null
  topology: WorkflowTopology | null
  selectedNodeId: string | null
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
  issues: readonly WorkflowIssue[]
  error?: string
}>

export type WorkflowEditorLoadResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; reason: 'dirty' | 'not-found' | 'stale' }>

export type WorkflowEditorApplyResult =
  | Readonly<{ ok: true }>
  | Readonly<{
      ok: false
      reason: 'conflict' | 'invalid' | 'stale' | 'empty'
    }>

export type WorkflowEditorModel = Readonly<{
  getSnapshot(): WorkflowEditorSnapshot
  subscribe(listener: () => void): () => void
  load(
    path?: string | null,
    options?: Readonly<{ discardDirty?: boolean }>,
  ): Promise<WorkflowEditorLoadResult>
  selectNode(nodeId: string | null): void
  updateTopology(topology: WorkflowTopology): boolean
  apply(): Promise<WorkflowEditorApplyResult>
  undo(): boolean
  redo(): boolean
  autoLayout(): boolean
  create(input: CreateWorkflowInput): Promise<CreateWorkflowResult>
  trashCurrent(): Promise<boolean>
  dispose(): void
}>

export type WorkflowEditorCopy = WorkflowCopy | (() => WorkflowCopy)

type MutableHistory = {
  past: WorkflowTopology[]
  future: WorkflowTopology[]
}

export function createWorkflowEditorModel(
  repository: WorkflowRepository,
  copy: WorkflowEditorCopy = en,
): WorkflowEditorModel {
  const listeners = new Set<() => void>()
  const history: MutableHistory = { past: [], future: [] }
  let snapshot = initialSnapshot()
  let currentManifest: WorkflowTextFile | null = null
  let loadRevision = 0
  let changeVersion = 0
  let savedTopology: WorkflowTopology | null = null
  let saving = false
  let disposed = false
  const getCopy = typeof copy === 'function' ? copy : () => copy

  const resetHistory = (): void => {
    history.past = []
    history.future = []
  }

  const publish = (changes: Partial<WorkflowEditorSnapshot>): void => {
    snapshot = Object.freeze({
      ...snapshot,
      ...changes,
      workflows: Object.freeze([
        ...((changes.workflows ?? snapshot.workflows) as readonly {
          path: string
          title: string
        }[]),
      ]),
      issues: Object.freeze([...(changes.issues ?? snapshot.issues)]),
    })
    for (const listener of listeners) listener()
  }

  const refreshWorkflows = (): void => {
    publish({ workflows: repository.list() })
  }

  const dirtyFor = (topology: WorkflowTopology | null): boolean =>
    topology !== null &&
    (savedTopology === null || !sameTopology(savedTopology, topology))

  const setTopology = (
    topology: WorkflowTopology,
    changes: Readonly<{
      dirty?: boolean
      status?: WorkflowEditorStatus
      selectedNodeId?: string | null
    }>,
  ): void => {
    const next = cloneTopology(topology)
    if (!next) return
    const selectedNodeId =
      changes.selectedNodeId === undefined
        ? snapshot.selectedNodeId
        : changes.selectedNodeId
    publish({
      topology: next,
      dirty: changes.dirty ?? dirtyFor(next),
      status:
        changes.status ??
        (snapshot.status === 'conflict' ? 'conflict' : 'ready'),
      selectedNodeId:
        selectedNodeId && next.nodes.some((node) => node.id === selectedNodeId)
          ? selectedNodeId
          : null,
      canUndo: history.past.length > 0,
      canRedo: history.future.length > 0,
      issues: collectIssues(snapshot.bundle?.document ?? null, next),
      error: undefined,
    })
  }

  const load = async (
    requestedPath?: string | null,
    options: Readonly<{ discardDirty?: boolean }> = {},
  ): Promise<WorkflowEditorLoadResult> => {
    if (disposed) return { ok: false, reason: 'stale' }
    if (snapshot.dirty && !options.discardDirty)
      return { ok: false, reason: 'dirty' }

    const revision = ++loadRevision
    changeVersion += 1
    let workflows: readonly { path: string; title: string }[]
    try {
      workflows = repository.list()
    } catch (error) {
      currentManifest = null
      savedTopology = null
      resetHistory()
      publish({
        status: 'error',
        workflows: [],
        path: null,
        bundle: null,
        topology: null,
        selectedNodeId: null,
        dirty: false,
        canUndo: false,
        canRedo: false,
        issues: [],
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    const target =
      requestedPath !== undefined
        ? requestedPath
        : snapshot.path &&
            workflows.some((workflow) => workflow.path === snapshot.path)
          ? snapshot.path
          : (workflows[0]?.path ?? null)
    currentManifest = null
    savedTopology = null
    resetHistory()
    publish({
      workflows,
      status: target ? 'loading' : 'empty',
      path: target,
      bundle: null,
      topology: null,
      selectedNodeId: null,
      dirty: false,
      canUndo: false,
      canRedo: false,
      issues: [],
      error: undefined,
    })
    if (!target) {
      return { ok: true }
    }

    let bundle: WorkflowBundle | null
    try {
      bundle = await repository.read(target)
    } catch (error) {
      if (disposed || revision !== loadRevision)
        return { ok: false, reason: 'stale' }
      publish({
        status: 'error',
        bundle: null,
        topology: null,
        selectedNodeId: null,
        dirty: false,
        canUndo: false,
        canRedo: false,
        issues: [],
        error: error instanceof Error ? error.message : String(error),
      })
      throw error
    }
    if (disposed || revision !== loadRevision)
      return { ok: false, reason: 'stale' }
    if (!bundle) {
      publish({
        status: 'error',
        path: target,
        bundle: null,
        topology: null,
        selectedNodeId: null,
        dirty: false,
        canUndo: false,
        canRedo: false,
        issues: [],
        error: 'workflow-not-found',
      })
      return { ok: false, reason: 'not-found' }
    }

    const topology = topologyFor(bundle.document)
    currentManifest =
      bundle.files.find((file) => file.nodeId === 'workflow') ?? null
    savedTopology = topology
    resetHistory()
    publish({
      status: 'ready',
      path: target,
      bundle,
      topology,
      selectedNodeId: topology?.nodes[0]?.id ?? null,
      dirty: false,
      canUndo: false,
      canRedo: false,
      issues: collectIssues(bundle.document, topology),
      error: undefined,
    })
    return { ok: true }
  }

  const updateTopology = (topology: WorkflowTopology): boolean => {
    if (disposed) return false
    const next = cloneTopology(topology)
    if (!next || !snapshot.topology || sameTopology(snapshot.topology, next))
      return false
    history.past = [...history.past, snapshot.topology].slice(-HISTORY_LIMIT)
    history.future = []
    changeVersion += 1
    setTopology(next, {})
    return true
  }

  const undo = (): boolean => {
    if (disposed) return false
    const previous = history.past.at(-1)
    if (!previous || !snapshot.topology) return false
    history.past = history.past.slice(0, -1)
    history.future = [snapshot.topology, ...history.future].slice(
      0,
      HISTORY_LIMIT,
    )
    changeVersion += 1
    setTopology(previous, {})
    return true
  }

  const redo = (): boolean => {
    if (disposed) return false
    const next = history.future[0]
    if (!next || !snapshot.topology) return false
    history.future = history.future.slice(1)
    history.past = [...history.past, snapshot.topology].slice(-HISTORY_LIMIT)
    changeVersion += 1
    setTopology(next, {})
    return true
  }

  const apply = async (): Promise<WorkflowEditorApplyResult> => {
    if (disposed) return { ok: false, reason: 'stale' }
    if (!snapshot.bundle || !snapshot.topology || !currentManifest)
      return { ok: false, reason: 'empty' }
    if (!snapshot.dirty) return { ok: true }
    if (saving) return { ok: false, reason: 'stale' }
    const basePath = snapshot.path
    const baseTopology = snapshot.topology
    if (validateWorkflowTopology(baseTopology).length > 0)
      return { ok: false, reason: 'invalid' }
    const expected = currentManifest.snapshot
    const content = updateWorkflowManagedBlocks(
      snapshot.bundle.document.content,
      baseTopology,
      getCopy(),
    )
    saving = true
    const revision = loadRevision
    const version = changeVersion
    let result: Awaited<ReturnType<WorkflowRepository['replaceFile']>>
    try {
      result = await repository.replaceFile(expected, content)
    } catch (error) {
      if (!disposed && revision === loadRevision && snapshot.path === basePath)
        publish({
          status: 'error',
          dirty: dirtyFor(snapshot.topology),
          error: error instanceof Error ? error.message : String(error),
        })
      throw error
    } finally {
      saving = false
    }
    if (disposed || revision !== loadRevision || snapshot.path !== basePath)
      return { ok: false, reason: 'stale' }
    if (!result || !result.ok) {
      publish({ status: 'conflict', dirty: dirtyFor(snapshot.topology) })
      return { ok: false, reason: 'conflict' }
    }

    currentManifest = {
      ...currentManifest,
      snapshot: result.snapshot,
    }
    const document = parseWorkflowDocument(content, getCopy())
    const bundle: WorkflowBundle = Object.freeze({
      ...snapshot.bundle,
      document,
      files: Object.freeze(
        snapshot.bundle.files.map((file) =>
          file.nodeId === 'workflow'
            ? { ...file, snapshot: result.snapshot }
            : file,
        ),
      ),
    })
    savedTopology = baseTopology
    const changedDuringSave =
      version !== changeVersion &&
      (!snapshot.topology || !sameTopology(snapshot.topology, baseTopology))
    if (changedDuringSave) {
      publish({
        status: 'ready',
        bundle,
        dirty: true,
        issues: collectIssues(document, snapshot.topology),
        error: undefined,
      })
    } else {
      resetHistory()
      publish({
        status: 'ready',
        bundle,
        dirty: false,
        canUndo: false,
        canRedo: false,
        issues: collectIssues(document, baseTopology),
        error: undefined,
      })
    }
    return { ok: true }
  }

  const create = async (
    input: CreateWorkflowInput,
  ): Promise<CreateWorkflowResult> => {
    const result = await repository.create(input)
    if (result.ok)
      await load(`${input.slug}/WORKFLOW.md`, { discardDirty: true })
    refreshWorkflows()
    return result
  }

  const trashCurrent = async (): Promise<boolean> => {
    const path = snapshot.path
    if (!path) return false
    const deleted = await repository.trash(path)
    if (deleted) await load(undefined, { discardDirty: true })
    return deleted
  }

  const selectNode = (nodeId: string | null): void => {
    if (disposed) return
    if (
      nodeId !== null &&
      !snapshot.topology?.nodes.some((node) => node.id === nodeId)
    )
      return
    publish({ selectedNodeId: nodeId })
  }

  const autoLayout = (): boolean => {
    if (disposed) return false
    if (!snapshot.topology) return false
    return updateTopology(layoutWorkflowNodes(snapshot.topology))
  }

  const isRelevantEvent = (event: WorkflowRepositoryEvent): boolean => {
    if (event.type === 'root-changed') return true
    if (!snapshot.bundle) return false
    const manifest = snapshot.bundle.files.find(
      (file) => file.nodeId === 'workflow',
    )
    if (!manifest) return false
    const folder = manifest.snapshot.path.slice(0, -'/WORKFLOW.md'.length)
    const paths =
      event.event.type === 'rename'
        ? [event.event.entry.path, event.event.oldPath]
        : [event.event.entry.path]
    return paths.some(
      (path) =>
        path === folder ||
        path === manifest.snapshot.path ||
        path.startsWith(`${folder}/`),
    )
  }

  const onRepositoryEvent = (event: WorkflowRepositoryEvent): void => {
    if (saving) {
      refreshWorkflows()
      return
    }
    if (snapshot.dirty) {
      refreshWorkflows()
      if (isRelevantEvent(event)) publish({ status: 'conflict' })
      return
    }
    if (!isRelevantEvent(event)) {
      refreshWorkflows()
      return
    }
    void load(undefined, { discardDirty: true }).catch(() => undefined)
  }

  const unsubscribeRepository = repository.subscribe(onRepositoryEvent)

  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    load,
    selectNode,
    updateTopology,
    apply,
    undo,
    redo,
    autoLayout,
    create,
    trashCurrent,
    dispose: () => {
      if (disposed) return
      disposed = true
      unsubscribeRepository()
      listeners.clear()
    },
  })
}

function initialSnapshot(): WorkflowEditorSnapshot {
  return Object.freeze({
    status: 'loading',
    workflows: Object.freeze([]),
    path: null,
    bundle: null,
    topology: null,
    selectedNodeId: null,
    dirty: false,
    canUndo: false,
    canRedo: false,
    issues: Object.freeze([]),
  })
}

function topologyFor(document: WorkflowDocument): WorkflowTopology | null {
  if (document.topology) return cloneTopology(document.topology)
  if (document.steps.length === 0) return null
  const nodes = document.steps.map((step, index) => ({
    id: step.nodeId,
    kind:
      index === 0
        ? ('input' as const)
        : index === document.steps.length - 1
          ? ('output' as const)
          : ('agent' as const),
    label: step.label,
    stepPath: step.stepPath,
    position: { x: 70 + index * 245, y: 90 },
  }))
  return freezeTopology({
    revision: 1,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `${nodes[index]?.id ?? 'node'}-${node.id}`,
      source: nodes[index]?.id ?? '',
      target: node.id,
    })),
  })
}

function collectIssues(
  document: WorkflowDocument | null,
  topology: WorkflowTopology | null,
): readonly WorkflowIssue[] {
  const issues: WorkflowIssue[] = document
    ? document.issues.map((code) => ({ code }))
    : []
  if (topology) issues.push(...validateWorkflowTopology(topology))
  return Object.freeze(issues.map((issue) => Object.freeze({ ...issue })))
}

function cloneTopology(value: WorkflowTopology): WorkflowTopology | null {
  if (!isRecord(value) || value.revision !== 1) return null
  if (!Array.isArray(value.nodes) || !Array.isArray(value.edges)) return null
  if (!isJsonSerializable(value)) return null
  const nodes = value.nodes.map(cloneNode)
  const edges = value.edges.map(cloneEdge)
  if (
    nodes.some((node) => node === null) ||
    edges.some((edge) => edge === null)
  )
    return null
  const next = freezeTopology({
    revision: 1,
    nodes: nodes as WorkflowTopology['nodes'],
    edges: edges as WorkflowTopology['edges'],
  })
  return validateWorkflowTopology(next).some(
    (issue) => issue.code === 'invalidTopology',
  )
    ? null
    : next
}

function cloneNode(value: unknown): WorkflowTopology['nodes'][number] | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' ||
    typeof value.kind !== 'string' ||
    typeof value.label !== 'string' ||
    typeof value.stepPath !== 'string' ||
    !isRecord(value.position) ||
    !isFiniteNumber(value.position.x) ||
    !isFiniteNumber(value.position.y)
  )
    return null
  if (
    value.inputPredicates !== undefined &&
    !isStringRecord(value.inputPredicates)
  )
    return null
  return {
    ...(value as WorkflowTopology['nodes'][number]),
    position: { x: value.position.x, y: value.position.y },
    ...(isStringRecord(value.inputPredicates)
      ? { inputPredicates: { ...value.inputPredicates } }
      : {}),
  }
}

function cloneEdge(value: unknown): WorkflowTopology['edges'][number] | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' ||
    typeof value.source !== 'string' ||
    typeof value.target !== 'string' ||
    (value.branch !== undefined && typeof value.branch !== 'string') ||
    (value.label !== undefined && typeof value.label !== 'string')
  )
    return null
  return { ...(value as WorkflowTopology['edges'][number]) }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringRecord(
  value: unknown,
): value is Readonly<Record<string, string>> {
  return (
    isRecord(value) &&
    Object.values(value).every((entry) => typeof entry === 'string')
  )
}

function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value)
    return true
  } catch {
    return false
  }
}

function freezeTopology(value: WorkflowTopology): WorkflowTopology {
  return deepFreeze(value)
}

function sameTopology(
  left: WorkflowTopology,
  right: WorkflowTopology,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child, seen)
  }
  return value
}
