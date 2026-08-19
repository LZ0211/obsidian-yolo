import type { ReactElement } from 'react'

import { updateWorkflowManagedBlocks } from './domain/workflow-document'
import type { WorkflowNode, WorkflowTopology } from './domain/workflow-model'
import { createWorkflowRepository } from './domain/workflow-repository'
import { createWorkflowDefinition } from './execution/workflow-definition'
import type { WorkflowRunCoordinatorWithNodeTests } from './execution/workflow-run-coordinator'
import { createWorkflowRunStore } from './execution/workflow-run-store'
import type { WorkflowRunSnapshot } from './execution/workflow-run-types'
import { createWorkflowCopy } from './i18n'
import type { WorkflowEditorModel } from './ui/workflow-editor-model'

type WorkflowModuleDefinition = Readonly<{
  activate(host: YoloModuleHostApiV1): void | Promise<void>
}>

type WorkflowModuleViewProps = Readonly<{
  viewId: string
  editor: WorkflowEditorModel
  coordinator: WorkflowRunCoordinatorWithNodeTests
  runs: Readonly<{
    subscribe(listener: () => void): () => void
    getSnapshot(): Readonly<Record<string, WorkflowRunSnapshot>>
  }>
}>

type RegisteredView = Readonly<{
  render(context: unknown): ReactElement<WorkflowModuleViewProps>
  setState?(
    state: Readonly<Record<string, unknown>>,
    context: unknown,
  ): Promise<void>
}>

let moduleDefinition: WorkflowModuleDefinition | null = null

describe('workflow execution lifecycle through the module', () => {
  it('executes input -> agent -> output and maps the run to background activities', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    await activateModule(host)

    const element = registeredView(host).render(createViewContext('view-1'))
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    expect(editor.getSnapshot().issues).toEqual([])

    const activityId = 'workflow:run:demo/WORKFLOW.md'
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started).toEqual({ ok: true, runId: expect.any(String) })
    if (!started.ok) return

    const snapshot = await terminalStoredRun(host.store, 'demo/WORKFLOW.md')
    expect(snapshot.status).toBe('succeeded')
    expect(snapshot.outputs).toEqual({ output: { ok: true } })
    expect(snapshot.nodes.agent).toMatchObject({ status: 'succeeded' })
    expect(snapshot.error).toBeUndefined()
    expect(snapshot.finishedAt).toEqual(expect.any(Number))

    // The activity is removed as soon as the run succeeds, and the
    // awaiting_approval tool event flipped it to waiting mid-run.
    expect(host.background.activities.get(activityId)).toBeUndefined()
    expect(
      host.background.upsert.mock.calls.some(
        ([activity]) =>
          activity.id === activityId && activity.status === 'running',
      ),
    ).toBe(true)
    expect(
      host.background.upsert.mock.calls.some(
        ([activity]) =>
          activity.id === activityId && activity.status === 'waiting',
      ),
    ).toBe(true)
    // A plain run never shows the repairing detail: the host's own
    // `running` tool events for the submit tool are not repair hints.
    expect(
      host.background.upsert.mock.calls.some(
        ([activity]) => activity.detail === 'Repairing output…',
      ),
    ).toBe(false)
    expect(host.background.remove).toHaveBeenCalledWith(activityId)
  })

  it('recovers a persisted running snapshot to interrupted with a reminder activity', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    const repository = createWorkflowRepository(host.api)
    const bundle = await repository.read('demo/WORKFLOW.md')
    expect(bundle).not.toBeNull()
    const built = await createWorkflowDefinition(bundle!, host.modelSnapshot)
    expect(built.ok).toBe(true)
    if (!built.ok) return
    await host.store.write({
      schemaVersion: 1,
      runId: 'recovered-run',
      workflowPath: 'demo/WORKFLOW.md',
      definition: built.definition,
      input: { topic: 'integration' },
      status: 'running',
      nodes: {
        input: { status: 'succeeded', output: { topic: 'integration' } },
        agent: { status: 'running', startedAt: 1000 },
        output: { status: 'pending' },
      },
      outputs: {},
      startedAt: 1000,
    } satisfies WorkflowRunSnapshot)
    expect(host.background.activities.size).toBe(0)

    await activateModule(host)

    const stored = await host.store.read('demo/WORKFLOW.md')
    expect(stored?.status).toBe('interrupted')
    expect(stored?.finishedAt).toBeGreaterThanOrEqual(1000)
    const activity = host.background.activities.get(
      'workflow:run:demo/WORKFLOW.md',
    )
    expect(activity?.status).toBe('reminder')
    await activity?.onOpen?.()
    expect(host.openView).toHaveBeenCalledWith({
      state: { path: 'demo/WORKFLOW.md' },
    })

    // A view opened after activation already sees the recovered run through
    // the shared module-level run selection layer: Continue is reachable
    // instead of the view showing `run === null`.
    const element = registeredView(host).render(createViewContext('view-1'))
    expect(element.props.runs.getSnapshot()['demo/WORKFLOW.md']?.status).toBe(
      'interrupted',
    )
  })

  it('shares one run selection layer across views and reflects later publishes', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    await activateModule(host)

    const view = registeredView(host)
    const firstElement = view.render(createViewContext('view-1'))
    const secondElement = view.render(createViewContext('view-2'))
    const firstRuns = firstElement.props.runs
    const secondRuns = secondElement.props.runs
    // One module-level selection layer, not one per view.
    expect(firstRuns).toBe(secondRuns)
    expect(firstRuns.getSnapshot()).toEqual({})

    const { coordinator, editor } = firstElement.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await terminalStoredRun(host.store, 'demo/WORKFLOW.md')

    // Both views observe the terminal snapshot through the shared layer.
    expect(firstRuns.getSnapshot()['demo/WORKFLOW.md']?.status).toBe(
      'succeeded',
    )
    expect(secondRuns.getSnapshot()['demo/WORKFLOW.md']?.status).toBe(
      'succeeded',
    )
  })

  it('keeps a full run running when the view that started it is disposed', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    const gate = deferred()
    host.agent = createFakeAgent({ gate: gate.promise })
    await activateModule(host)

    const view = registeredView(host)
    const context = createViewContext('view-1')
    const element = view.render(context)
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()

    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    expect((await host.store.read('demo/WORKFLOW.md'))?.status).toBe('running')

    // View cleanup disposes only the view editor; the full run continues.
    context.dispose()
    gate.resolve()

    const snapshot = await terminalStoredRun(host.store, 'demo/WORKFLOW.md')
    expect(snapshot.status).toBe('succeeded')
    expect(host.background.activities.size).toBe(0)
    expect(host.background.remove).toHaveBeenCalledWith(
      'workflow:run:demo/WORKFLOW.md',
    )

    // A fresh render for the same view id gets a new editor: the disposed
    // editor was removed from the per-view registry, while the module
    // coordinator is still the same instance.
    const replacement = view.render(context)
    expect(replacement.props.editor).not.toBe(editor)
    expect(replacement.props.coordinator).toBe(coordinator)
  })

  it('quiesce converts an active run to interrupted', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    const gate = deferred()
    host.agent = createFakeAgent({ gate: gate.promise })
    await activateModule(host)

    const element = registeredView(host).render(createViewContext('view-1'))
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    expect(host.onQuiesce).toHaveBeenCalledTimes(1)
    await host.onQuiesce.mock.calls[0][0]()

    const stored = await host.store.read('demo/WORKFLOW.md')
    expect(stored?.status).toBe('interrupted')
    expect(
      host.background.activities.get('workflow:run:demo/WORKFLOW.md')?.status,
    ).toBe('reminder')

    // Let the gated agent settle: the aborted executor call must not mutate
    // the already-interrupted record.
    gate.resolve()
    await expect(host.store.read('demo/WORKFLOW.md')).resolves.toMatchObject({
      status: 'interrupted',
    })
  })

  it('tests a single node through the same executor path without touching run state', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    const agentRequests: HostAgentRequest[] = []
    host.agent = createFakeAgent({
      onRequest: (request) => agentRequests.push(request),
    })
    await activateModule(host)

    const element = registeredView(host).render(createViewContext('view-1'))
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await terminalStoredRun(host.store, 'demo/WORKFLOW.md')
    const record = await host.store.read('demo/WORKFLOW.md')
    const callsBefore = agentRequests.length

    const result = await coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'agent',
      input: { topic: 'preview' },
    })

    // The structured submission tool result comes back unchanged.
    expect(result).toEqual({ value: { ok: true } })
    // The full-run record and background registry are untouched.
    expect(await host.store.read('demo/WORKFLOW.md')).toEqual(record)
    expect(host.background.activities.size).toBe(0)

    // The test went through the same real executor path: same model
    // resolution, prompt construction, and vault-write capability.
    expect(agentRequests.length).toBe(callsBefore + 1)
    const request = agentRequests.at(-1)!
    expect(request.capability).toBe('vault-write')
    expect(request.modelId).toBe('default-model')
    expect(request.activity).toEqual({
      title: 'demo/WORKFLOW.md',
      detail: 'Agent',
    })
    expect(request.systemPrompt).toContain('# Agent')
    expect(request.prompt).toContain('"workflowInput":{"topic":"preview"}')
  })

  it('aborts the view-scoped node test when the view is disposed', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    const gate = deferred()
    await activateModule(host)

    const view = registeredView(host)
    const context = createViewContext('view-1')
    const element = view.render(context)
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await terminalStoredRun(host.store, 'demo/WORKFLOW.md')
    const record = await host.store.read('demo/WORKFLOW.md')

    // The agent wrapper forwards to the current agent at call time, so the
    // node test can park on a gate while the seed run used the fast agent.
    host.agent = createFakeAgent({ gate: gate.promise })
    const test = coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'agent',
      input: { topic: 'preview' },
    })
    await new Promise((resolve) => setTimeout(resolve, 20))

    context.dispose()
    gate.resolve()

    await expect(test).rejects.toMatchObject({ code: 'cancelled' })
    expect(await host.store.read('demo/WORKFLOW.md')).toEqual(record)
    expect(host.background.activities.size).toBe(0)
  })

  it('pause, reload, resume, and rename keep the run recoverable', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    const gate = deferred()
    host.agent = createFakeAgent({
      gate: gate.promise,
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    })
    await activateModule(host)

    const element = registeredView(host).render(createViewContext('view-1'))
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    // The held agent call keeps the run mid-flight; pause parks the chain.
    await until(async () => {
      const record = await host.store.read('demo/WORKFLOW.md')
      return record?.nodes.agent.status === 'running'
    })
    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(true)
    gate.resolve()
    await until(async () => {
      const record = await host.store.read('demo/WORKFLOW.md')
      return (
        record?.nodes.agent.status === 'succeeded' && record.paused === true
      )
    })
    let record = await host.store.read('demo/WORKFLOW.md')
    expect(record?.status).toBe('running')
    expect(record?.paused).toBe(true)
    expect(record?.nodes.output.status).toBe('pending')

    // Re-activate the module over the same store: the recovered paused run
    // publishes into the fresh module-level run selection layer.
    await moduleDefinition!.activate(host.api)
    const recoveredView = host.workspace.registerView.mock
      .calls[1]?.[0] as RegisteredView
    const recovered = recoveredView.render(createViewContext('view-2'))
    expect(recovered.props.runs.getSnapshot()['demo/WORKFLOW.md']?.status).toBe(
      'running',
    )
    expect(recovered.props.runs.getSnapshot()['demo/WORKFLOW.md']?.paused).toBe(
      true,
    )
    // The paused recovered run maps to a waiting background activity.
    expect(
      host.background.upsert.mock.calls.some(
        ([activity]) =>
          activity.id === 'workflow:run:demo/WORKFLOW.md' &&
          activity.status === 'waiting',
      ),
    ).toBe(true)

    // Resume with the side-effect confirmation. The agent node already
    // succeeded with its usage before the pause; the resume re-executes only
    // the remaining output node, so the run-level usage keeps the agent's.
    const continued = await recovered.props.coordinator.continueRun(
      'demo/WORKFLOW.md',
      { confirmSideEffects: true },
    )
    expect(continued).toEqual({ ok: true, runId: record!.runId })
    await terminalStoredRun(host.store, 'demo/WORKFLOW.md')
    record = await host.store.read('demo/WORKFLOW.md')
    expect(record?.status).toBe('succeeded')
    expect(record?.nodes.agent.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    })
    expect(record?.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    })

    // Rename after success: the record migrates and the path-keyed surfaces
    // follow (the view-level lease and index re-key are covered by the
    // module view tests).
    await recovered.props.coordinator.notifyRenamedWorkflow(
      'demo/WORKFLOW.md',
      'renamed/WORKFLOW.md',
    )
    const migrated = await host.store.read('renamed/WORKFLOW.md')
    expect(migrated).not.toBeNull()
    expect(migrated?.workflowPath).toBe('renamed/WORKFLOW.md')
    expect(migrated?.definition.workflowPath).toBe('renamed/WORKFLOW.md')
    expect(migrated?.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    })
    expect(await host.store.read('demo/WORKFLOW.md')).toBeNull()
    expect(
      recovered.props.runs.getSnapshot()['renamed/WORKFLOW.md']?.status,
    ).toBe('succeeded')
    // No stale background activity under the old path id.
    expect(
      host.background.activities.get('workflow:run:demo/WORKFLOW.md'),
    ).toBeUndefined()
    // continueRun resolves the migrated path (a succeeded record is final,
    // so the answer proves the path resolved instead of a not-found).
    expect(
      await recovered.props.coordinator.continueRun('renamed/WORKFLOW.md', {
        confirmSideEffects: true,
      }),
    ).toEqual({ ok: false, reason: 'not-continuable' })
  })

  it('usage aggregates across nodes into the run record', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    host.agent = createFakeAgent({
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    })
    await activateModule(host)

    const element = registeredView(host).render(createViewContext('view-1'))
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return
    await terminalStoredRun(host.store, 'demo/WORKFLOW.md')

    const record = await host.store.read('demo/WORKFLOW.md')
    expect(record?.nodes.agent.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    })
    expect(record?.usage).toEqual({
      inputTokens: 7,
      outputTokens: 3,
      totalTokens: 10,
    })
  })

  it('repairs a rejected schema submission end to end', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host)
    const agentRequests: HostAgentRequest[] = []
    host.agent = createFakeAgent({
      onRequest: (request) => agentRequests.push(request),
      // Round 1 submits a wrong-typed value (rejected by the run-scoped
      // tool); the executor's repair round submits the corrected value.
      outputValues: [{ ok: 'not-a-boolean' }, { ok: true }],
    })
    await activateModule(host)

    const element = registeredView(host).render(createViewContext('view-1'))
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started).toEqual({ ok: true, runId: expect.any(String) })
    if (!started.ok) return

    const snapshot = await terminalStoredRun(host.store, 'demo/WORKFLOW.md')
    expect(snapshot.status).toBe('succeeded')
    // The run output is the repaired round-2 value, not the rejected one.
    expect(snapshot.outputs).toEqual({ output: { ok: true } })
    expect(snapshot.nodes.agent).toMatchObject({ status: 'succeeded' })
    // Two streams: the original round and the repair round, whose prompt
    // carries the rejection feedback from round 1.
    expect(agentRequests).toHaveLength(2)
    expect(agentRequests[1].prompt).toContain(
      'previous submission was rejected',
    )
    // The executor's repair hint surfaces in the background activity: a
    // running upsert carrying the repairing detail lands between the
    // rejected first round and the repaired second round, so users can tell
    // repair-in-progress from a plain running node.
    expect(
      host.background.upsert.mock.calls.some(
        ([activity]) =>
          activity.id === 'workflow:run:demo/WORKFLOW.md' &&
          activity.status === 'running' &&
          activity.detail === 'Repairing output…',
      ),
    ).toBe(true)
  })

  it('verification hard failure fails the run with verification-failed', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host, {
      verification: {
        schema: {
          type: 'object',
          properties: { ok: { const: true } },
          required: ['ok'],
          additionalProperties: false,
        },
        mode: 'hard',
      },
    })
    // The submitted value passes the node output schema ({ ok: boolean })
    // but violates the hard verification postcondition ({ ok: true }).
    host.agent = createFakeAgent({ outputValues: [{ ok: false }] })
    await activateModule(host)

    const element = registeredView(host).render(createViewContext('view-1'))
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      input: { topic: 'integration' },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const snapshot = await terminalStoredRun(host.store, 'demo/WORKFLOW.md')
    expect(snapshot.status).toBe('failed')
    expect(snapshot.nodes.agent).toMatchObject({
      status: 'failed',
      error: { code: 'verification-failed', nodeId: 'agent' },
    })
    expect(snapshot.error).toMatchObject({
      code: 'verification-failed',
      nodeId: 'agent',
      message: expect.stringMatching(/^verification: /),
    })
  })

  it('routes a tier alias to the mapped model', async () => {
    const host = new ExecutionHost()
    seedWorkflow(host, { modelId: 'deep' })
    const agentRequests: HostAgentRequest[] = []
    host.agent = createFakeAgent({
      onRequest: (request) => agentRequests.push(request),
    })
    await activateModule(host)

    const element = registeredView(host).render(createViewContext('view-1'))
    const { coordinator, editor } = element.props
    await editor.load('demo/WORKFLOW.md')
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    const started = await coordinator.start({
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle!,
      modelSnapshot: host.modelSnapshot,
      tierMap: { deep: 'deep-model' },
      input: { topic: 'integration' },
    })
    expect(started.ok).toBe(true)
    if (!started.ok) return

    const snapshot = await terminalStoredRun(host.store, 'demo/WORKFLOW.md')
    expect(snapshot.status).toBe('succeeded')
    // The alias resolved to the mapped model both in the frozen definition
    // and on the agent request the executor made.
    expect(snapshot.definition.modelByNodeId.agent).toBe('deep-model')
    expect(agentRequests).toHaveLength(1)
    expect(agentRequests[0].modelId).toBe('deep-model')
  })
})

async function activateModule(host: ExecutionHost): Promise<void> {
  await moduleDefinition!.activate(host.api)
}

function registeredView(host: ExecutionHost): RegisteredView {
  const view = host.workspace.registerView.mock.calls[0]?.[0] as
    | RegisteredView
    | undefined
  expect(view).toBeDefined()
  return view!
}

function createViewContext(id: string) {
  const disposers: Array<() => void> = []
  return {
    id,
    document: {} as Document,
    window: {} as Window,
    lifecycle: {
      add: (disposer: () => void) => {
        disposers.push(disposer)
      },
    },
    dispose: () => {
      for (const disposer of disposers.splice(0)) disposer()
    },
  }
}

/**
 * Resolves with the first persisted non-running record. The coordinator
 * publishes a terminal snapshot before its store write lands, so asserting
 * on the store (rather than the publish) keeps the assertion race-free.
 */
async function terminalStoredRun(
  store: ReturnType<typeof createWorkflowRunStore>,
  workflowPath: string,
  timeoutMs = 2000,
): Promise<WorkflowRunSnapshot> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const snapshot = await store.read(workflowPath)
    if (snapshot !== null && snapshot.status !== 'running') return snapshot
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for a terminal run record for ${workflowPath}`,
      )
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

function deferred(): Readonly<{
  promise: Promise<void>
  resolve(): void
}> {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function seedWorkflow(
  host: ExecutionHost,
  agentPatch?: Readonly<Partial<WorkflowNode>>,
): void {
  const copy = createWorkflowCopy('en')
  const manifest = updateWorkflowManagedBlocks(
    '# Demo\n',
    createTopology(agentPatch),
    copy,
  )
  host.file('managed/workflows/demo/WORKFLOW.md', manifest)
  host.file('managed/workflows/demo/steps/input/STEP.md', '# Input\n')
  host.file('managed/workflows/demo/steps/agent/STEP.md', '# Agent\n')
  host.file('managed/workflows/demo/steps/output/STEP.md', '# Output\n')
}

function createTopology(
  agentPatch: Readonly<Partial<WorkflowNode>> = {},
): WorkflowTopology {
  return {
    revision: 1,
    nodes: [
      {
        id: 'input',
        kind: 'input',
        label: 'Input',
        stepPath: 'steps/input/STEP.md',
        position: { x: 70, y: 90 },
      },
      {
        id: 'agent',
        kind: 'agent',
        label: 'Agent',
        stepPath: 'steps/agent/STEP.md',
        position: { x: 315, y: 90 },
        outputSchema: {
          type: 'object',
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
          additionalProperties: false,
        },
        ...agentPatch,
      },
      {
        id: 'output',
        kind: 'output',
        label: 'Output',
        stepPath: 'steps/output/STEP.md',
        position: { x: 560, y: 90 },
      },
    ],
    edges: [
      { id: 'input-agent', source: 'input', target: 'agent' },
      { id: 'agent-output', source: 'agent', target: 'output' },
    ],
  }
}

type HostAgentRequest = Parameters<YoloModuleHostApiV1['agent']['stream']>[0]

/**
 * Host-side agent stand-in: announces awaiting_approval, submits the node's
 * result through the run-scoped `submit_workflow_output` tool exactly like
 * the real host dispatcher, then completes. With `gate` the stream parks
 * until released, which lets tests observe the running activity and abort
 * the run from the host side.
 */
function createFakeAgent(
  options: Readonly<{
    gate?: Promise<void>
    onRequest?: (request: HostAgentRequest) => void
    usage?: Readonly<{
      inputTokens?: number
      outputTokens?: number
      totalTokens?: number
    }>
    /**
     * Scripted values for `submit_workflow_output`, one per executor round:
     * round 1 submits index 0, the repair round index 1, and so on. A
     * rejected submission ends its round normally (the executor starts the
     * repair round instead of failing the node); an accepted one completes
     * the round. Exhausted scripts fall back to `{ ok: true }`, the same
     * value the unscripted agent always submits.
     */
    outputValues?: readonly unknown[]
  }> = {},
): YoloModuleHostApiV1['agent'] {
  type HostAgentEvent =
    ReturnType<YoloModuleHostApiV1['agent']['stream']> extends AsyncIterable<
      infer Event
    >
      ? Event
      : never
  let outputRound = 0
  const stream = async function* (
    request: HostAgentRequest,
  ): AsyncGenerator<HostAgentEvent> {
    options.onRequest?.(request)
    const tool = request.tools?.find(
      (candidate) => candidate.name === 'submit_workflow_output',
    )
    if (tool) {
      yield {
        type: 'tool',
        name: tool.name,
        status: 'awaiting_approval',
        arguments: {},
      }
      if (options.gate) await options.gate
      if (request.signal?.aborted) return
      // Once approved, the host's dispatcher executes the call and emits a
      // `running` tool event; the module wiring must not mistake this plain
      // execution event for the executor's repair-round hint.
      yield { type: 'tool', name: tool.name, status: 'running', arguments: {} }
      const scripted = options.outputValues
      const value = scripted ? scripted[outputRound++] : { ok: true }
      const result = await tool.handler({ value })
      if (result.isError) {
        // Rejected: announce the failed submission like the host's
        // in-process tool server does (isError -> error tool status), then
        // end the round without a stream-level error so the executor
        // records the rejection and runs its repair round.
        yield { type: 'tool', name: tool.name, status: 'error' }
        yield { type: 'completed', text: 'done' }
        return
      }
      yield { type: 'tool', name: tool.name, status: 'completed' }
      yield {
        type: 'completed',
        text: 'done',
        ...(options.usage ? { usage: options.usage } : {}),
      }
      return
    }
    // Text-mode calls (no tools): finish in plain text.
    if (options.gate) await options.gate
    if (request.signal?.aborted) return
    yield {
      type: 'completed',
      text: 'done',
      ...(options.usage ? { usage: options.usage } : {}),
    }
  }
  return { stream }
}

const until = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type BackgroundActivity = Parameters<
  YoloModuleHostApiV1['background']['upsert']
>[0]

/**
 * In-memory ModulePrivateStorageScopeV1 stand-in recording every blob. The
 * module's run store only uses `list`/`readText`/`writeText`/`removeFile`;
 * the rest exists so the fixture matches the real scope shape.
 */
function fakePrivateStorageScope() {
  const blobs = new Map<string, string>()
  return {
    blobs,
    list: jest.fn(async (directoryPrefix?: string) => {
      const prefix = directoryPrefix === undefined ? '' : `${directoryPrefix}/`
      return [...blobs.keys()].filter((key) => key.startsWith(prefix)).sort()
    }),
    stat: jest.fn(async (key: string) =>
      blobs.has(key)
        ? { type: 'file' as const, size: blobs.get(key)!.length }
        : null,
    ),
    readJson: jest.fn(async (key: string) => {
      const raw = blobs.get(key)
      return raw === undefined ? null : (JSON.parse(raw) as unknown)
    }),
    readText: jest.fn(async (key: string) => blobs.get(key) ?? null),
    writeJson: jest.fn(async (key: string, value: unknown) => {
      blobs.set(key, JSON.stringify(value))
    }),
    writeText: jest.fn(async (key: string, value: string) => {
      blobs.set(key, value)
    }),
    mkdir: jest.fn(async () => undefined),
    removeFile: jest.fn(async (key: string) => blobs.delete(key)),
  }
}

/** Background registry recording every upsert/remove in call order. */
function fakeBackgroundRegistry() {
  const activities = new Map<string, BackgroundActivity>()
  return {
    activities,
    upsert: jest.fn((activity: BackgroundActivity) => {
      activities.set(activity.id, activity)
    }),
    remove: jest.fn((id: string) => {
      activities.delete(id)
    }),
  }
}

class ExecutionHost {
  readonly files = new Map<string, string>()
  private readonly folders = new Set<string>()
  readonly deviceLocal = fakePrivateStorageScope()
  readonly background = fakeBackgroundRegistry()
  readonly openView = jest.fn(async () => undefined)
  readonly onQuiesce = jest.fn()
  readonly modelSnapshot: YoloModuleHostModelSnapshotV1 = {
    defaultModelId: 'default-model',
    models: [
      { id: 'default-model', name: 'Default model', providerId: 'provider' },
      { id: 'explicit-model', name: 'Explicit model', providerId: 'provider' },
      // Mapped target for the tier-alias routing test.
      { id: 'deep-model', name: 'Deep model', providerId: 'provider' },
    ],
  }
  /** Swappable per test; `api.agent` forwards to the current value. */
  agent: YoloModuleHostApiV1['agent'] = createFakeAgent()
  readonly workspace = {
    registerView: jest.fn(),
    registerRibbonAction: jest.fn(),
    registerCommand: jest.fn(),
    openView: this.openView,
  }
  /** Test-side store over the same device-local scope the module writes to. */
  readonly store = createWorkflowRunStore(this.deviceLocal)

  readonly api = {
    agent: {
      stream: (
        request: Parameters<YoloModuleHostApiV1['agent']['stream']>[0],
      ) => this.agent.stream(request),
    },
    assets: { readText: jest.fn(async () => '') },
    background: this.background,
    chat: { registerMode: jest.fn() },
    i18n: {
      getSnapshot: () => ({ locale: 'en' }),
      subscribe: () => () => undefined,
    },
    lifecycle: {
      add: jest.fn(),
      whenActive: jest.fn(),
      onQuiesce: this.onQuiesce,
    },
    paths: {
      getSnapshot: () => ({ contentRoot: 'managed/workflows' }),
      subscribe: () => () => undefined,
      runExclusive: async <T>(
        _namespace: string,
        operation: () => T | PromiseLike<T>,
      ) => operation(),
    },
    privateStorage: {
      synchronized: fakePrivateStorageScope(),
      deviceLocal: this.deviceLocal,
    },
    settings: {
      getModelSnapshot: () => this.modelSnapshot,
      subscribeModels: () => () => undefined,
    },
    ui: {
      notice: jest.fn(),
      confirm: jest.fn(async () => true),
      openFileAt: jest.fn(async () => true),
    },
    vault: {
      getEntry: (path: string) => this.entry(path),
      listChildren: (folder: string) => this.children(folder),
      exists: async (path: string) =>
        this.files.has(path) || this.folders.has(path),
      readTextSnapshot: async (path: string) => {
        const content = this.files.get(path)
        return content === undefined ? null : { path, content }
      },
      ensureFolder: async (path: string) => this.addFolder(path),
      createTextIfAbsent: async (path: string, content: string) => {
        if (this.files.has(path)) return null
        this.file(path, content)
        return { path, content }
      },
      replaceTextIfUnchanged: async (
        expected: { path: string; content: string },
        content: string,
      ) => {
        if (this.files.get(expected.path) !== expected.content) return null
        this.file(expected.path, content)
        return { path: expected.path, content }
      },
      trashPath: async (path: string) => {
        const prefix = `${path}/`
        const targets = [...this.files.keys()].filter(
          (filePath) => filePath === path || filePath.startsWith(prefix),
        )
        for (const target of targets) this.files.delete(target)
        return targets.length > 0
      },
      removeFileExact: async (path: string) => this.files.delete(path),
      subscribe: () => () => undefined,
    },
    workspace: this.workspace,
  } as unknown as YoloModuleHostApiV1

  file(path: string, content: string): void {
    this.addFolder(path.slice(0, path.lastIndexOf('/')))
    this.files.set(path, content)
  }

  private addFolder(path: string): void {
    const parts = path.split('/').filter(Boolean)
    for (let index = 1; index <= parts.length; index++)
      this.folders.add(parts.slice(0, index).join('/'))
  }

  private entry(path: string) {
    if (this.files.has(path))
      return {
        kind: 'file' as const,
        path,
        name: path.split('/').at(-1)!,
        ctime: 0,
        mtime: 0,
      }
    if (this.folders.has(path))
      return { kind: 'folder' as const, path, name: path.split('/').at(-1)! }
    return null
  }

  private children(folder: string) {
    const prefix = `${folder}/`
    const paths = [...this.folders, ...this.files.keys()].filter(
      (path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    )
    return paths.map((path) => this.entry(path)!).filter(Boolean)
  }
}

// Register the module once per test file, mirroring the host entry flow.
beforeAll(async () => {
  const registerModule = jest.fn()
  Object.defineProperty(globalThis, 'yolo', {
    configurable: true,
    value: { registerModule },
  })
  await import('./index')
  moduleDefinition = registerModule.mock.calls[0]?.[0] ?? null
  expect(moduleDefinition).not.toBeNull()
})
