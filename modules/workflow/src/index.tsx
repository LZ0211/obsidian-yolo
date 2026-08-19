import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react'

import { createWorkflowRepository } from './domain/workflow-repository'
import { createWorkflowChatTools } from './domain/workflow-tools'
import { createWorkflowNodeExecutor } from './execution/workflow-node-executor'
import { createWorkflowRunCoordinator } from './execution/workflow-run-coordinator'
import { createWorkflowRunStore } from './execution/workflow-run-store'
import type {
  JsonValue,
  WorkflowRunCoordinator,
  WorkflowRunError,
  WorkflowRunSnapshot,
  WorkflowRunStartFailureReason,
} from './execution/workflow-run-types'
import type { WorkflowCopy } from './i18n'
import { createWorkflowCopy, createWorkflowLocalizedText } from './i18n'
import { createWorkflowEditorModel } from './ui/workflow-editor-model'
import { WorkflowStudio } from './ui/workflow-studio'

const MODULE_ID = 'workflow'
const VIEW_TYPE = 'yolo-workflow-view'
/**
 * Deterministic background activity id derived from the Workflow path. The
 * path is stable across sessions, so a recovered activity can be resumed and
 * a cleared one stays cleared after re-activation.
 */
const RUN_ACTIVITY_ID_PREFIX = 'workflow:run:'

type BackgroundActivity = Parameters<
  YoloModuleHostApiV1['background']['upsert']
>[0]

/**
 * The view-facing selection layer over Coordinator publishes. Snapshots are
 * keyed by Workflow path so a view can select the current Workflow's run
 * without copying run state into React local state.
 */
type RunSnapshotIndex = Readonly<{
  subscribe(listener: () => void): () => void
  getSnapshot(): Readonly<Record<string, WorkflowRunSnapshot>>
}>

function createRunSnapshotIndex(
  coordinator: WorkflowRunCoordinator,
): RunSnapshotIndex {
  let snapshots: Readonly<Record<string, WorkflowRunSnapshot>> = Object.freeze(
    {},
  )
  const subscribe = (listener: () => void): (() => void) =>
    coordinator.subscribe((snapshot) => {
      snapshots = Object.freeze({
        ...snapshots,
        [snapshot.workflowPath]: snapshot,
      })
      listener()
    })
  return Object.freeze({
    subscribe,
    getSnapshot: () => snapshots,
  })
}

function workflowRunActivityId(workflowPath: string): string {
  return `${RUN_ACTIVITY_ID_PREFIX}${workflowPath}`
}

function workflowRunActivity(
  workflowPath: string,
  status: BackgroundActivity['status'],
  openWorkflow: (path: string) => void | Promise<void>,
): BackgroundActivity {
  return {
    id: workflowRunActivityId(workflowPath),
    title: workflowPath,
    status,
    onOpen: () => openWorkflow(workflowPath),
  }
}

function isWaitingForApproval(
  snapshot: WorkflowRunSnapshot,
  pendingApprovalNodeIds: ReadonlySet<string>,
): boolean {
  for (const node of snapshot.definition.topology.nodes) {
    if (
      snapshot.nodes[node.id]?.status === 'running' &&
      pendingApprovalNodeIds.has(node.id)
    )
      return true
  }
  return false
}

yolo.registerModule({
  id: MODULE_ID,
  async activate(host) {
    const repository = createWorkflowRepository(host)
    const getCopy = () => createWorkflowCopy(host.i18n.getSnapshot().locale)
    const editors = new Map<
      string,
      ReturnType<typeof createWorkflowEditorModel>
    >()
    const getEditor = (context: YoloModuleHostViewContextV1) => {
      const existing = editors.get(context.id)
      if (existing) return existing
      const editor = createWorkflowEditorModel(repository, getCopy)
      editors.set(context.id, editor)
      context.lifecycle.add(() => {
        editor.dispose()
        editors.delete(context.id)
      })
      return editor
    }
    const tools = createWorkflowChatTools(repository, getCopy)
    const openView = (): Promise<void> => host.workspace.openView()
    const openWorkflow = (path: string): Promise<void> =>
      host.workspace.openView({ state: { path } })
    const readStyle = (): Promise<string> => host.assets.readText('style.css')

    const store = createWorkflowRunStore(host.privateStorage.deviceLocal)
    // Node ids whose agent call is currently awaiting approval, and the
    // Workflow path each running node belongs to. Both are derived from
    // Coordinator publishes and agent events, never a parallel run state.
    const pendingApprovalNodeIds = new Set<string>()
    const runningNodeWorkflow = new Map<string, string>()
    const executor = createWorkflowNodeExecutor({
      agent: host.agent,
      onAgentEvent: (nodeId, event) => {
        if (event.type !== 'tool') return
        if (event.status === 'awaiting_approval') {
          pendingApprovalNodeIds.add(nodeId)
          const workflowPath = runningNodeWorkflow.get(nodeId)
          if (workflowPath !== undefined)
            host.background.upsert(
              workflowRunActivity(workflowPath, 'waiting', openWorkflow),
            )
          return
        }
        if (event.status === 'completed' || event.status === 'error')
          pendingApprovalNodeIds.delete(nodeId)
      },
    })
    const coordinator = createWorkflowRunCoordinator({ executor, store })
    coordinator.subscribe((snapshot) => {
      switch (snapshot.status) {
        case 'succeeded':
        case 'cancelled':
          host.background.remove(workflowRunActivityId(snapshot.workflowPath))
          break
        case 'running':
          host.background.upsert(
            workflowRunActivity(
              snapshot.workflowPath,
              isWaitingForApproval(snapshot, pendingApprovalNodeIds)
                ? 'waiting'
                : 'running',
              openWorkflow,
            ),
          )
          break
        case 'failed':
          host.background.upsert(
            workflowRunActivity(snapshot.workflowPath, 'failed', openWorkflow),
          )
          break
        case 'interrupted':
          host.background.upsert(
            workflowRunActivity(
              snapshot.workflowPath,
              'reminder',
              openWorkflow,
            ),
          )
          break
      }
      for (const node of snapshot.definition.topology.nodes) {
        if (
          snapshot.status === 'running' &&
          snapshot.nodes[node.id]?.status === 'running'
        ) {
          runningNodeWorkflow.set(node.id, snapshot.workflowPath)
        } else {
          runningNodeWorkflow.delete(node.id)
          pendingApprovalNodeIds.delete(node.id)
        }
      }
    })
    await coordinator.initialize()
    host.lifecycle.onQuiesce(() => coordinator.quiesce())

    host.workspace.registerView({
      type: VIEW_TYPE,
      name: createWorkflowLocalizedText('module.name'),
      icon: 'git-branch',
      render: (context) => (
        <WorkflowModuleView
          viewId={context.id}
          editor={getEditor(context)}
          coordinator={coordinator}
          getCopy={getCopy}
          getLocaleSnapshot={host.i18n.getSnapshot}
          subscribeLocale={host.i18n.subscribe}
          agent={host.agent}
          getModelSnapshot={host.settings.getModelSnapshot}
          subscribeModels={host.settings.subscribeModels}
          readStyle={readStyle}
          openFile={async (path) => {
            await host.ui.openFileAt({ path })
          }}
          notice={host.ui.notice}
          confirm={host.ui.confirm}
        />
      ),
      getState: (context) => ({ path: getEditor(context).getSnapshot().path }),
      setState: async (state, context) => {
        if (typeof state.path === 'string')
          await getEditor(context).load(state.path)
      },
    })
    host.workspace.registerRibbonAction({
      icon: 'git-branch',
      title: createWorkflowLocalizedText('module.open'),
      onClick: () => {
        void openView().catch((error: unknown) => {
          host.ui.notice(error instanceof Error ? error.message : String(error))
        })
      },
    })
    host.workspace.registerCommand({
      id: 'open-workflow-studio',
      name: createWorkflowLocalizedText('module.open'),
      callback: openView,
    })
    host.chat.registerMode({
      id: 'workflow',
      label: createWorkflowLocalizedText('module.name'),
      description: createWorkflowLocalizedText('mode.description'),
      icon: 'workflow',
      personaPrompt: getCopy().mode.persona,
      capability: 'vault-write',
      skills: ['skills/workflow/SKILL.md'],
      tools: [tools.read, tools.create],
    })
  },
})

function WorkflowModuleView({
  viewId,
  editor,
  coordinator,
  getCopy,
  getLocaleSnapshot,
  subscribeLocale,
  agent,
  getModelSnapshot,
  subscribeModels,
  readStyle,
  openFile,
  notice,
  confirm,
}: Readonly<{
  viewId: string
  editor: ReturnType<typeof createWorkflowEditorModel>
  coordinator: WorkflowRunCoordinator
  getCopy(): ReturnType<typeof createWorkflowCopy>
  getLocaleSnapshot(): Readonly<{ locale: string }>
  subscribeLocale(listener: () => void): () => void
  agent: YoloModuleHostApiV1['agent']
  getModelSnapshot(): YoloModuleHostModelSnapshotV1
  subscribeModels(listener: () => void): () => void
  readStyle(): Promise<string>
  openFile(path: string): void | Promise<void>
  notice(message: string): void
  confirm(
    options: Readonly<{
      title: string
      message: string
      ctaText?: string
      cancelText?: string
    }>,
  ): Promise<boolean>
}>) {
  const [styleText, setStyleText] = useState('')
  useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot)
  const models = useSyncExternalStore(
    subscribeModels,
    getModelSnapshot,
    getModelSnapshot,
  )
  const editorSnapshot = useSyncExternalStore(
    editor.subscribe,
    editor.getSnapshot,
    editor.getSnapshot,
  )
  // One run selection layer per view over the shared module Coordinator.
  const runs = useMemo(() => createRunSnapshotIndex(coordinator), [coordinator])
  const runByPath = useSyncExternalStore(
    runs.subscribe,
    runs.getSnapshot,
    runs.getSnapshot,
  )
  const currentRun =
    editorSnapshot.path === null
      ? null
      : (runByPath[editorSnapshot.path] ?? null)
  const startRun = useCallback(
    (input: JsonValue, modelId: string): void => {
      const snapshot = editor.getSnapshot()
      if (!snapshot.path || !snapshot.bundle) return
      void coordinator
        .start({
          workflowPath: snapshot.path,
          bundle: snapshot.bundle,
          modelSnapshot: { ...models, defaultModelId: modelId },
          input,
        })
        .then((result) => {
          if (!result.ok)
            notice(
              runStartFailureMessage(result.reason, getCopy(), result.error),
            )
        })
        .catch((error: unknown) =>
          notice(error instanceof Error ? error.message : String(error)),
        )
    },
    [coordinator, editor, getCopy, models, notice],
  )
  const cancelRun = useCallback((): void => {
    const path = editor.getSnapshot().path
    if (path !== null) void coordinator.cancel(path)
  }, [coordinator, editor])
  const continueRun = useCallback((): void => {
    const path = editor.getSnapshot().path
    if (path === null) return
    void coordinator
      .continueRun(path, { confirmSideEffects: true })
      .then((result) => {
        if (result.ok) return
        if (result.reason === 'already-running') {
          notice(getCopy().run.alreadyRunning)
          return
        }
        notice(result.error?.message ?? getCopy().run.error)
      })
      .catch((error: unknown) =>
        notice(error instanceof Error ? error.message : String(error)),
      )
  }, [coordinator, editor, getCopy, notice])
  useEffect(() => {
    let active = true
    void readStyle()
      .then((css) => {
        if (active) setStyleText(css)
      })
      .catch((error: unknown) => {
        if (active) console.error('Workflow module style failed to load', error)
      })
    return () => {
      active = false
    }
  }, [readStyle])
  return (
    <div
      className="yolo-workflow-module-root"
      data-yolo-view-id={viewId}
      data-yolo-run-status={currentRun?.status ?? ''}
    >
      {styleText ? (
        <style data-yolo-workflow-style="true">{styleText}</style>
      ) : null}
      <WorkflowStudio
        model={editor}
        copy={getCopy()}
        openFile={openFile}
        notice={notice}
        confirm={confirm}
        agent={agent}
        models={models}
        run={currentRun}
        onStart={startRun}
        onCancel={cancelRun}
        onContinue={continueRun}
      />
    </div>
  )
}

function runStartFailureMessage(
  reason: WorkflowRunStartFailureReason,
  copy: WorkflowCopy,
  error?: WorkflowRunError,
): string {
  if (reason === 'already-running') return copy.run.alreadyRunning
  if (reason === 'model-unavailable') return copy.run.noModel
  if (reason === 'invalid-definition') return copy.run.invalidDefinition
  return error?.message ?? copy.run.error
}
