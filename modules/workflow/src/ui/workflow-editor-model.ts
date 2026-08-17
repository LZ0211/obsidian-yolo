import { en, type WorkflowCopy } from '../i18n'
import {
  parseWorkflowDocument,
  updateWorkflowManagedBlocks,
} from '../domain/workflow-document'
import {
  layoutWorkflowNodes,
  type WorkflowIssue,
  type WorkflowTopology,
  validateWorkflowTopology,
} from '../domain/workflow-model'
import type {
  WorkflowBundle,
  WorkflowListEntry,
  WorkflowRepository,
  WorkflowRepositoryEvent,
} from '../domain/workflow-repository'

export type WorkflowEditorStatus =
  | 'loading'
  | 'ready'
  | 'empty'
  | 'error'
  | 'conflict'

export type WorkflowEditorSnapshot = Readonly<{
  status: WorkflowEditorStatus
  workflows: readonly WorkflowListEntry[]
  bundle: WorkflowBundle | null
  path: string | null
  topology: WorkflowTopology | null
  selectedNodeId: string | null
  dirty: boolean
  history: Readonly<{ canUndo: boolean; canRedo: boolean }>
  issues: readonly WorkflowIssue[]
  error: unknown | null
}>

export type WorkflowEditorModel = Readonly<{
  getSnapshot(): WorkflowEditorSnapshot
  subscribe(listener: () => void): () => void
  load(path: string): Promise<void>
  selectNode(nodeId: string | null): void
  updateTopology(topology: WorkflowTopology): boolean
  apply(): Promise<boolean>
  undo(): boolean
  redo(): boolean
  autoLayout(): boolean
  markDirty(dirty?: boolean): void
  dispose(): void
}>

const HISTORY_LIMIT = 50

export function createWorkflowEditorModel(
  repository: WorkflowRepository,
  copy: WorkflowCopy = en,
): WorkflowEditorModel {
  let disposed = false
  let applying = false
  let loadToken = 0
  let changeVersion = 0
  let savedTopology: WorkflowTopology | null = null
  let additionalDirty = false
  let past: WorkflowTopology[] = []
  let future: WorkflowTopology[] = []
  let workflows: readonly WorkflowListEntry[] = []
  let snapshot: WorkflowEditorSnapshot
  const listeners = new Set<() => void>()

  try {
    workflows = freezeWorkflows(repository.list())
    snapshot = createSnapshot({
      status: 'loading',
      workflows,
      bundle: null,
      path: null,
      topology: null,
      selectedNodeId: null,
      dirty: false,
      history: emptyHistory(),
      issues: [],
      error: null,
    })
  } catch (error) {
    snapshot = createSnapshot({
      status: 'error',
      workflows: [],
      bundle: null,
      path: null,
      topology: null,
      selectedNodeId: null,
      dirty: false,
      history: emptyHistory(),
      issues: [],
      error,
    })
  }

  const disposeRepository = repository.subscribe(handleRepositoryEvent)

  function getSnapshot(): WorkflowEditorSnapshot {
    return snapshot
  }

  function subscribe(listener: () => void): () => void {
    if (disposed) return () => undefined
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  async function load(path: string): Promise<void> {
    if (disposed) return
    if (snapshot.dirty) {
      if (snapshot.path === path) publish({ status: 'conflict', error: null })
      return
    }
    const token = ++loadToken
    changeVersion += 1
    past = []
    future = []
    savedTopology = null
    additionalDirty = false
    try {
      publish({
        status: 'loading',
        workflows: readWorkflows(),
        bundle: null,
        path,
        topology: null,
        selectedNodeId: null,
        dirty: false,
        history: emptyHistory(),
        issues: [],
        error: null,
      })
      const bundle = await repository.read(path)
      if (disposed || token !== loadToken) return
      if (!bundle) {
        publish({ status: 'empty', bundle: null, topology: null, issues: [] })
        return
      }
      const normalizedBundle = freezeBundle(bundle)
      const topology = topologyForBundle(normalizedBundle)
      savedTopology = topology
      publish({
        status: 'ready',
        workflows,
        bundle: normalizedBundle,
        topology,
        selectedNodeId: null,
        dirty: false,
        history: emptyHistory(),
        issues: issuesFor(normalizedBundle, topology),
        error: null,
      })
    } catch (error) {
      if (disposed || token !== loadToken) return
      publish({
        status: 'error',
        bundle: null,
        topology: null,
        selectedNodeId: null,
        dirty: false,
        history: emptyHistory(),
        issues: [],
        error,
      })
    }
  }

  function selectNode(nodeId: string | null): void {
    if (disposed || !snapshot.topology) return
    const nextNodeId =
      nodeId && snapshot.topology.nodes.some((node) => node.id === nodeId)
        ? nodeId
        : null
    if (nextNodeId === snapshot.selectedNodeId) return
    publish({ selectedNodeId: nextNodeId })
  }

  function updateTopology(nextTopology: WorkflowTopology): boolean {
    if (disposed || !snapshot.topology || !isDisplayable(nextTopology))
      return false
    const topology = freezeTopology(nextTopology)
    if (sameTopology(snapshot.topology, topology)) return false
    past = appendHistory(past, snapshot.topology)
    future = []
    changeVersion += 1
    publishTopology(topology)
    return true
  }

  async function apply(): Promise<boolean> {
    if (
      disposed ||
      !snapshot.dirty ||
      !snapshot.path ||
      !snapshot.bundle ||
      !snapshot.topology
    )
      return !snapshot.dirty

    const path = snapshot.path
    const bundle = snapshot.bundle
    const topology = snapshot.topology
    const version = changeVersion
    const manifest = bundle.files.find(
      (file) =>
        file.nodeId === 'workflow' || file.relativePath === bundle.path,
    )
    if (!manifest) {
      publish({ status: 'error', error: new Error('Workflow manifest is missing') })
      return false
    }
    const content = updateWorkflowManagedBlocks(
      bundle.document.content,
      topology,
      copy,
    )
    applying = true
    try {
      const result = await repository.replaceFile(manifest.snapshot, content)
      if (!result.ok) {
        publish({ status: 'conflict', error: null })
        return false
      }
      const refreshed = await repository.read(path)
      if (!refreshed) {
        publish({ status: 'error', error: new Error('Workflow disappeared') })
        return false
      }
      if (disposed) return false
      const normalizedBundle = freezeBundle(refreshed)
      const refreshedTopology = topologyForBundle(normalizedBundle)
      savedTopology = refreshedTopology
      if (version !== changeVersion) {
        publish({
          status: 'ready',
          bundle: normalizedBundle,
          dirty: dirtyFor(snapshot.topology),
          issues: issuesFor(normalizedBundle, snapshot.topology),
          error: null,
        })
        return true
      }
      past = []
      future = []
      additionalDirty = false
      publish({
        status: 'ready',
        bundle: normalizedBundle,
        topology: refreshedTopology,
        dirty: false,
        history: emptyHistory(),
        issues: issuesFor(normalizedBundle, refreshedTopology),
        error: null,
      })
      return true
    } catch (error) {
      publish({ status: 'error', error })
      return false
    } finally {
      applying = false
    }
  }

  function undo(): boolean {
    if (disposed || !snapshot.topology || past.length === 0) return false
    const previous = past[past.length - 1]
    past = past.slice(0, -1)
    future = appendHistory(future, snapshot.topology)
    changeVersion += 1
    publishTopology(previous)
    return true
  }

  function redo(): boolean {
    if (disposed || !snapshot.topology || future.length === 0) return false
    const next = future[future.length - 1]
    future = future.slice(0, -1)
    past = appendHistory(past, snapshot.topology)
    changeVersion += 1
    publishTopology(next)
    return true
  }

  function autoLayout(): boolean {
    if (disposed || !snapshot.topology) return false
    return updateTopology(layoutWorkflowNodes(snapshot.topology))
  }

  function markDirty(dirty = true): void {
    if (disposed) return
    additionalDirty = dirty
    changeVersion += 1
    publish({ dirty: dirtyFor(snapshot.topology) })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    loadToken += 1
    changeVersion += 1
    disposeRepository()
    listeners.clear()
  }

  function publishTopology(topology: WorkflowTopology): void {
    const selectedNodeId = snapshot.selectedNodeId
      ? topology.nodes.some((node) => node.id === snapshot.selectedNodeId)
        ? snapshot.selectedNodeId
        : null
      : null
    publish({
      status: snapshot.status === 'conflict' ? 'conflict' : 'ready',
      topology,
      selectedNodeId,
      dirty: dirtyFor(topology),
      history: historySnapshot(past, future),
      issues: snapshot.bundle ? issuesFor(snapshot.bundle, topology) : [],
      error: null,
    })
  }

  function handleRepositoryEvent(event: WorkflowRepositoryEvent): void {
    if (disposed || applying) return
    if (event.type === 'root-changed') {
      handleCurrentExternalChange()
      return
    }
    if (affectsCurrentWorkflow(event)) handleCurrentExternalChange()
    else refreshWorkflows()
  }

  function handleCurrentExternalChange(): void {
    if (snapshot.dirty) {
      publish({ status: 'conflict', error: null })
      return
    }
    if (snapshot.path) void load(snapshot.path)
    else refreshWorkflows()
  }

  function affectsCurrentWorkflow(event: Extract<WorkflowRepositoryEvent, { type: 'vault' }>): boolean {
    if (!snapshot.bundle) return false
    const manifest = snapshot.bundle.files.find(
      (file) => file.nodeId === 'workflow' || file.relativePath === snapshot.path,
    )
    if (!manifest) return false
    const folder = manifest.snapshot.path.slice(0, -'/WORKFLOW.md'.length)
    const paths =
      event.event.type === 'rename'
        ? [event.event.entry.path, event.event.oldPath]
        : [event.event.entry.path]
    return paths.some((path) => path === manifest.snapshot.path || path.startsWith(`${folder}/`))
  }

  function refreshWorkflows(): void {
    try {
      workflows = readWorkflows()
      publish({ workflows })
    } catch (error) {
      publish({ status: 'error', error })
    }
  }

  function readWorkflows(): readonly WorkflowListEntry[] {
    workflows = freezeWorkflows(repository.list())
    return workflows
  }

  function publish(changes: Partial<WorkflowEditorSnapshot>): void {
    snapshot = createSnapshot({ ...snapshot, ...changes })
    for (const listener of [...listeners]) listener()
  }

  function dirtyFor(topology: WorkflowTopology | null): boolean {
    return (
      additionalDirty ||
      (topology !== null &&
        savedTopology !== null &&
        !sameTopology(topology, savedTopology))
    )
  }

  return Object.freeze({
    getSnapshot,
    subscribe,
    load,
    selectNode,
    updateTopology,
    apply,
    undo,
    redo,
    autoLayout,
    markDirty,
    dispose,
  })
}

function createSnapshot(
  snapshot: Omit<WorkflowEditorSnapshot, never>,
): WorkflowEditorSnapshot {
  return Object.freeze({
    ...snapshot,
    workflows: freezeWorkflows(snapshot.workflows),
    history: Object.freeze({ ...snapshot.history }),
    issues: freezeIssues(snapshot.issues),
  })
}

function emptyHistory(): Readonly<{ canUndo: false; canRedo: false }> {
  return { canUndo: false, canRedo: false }
}

function historySnapshot(
  past: readonly WorkflowTopology[],
  future: readonly WorkflowTopology[],
): Readonly<{ canUndo: boolean; canRedo: boolean }> {
  return Object.freeze({ canUndo: past.length > 0, canRedo: future.length > 0 })
}

function appendHistory(
  history: WorkflowTopology[],
  topology: WorkflowTopology,
): WorkflowTopology[] {
  const next = [...history, topology]
  return next.length > HISTORY_LIMIT ? next.slice(-HISTORY_LIMIT) : next
}

function isDisplayable(topology: WorkflowTopology): boolean {
  try {
    return !validateWorkflowTopology(topology).some(
      (issue) => issue.code === 'invalidTopology',
    )
  } catch {
    return false
  }
}

function topologyForBundle(bundle: WorkflowBundle): WorkflowTopology {
  if (bundle.document.topology) return freezeTopology(bundle.document.topology)
  return layoutWorkflowNodes(fallbackTopology(bundle.document))
}

function fallbackTopology(
  document: ReturnType<typeof parseWorkflowDocument>,
): WorkflowTopology {
  const lastIndex = document.steps.length - 1
  const nodes = document.steps.map((step, index) => ({
    id: step.nodeId,
    kind:
      document.steps.length > 1 && index === 0
        ? ('input' as const)
        : document.steps.length > 1 && index === lastIndex
          ? ('output' as const)
          : ('agent' as const),
    label: step.label,
    stepPath: step.stepPath,
    position: { x: 0, y: 0 },
  }))
  return {
    revision: 1,
    nodes,
    edges: nodes.slice(1).map((node, index) => ({
      id: `edge-${index}-${nodes[index]?.id ?? 'source'}-${node.id}`,
      source: nodes[index]?.id ?? '',
      target: node.id,
    })),
  }
}

function issuesFor(
  bundle: WorkflowBundle,
  topology: WorkflowTopology,
): readonly WorkflowIssue[] {
  const issues = [
    ...bundle.document.issues.map((code): WorkflowIssue => ({ code })),
    ...validateWorkflowTopology(topology),
  ]
  const seen = new Set<string>()
  return freezeIssues(
    issues.filter((issue) => {
      const key = `${issue.code}:${issue.nodeId ?? ''}:${issue.edgeId ?? ''}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  )
}

function sameTopology(
  left: WorkflowTopology | null,
  right: WorkflowTopology | null,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function freezeWorkflows(
  entries: readonly WorkflowListEntry[],
): readonly WorkflowListEntry[] {
  return Object.freeze(
    entries.map((entry) => Object.freeze({ path: entry.path, title: entry.title })),
  )
}

function freezeIssues(issues: readonly WorkflowIssue[]): readonly WorkflowIssue[] {
  return Object.freeze(issues.map((issue) => Object.freeze({ ...issue })))
}

function freezeBundle(bundle: WorkflowBundle): WorkflowBundle {
  return Object.freeze({
    ...bundle,
    document: Object.freeze({
      ...bundle.document,
      steps: Object.freeze(
        bundle.document.steps.map((step) => Object.freeze({ ...step })),
      ),
      topology: bundle.document.topology
        ? freezeTopology(bundle.document.topology)
        : null,
      issues: Object.freeze([...bundle.document.issues]),
    }),
    files: Object.freeze(
      bundle.files.map((file) =>
        Object.freeze({
          ...file,
          snapshot: Object.freeze({ ...file.snapshot }),
        }),
      ),
    ),
  })
}

function freezeTopology(topology: WorkflowTopology): WorkflowTopology {
  return deepFreeze({
    revision: 1,
    nodes: topology.nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      ...(node.inputPredicates === undefined
        ? {}
        : { inputPredicates: { ...node.inputPredicates } }),
      ...(Object.prototype.hasOwnProperty.call(node, 'outputSchema')
        ? { outputSchema: cloneValue(node.outputSchema) }
        : {}),
    })),
    edges: topology.edges.map((edge) => ({ ...edge })),
  })
}

function cloneValue(
  value: unknown,
  seen = new WeakMap<object, unknown>(),
): unknown {
  if (!value || typeof value !== 'object') return value
  const existing = seen.get(value)
  if (existing) return existing
  if (Array.isArray(value)) {
    const clone: unknown[] = []
    seen.set(value, clone)
    for (const entry of value) clone.push(cloneValue(entry, seen))
    return clone
  }
  const clone: Record<string, unknown> = {}
  seen.set(value, clone)
  for (const [key, entry] of Object.entries(value))
    clone[key] = cloneValue(entry, seen)
  return clone
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
