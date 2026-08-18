import {
  AlertTriangle,
  Bot,
  CircleDot,
  CircleStop,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FileInput,
  FileCode2,
  GitBranch,
  GitFork,
  Layers3,
  LayoutDashboard,
  Merge,
  Maximize2,
  PanelLeft,
  PanelRight,
  Plus,
  Redo2,
  Save,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  WandSparkles,
  X,
} from 'lucide-react'
import {
  type ChangeEvent,
  type FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import {
  type WorkflowBranch,
  type WorkflowConnectionCandidate,
  type WorkflowEdge,
  type WorkflowGateType,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowTopology,
  connectionProblem,
  layoutWorkflowNodes,
} from '../domain/workflow-model'
import {
  exportDshFlowJson,
  parseDshFlowJson,
  updateWorkflowManagedBlocks,
} from '../domain/workflow-document'
import type { WorkflowCopy } from '../i18n'
import type { WorkflowBundle } from '../domain/workflow-repository'
import type {
  WorkflowEditorModel,
  WorkflowEditorSnapshot,
} from './workflow-editor-model'
import { WorkflowGraph, type WorkflowGraphController } from './workflow-graph'

export type WorkflowStudioProps = Readonly<{
  model: WorkflowEditorModel
  copy: WorkflowCopy
  openFile(path: string): void | Promise<void>
  notice(message: string): void
}>

type PendingConnection = Readonly<{
  candidate: WorkflowConnectionCandidate
  available: readonly WorkflowBranch[]
}>

type PanelState = Readonly<{
  rail: boolean
  inspector: boolean
}>

type AssistantAction = 'validation' | 'document' | 'workflow'

type AssistantProposal = Readonly<{
  action: Exclude<AssistantAction, 'validation'>
  baseContent: string
  content: string
}>

const NODE_KINDS: readonly WorkflowNodeKind[] = [
  'input',
  'agent',
  'mapAgent',
  'condition',
  'merge',
  'output',
]
const GATE_TYPES: readonly WorkflowGateType[] = [
  'ifElse',
  'and',
  'or',
  'not',
  'nand',
  'nor',
  'xor',
  'xnor',
]

export function WorkflowStudio({
  model,
  copy,
  openFile,
  notice,
}: WorkflowStudioProps) {
  const snapshot = useSyncExternalStore(
    model.subscribe,
    model.getSnapshot,
    model.getSnapshot,
  )
  const rootRef = useRef<HTMLDivElement | null>(null)
  const importRef = useRef<HTMLInputElement | null>(null)
  const [controller, setController] = useState<WorkflowGraphController | null>(
    null,
  )
  const [panels, setPanels] = useState<PanelState>({
    rail: true,
    inspector: true,
  })
  const [compactLayout, setCompactLayout] = useState(false)
  const [pendingConnection, setPendingConnection] =
    useState<PendingConnection | null>(null)
  const [connectionMessage, setConnectionMessage] = useState<string | null>(
    null,
  )
  const [newWorkflowOpen, setNewWorkflowOpen] = useState(false)
  const [newWorkflowSlug, setNewWorkflowSlug] = useState('')
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [markdownTarget, setMarkdownTarget] = useState('workflow')
  const [assistantAction, setAssistantAction] =
    useState<AssistantAction>('validation')
  const [assistantProposal, setAssistantProposal] =
    useState<AssistantProposal | null>(null)

  useEffect(() => {
    void model.load().catch((error: unknown) => {
      notice(error instanceof Error ? error.message : String(error))
    })
  }, [model, notice])

  useEffect(() => {
    const view = rootRef.current?.ownerDocument.defaultView
    if (!view || typeof view.matchMedia !== 'function') return
    const media = view.matchMedia('(max-width: 760px)')
    const updateLayout = (): void => setCompactLayout(media.matches)
    updateLayout()
    media.addEventListener('change', updateLayout)
    return () => media.removeEventListener('change', updateLayout)
  }, [])

  useEffect(() => {
    if (compactLayout)
      setPanels((value) => ({ ...value, rail: false, inspector: false }))
  }, [compactLayout])

  useEffect(() => {
    if (snapshot.status !== 'loading') return
    setPendingConnection(null)
    setConnectionMessage(null)
    setSelectedEdgeId(null)
    setMarkdownTarget('workflow')
    setAssistantAction('validation')
    setAssistantProposal(null)
  }, [snapshot.path, snapshot.status])

  const selectedNode = useMemo(
    () =>
      snapshot.topology?.nodes.find(
        (node) => node.id === snapshot.selectedNodeId,
      ) ?? null,
    [snapshot.selectedNodeId, snapshot.topology],
  )
  const selectedEdge = useMemo(
    () =>
      snapshot.topology?.edges.find((edge) => edge.id === selectedEdgeId) ??
      null,
    [selectedEdgeId, snapshot.topology],
  )

  const showNotice = useCallback(
    (message: string) => {
      setConnectionMessage(message)
      notice(message)
    },
    [notice],
  )

  const selectNode = useCallback(
    (nodeId: string | null) => {
      setSelectedEdgeId(null)
      model.selectNode(nodeId)
    },
    [model],
  )

  const selectEdge = useCallback(
    (edgeId: string | null) => {
      setSelectedEdgeId(edgeId)
      if (edgeId) model.selectNode(null)
    },
    [model],
  )

  const loadWorkflow = useCallback(
    (path: string) => {
      void model
        .load(path)
        .then((result) => {
          if (!result.ok && result.reason === 'dirty')
            showNotice(copy.state.conflict)
        })
        .catch((error: unknown) =>
          showNotice(error instanceof Error ? error.message : String(error)),
        )
    },
    [copy.state.conflict, model, showNotice],
  )

  const updateTopology = useCallback(
    (next: WorkflowTopology) => {
      setPendingConnection(null)
      setConnectionMessage(null)
      model.updateTopology(next)
    },
    [model],
  )

  const updateNode = useCallback(
    (nodeId: string, patch: Partial<WorkflowNode>) => {
      const topology = snapshot.topology
      if (!topology) return
      updateTopology({
        ...topology,
        nodes: topology.nodes.map((node) =>
          node.id === nodeId ? { ...node, ...patch } : node,
        ),
      })
    },
    [snapshot.topology, updateTopology],
  )

  const moveNode = useCallback(
    (nodeId: string, position: Readonly<{ x: number; y: number }>) =>
      updateNode(nodeId, { position }),
    [updateNode],
  )

  const addConnection = useCallback(
    (candidate: WorkflowConnectionCandidate) => {
      const topology = snapshot.topology
      if (!topology) return
      const problem = connectionProblem(topology, candidate)
      if (problem) {
        setConnectionMessage(connectionMessageFor(problem.code, copy))
        if (problem.code === 'branchRequired' && problem.available) {
          setPendingConnection({ candidate, available: problem.available })
        }
        return
      }
      const edge: WorkflowEdge = {
        id:
          candidate.id ??
          nextEdgeId(topology.edges, candidate.source, candidate.target),
        source: candidate.source,
        target: candidate.target,
        ...(candidate.branch ? { branch: candidate.branch } : {}),
      }
      const edges = candidate.id
        ? topology.edges.map((current) =>
            current.id === candidate.id ? edge : current,
          )
        : [...topology.edges, edge]
      updateTopology({ ...topology, edges })
    },
    [copy, snapshot.topology, updateTopology],
  )

  const chooseConnectionBranch = useCallback(
    (branch: WorkflowBranch) => {
      if (!pendingConnection) return
      const candidate = { ...pendingConnection.candidate, branch }
      const topology = snapshot.topology
      if (!topology) return
      const problem = connectionProblem(topology, candidate)
      if (problem) {
        setConnectionMessage(connectionMessageFor(problem.code, copy))
        return
      }
      addConnection(candidate)
      setPendingConnection(null)
    },
    [addConnection, copy, pendingConnection, snapshot.topology],
  )

  const focusIssue = useCallback(
    (nodeId?: string, edgeId?: string) => {
      const topology = snapshot.topology
      const edge = edgeId
        ? topology?.edges.find((candidate) => candidate.id === edgeId)
        : undefined
      const focusedNodeId =
        nodeId ??
        (edge
          ? (topology?.nodes.find((node) => node.id === edge.target)?.id ??
            topology?.nodes.find((node) => node.id === edge.source)?.id)
          : undefined)
      if (edgeId) {
        setSelectedEdgeId(edgeId)
        if (focusedNodeId) {
          model.selectNode(focusedNodeId)
          controller?.focusNode(focusedNodeId)
        }
      } else if (focusedNodeId) {
        selectNode(focusedNodeId)
        controller?.focusNode(focusedNodeId)
      }
    },
    [controller, model, selectNode, snapshot.topology],
  )

  const openStep = useCallback(
    (nodeId: string) => {
      const path = snapshot.bundle?.files.find((file) => file.nodeId === nodeId)
        ?.snapshot.path
      if (!path) return
      void Promise.resolve(openFile(path)).catch((error: unknown) => {
        showNotice(error instanceof Error ? error.message : String(error))
      })
    },
    [openFile, showNotice, snapshot.bundle],
  )

  const createWorkflow = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (snapshot.dirty) {
        showNotice(copy.state.conflict)
        return
      }
      const slug = normalizeSlug(newWorkflowSlug)
      if (!slug) return
      const createdTopology = initialTopology(copy)
      const manifestContent = updateWorkflowManagedBlocks(
        `# ${slug}\n`,
        createdTopology,
        copy,
      )
      void model
        .create({
          slug,
          manifestContent,
          stepFiles: createdTopology.nodes.map((node) => ({
            relativePath: node.stepPath,
            content: `# ${node.label}\n`,
          })),
        })
        .then((result) => {
          if (!result.ok) {
            showNotice(
              result.reason === 'target-exists'
                ? copy.chatToolError.targetExists
                : copy.chatToolError.invalidInput,
            )
            return
          }
          setNewWorkflowOpen(false)
          setNewWorkflowSlug('')
        })
        .catch((error: unknown) => {
          showNotice(error instanceof Error ? error.message : String(error))
        })
    },
    [copy, model, newWorkflowSlug, showNotice, snapshot.dirty],
  )

  const addNode = useCallback(
    (kind: WorkflowNodeKind) => {
      const topology = snapshot.topology
      if (!topology) return
      const nodeId = nextNodeId(topology.nodes, kind)
      const position = controller?.screenCenter() ?? {
        x: 120 + topology.nodes.length * 24,
        y: 120 + topology.nodes.length * 18,
      }
      const node: WorkflowNode = {
        id: nodeId,
        kind,
        label: copy.nodeKind[kind],
        stepPath: `steps/${nodeId}/STEP.md`,
        position,
        ...(kind === 'condition' ? { gateType: 'ifElse' } : {}),
      }
      void model
        .addNode(node, `# ${node.label}\n`)
        .then((created) => {
          if (!created) {
            showNotice(copy.chatToolError.applyFailed)
            return
          }
          selectNode(nodeId)
          controller?.focusNode(nodeId)
        })
        .catch((error: unknown) =>
          showNotice(error instanceof Error ? error.message : String(error)),
        )
    },
    [
      controller,
      copy.chatToolError.applyFailed,
      copy.nodeKind,
      model,
      selectNode,
      showNotice,
      snapshot.topology,
    ],
  )

  const applyChanges = useCallback(() => {
    void model
      .apply()
      .then((result) => {
        if (!result.ok) {
          if (result.reason === 'conflict') showNotice(copy.state.conflict)
          else if (result.reason === 'invalid')
            showNotice(copy.chatToolError.applyFailed)
        }
      })
      .catch((error: unknown) =>
        showNotice(error instanceof Error ? error.message : String(error)),
      )
  }, [copy.chatToolError.applyFailed, copy.state.conflict, model, showNotice])

  const deleteWorkflow = useCallback(() => {
    if (!snapshot.path) return
    if (snapshot.dirty) {
      showNotice(copy.state.conflict)
      return
    }
    void model
      .trashCurrent()
      .catch((error: unknown) =>
        showNotice(error instanceof Error ? error.message : String(error)),
      )
  }, [copy.state.conflict, model, showNotice, snapshot.dirty, snapshot.path])

  const deleteNode = useCallback(
    (nodeId: string) => {
      void model
        .removeNode(nodeId)
        .then((removed) => {
          if (removed) selectNode(null)
          else showNotice(copy.chatToolError.applyFailed)
        })
        .catch((error: unknown) =>
          showNotice(error instanceof Error ? error.message : String(error)),
        )
    },
    [copy.chatToolError.applyFailed, model, selectNode, showNotice],
  )

  const reconnectEdge = useCallback(
    (edgeId: string, source: string, target: string) => {
      const edge = snapshot.topology?.edges.find((item) => item.id === edgeId)
      if (!edge) return
      addConnection({
        id: edge.id,
        source,
        target,
        ...(edge.branch ? { branch: edge.branch } : {}),
      })
    },
    [addConnection, snapshot.topology],
  )

  const deleteEdge = useCallback(() => {
    const topology = snapshot.topology
    if (!topology || !selectedEdgeId) return
    updateTopology({
      ...topology,
      edges: topology.edges.filter((edge) => edge.id !== selectedEdgeId),
    })
    setSelectedEdgeId(null)
  }, [selectedEdgeId, snapshot.topology, updateTopology])

  const runAssistant = useCallback(
    (action: AssistantAction) => {
      setAssistantAction(action)
      if (action === 'validation') {
        setAssistantProposal(null)
        return
      }
      if (!snapshot.bundle || !snapshot.topology) return
      if (action === 'document') {
        setAssistantProposal({
          action,
          baseContent: snapshot.bundle.document.content,
          content: documentProposal(
            snapshot.bundle.document.content,
            snapshot.topology,
          ),
        })
        return
      }
      const topology = layoutWorkflowNodes(snapshot.topology)
      setAssistantProposal({
        action,
        baseContent: snapshot.bundle.document.content,
        content: updateWorkflowManagedBlocks(
          snapshot.bundle.document.content,
          topology,
          copy,
        ),
      })
    },
    [copy, snapshot.bundle, snapshot.topology],
  )

  const acceptAssistantProposal = useCallback(() => {
    if (!assistantProposal) return
    if (!snapshot.bundle) return
    if (snapshot.bundle.document.content !== assistantProposal.baseContent) {
      setAssistantProposal(null)
      showNotice(copy.assistant.stale)
      return
    }
    const accepted = model.updateFile('workflow', assistantProposal.content)
    if (!accepted) {
      showNotice(copy.assistant.stale)
      return
    }
    setAssistantProposal(null)
    setAssistantAction('validation')
  }, [
    assistantProposal,
    copy.assistant.stale,
    model,
    showNotice,
    snapshot.bundle,
  ])

  const saveFile = useCallback(
    (nodeId: string) => {
      void model
        .saveFile(nodeId)
        .then((result) => {
          if (!result.ok) {
            showNotice(
              result.reason === 'conflict'
                ? copy.state.conflict
                : copy.chatToolError.applyFailed,
            )
          }
        })
        .catch((error: unknown) =>
          showNotice(error instanceof Error ? error.message : String(error)),
        )
    },
    [copy.chatToolError.applyFailed, copy.state.conflict, model, showNotice],
  )

  const exportWorkflow = useCallback(() => {
    if (!snapshot.bundle || !snapshot.topology) return
    const ownerDocument = rootRef.current?.ownerDocument
    const view = ownerDocument?.defaultView
    if (!ownerDocument || !view) return
    const value = JSON.stringify(
      exportDshFlowJson({
        title: snapshot.bundle.document.title,
        content: snapshot.bundle.document.content,
        topology: snapshot.topology,
      }),
      null,
      2,
    )
    const url = view.URL.createObjectURL(
      new Blob([value], { type: 'application/json' }),
    )
    const anchor = ownerDocument.createElement('a')
    anchor.href = url
    anchor.download = `${snapshot.bundle.document.title || 'workflow'}.json`
    ownerDocument.body.appendChild(anchor)
    anchor.click()
    anchor.remove()
    view.setTimeout(() => view.URL.revokeObjectURL(url), 0)
  }, [snapshot.bundle, snapshot.topology])

  const importWorkflow = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.currentTarget.files?.[0]
      event.currentTarget.value = ''
      if (!file) return
      if (snapshot.dirty) {
        showNotice(copy.state.conflict)
        return
      }
      void file
        .text()
        .then((content) => {
          const bundle = parseDshFlowJson(content, copy)
          if (!bundle) {
            showNotice(copy.chatToolError.importFailed)
            return
          }
          const slug = normalizeSlug(bundle.title) || `workflow-${Date.now()}`
          const stepFiles = bundle.topology.nodes.map((node) => ({
            relativePath: node.stepPath,
            content: bundle.stepContents?.[node.id] ?? `# ${node.label}\n`,
          }))
          const manifestContent = updateWorkflowManagedBlocks(
            bundle.content || `# ${bundle.title}\n`,
            bundle.topology,
            copy,
          )
          return model
            .create({ slug, manifestContent, stepFiles })
            .then((result) => {
              if (!result.ok) {
                showNotice(
                  result.reason === 'target-exists'
                    ? copy.chatToolError.targetExists
                    : copy.chatToolError.importFailed,
                )
              }
            })
        })
        .catch((error: unknown) => {
          showNotice(error instanceof Error ? error.message : String(error))
        })
    },
    [copy, model, showNotice, snapshot.dirty],
  )

  const statusMessage = statusText(snapshot, copy)
  return (
    <div ref={rootRef} className="yolo-workflow-studio">
      <header className="yolo-workflow-toolbar">
        <div className="yolo-workflow-toolbar__identity">
          <span className="yolo-workflow-toolbar__mark">
            <GitBranch size={16} strokeWidth={2.4} />
          </span>
          <div>
            <div className="yolo-workflow-toolbar__identity-title">
              <strong>{copy.studio.title}</strong>
              <span>{copy.studio.editorOnly}</span>
            </div>
            <span className="yolo-workflow-toolbar__session-boundary">
              {copy.studio.sessionBoundary}
            </span>
          </div>
        </div>
        <div className="yolo-workflow-toolbar__status" role="status">
          <span className={snapshot.dirty ? 'is-dirty' : undefined}>
            {snapshot.dirty ? copy.toolbar.save : statusMessage}
          </span>
          <div className="yolo-workflow-toolbar__panel-toggle">
            <button
              type="button"
              className="yolo-workflow-icon-button"
              aria-label={copy.rail.workflows}
              title={copy.rail.workflows}
              onClick={() =>
                setPanels((value) => ({ ...value, rail: !value.rail }))
              }
            >
              <PanelLeft size={15} />
            </button>
          </div>
          <div className="yolo-workflow-toolbar__panel-toggle">
            <button
              type="button"
              className="yolo-workflow-icon-button"
              aria-label={copy.inspector.title}
              title={copy.inspector.title}
              onClick={() =>
                setPanels((value) => ({
                  ...value,
                  inspector: !value.inspector,
                }))
              }
            >
              <PanelRight size={15} />
            </button>
          </div>
        </div>
      </header>
      {newWorkflowOpen ? (
        <form className="yolo-workflow-create-bar" onSubmit={createWorkflow}>
          <Plus size={15} />
          <input
            autoFocus
            value={newWorkflowSlug}
            onChange={(event) => setNewWorkflowSlug(event.currentTarget.value)}
            aria-label={copy.toolbar.create}
            placeholder={copy.toolbar.create}
          />
          <button type="submit">{copy.toolbar.create}</button>
          <button
            type="button"
            aria-label={copy.assistant.cancel}
            onClick={() => setNewWorkflowOpen(false)}
          >
            <X size={15} />
          </button>
        </form>
      ) : null}
      <input
        ref={importRef}
        className="yolo-workflow-visually-hidden"
        type="file"
        accept="application/json,.json"
        onChange={importWorkflow}
      />
      <div className="yolo-workflow-workspace">
        {panels.rail ? (
          <WorkflowRail
            snapshot={snapshot}
            copy={copy}
            onLoad={loadWorkflow}
            onOpenStep={openStep}
            onSelectNode={selectNode}
            style={compactLayout ? { display: 'flex' } : undefined}
          />
        ) : null}
        <main className="yolo-workflow-canvas-shell">
          <div className="yolo-workflow-canvas-toolbar">
            <label className="yolo-workflow-canvas-toolbar__flow">
              <span>{copy.toolbar.flow}</span>
              <select
                aria-label={copy.toolbar.read}
                value={snapshot.path ?? ''}
                onChange={(event) => loadWorkflow(event.currentTarget.value)}
                disabled={snapshot.workflows.length === 0}
              >
                {snapshot.workflows.length === 0 ? (
                  <option value="">{copy.state.empty}</option>
                ) : null}
                {snapshot.workflows.map((workflow) => (
                  <option key={workflow.path} value={workflow.path}>
                    {workflow.title}
                  </option>
                ))}
              </select>
              <ChevronDown size={13} />
            </label>
            <CanvasToolbarButton
              icon={<Plus size={13} />}
              label={copy.toolbar.create}
              onClick={() => setNewWorkflowOpen(true)}
            />
            <CanvasToolbarButton
              icon={<Upload size={13} />}
              label={copy.toolbar.import}
              onClick={() => importRef.current?.click()}
            />
            <CanvasToolbarButton
              icon={<Download size={13} />}
              label={copy.toolbar.export}
              disabled={!snapshot.topology}
              onClick={exportWorkflow}
            />
            <CanvasToolbarButton
              icon={<Save size={13} />}
              label={copy.toolbar.save}
              disabled={!snapshot.dirty}
              onClick={applyChanges}
            />
            <CanvasToolbarButton
              icon={<Undo2 size={13} />}
              label={copy.toolbar.undo}
              disabled={!snapshot.canUndo}
              onClick={() => model.undo()}
            />
            <CanvasToolbarButton
              icon={<Redo2 size={13} />}
              label={copy.toolbar.redo}
              disabled={!snapshot.canRedo}
              onClick={() => model.redo()}
            />
            <CanvasToolbarButton
              icon={<LayoutDashboard size={13} />}
              label={copy.toolbar.layout}
              disabled={!snapshot.topology}
              onClick={() => model.autoLayout()}
            />
            <CanvasToolbarButton
              icon={<Trash2 size={13} />}
              label={copy.toolbar.delete}
              disabled={!snapshot.path}
              onClick={deleteWorkflow}
            />
            <span
              className={`yolo-workflow-canvas-toolbar__sync${snapshot.dirty ? ' is-dirty' : ''}`}
            >
              {snapshot.dirty ? copy.toolbar.save : copy.studio.synced}
            </span>
          </div>
          {snapshot.topology ? (
            <WorkflowGraph
              key={snapshot.path ?? 'empty-workflow'}
              topology={snapshot.topology}
              selectedNodeId={snapshot.selectedNodeId}
              selectedEdgeId={selectedEdgeId}
              copy={copy}
              onSelectNode={selectNode}
              onSelectEdge={selectEdge}
              onMoveNode={moveNode}
              onConnect={addConnection}
              onReady={setController}
            />
          ) : (
            <EmptyState copy={copy} onCreate={() => setNewWorkflowOpen(true)} />
          )}
          {pendingConnection ? (
            <div className="yolo-workflow-branch-picker" role="dialog">
              <div>
                <strong>{copy.inspector.gate}</strong>
                <span>{copy.connection.branchRequired}</span>
              </div>
              <div className="yolo-workflow-branch-picker__choices">
                {pendingConnection.available.map((branch) => (
                  <button
                    key={branch}
                    type="button"
                    onClick={() => chooseConnectionBranch(branch)}
                  >
                    {copy.branchLabel[branch]}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="yolo-workflow-icon-button"
                aria-label={copy.assistant.cancel}
                onClick={() => setPendingConnection(null)}
              >
                <X size={14} />
              </button>
            </div>
          ) : null}
          {connectionMessage ? (
            <div className="yolo-workflow-canvas-message" role="status">
              <AlertTriangle size={14} />
              <span>{connectionMessage}</span>
              <button
                type="button"
                aria-label={copy.assistant.cancel}
                onClick={() => setConnectionMessage(null)}
              >
                <X size={13} />
              </button>
            </div>
          ) : null}
        </main>
        {panels.inspector ? (
          <WorkflowInspector
            node={selectedNode}
            edge={selectedEdge}
            bundle={snapshot.bundle}
            markdownTarget={markdownTarget}
            copy={copy}
            onChange={updateNode}
            onChangeFile={model.updateFile}
            onSaveFile={saveFile}
            onSelectMarkdownTarget={setMarkdownTarget}
            onOpenStep={openStep}
            onReconnectEdge={reconnectEdge}
            onDeleteEdge={deleteEdge}
            onDeleteNode={deleteNode}
            style={compactLayout ? { display: 'flex' } : undefined}
          />
        ) : null}
      </div>
      {snapshot.topology ? (
        <button
          type="button"
          className="yolo-workflow-apply-float"
          aria-label={copy.toolbar.apply}
          title={copy.toolbar.apply}
          disabled={!snapshot.dirty}
          onClick={applyChanges}
        >
          <Check size={14} />
          <span>{copy.toolbar.apply}</span>
          <b>{snapshot.dirty ? 1 : 0}</b>
        </button>
      ) : null}
      <WorkflowAddNodeBar
        copy={copy}
        disabled={!snapshot.topology}
        onAdd={addNode}
      />
      <WorkflowAssistant
        snapshot={snapshot}
        copy={copy}
        action={assistantAction}
        proposal={assistantProposal}
        onAction={runAssistant}
        onFocus={focusIssue}
        onAccept={acceptAssistantProposal}
        onReject={() => setAssistantProposal(null)}
      />
    </div>
  )
}

function WorkflowRail({
  snapshot,
  copy,
  onLoad,
  onOpenStep,
  onSelectNode,
  style,
}: Readonly<{
  snapshot: WorkflowEditorSnapshot
  copy: WorkflowCopy
  onLoad(path: string): void
  onOpenStep(nodeId: string): void
  onSelectNode(nodeId: string): void
  style?: React.CSSProperties
}>) {
  const steps = snapshot.topology
    ? snapshot.topology.nodes.map((node) => ({
        nodeId: node.id,
        label: node.label,
        stepPath: node.stepPath,
      }))
    : (snapshot.bundle?.document.steps ?? [])
  return (
    <aside className="yolo-workflow-rail" style={style}>
      <div className="yolo-workflow-panel-heading">
        <div>
          <span className="yolo-workflow-eyebrow">{copy.rail.documents}</span>
          <strong>{copy.rail.docsFirst}</strong>
        </div>
        <FileCode2 size={17} />
      </div>
      <div className="yolo-workflow-rail__list">
        <span className="yolo-workflow-eyebrow yolo-workflow-rail__section-label">
          {copy.rail.master}
        </span>
        {snapshot.workflows.map((workflow) => (
          <button
            key={workflow.path}
            type="button"
            className={`yolo-workflow-rail__workflow${
              workflow.path === snapshot.path ? ' is-active' : ''
            }`}
            onClick={() => onLoad(workflow.path)}
          >
            <span className="yolo-workflow-rail__file-icon">MD</span>
            <span>
              <strong>{workflow.title}</strong>
              <small>{workflow.path}</small>
            </span>
          </button>
        ))}
        {snapshot.workflows.length === 0 ? (
          <p className="yolo-workflow-muted">{copy.state.empty}</p>
        ) : null}
      </div>
      {snapshot.bundle ? (
        <div className="yolo-workflow-rail__steps">
          <span className="yolo-workflow-eyebrow">
            {copy.rail.stepWorkspaces}
          </span>
          {steps.map((step, index) => (
            <button
              key={step.nodeId}
              type="button"
              className={`yolo-workflow-rail__step${
                step.nodeId === snapshot.selectedNodeId ? ' is-active' : ''
              }`}
              onClick={() => {
                onSelectNode(step.nodeId)
                onOpenStep(step.nodeId)
              }}
            >
              <span className="yolo-workflow-rail__step-number">
                {String(index + 1).padStart(2, '0')}
              </span>
              <span className="yolo-workflow-rail__step-copy">
                <strong>{step.label}</strong>
                <small>{step.stepPath}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </aside>
  )
}

function WorkflowInspector({
  node,
  edge,
  bundle,
  markdownTarget,
  copy,
  onChange,
  onChangeFile,
  onSaveFile,
  onSelectMarkdownTarget,
  onOpenStep,
  onReconnectEdge,
  onDeleteEdge,
  onDeleteNode,
  style,
}: Readonly<{
  node: WorkflowNode | null
  edge: WorkflowEdge | null
  bundle: WorkflowBundle | null
  markdownTarget: string
  copy: WorkflowCopy
  onChange(nodeId: string, patch: Partial<WorkflowNode>): void
  onChangeFile(nodeId: string, content: string): boolean
  onSaveFile(nodeId: string): void
  onSelectMarkdownTarget(nodeId: string): void
  onOpenStep(nodeId: string): void
  onReconnectEdge(edgeId: string, source: string, target: string): void
  onDeleteEdge(): void
  onDeleteNode(nodeId: string): void
  style?: React.CSSProperties
}>) {
  const markdownFile =
    bundle?.files.find((file) => file.nodeId === markdownTarget) ??
    bundle?.files.find((file) => file.nodeId === 'workflow') ??
    null
  const stepFiles =
    bundle?.files.filter((file) => file.nodeId !== 'workflow') ?? []
  const nodeIds = bundle?.document.steps.map((step) => step.nodeId) ?? []
  return (
    <aside className="yolo-workflow-inspector" style={style}>
      <div className="yolo-workflow-panel-heading">
        <div>
          <span className="yolo-workflow-eyebrow">{copy.inspector.title}</span>
          <strong>
            {markdownFile?.nodeId === 'workflow'
              ? 'WORKFLOW.md'
              : (node?.label ?? copy.state.empty)}
          </strong>
        </div>
        <FileCode2 size={17} />
      </div>
      <div className="yolo-workflow-inspector__form">
        <div className="yolo-workflow-markdown-tabs" role="tablist">
          <button
            type="button"
            className={markdownTarget === 'workflow' ? 'is-active' : undefined}
            onClick={() => onSelectMarkdownTarget('workflow')}
          >
            WORKFLOW.md
          </button>
          {node ? (
            <button
              type="button"
              className={markdownTarget === node.id ? 'is-active' : undefined}
              onClick={() => onSelectMarkdownTarget(node.id)}
            >
              {node.label}
            </button>
          ) : null}
        </div>
        <div className="yolo-workflow-markdown-meta">
          <span className="yolo-workflow-eyebrow">
            {markdownFile?.nodeId === 'workflow'
              ? copy.rail.master
              : copy.rail.steps}
          </span>
          <small>{markdownFile?.relativePath ?? copy.state.empty}</small>
        </div>
        <label className="yolo-workflow-markdown-field">
          <span>{copy.inspector.markdownContent}</span>
          <textarea
            aria-label={copy.inspector.markdownContent}
            value={markdownFile?.snapshot.content ?? ''}
            disabled={!markdownFile}
            onInput={(event) => {
              if (markdownFile)
                onChangeFile(markdownFile.nodeId, event.currentTarget.value)
            }}
          />
        </label>
        <div className="yolo-workflow-markdown-actions">
          <button
            type="button"
            disabled={!markdownFile}
            onClick={() => markdownFile && onSaveFile(markdownFile.nodeId)}
          >
            <Save size={13} />
            {copy.toolbar.save}
          </button>
          {markdownFile && markdownFile.nodeId !== 'workflow' ? (
            <button
              type="button"
              onClick={() => onOpenStep(markdownFile.nodeId)}
            >
              <FileInput size={13} />
              {copy.toolbar.read}
            </button>
          ) : null}
        </div>
        {edge ? (
          <div className="yolo-workflow-edge-inspector">
            <div className="yolo-workflow-panel-heading">
              <div>
                <span className="yolo-workflow-eyebrow">
                  {copy.inspector.title}
                </span>
                <strong>{edge.id}</strong>
              </div>
              <GitFork size={16} />
            </div>
            <InspectorField label={copy.inspector.source}>
              <select
                value={edge.source}
                onChange={(event) =>
                  onReconnectEdge(
                    edge.id,
                    event.currentTarget.value,
                    edge.target,
                  )
                }
              >
                {nodeIds.map((nodeId) => (
                  <option key={nodeId} value={nodeId}>
                    {nodeId}
                  </option>
                ))}
              </select>
            </InspectorField>
            <InspectorField label={copy.inspector.target}>
              <select
                value={edge.target}
                onChange={(event) =>
                  onReconnectEdge(
                    edge.id,
                    edge.source,
                    event.currentTarget.value,
                  )
                }
              >
                {nodeIds.map((nodeId) => (
                  <option key={nodeId} value={nodeId}>
                    {nodeId}
                  </option>
                ))}
              </select>
            </InspectorField>
            <button type="button" onClick={onDeleteEdge}>
              <Trash2 size={13} />
              {copy.toolbar.delete}
            </button>
          </div>
        ) : null}
        {node ? (
          <div className="yolo-workflow-node-inspector">
            <div className="yolo-workflow-panel-heading">
              <div>
                <span className="yolo-workflow-eyebrow">
                  {copy.inspector.title}
                </span>
                <strong>{node.label}</strong>
              </div>
              <GitBranch size={16} />
            </div>
            <InspectorField label={copy.inspector.id}>
              <input value={node.id} readOnly />
            </InspectorField>
            <InspectorField label={copy.inspector.label}>
              <input
                value={node.label}
                onChange={(event) =>
                  onChange(node.id, { label: event.currentTarget.value })
                }
              />
            </InspectorField>
            <InspectorField label={copy.inspector.kind}>
              <select
                value={node.kind}
                onChange={(event) =>
                  onChange(node.id, {
                    kind: event.currentTarget.value as WorkflowNodeKind,
                  })
                }
              >
                {NODE_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {copy.nodeKind[kind]}
                  </option>
                ))}
              </select>
            </InspectorField>
            <InspectorField label={copy.inspector.stepPath}>
              <input value={node.stepPath} readOnly />
            </InspectorField>
            <InspectorField label={copy.inspector.stage}>
              <input
                value={node.stage ?? ''}
                onChange={(event) =>
                  onChange(node.id, {
                    stage: event.currentTarget.value || undefined,
                  })
                }
              />
            </InspectorField>
            <InspectorField label={copy.inspector.model}>
              <input
                value={node.modelId ?? ''}
                onChange={(event) =>
                  onChange(node.id, {
                    modelId: event.currentTarget.value || undefined,
                  })
                }
              />
            </InspectorField>
            {node.kind === 'condition' ? (
              <>
                <InspectorField label={copy.inspector.gate}>
                  <select
                    value={node.gateType ?? 'ifElse'}
                    onChange={(event) =>
                      onChange(node.id, {
                        gateType: event.currentTarget.value as WorkflowGateType,
                      })
                    }
                  >
                    {GATE_TYPES.map((gate) => (
                      <option key={gate} value={gate}>
                        {copy.gateType[gate]}
                      </option>
                    ))}
                  </select>
                </InspectorField>
                <InspectorField label={copy.inspector.predicate}>
                  <input
                    value={node.predicate ?? ''}
                    onChange={(event) =>
                      onChange(node.id, {
                        predicate: event.currentTarget.value || undefined,
                      })
                    }
                  />
                </InspectorField>
              </>
            ) : null}
            {node.outputSchema !== undefined ? (
              <InspectorField label={copy.inspector.outputSchema}>
                <pre>{JSON.stringify(node.outputSchema, null, 2)}</pre>
              </InspectorField>
            ) : null}
            <button
              type="button"
              aria-label={copy.inspector.deleteNode}
              disabled={node.kind === 'input' || node.kind === 'output'}
              onClick={() => onDeleteNode(node.id)}
            >
              <Trash2 size={13} />
              {copy.inspector.deleteNode}
            </button>
          </div>
        ) : null}
        {!node && !edge && !markdownFile ? (
          <div className="yolo-workflow-inspector__empty">
            <Sparkles size={18} />
            <span>{copy.rail.steps}</span>
          </div>
        ) : null}
      </div>
    </aside>
  )
}

function InspectorField({
  label,
  children,
}: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <label className="yolo-workflow-inspector__field">
      <span>{label}</span>
      {children}
    </label>
  )
}

function WorkflowFindingList({
  snapshot,
  copy,
  onFocus,
}: Readonly<{
  snapshot: WorkflowEditorSnapshot
  copy: WorkflowCopy
  onFocus(nodeId?: string, edgeId?: string): void
}>) {
  return (
    <div className="yolo-workflow-findings">
      {snapshot.issues.length > 0 ? (
        snapshot.issues.map((issue, index) => (
          <button
            key={`${issue.code}-${issue.nodeId ?? ''}-${issue.edgeId ?? ''}-${index}`}
            type="button"
            className="yolo-workflow-finding"
            onClick={() => onFocus(issue.nodeId, issue.edgeId)}
          >
            <AlertTriangle size={14} />
            <span>{findingMessage(issue.code, copy)}</span>
            {issue.nodeId ? <small>{issue.nodeId}</small> : null}
          </button>
        ))
      ) : (
        <span className="yolo-workflow-success">
          <CheckCircle2 size={14} />
          {copy.finding.none}
        </span>
      )}
    </div>
  )
}

function WorkflowAddNodeBar({
  copy,
  disabled,
  onAdd,
}: Readonly<{
  copy: WorkflowCopy
  disabled: boolean
  onAdd(kind: WorkflowNodeKind): void
}>) {
  return (
    <section className="yolo-workflow-add-node-bar">
      <span className="yolo-workflow-eyebrow">{copy.rail.addNode}</span>
      <div className="yolo-workflow-add-node-bar__buttons">
        {NODE_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            aria-label={`${copy.rail.addNode}: ${copy.nodeKind[kind]}`}
            disabled={disabled}
            onClick={() => onAdd(kind)}
          >
            {nodeKindIcon(kind)}
            <span>{copy.nodeKind[kind]}</span>
          </button>
        ))}
      </div>
      <span className="yolo-workflow-add-node-bar__hint">
        {copy.rail.dragHint}
      </span>
    </section>
  )
}

function WorkflowAssistant({
  snapshot,
  copy,
  action,
  proposal,
  onAction,
  onFocus,
  onAccept,
  onReject,
}: Readonly<{
  snapshot: WorkflowEditorSnapshot
  copy: WorkflowCopy
  action: AssistantAction
  proposal: AssistantProposal | null
  onAction(action: AssistantAction): void
  onFocus(nodeId?: string, edgeId?: string): void
  onAccept(): void
  onReject(): void
}>) {
  return (
    <section className="yolo-workflow-assistant">
      <header className="yolo-workflow-assistant__header">
        <div className="yolo-workflow-assistant__identity">
          <span className="yolo-workflow-assistant__mark">
            <Sparkles size={15} />
          </span>
          <div>
            <strong>{copy.assistant.title}</strong>
            <small>{copy.assistant.manual}</small>
          </div>
        </div>
        <span className="yolo-workflow-assistant__target">WORKFLOW.md</span>
        <div className="yolo-workflow-assistant__actions">
          <button
            type="button"
            className={action === 'validation' ? 'is-active' : undefined}
            onClick={() => onAction('validation')}
          >
            {copy.assistant.validate}
          </button>
          <button
            type="button"
            className={action === 'document' ? 'is-active' : undefined}
            disabled={!snapshot.bundle}
            onClick={() => onAction('document')}
          >
            {copy.assistant.optimizeDocument}
          </button>
          <button
            type="button"
            className={action === 'workflow' ? 'is-active' : undefined}
            disabled={!snapshot.topology}
            onClick={() => onAction('workflow')}
          >
            {copy.assistant.optimizeWorkflow}
          </button>
        </div>
      </header>
      <div className="yolo-workflow-assistant__body">
        <div className="yolo-workflow-assistant__findings">
          <div className="yolo-workflow-assistant__section-heading">
            <span className="yolo-workflow-eyebrow">{copy.finding.title}</span>
            <strong>{snapshot.issues.length}</strong>
          </div>
          <WorkflowFindingList
            snapshot={snapshot}
            copy={copy}
            onFocus={onFocus}
          />
        </div>
        <div className="yolo-workflow-assistant__proposal">
          <div className="yolo-workflow-assistant__section-heading">
            <span className="yolo-workflow-eyebrow">
              {copy.assistant.proposal}
            </span>
            {proposal ? (
              <div className="yolo-workflow-assistant__proposal-actions">
                <button type="button" onClick={onReject}>
                  {copy.assistant.reject}
                </button>
                <button type="button" className="is-primary" onClick={onAccept}>
                  {copy.assistant.accept}
                </button>
              </div>
            ) : null}
          </div>
          {proposal ? (
            <textarea
              className="yolo-workflow-assistant__proposal-text"
              readOnly
              value={proposal.content}
              aria-label={copy.assistant.proposal}
            />
          ) : (
            <div className="yolo-workflow-assistant__proposal-empty">
              <WandSparkles size={15} />
              <span>{copy.assistant.proposalEmpty}</span>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function EmptyState({
  copy,
  onCreate,
}: Readonly<{ copy: WorkflowCopy; onCreate(): void }>) {
  return (
    <div className="yolo-workflow-empty-state">
      <div>
        <GitBranch size={30} />
        <strong>{copy.state.empty}</strong>
        <span>{copy.studio.editorOnly}</span>
        <button type="button" onClick={onCreate}>
          <Plus size={14} />
          {copy.toolbar.create}
        </button>
      </div>
    </div>
  )
}

function CanvasToolbarButton({
  icon,
  label,
  disabled,
  onClick,
}: Readonly<{
  icon: React.ReactNode
  label: string
  disabled?: boolean
  onClick(): void
}>) {
  return (
    <button
      type="button"
      className="yolo-workflow-canvas-toolbar__button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  )
}

function nodeKindIcon(kind: WorkflowNodeKind): React.ReactNode {
  if (kind === 'input') return <CircleDot size={13} />
  if (kind === 'agent') return <Bot size={13} />
  if (kind === 'mapAgent') return <Layers3 size={13} />
  if (kind === 'condition') return <GitFork size={13} />
  if (kind === 'merge') return <Merge size={13} />
  return <CircleStop size={13} />
}

function documentProposal(content: string, topology: WorkflowTopology): string {
  if (/^##\s+Execution order\s*$/im.test(content)) return content
  const executionOrder = topology.nodes
    .map((node, index) => `${index + 1}. ${node.label}`)
    .join('\n')
  const base = content.trimEnd()
  return `${base}${base ? '\n\n' : ''}## Execution order\n\n${executionOrder}\n`
}

function initialTopology(copy: WorkflowCopy): WorkflowTopology {
  const nodes: WorkflowNode[] = [
    {
      id: 'input',
      kind: 'input',
      label: copy.nodeKind.input,
      stepPath: 'steps/input/STEP.md',
      position: { x: 70, y: 90 },
    },
    {
      id: 'agent',
      kind: 'agent',
      label: copy.nodeKind.agent,
      stepPath: 'steps/agent/STEP.md',
      position: { x: 315, y: 90 },
    },
    {
      id: 'output',
      kind: 'output',
      label: copy.nodeKind.output,
      stepPath: 'steps/output/STEP.md',
      position: { x: 560, y: 90 },
    },
  ]
  return {
    revision: 1,
    nodes,
    edges: [
      { id: 'input-agent', source: 'input', target: 'agent' },
      { id: 'agent-output', source: 'agent', target: 'output' },
    ],
  }
}

function nextNodeId(
  nodes: readonly WorkflowNode[],
  kind: WorkflowNodeKind,
): string {
  const prefix = kind === 'mapAgent' ? 'map-agent' : kind
  let index = 1
  while (nodes.some((node) => node.id === `${prefix}-${index}`)) index += 1
  return `${prefix}-${index}`
}

function nextEdgeId(
  edges: readonly WorkflowEdge[],
  source: string,
  target: string,
): string {
  const prefix = `${source}-${target}`
  let index = 1
  while (edges.some((edge) => edge.id === `${prefix}-${index}`)) index += 1
  return `${prefix}-${index}`
}

function normalizeSlug(value: string): string {
  return value
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}

function connectionMessageFor(
  code:
    | 'invalidConnection'
    | 'duplicateConnection'
    | 'branchRequired'
    | 'branchUsed'
    | 'gateMismatch'
    | 'gateLimit',
  copy: WorkflowCopy,
): string {
  return copy.connection[connectionKey(code)]
}

function connectionKey(
  code:
    | 'invalidConnection'
    | 'duplicateConnection'
    | 'branchRequired'
    | 'branchUsed'
    | 'gateMismatch'
    | 'gateLimit',
):
  | 'invalid'
  | 'duplicate'
  | 'branchRequired'
  | 'branchUsed'
  | 'gateMismatch'
  | 'gateLimit' {
  if (code === 'invalidConnection') return 'invalid'
  if (code === 'duplicateConnection') return 'duplicate'
  return code
}

function findingMessage(
  code: WorkflowEditorSnapshot['issues'][number]['code'],
  copy: WorkflowCopy,
): string {
  if (code === 'invalidStructure' || code === 'missingStep')
    return copy.finding.invalidStructure
  if (code === 'cycle') return copy.finding.cycle
  if (code === 'unreachable') return copy.finding.unreachable
  return copy.finding.invalidTopology
}

function statusText(
  snapshot: WorkflowEditorSnapshot,
  copy: WorkflowCopy,
): string {
  if (snapshot.status === 'loading') return copy.state.loading
  if (snapshot.status === 'empty') return copy.state.empty
  if (snapshot.status === 'error') return copy.state.error
  if (snapshot.status === 'conflict') return copy.state.conflict
  return copy.studio.editorOnly
}
