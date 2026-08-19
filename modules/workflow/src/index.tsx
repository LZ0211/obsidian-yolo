import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import { createWorkflowRepository } from './domain/workflow-repository'
import { createWorkflowChatTools } from './domain/workflow-tools'
import { createWorkflowNodeExecutor } from './execution/workflow-node-executor'
import {
  type WorkflowRunCoordinatorWithNodeTests,
  createWorkflowRunCoordinator,
} from './execution/workflow-run-coordinator'
import { createWorkflowRunStore } from './execution/workflow-run-store'
import type {
  JsonValue,
  WorkflowNodeExecutionResult,
  WorkflowRunError,
  WorkflowRunSnapshot,
  WorkflowRunStartFailureReason,
  WorkflowRunStore,
  WorkflowTier,
  WorkflowTierMap,
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
 * without copying run state into React local state. One module-level layer is
 * created before `initialize()` and passed to every view, so recovered runs
 * publish into the layer and all views observe the same run.
 */
type RunSnapshotIndex = Readonly<{
  subscribe(listener: () => void): () => void
  getSnapshot(): Readonly<Record<string, WorkflowRunSnapshot>>
  /** Drops the key of a renamed path; the migrated record lives under the new key. */
  remove(path: string): void
}>

/**
 * The layer subscribes to the Coordinator eagerly at creation, so publishes
 * that happen before any view exists (recovery during `initialize()`) still
 * land in the layer. Views register listeners through the returned
 * `subscribe`; every publish notifies all of them.
 */
function createRunSnapshotIndex(
  coordinator: WorkflowRunCoordinatorWithNodeTests,
): RunSnapshotIndex {
  let snapshots: Readonly<Record<string, WorkflowRunSnapshot>> = Object.freeze(
    {},
  )
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of [...listeners]) {
      try {
        listener()
      } catch {
        // A subscriber failure must not corrupt the run selection layer.
      }
    }
  }
  coordinator.subscribe((snapshot) => {
    snapshots = Object.freeze({
      ...snapshots,
      [snapshot.workflowPath]: snapshot,
    })
    notify()
  })
  return Object.freeze({
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot: () => snapshots,
    remove: (path: string): void => {
      if (!(path in snapshots)) return
      snapshots = Object.freeze(
        Object.fromEntries(
          Object.entries(snapshots).filter(([key]) => key !== path),
        ),
      )
      notify()
    },
  })
}

function workflowRunActivityId(workflowPath: string): string {
  return `${RUN_ACTIVITY_ID_PREFIX}${workflowPath}`
}

/**
 * Reads the flat `tier.<fast|balanced|deep>` settings values out of the
 * module config document; missing or non-string values contribute nothing,
 * so an unconfigured module behaves exactly like a module without settings.
 */
function readWorkflowTierMap(
  snapshot: Readonly<{ schemaVersion: number; data: unknown }>,
): WorkflowTierMap {
  const data = snapshot.data
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
  const record = data as Readonly<Record<string, unknown>>
  const tierMap: Partial<Record<WorkflowTier, string>> = {}
  for (const tier of ['fast', 'balanced', 'deep'] as const) {
    const value = record[`tier.${tier}`]
    if (typeof value === 'string' && value.trim().length > 0)
      tierMap[tier] = value
  }
  return tierMap
}

/**
 * Localized settings contribution for the fast/balanced/deep tier model
 * pickers; the English fallback is mandatory for host-side snapshotting.
 */
function workflowSettingsLocalizations(): YoloModuleHostSettingsContributionV1['localizations'] {
  const title = createWorkflowLocalizedText('settings.title')
  const tierNames = {
    fast: createWorkflowLocalizedText('settings.tier.fast'),
    balanced: createWorkflowLocalizedText('settings.tier.balanced'),
    deep: createWorkflowLocalizedText('settings.tier.deep'),
  }
  const localizations: Record<string, unknown> = {}
  for (const locale of ['en', 'zh', 'it'] as const) {
    localizations[locale] = Object.freeze({
      title: title[locale],
      fields: Object.freeze({
        'tier.fast': Object.freeze({ name: tierNames.fast[locale] }),
        'tier.balanced': Object.freeze({ name: tierNames.balanced[locale] }),
        'tier.deep': Object.freeze({ name: tierNames.deep[locale] }),
      }),
    })
  }
  return Object.freeze(
    localizations,
  ) as YoloModuleHostSettingsContributionV1['localizations']
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
    // Base field strings are the English fallback; localizations carry the
    // per-locale names (en is mandatory for host-side snapshotting). The
    // optional call keeps activation on hosts without the settings capability.
    host.settings.contribute?.({
      id: MODULE_ID,
      icon: 'git-branch',
      title: createWorkflowLocalizedText('settings.title').en,
      fields: [
        {
          key: 'tier.fast',
          type: 'model',
          name: createWorkflowLocalizedText('settings.tier.fast').en,
        },
        {
          key: 'tier.balanced',
          type: 'model',
          name: createWorkflowLocalizedText('settings.tier.balanced').en,
        },
        {
          key: 'tier.deep',
          type: 'model',
          name: createWorkflowLocalizedText('settings.tier.deep').en,
        },
      ],
      localizations: workflowSettingsLocalizations(),
    })
    // Long-lived getter: tier settings are read at run start, so config
    // changes apply without re-activating the module.
    const getTierMap = (): WorkflowTierMap =>
      readWorkflowTierMap(host.config.getSnapshot())
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
        // The view's ephemeral node test is aborted with the view; full runs
        // are module-scoped and keep running.
        coordinator.cancelNodeTest(context.id)
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
    // One module-level run selection layer shared by every view, created
    // before initialize() so recovery publishes land in the layer and a view
    // opened after activation already sees the recovered run.
    const runs = createRunSnapshotIndex(coordinator)
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
              snapshot.paused
                ? 'waiting'
                : isWaitingForApproval(snapshot, pendingApprovalNodeIds)
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
          runs={runs}
          store={store}
          getCopy={getCopy}
          getLocaleSnapshot={host.i18n.getSnapshot}
          subscribeLocale={host.i18n.subscribe}
          agent={host.agent}
          getModelSnapshot={host.settings.getModelSnapshot}
          subscribeModels={host.settings.subscribeModels}
          getTierMap={getTierMap}
          readStyle={readStyle}
          openFile={async (path) => {
            await host.ui.openFileAt({ path })
          }}
          notice={(message) => host.ui.notice(message)}
          confirm={(options) => host.ui.confirm(options)}
          removeRunBackground={(path) =>
            host.background.remove(workflowRunActivityId(path))
          }
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
  runs,
  store,
  getCopy,
  getLocaleSnapshot,
  subscribeLocale,
  agent,
  getModelSnapshot,
  subscribeModels,
  getTierMap,
  readStyle,
  openFile,
  notice,
  confirm,
  removeRunBackground,
}: Readonly<{
  viewId: string
  editor: ReturnType<typeof createWorkflowEditorModel>
  coordinator: WorkflowRunCoordinatorWithNodeTests
  runs: RunSnapshotIndex
  store: WorkflowRunStore
  getCopy(): ReturnType<typeof createWorkflowCopy>
  getLocaleSnapshot(): Readonly<{ locale: string }>
  subscribeLocale(listener: () => void): () => void
  agent: YoloModuleHostApiV1['agent']
  getModelSnapshot(): YoloModuleHostModelSnapshotV1
  subscribeModels(listener: () => void): () => void
  getTierMap(): WorkflowTierMap
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
  removeRunBackground(path: string): void
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
  // The module-level run selection layer shared by every view.
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
      if (coordinator.isRenaming(snapshot.path)) {
        notice(getCopy().run.renameInProgress)
        return
      }
      void coordinator
        .start({
          workflowPath: snapshot.path,
          bundle: snapshot.bundle,
          modelSnapshot: { ...models, defaultModelId: modelId },
          tierMap: getTierMap(),
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
    [coordinator, editor, getCopy, getTierMap, models, notice],
  )
  const pauseRun = useCallback((): void => {
    const path = editor.getSnapshot().path
    if (path === null) return
    void coordinator
      .pause(path)
      .then((paused) => {
        if (!paused) notice(getCopy().run.alreadyRunning)
      })
      .catch((error: unknown) =>
        notice(error instanceof Error ? error.message : String(error)),
      )
  }, [coordinator, editor, getCopy, notice])
  const cancelRun = useCallback((): void => {
    const path = editor.getSnapshot().path
    if (path !== null) void coordinator.cancel(path)
  }, [coordinator, editor])
  const continueRun = useCallback((): void => {
    const path = editor.getSnapshot().path
    if (path === null) return
    if (coordinator.isRenaming(path)) {
      notice(getCopy().run.renameInProgress)
      return
    }
    // The panel resumes a paused run without asking: an in-memory pause
    // resumes cleanly, while a recovered paused run makes the Coordinator
    // answer `side-effect-confirmation-required`. That answer is handled
    // here: confirm once, then retry with the confirmation granted.
    const paused = currentRun?.paused === true
    const attempt = (confirmSideEffects: boolean): Promise<void> =>
      coordinator.continueRun(path, { confirmSideEffects }).then((result) => {
        if (result.ok) return
        if (result.reason === 'already-running') {
          notice(getCopy().run.alreadyRunning)
          return
        }
        if (paused && result.reason === 'side-effect-confirmation-required') {
          return confirm({
            title: getCopy().run.continue,
            message: getCopy().run.confirmSideEffects,
            ctaText: getCopy().run.continue,
            cancelText: getCopy().assistant.cancel,
          }).then((accepted) => {
            if (accepted) return attempt(true)
            return undefined
          })
        }
        notice(result.error?.message ?? getCopy().run.error)
      })
    void attempt(!paused).catch((error: unknown) =>
      notice(error instanceof Error ? error.message : String(error)),
    )
  }, [confirm, coordinator, currentRun, editor, getCopy, notice])
  const renameWorkflow = useCallback(
    (slug: string): Promise<boolean> => {
      const path = editor.getSnapshot().path
      if (path === null) return Promise.resolve(false)
      const copy = getCopy()
      // A rename must not land while a run is active for the path (in-memory,
      // including paused) or while a running+paused record exists
      // (recovered). The lease below refuses start/continueRun for the
      // duration; this reverse check refuses the rename itself.
      if (coordinator.isActive(path)) {
        notice(copy.run.cannotRenameWhileRunning)
        return Promise.resolve(false)
      }
      return store.read(path).then((record) => {
        if (record?.status === 'running' && record.paused) {
          notice(copy.run.cannotRenameWhileRunning)
          return false
        }
        // The lease must precede the rename's own exclusive section (the
        // repository runs the file move under runExclusive) and must be
        // released no matter how the rename settles.
        coordinator.beginRename(path)
        return editor
          .rename(slug)
          .then(async (renamed) => {
            if (!renamed) {
              notice(copy.run.renameFailed)
              return false
            }
            const nextPath = editor.getSnapshot().path
            if (nextPath === null) return false
            await coordinator.notifyRenamedWorkflow(path, nextPath)
            // Drop the stale old-path key; the migrated record was published
            // under the new path.
            runs.remove(path)
            removeRunBackground(path)
            return true
          })
          .catch((error: unknown) => {
            notice(error instanceof Error ? error.message : String(error))
            return false
          })
          .finally(() => {
            coordinator.endRename(path)
          })
      })
    },
    [coordinator, editor, getCopy, notice, removeRunBackground, runs, store],
  )
  const testNode = useCallback(
    // The second parameter is optional so the handler stays assignable to the
    // Studio's pass-through `(nodeId, input?) => Promise<...> | undefined`
    // prop; the Run panel always passes the parsed input, and a missing value
    // is a deterministic null.
    (
      nodeId: string,
      input?: JsonValue,
    ): Promise<WorkflowNodeExecutionResult> => {
      const path = editor.getSnapshot().path
      if (path === null) return Promise.reject(new Error(getCopy().state.empty))
      return coordinator.testNode(viewId, {
        workflowPath: path,
        nodeId,
        input: input ?? null,
      })
    },
    [coordinator, editor, getCopy, viewId],
  )
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
        onPause={pauseRun}
        onCancel={cancelRun}
        onContinue={continueRun}
        onTestNode={testNode}
        onRename={renameWorkflow}
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
  if (reason === 'tier-unavailable') return copy.run.modelTierUnavailable
  if (reason === 'invalid-definition') return copy.run.invalidDefinition
  return error?.message ?? copy.run.error
}
