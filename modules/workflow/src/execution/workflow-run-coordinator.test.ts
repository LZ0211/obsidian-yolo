import type { WorkflowTopology } from '../domain/workflow-model'
import type { WorkflowBundle } from '../domain/workflow-repository'

import { createWorkflowNodeExecutor } from './workflow-node-executor'
import type { WorkflowAgentEvent } from './workflow-node-executor'
import { createWorkflowRunCoordinator } from './workflow-run-coordinator'
import { createWorkflowRunStore } from './workflow-run-store'
import { WorkflowNodeExecutionError } from './workflow-run-types'
import type {
  JsonValue,
  WorkflowModelSnapshot,
  WorkflowNodeExecutionRequest,
  WorkflowNodeExecutionResult,
  WorkflowNodeExecutor,
  WorkflowRunSnapshot,
  WorkflowRunStartInput,
  WorkflowRunStorage,
  WorkflowRunStore,
} from './workflow-run-types'

const modelSnapshot = (): WorkflowModelSnapshot => ({
  defaultModelId: 'model-a',
  models: [{ id: 'model-a', name: 'Model A', providerId: 'provider' }],
})

const runnableTopology = (
  mergeStrategy?: 'concat' | 'dedupe',
): WorkflowTopology => ({
  revision: 1,
  nodes: [
    {
      id: 'in',
      kind: 'input',
      label: 'Request',
      stepPath: 'steps/in/STEP.md',
      position: { x: 0, y: 0 },
    },
    {
      id: 'draft',
      kind: 'agent',
      label: 'Draft',
      stepPath: 'steps/draft/STEP.md',
      position: { x: 1, y: 0 },
    },
    {
      id: 'gate',
      kind: 'condition',
      label: 'Check',
      stepPath: 'steps/gate/STEP.md',
      position: { x: 2, y: 0 },
      gateType: 'ifElse',
    },
    {
      id: 'yes',
      kind: 'agent',
      label: 'Yes',
      stepPath: 'steps/yes/STEP.md',
      position: { x: 3, y: 0 },
    },
    {
      id: 'no',
      kind: 'agent',
      label: 'No',
      stepPath: 'steps/no/STEP.md',
      position: { x: 3, y: 1 },
    },
    {
      id: 'merged',
      kind: 'merge',
      label: 'Merge',
      stepPath: 'steps/merged/STEP.md',
      position: { x: 4, y: 0 },
      ...(mergeStrategy ? { mergeStrategy } : {}),
    },
    {
      id: 'out',
      kind: 'output',
      label: 'Result',
      stepPath: 'steps/out/STEP.md',
      position: { x: 5, y: 0 },
    },
  ],
  edges: [
    { id: 'e-in-draft', source: 'in', target: 'draft' },
    { id: 'e-draft-gate', source: 'draft', target: 'gate' },
    { id: 'e-gate-yes', source: 'gate', target: 'yes', branch: 'true' },
    { id: 'e-gate-no', source: 'gate', target: 'no', branch: 'false' },
    { id: 'e-yes-merged', source: 'yes', target: 'merged' },
    { id: 'e-no-merged', source: 'no', target: 'merged' },
    { id: 'e-merged-out', source: 'merged', target: 'out' },
  ],
})

const bundle = (
  topology: WorkflowTopology,
  path = 'demo/WORKFLOW.md',
): WorkflowBundle => ({
  path,
  document: {
    title: 'Demo workflow',
    content: '# Demo workflow\n\nProse [[link]].\n',
    steps: topology.nodes.map((node) => ({
      nodeId: node.id,
      label: node.label,
      stepPath: node.stepPath,
    })),
    topology,
    issues: [],
  },
  files: [
    {
      nodeId: 'workflow',
      relativePath: path,
      snapshot: { path, content: '# Demo\n' },
    },
    ...topology.nodes.map((node) => ({
      nodeId: node.id,
      relativePath: `${path.slice(0, path.lastIndexOf('/'))}/${node.stepPath}`,
      snapshot: {
        path: `${path.slice(0, path.lastIndexOf('/'))}/${node.stepPath}`,
        content: `# ${node.label}\n`,
      },
    })),
  ],
})

class MemoryStorage implements WorkflowRunStorage {
  readonly blobs = new Map<string, string>()
  /** When set, writes wait for this promise before landing. */
  writeGate: Promise<void> | null = null

  async list(directoryPrefix = ''): Promise<readonly string[]> {
    const prefix = directoryPrefix ? `${directoryPrefix}/` : ''
    return Object.freeze(
      [...this.blobs.keys()].filter((key) => key.startsWith(prefix)).sort(),
    )
  }

  async readText(key: string): Promise<string | null> {
    return this.blobs.get(key) ?? null
  }

  async writeText(key: string, value: string): Promise<void> {
    if (this.writeGate) await this.writeGate
    this.blobs.set(key, value)
  }

  async removeFile(key: string): Promise<boolean> {
    return this.blobs.delete(key)
  }
}

class FakeExecutor implements WorkflowNodeExecutor {
  calls: WorkflowNodeExecutionRequest[] = []
  readonly failOnce = new Set<string>()
  readonly failAlways = new Set<string>()
  /** Requests that stay pending until the test resolves them. */
  readonly pending: {
    request: WorkflowNodeExecutionRequest
    resolve: (result: { value: JsonValue }) => void
    reject: (error: Error) => void
  }[] = []
  /** Raw values, cast per test; runtime validation happens in the coordinator. */
  outputs: Readonly<Record<string, unknown>> = {}

  async execute(request: WorkflowNodeExecutionRequest) {
    this.calls.push(request)
    const nodeId = request.node.id
    if (this.failAlways.has(nodeId)) throw new Error(`boom ${nodeId}`)
    if (this.failOnce.has(nodeId)) {
      this.failOnce.delete(nodeId)
      throw new Error(`boom ${nodeId}`)
    }
    if (Object.prototype.hasOwnProperty.call(this.outputs, nodeId)) {
      return { value: this.outputs[nodeId] as JsonValue }
    }
    if (nodeId in this.pendingByNode) {
      return new Promise<{ value: JsonValue }>((resolve, reject) => {
        this.pending.push({
          request,
          resolve: (result) => resolve(result),
          reject,
        })
      })
    }
    return { value: `value-${nodeId}` }
  }

  pendingByNode: Record<string, boolean> = {}

  hold(nodeId: string): void {
    this.pendingByNode[nodeId] = true
  }

  releaseAll(): void {
    const pending = this.pending.splice(0)
    for (const entry of pending)
      entry.resolve({ value: `late-${entry.request.node.id}` })
  }

  releaseOne(nodeId: string): void {
    const index = this.pending.findIndex(
      (entry) => entry.request.node.id === nodeId,
    )
    if (index < 0) return
    const [entry] = this.pending.splice(index, 1)
    entry.resolve({ value: `late-${nodeId}` })
  }

  testCalls: WorkflowNodeExecutionRequest[] = []
  readonly testFailOnce = new Set<string>()
  readonly testFailAlways = new Set<string>()
  readonly testPending: {
    request: WorkflowNodeExecutionRequest
    resolve: (result: { value: JsonValue }) => void
    reject: (error: Error) => void
  }[] = []
  testOutputs: Readonly<Record<string, unknown>> = {}
  testPendingByNode: Record<string, boolean> = {}

  async testNode(request: WorkflowNodeExecutionRequest) {
    this.testCalls.push(request)
    const nodeId = request.node.id
    if (this.testFailAlways.has(nodeId)) throw new Error(`boom ${nodeId}`)
    if (this.testFailOnce.has(nodeId)) {
      this.testFailOnce.delete(nodeId)
      throw new Error(`boom ${nodeId}`)
    }
    if (Object.prototype.hasOwnProperty.call(this.testOutputs, nodeId)) {
      return { value: this.testOutputs[nodeId] as JsonValue }
    }
    if (this.testPendingByNode[nodeId]) {
      return new Promise<{ value: JsonValue }>((resolve, reject) => {
        this.testPending.push({
          request,
          resolve: (result) => resolve(result),
          reject,
        })
      })
    }
    return { value: `test-${nodeId}` }
  }

  testHold(nodeId: string): void {
    this.testPendingByNode[nodeId] = true
  }

  testReleaseAll(): void {
    const pending = this.testPending.splice(0)
    for (const entry of pending)
      entry.resolve({ value: `late-${entry.request.node.id}` })
  }
}

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const until = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now()
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const makeHarness = <T extends WorkflowNodeExecutor = FakeExecutor>(options: {
  executor?: T
  topology?: WorkflowTopology
  storage?: MemoryStorage
  workflowPath?: string
}) => {
  const executor = options.executor ?? new FakeExecutor()
  const storage = options.storage ?? new MemoryStorage()
  const store = createWorkflowRunStore(storage)
  let now = 1000
  let runCounter = 0
  const coordinator = createWorkflowRunCoordinator({
    executor,
    store,
    now: () => now++,
    createRunId: () => `run-${++runCounter}`,
  })
  const snapshots: WorkflowRunSnapshot[] = []
  coordinator.subscribe((snapshot) => snapshots.push(snapshot))
  const input: WorkflowRunStartInput = {
    workflowPath: options.workflowPath ?? 'demo/WORKFLOW.md',
    bundle: bundle(
      options.topology ?? runnableTopology(),
      options.workflowPath ?? 'demo/WORKFLOW.md',
    ),
    modelSnapshot: modelSnapshot(),
    input: 'proceed',
  }
  return { executor, storage, store, coordinator, snapshots, input }
}

describe('workflow run coordinator', () => {
  it('runs a happy path serially and publishes frozen snapshots', async () => {
    const executor = new FakeExecutor()
    executor.outputs = { draft: 'drafted' }
    const { coordinator, store, snapshots, input } = makeHarness({ executor })

    const start = await coordinator.start(input)
    expect(start).toEqual({ ok: true, runId: 'run-1' })

    await until(() =>
      snapshots.some((snapshot) => snapshot.status === 'succeeded'),
    )

    const latest = await store.read('demo/WORKFLOW.md')
    expect(latest?.status).toBe('succeeded')
    expect(latest?.nodes.in).toMatchObject({
      status: 'succeeded',
      output: 'proceed',
    })
    expect(latest?.nodes.gate).toMatchObject({
      status: 'succeeded',
      conditionResult: true,
      output: 'drafted',
    })
    expect(latest?.nodes.yes).toMatchObject({
      status: 'succeeded',
      output: 'value-yes',
    })
    expect(latest?.nodes.no.status).toBe('skipped')
    expect(latest?.nodes.merged).toMatchObject({
      status: 'succeeded',
      output: 'value-yes',
    })
    expect(latest?.nodes.out).toMatchObject({
      status: 'succeeded',
      output: 'value-yes',
    })
    expect(latest?.outputs).toEqual({ out: 'value-yes' })
    expect(latest?.startedAt).toBe(1000)
    expect(typeof latest?.finishedAt).toBe('number')
    expect(Object.isFrozen(latest)).toBe(true)
    expect(Object.isFrozen(latest?.nodes.in)).toBe(true)
    expect(snapshots[0].nodes.in.status).toBe('pending')
    expect(snapshots.every((snapshot) => snapshot.runId === 'run-1')).toBe(true)
  })

  it('persists all nodes as pending before any external Agent call', async () => {
    const storage = new MemoryStorage()
    const gate = deferred()
    storage.writeGate = gate.promise
    const executor = new FakeExecutor()
    const { coordinator, input } = makeHarness({ executor, storage })

    const start = coordinator.start(input)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(executor.calls.length).toBe(0)

    gate.resolve()
    expect((await start).ok).toBe(true)
    await until(() => executor.calls.length > 0)
  })

  it('marks inactive branches skipped in stable topological order', async () => {
    const { coordinator, store, input } = makeHarness({})

    await coordinator.start(input)
    await until(async () => {
      const snapshot = await store.read('demo/WORKFLOW.md')
      return snapshot?.status === 'succeeded'
    })

    const snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.nodes.no.status).toBe('skipped')
    expect(snapshot?.nodes.yes.status).toBe('succeeded')
  })

  it('stops on the first failed node and persists failed', async () => {
    const executor = new FakeExecutor()
    executor.failOnce.add('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    const start = await coordinator.start(input)
    expect(start.ok).toBe(true)

    await until(async () => {
      const snapshot = await store.read('demo/WORKFLOW.md')
      return snapshot?.status === 'failed'
    })
    const snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.nodes.draft).toMatchObject({
      status: 'failed',
      error: { code: 'agent-failed', nodeId: 'draft', message: 'boom draft' },
    })
    expect(snapshot?.error).toMatchObject({ code: 'agent-failed' })
    expect(snapshot?.nodes.yes.status).toBe('pending')
  })

  it('rejects non-JSON executor output as invalid-output', async () => {
    const executor = new FakeExecutor()
    executor.outputs = { draft: { bad: BigInt(1) } }
    const { coordinator, store, input } = makeHarness({ executor })

    await coordinator.start(input)
    await until(async () => {
      const snapshot = await store.read('demo/WORKFLOW.md')
      return snapshot?.status === 'failed'
    })
    const snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.nodes.draft.error?.code).toBe('invalid-output')
  })

  it('rejects a second start for the same path before async preflight can race', async () => {
    const { coordinator, input } = makeHarness({})
    const first = coordinator.start(input)
    const second = await coordinator.start(input)

    expect(second).toEqual({ ok: false, reason: 'already-running' })
    expect((await first).ok).toBe(true)
  })

  it('allows a new run for the same path after the previous run finished', async () => {
    const { coordinator, store, input } = makeHarness({})

    expect((await coordinator.start(input)).ok).toBe(true)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const second = await coordinator.start({ ...input, input: 'again' })
    expect(second).toEqual({ ok: true, runId: 'run-2' })
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    expect((await store.read('demo/WORKFLOW.md'))?.input).toBe('again')
  })

  it('lets different paths execute independently', async () => {
    const executor = new FakeExecutor()
    const { coordinator, store, input } = makeHarness({ executor })
    const other = makeHarness({
      executor,
      topology: runnableTopology(),
      workflowPath: 'other/WORKFLOW.md',
    })

    const first = coordinator.start(input)
    const second = other.coordinator.start(other.input)
    expect((await first).ok).toBe(true)
    expect((await second).ok).toBe(true)

    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    await until(
      async () =>
        (await other.store.read('other/WORKFLOW.md'))?.status === 'succeeded',
    )
    expect(executor.calls.length).toBe(4)
  })

  it('dedupes multi-source merge output with stable first-seen order', async () => {
    const topology: WorkflowTopology = {
      revision: 1,
      nodes: [
        {
          id: 'in',
          kind: 'input',
          label: 'In',
          stepPath: 'steps/in/STEP.md',
          position: { x: 0, y: 0 },
        },
        {
          id: 'a1',
          kind: 'agent',
          label: 'A1',
          stepPath: 'steps/a1/STEP.md',
          position: { x: 1, y: 0 },
        },
        {
          id: 'a2',
          kind: 'agent',
          label: 'A2',
          stepPath: 'steps/a2/STEP.md',
          position: { x: 1, y: 1 },
        },
        {
          id: 'merged',
          kind: 'merge',
          label: 'M',
          stepPath: 'steps/m/STEP.md',
          position: { x: 2, y: 0 },
          mergeStrategy: 'dedupe',
        },
        {
          id: 'out',
          kind: 'output',
          label: 'Out',
          stepPath: 'steps/out/STEP.md',
          position: { x: 3, y: 0 },
        },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'a1' },
        { id: 'e2', source: 'in', target: 'a2' },
        { id: 'e3', source: 'a1', target: 'merged' },
        { id: 'e4', source: 'a2', target: 'merged' },
        { id: 'e5', source: 'merged', target: 'out' },
      ],
    }
    const executor = new FakeExecutor()
    executor.outputs = { a1: [1, 2], a2: [1, 3] }
    const { coordinator, store, input } = makeHarness({ executor, topology })

    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.nodes.merged.output).toEqual([1, 2, 3])
    expect(snapshot?.outputs.out).toEqual([1, 2, 3])
  })

  it('requires an explicit side-effect confirmation to continue', async () => {
    const executor = new FakeExecutor()
    executor.failOnce.add('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    await coordinator.start(input)
    await until(
      async () => (await store.read('demo/WORKFLOW.md'))?.status === 'failed',
    )

    expect(
      await coordinator.continueRun('demo/WORKFLOW.md', {
        confirmSideEffects: false,
      }),
    ).toEqual({ ok: false, reason: 'side-effect-confirmation-required' })
    expect((await store.read('demo/WORKFLOW.md'))?.status).toBe('failed')
  })

  it('does not rerun successful nodes after continue and keeps the definition hash', async () => {
    const executor = new FakeExecutor()
    executor.failOnce.add('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    await coordinator.start(input)
    await until(
      async () => (await store.read('demo/WORKFLOW.md'))?.status === 'failed',
    )
    const failed = await store.read('demo/WORKFLOW.md')
    expect(
      executor.calls.filter((call) => call.node.id === 'draft').length,
    ).toBe(1)
    expect(executor.calls.filter((call) => call.node.id === 'yes').length).toBe(
      0,
    )

    const continued = await coordinator.continueRun('demo/WORKFLOW.md', {
      confirmSideEffects: true,
    })
    expect(continued).toEqual({ ok: true, runId: failed?.runId })

    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const final = await store.read('demo/WORKFLOW.md')
    expect(
      executor.calls.filter((call) => call.node.id === 'draft').length,
    ).toBe(2)
    expect(executor.calls.filter((call) => call.node.id === 'yes').length).toBe(
      1,
    )
    expect(final?.definition.definitionHash).toBe(
      failed?.definition.definitionHash,
    )
    expect(final?.nodes.draft.output).toBe('value-draft')
  })

  it('rejects continuing a run that already succeeded or is missing', async () => {
    const { coordinator, store, input } = makeHarness({})

    expect(
      await coordinator.continueRun('demo/WORKFLOW.md', {
        confirmSideEffects: true,
      }),
    ).toEqual({ ok: false, reason: 'not-found' })

    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    expect(
      await coordinator.continueRun('demo/WORKFLOW.md', {
        confirmSideEffects: true,
      }),
    ).toEqual({ ok: false, reason: 'not-continuable' })
  })

  it('converts persisted running startup records to interrupted without executor calls', async () => {
    const { coordinator, store, input, executor } = makeHarness({})
    const start = await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    expect(start.ok).toBe(true)

    const before = await store.read('demo/WORKFLOW.md')
    const running = {
      ...before!,
      status: 'running' as const,
      cancelRequested: false,
    }
    await store.write(running)
    const draftRun = {
      status: 'running' as const,
      startedAt: 5,
    }
    await store.write({
      ...before!,
      status: 'running',
      nodes: { ...before!.nodes, draft: draftRun },
    })

    const executorCallsBefore = executor.calls.length
    const interrupted = await store.list()
    expect(
      interrupted.filter((run) => run.status === 'running').length,
    ).toBeGreaterThan(0)

    await coordinator.initialize()

    const recovered = await store.read('demo/WORKFLOW.md')
    expect(recovered?.status).toBe('interrupted')
    expect(recovered?.finishedAt).toBeGreaterThanOrEqual(1000)
    expect(executor.calls.length).toBe(executorCallsBefore)
  })

  it('cancel wins over late completed results and persists cancelled', async () => {
    const executor = new FakeExecutor()
    executor.hold('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    const start = await coordinator.start(input)
    expect(start.ok).toBe(true)
    await until(() => executor.calls.some((call) => call.node.id === 'draft'))

    await coordinator.cancel('demo/WORKFLOW.md')
    let snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('cancelled')
    expect(snapshot?.cancelRequested).toBe(true)
    expect(snapshot?.nodes.draft.status).toBe('running')

    executor.releaseOne('draft')
    await until(async () => {
      const current = await store.read('demo/WORKFLOW.md')
      return current?.status === 'cancelled' && executor.calls.length >= 1
    })
    snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('cancelled')
    expect(snapshot?.nodes.draft.status).toBe('running')
    expect(snapshot?.nodes.draft.error).toBeUndefined()
  })

  it('keeps a terminal success persisted before the cancel boundary', async () => {
    const { coordinator, store, input } = makeHarness({})

    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    await coordinator.cancel('demo/WORKFLOW.md')
    expect((await store.read('demo/WORKFLOW.md'))?.status).toBe('succeeded')
  })

  it('module quiesce aborts active work and persists interrupted', async () => {
    const executor = new FakeExecutor()
    executor.hold('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    await coordinator.start(input)
    await until(() => executor.calls.some((call) => call.node.id === 'draft'))

    await coordinator.quiesce()
    const snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('interrupted')
    expect(snapshot?.cancelRequested).toBeUndefined()

    executor.releaseAll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    const after = await store.read('demo/WORKFLOW.md')
    expect(after?.status).toBe('interrupted')
    expect(after?.nodes.draft.status).toBe('running')
  })

  it('parks the serial chain at the next node boundary after pause', async () => {
    const executor = new FakeExecutor()
    executor.hold('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    const start = await coordinator.start(input)
    expect(start.ok).toBe(true)
    await until(() => executor.calls.some((call) => call.node.id === 'draft'))

    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(true)
    let snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('running')
    expect(snapshot?.paused).toBe(true)

    // Already paused: a second pause is a no-op.
    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(false)

    executor.releaseOne('draft')
    await new Promise((resolve) => setTimeout(resolve, 50))
    snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('running')
    expect(snapshot?.paused).toBe(true)
    // The chain parked before the next node: gate never evaluated, no branch
    // agent ran.
    expect(snapshot?.nodes.gate.status).toBe('pending')
    expect(executor.calls.some((call) => call.node.id === 'yes')).toBe(false)
  })

  it('resume continues the same ActiveRun chain without re-running succeeded nodes', async () => {
    const executor = new FakeExecutor()
    executor.hold('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    const start = await coordinator.start(input)
    expect(start.ok).toBe(true)
    await until(() => executor.calls.some((call) => call.node.id === 'draft'))

    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(true)
    executor.releaseOne('draft')
    await until(async () => {
      const snapshot = await store.read('demo/WORKFLOW.md')
      return snapshot?.nodes.draft.status === 'succeeded'
    })
    const parked = await store.read('demo/WORKFLOW.md')
    expect(parked?.status).toBe('running')
    expect(parked?.paused).toBe(true)
    expect(parked?.nodes.gate.status).toBe('pending')
    expect(executor.calls.some((call) => call.node.id === 'yes')).toBe(false)

    // The in-memory pause needs no side-effect confirmation: no node
    // re-executes, so nothing can re-apply side effects.
    const continued = await coordinator.continueRun('demo/WORKFLOW.md', {
      confirmSideEffects: false,
    })
    expect(continued).toEqual({ ok: true, runId: 'run-1' })

    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const final = await store.read('demo/WORKFLOW.md')
    expect(final?.status).toBe('succeeded')
    expect(final?.paused).toBeUndefined()
    expect(final?.nodes.draft.output).toBe('late-draft')
    expect(
      executor.calls.filter((call) => call.node.id === 'draft').length,
    ).toBe(1)
  })

  it('pause-then-cancel wins and clears paused on the terminal record', async () => {
    const executor = new FakeExecutor()
    executor.hold('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    const start = await coordinator.start(input)
    expect(start.ok).toBe(true)
    await until(() => executor.calls.some((call) => call.node.id === 'draft'))

    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(true)
    await coordinator.cancel('demo/WORKFLOW.md')

    let snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('cancelled')
    expect(snapshot?.paused).toBeUndefined()

    executor.releaseAll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('cancelled')
    expect(snapshot?.paused).toBeUndefined()
  })

  it('quiesce converts a parked run to interrupted and clears paused', async () => {
    const executor = new FakeExecutor()
    executor.hold('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    const start = await coordinator.start(input)
    expect(start.ok).toBe(true)
    await until(() => executor.calls.some((call) => call.node.id === 'draft'))

    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(true)
    await coordinator.quiesce()

    let snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('interrupted')
    expect(snapshot?.paused).toBeUndefined()

    executor.releaseAll()
    await new Promise((resolve) => setTimeout(resolve, 20))
    snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('interrupted')
    expect(snapshot?.paused).toBeUndefined()
  })

  it('pause on a non-running run is a no-op returning false', async () => {
    const executor = new FakeExecutor()
    executor.failOnce.add('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    // No run at all: no record is created.
    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(false)
    expect(await store.read('demo/WORKFLOW.md')).toBeNull()

    // A finished (failed) run is not paused: the record stays untouched.
    await coordinator.start(input)
    await until(
      async () => (await store.read('demo/WORKFLOW.md'))?.status === 'failed',
    )
    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(false)
    const snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('failed')
    expect(snapshot?.paused).toBeUndefined()
  })

  it('a parked run still rejects a second start with already-running', async () => {
    const executor = new FakeExecutor()
    executor.hold('draft')
    const { coordinator, store, input } = makeHarness({ executor })

    const start = await coordinator.start(input)
    expect(start.ok).toBe(true)
    await until(() => executor.calls.some((call) => call.node.id === 'draft'))

    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(true)
    const second = await coordinator.start({ ...input, input: 'again' })
    expect(second).toEqual({ ok: false, reason: 'already-running' })

    executor.releaseAll()
    expect(
      await coordinator.continueRun('demo/WORKFLOW.md', {
        confirmSideEffects: false,
      }),
    ).toEqual({ ok: true, runId: 'run-1' })
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
  })

  it('pause arriving after terminal does not produce succeeded+paused', async () => {
    const { coordinator, store, input } = makeHarness({})

    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(false)
    const snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.status).toBe('succeeded')
    expect(snapshot?.paused).toBeUndefined()
  })

  it('publishes snapshots that cannot be mutated through caller-owned objects', async () => {
    const executor = new FakeExecutor()
    const callerInput = { items: [1, 2], nested: { keep: 'yes' } }
    const draftOutput = { result: 'x' }
    executor.outputs = { draft: draftOutput }
    const { coordinator, store, input, snapshots } = makeHarness({ executor })
    const runInput = { ...input, input: callerInput }

    await coordinator.start(runInput)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    callerInput.items.push(3)
    callerInput.nested.keep = 'changed'
    draftOutput.result = 'mutated'

    for (const snapshot of snapshots) {
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.nodes.in)).toBe(true)
    }
    const latest = await store.read('demo/WORKFLOW.md')
    expect(latest?.input).toEqual({ items: [1, 2], nested: { keep: 'yes' } })
    expect(latest?.nodes.draft.output).toEqual({ result: 'x' })
    expect(Object.isFrozen(latest?.nodes.draft.output as object)).toBe(true)
  })

  it('preserves stable executor error codes from the real executor in the run error', async () => {
    const topology: WorkflowTopology = {
      revision: 1,
      nodes: [
        {
          id: 'in',
          kind: 'input',
          label: 'In',
          stepPath: 'steps/in/STEP.md',
          position: { x: 0, y: 0 },
        },
        {
          id: 'draft',
          kind: 'agent',
          label: 'Draft',
          stepPath: 'steps/draft/STEP.md',
          position: { x: 1, y: 0 },
          outputSchema: {
            type: 'object',
            properties: { plan: { type: 'string' } },
          },
        },
        {
          id: 'out',
          kind: 'output',
          label: 'Out',
          stepPath: 'steps/out/STEP.md',
          position: { x: 2, y: 0 },
        },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'draft' },
        { id: 'e2', source: 'draft', target: 'out' },
      ],
    }
    const executor = createWorkflowNodeExecutor({
      agent: {
        stream: async function* (): AsyncIterable<WorkflowAgentEvent> {
          yield { type: 'completed', text: 'model prose without a submission' }
        },
      },
    })
    const { coordinator, store, input } = makeHarness({ executor, topology })

    await coordinator.start(input)
    await until(
      async () => (await store.read('demo/WORKFLOW.md'))?.status === 'failed',
    )
    const snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.nodes.draft.error).toMatchObject({
      code: 'agent-failed',
    })
    expect(snapshot?.error).toMatchObject({
      code: 'agent-failed',
      nodeId: 'draft',
    })
  })

  it('persists invalid-output from the real executor for a non-array map input', async () => {
    const topology: WorkflowTopology = {
      revision: 1,
      nodes: [
        {
          id: 'in',
          kind: 'input',
          label: 'In',
          stepPath: 'steps/in/STEP.md',
          position: { x: 0, y: 0 },
        },
        {
          id: 'map',
          kind: 'mapAgent',
          label: 'Map',
          stepPath: 'steps/map/STEP.md',
          position: { x: 1, y: 0 },
        },
        {
          id: 'out',
          kind: 'output',
          label: 'Out',
          stepPath: 'steps/out/STEP.md',
          position: { x: 2, y: 0 },
        },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'map' },
        { id: 'e2', source: 'map', target: 'out' },
      ],
    }
    const executor = createWorkflowNodeExecutor({
      agent: {
        stream: async function* (): AsyncIterable<WorkflowAgentEvent> {
          throw new Error('the Agent must not be called for a non-array input')
          // Unreachable; the throw above fires if the executor pulls.
          yield { type: 'completed', text: '' }
        },
      },
    })
    const { coordinator, store, input } = makeHarness({ executor, topology })

    await coordinator.start({ ...input, input: 'not-an-array' })
    await until(
      async () => (await store.read('demo/WORKFLOW.md'))?.status === 'failed',
    )
    const snapshot = await store.read('demo/WORKFLOW.md')
    expect(snapshot?.nodes.map.error).toMatchObject({
      code: 'invalid-output',
    })
    expect(snapshot?.error).toMatchObject({
      code: 'invalid-output',
      nodeId: 'map',
    })
  })

  it('surfaces preflight failures without reserving the path', async () => {
    const { coordinator, store, input } = makeHarness({})
    const bad = await coordinator.start({
      ...input,
      bundle: {
        ...input.bundle,
        document: { ...input.bundle.document, issues: ['invalidStructure'] },
      },
    })
    expect(bad).toMatchObject({ ok: false, reason: 'invalid-definition' })

    const good = await coordinator.start(input)
    expect(good.ok).toBe(true)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
  })

  it('runs a node test through the executor and returns its result directly', async () => {
    const executor = new FakeExecutor()
    executor.outputs = { draft: 'drafted' }
    const { coordinator, storage, store, snapshots, input } = makeHarness({
      executor,
    })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const record = await store.read('demo/WORKFLOW.md')
    const writeSpy = jest.spyOn(storage, 'writeText')
    const publishesBefore = snapshots.length
    const executeCallsBefore = executor.calls.length

    const result = await coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'draft',
      input: 'preview',
    })

    expect(result).toEqual({ value: 'test-draft' })
    // No dependency execution: the test adds no execute calls and runs only
    // the one executor test call.
    expect(executor.calls.length).toBe(executeCallsBefore)
    expect(executor.testCalls.length).toBe(1)
    const request = executor.testCalls[0]
    expect(request.definition).toEqual(record!.definition)
    expect(request.node).toEqual(
      record!.definition.topology.nodes.find((node) => node.id === 'draft'),
    )
    expect(request.workflowInput).toBe('preview')
    expect(request.upstream).toEqual([
      { nodeId: 'test-input', value: 'preview' },
    ])
    expect(request.signal.aborted).toBe(false)
    // No persistent write, no publish, and the full-run record is untouched.
    expect(writeSpy).not.toHaveBeenCalled()
    expect(snapshots.length).toBe(publishesBefore)
    expect(await store.read('demo/WORKFLOW.md')).toEqual(record)
  })

  it('evaluates condition node tests locally and keeps merge tests on the executor', async () => {
    const executor = new FakeExecutor()
    const { coordinator, store, input } = makeHarness({ executor })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    // Condition tests use the real predecessor node id as upstream but are
    // judged by the same deterministic local gate as a full run; the executor
    // is never involved, so the preview matches what the run will decide.
    const condition = await coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'gate',
      input: 'truthy',
    })
    expect(condition).toEqual({ value: 'truthy', conditionResult: true })
    expect(executor.testCalls.length).toBe(0)

    // The merge has two incoming edges; sources use their real node ids in
    // the same stable edge-id order as a full run.
    const merge = await coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'merged',
      input: { yes: 'y', no: 'n' },
    })
    expect(merge).toEqual({ value: 'test-merged' })
    expect(executor.testCalls).toHaveLength(1)
    expect(executor.testCalls[0].upstream).toEqual([
      { nodeId: 'no', value: 'n' },
      { nodeId: 'yes', value: 'y' },
    ])
  })

  it('aligns condition node test results with the full-run gate evaluation', async () => {
    const runAndTest = async (
      draftOutput: JsonValue,
    ): Promise<{
      runConditionResult: boolean | undefined
      testResult: WorkflowNodeExecutionResult
    }> => {
      const executor = new FakeExecutor()
      executor.outputs = { draft: draftOutput }
      const { coordinator, store, input } = makeHarness({ executor })
      await coordinator.start(input)
      await until(
        async () =>
          (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
      )
      const record = await store.read('demo/WORKFLOW.md')
      const testResult = await coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'gate',
        input: draftOutput,
      })
      return {
        runConditionResult: record?.nodes.gate.conditionResult,
        testResult,
      }
    }

    const truthy = await runAndTest('drafted')
    expect(truthy.runConditionResult).toBe(true)
    expect(truthy.testResult).toEqual({
      value: 'drafted',
      conditionResult: true,
    })

    const falsy = await runAndTest('')
    expect(falsy.runConditionResult).toBe(false)
    expect(falsy.testResult).toEqual({ value: '', conditionResult: false })
  })

  it('rejects a condition node test without any active source', async () => {
    const topology: WorkflowTopology = {
      revision: 1,
      nodes: [
        {
          id: 'in',
          kind: 'input',
          label: 'In',
          stepPath: 'steps/in/STEP.md',
          position: { x: 0, y: 0 },
        },
        {
          id: 'gate',
          kind: 'condition',
          label: 'Gate',
          stepPath: 'steps/gate/STEP.md',
          position: { x: 1, y: 0 },
          gateType: 'ifElse',
        },
        {
          id: 'out',
          kind: 'output',
          label: 'Out',
          stepPath: 'steps/out/STEP.md',
          position: { x: 2, y: 0 },
        },
      ],
      edges: [{ id: 'e1', source: 'in', target: 'out' }],
    }
    const executor = new FakeExecutor()
    const { coordinator, store, input } = makeHarness({ executor, topology })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    await expect(
      coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'gate',
        input: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid-output' })
    expect(executor.testCalls.length).toBe(0)
  })

  it('keeps one active node test per view and replaces it on a new test', async () => {
    const executor = new FakeExecutor()
    executor.testHold('draft')
    const { coordinator, store, input } = makeHarness({ executor })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    const first = coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'draft',
      input: 'one',
    })
    const other = coordinator.testNode('view-2', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'draft',
      input: 'two',
    })
    await until(() => executor.testCalls.length === 2)
    expect(executor.testCalls[0].signal.aborted).toBe(false)
    expect(executor.testCalls[1].signal.aborted).toBe(false)

    // A second test in the same view aborts the first test's controller.
    const replacement = coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'draft',
      input: 'three',
    })
    await until(() => executor.testCalls.length === 3)
    expect(executor.testCalls[0].signal.aborted).toBe(true)
    expect(executor.testCalls[2].signal.aborted).toBe(false)

    executor.testReleaseAll()
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await expect(other).resolves.toEqual({ value: 'late-draft' })
    await expect(replacement).resolves.toEqual({ value: 'late-draft' })
  })

  it('aborts the view node test when the view is disposed', async () => {
    const executor = new FakeExecutor()
    executor.testHold('draft')
    const { coordinator, store, input } = makeHarness({ executor })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    const test = coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'draft',
      input: 'x',
    })
    await until(() => executor.testCalls.length === 1)

    // Disposing an unrelated view is a no-op.
    coordinator.cancelNodeTest('other-view')
    expect(executor.testCalls[0].signal.aborted).toBe(false)

    coordinator.cancelNodeTest('view-1')
    expect(executor.testCalls[0].signal.aborted).toBe(true)

    executor.testReleaseAll()
    await expect(test).rejects.toMatchObject({ code: 'cancelled' })

    // A fresh view session can test again; 'draft' is still held, so release
    // the new test call too.
    const retest = coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'draft',
      input: 'again',
    })
    await until(() => executor.testCalls.length === 2)
    executor.testReleaseAll()
    expect(await retest).toEqual({ value: 'late-draft' })
  })

  it('aborts pending node tests in every view when a full run starts', async () => {
    const executor = new FakeExecutor()
    executor.testHold('draft')
    const { coordinator, store, input } = makeHarness({ executor })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    const first = coordinator.testNode('view-1', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'draft',
      input: 'one',
    })
    const second = coordinator.testNode('view-2', {
      workflowPath: 'demo/WORKFLOW.md',
      nodeId: 'draft',
      input: 'two',
    })
    await until(() => executor.testCalls.length === 2)
    expect(executor.testCalls[0].signal.aborted).toBe(false)
    expect(executor.testCalls[1].signal.aborted).toBe(false)

    // Starting a full run supersedes the pending tests in every view: a stale
    // test result must never land while the run is executing.
    const start = await coordinator.start(input)
    expect(start.ok).toBe(true)
    expect(executor.testCalls[0].signal.aborted).toBe(true)
    expect(executor.testCalls[1].signal.aborted).toBe(true)

    executor.testReleaseAll()
    await expect(first).rejects.toMatchObject({ code: 'cancelled' })
    await expect(second).rejects.toMatchObject({ code: 'cancelled' })

    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
  })

  it('rejects a node test while a full run is active for the same workflow', async () => {
    const executor = new FakeExecutor()
    executor.hold('draft')
    const { coordinator, store, input } = makeHarness({ executor })
    const start = await coordinator.start(input)
    expect(start.ok).toBe(true)
    await until(() => executor.calls.some((call) => call.node.id === 'draft'))

    await expect(
      coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'draft',
        input: 'x',
      }),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(executor.testCalls.length).toBe(0)

    executor.releaseAll()
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
  })

  it('rejects a node test without a persisted run record', async () => {
    const { coordinator } = makeHarness({})

    await expect(
      coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'draft',
        input: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid-definition' })
  })

  it('rejects non-JSON input and unknown node ids', async () => {
    const executor = new FakeExecutor()
    const { coordinator, store, input } = makeHarness({ executor })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    await expect(
      coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'draft',
        input: { bad: BigInt(1) } as unknown as JsonValue,
      }),
    ).rejects.toMatchObject({ code: 'invalid-definition' })
    await expect(
      coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'missing',
        input: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid-definition' })
    expect(executor.testCalls.length).toBe(0)
  })

  it('applies the same output schema validation to node test results', async () => {
    const topology: WorkflowTopology = {
      revision: 1,
      nodes: [
        {
          id: 'in',
          kind: 'input',
          label: 'In',
          stepPath: 'steps/in/STEP.md',
          position: { x: 0, y: 0 },
        },
        {
          id: 'draft',
          kind: 'agent',
          label: 'Draft',
          stepPath: 'steps/draft/STEP.md',
          position: { x: 1, y: 0 },
          outputSchema: {
            type: 'object',
            properties: { plan: { type: 'string' } },
          },
        },
        {
          id: 'out',
          kind: 'output',
          label: 'Out',
          stepPath: 'steps/out/STEP.md',
          position: { x: 2, y: 0 },
        },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'draft' },
        { id: 'e2', source: 'draft', target: 'out' },
      ],
    }
    const executor = new FakeExecutor()
    executor.outputs = { draft: { plan: 'ok' } }
    const { coordinator, store, input } = makeHarness({ executor, topology })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    executor.testOutputs = { draft: { plan: 42 } }
    await expect(
      coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'draft',
        input: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid-output' })

    executor.testOutputs = { draft: { bad: BigInt(1) } }
    await expect(
      coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'draft',
        input: 'x',
      }),
    ).rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('wraps unexpected executor failures as agent-failed', async () => {
    const executor = new FakeExecutor()
    const { coordinator, store, input } = makeHarness({ executor })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    executor.testFailOnce.add('draft')
    await expect(
      coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'draft',
        input: 'x',
      }),
    ).rejects.toMatchObject({ code: 'agent-failed', message: 'boom draft' })
  })

  it('passes through executor WorkflowNodeExecutionError codes unchanged', async () => {
    const executor: WorkflowNodeExecutor = {
      execute: async () => ({ value: null }),
      testNode: async () => {
        throw new WorkflowNodeExecutionError('invalid-output', 'schema says no')
      },
    }
    const { coordinator, store, input } = makeHarness({ executor })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )

    await expect(
      coordinator.testNode('view-1', {
        workflowPath: 'demo/WORKFLOW.md',
        nodeId: 'draft',
        input: 'x',
      }),
    ).rejects.toMatchObject({
      code: 'invalid-output',
      message: 'schema says no',
    })
  })

  it('initialize keeps running+paused records and publishes them', async () => {
    const { coordinator, store, snapshots, input } = makeHarness({})
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const succeeded = await store.read('demo/WORKFLOW.md')
    await store.write({
      ...succeeded!,
      status: 'running' as const,
      paused: true,
      finishedAt: undefined,
    })

    const before = snapshots.length
    await coordinator.initialize()

    const record = await store.read('demo/WORKFLOW.md')
    expect(record?.status).toBe('running')
    expect(record?.paused).toBe(true)
    // The kept record reached listeners exactly once, with paused intact.
    expect(snapshots.slice(before)).toHaveLength(1)
    expect(snapshots[before].status).toBe('running')
    expect(snapshots[before].paused).toBe(true)
  })

  it('initialize still converts plain running records to interrupted', async () => {
    const { coordinator, store, snapshots, input } = makeHarness({})
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const succeeded = await store.read('demo/WORKFLOW.md')
    await store.write({
      ...succeeded!,
      status: 'running' as const,
      finishedAt: undefined,
    })

    const before = snapshots.length
    await coordinator.initialize()

    const record = await store.read('demo/WORKFLOW.md')
    expect(record?.status).toBe('interrupted')
    expect(record?.paused).toBeUndefined()
    expect(snapshots.slice(before)).toHaveLength(1)
    expect(snapshots[before].status).toBe('interrupted')
  })

  it('start rejects when the store holds a running+paused record', async () => {
    const { coordinator, store, input } = makeHarness({})
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const succeeded = await store.read('demo/WORKFLOW.md')
    await store.write({
      ...succeeded!,
      status: 'running' as const,
      paused: true,
      finishedAt: undefined,
    })

    const start = await coordinator.start(input)
    expect(start).toEqual({ ok: false, reason: 'already-running' })
    // start left the persisted record untouched...
    const record = await store.read('demo/WORKFLOW.md')
    expect(record?.status).toBe('running')
    expect(record?.paused).toBe(true)
    // ...and released its reservation: with the record gone, a fresh start
    // for the same path proceeds.
    await store.remove('demo/WORKFLOW.md')
    expect((await coordinator.start(input)).ok).toBe(true)
  })

  it('record-level cancel writes cancelled with paused cleared and publishes', async () => {
    const { coordinator, store, snapshots, input } = makeHarness({})
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const succeeded = await store.read('demo/WORKFLOW.md')
    await store.write({
      ...succeeded!,
      status: 'running' as const,
      paused: true,
      finishedAt: undefined,
    })

    const before = snapshots.length
    await coordinator.cancel('demo/WORKFLOW.md')

    const record = await store.read('demo/WORKFLOW.md')
    expect(record?.status).toBe('cancelled')
    expect(record?.cancelRequested).toBe(true)
    expect(record?.paused).toBeUndefined()
    expect(snapshots.slice(before)).toHaveLength(1)
    expect(snapshots[before].status).toBe('cancelled')
    expect(snapshots[before].paused).toBeUndefined()

    // Guard: a running record without paused is not a record-level target.
    await store.write({
      ...succeeded!,
      status: 'running' as const,
      finishedAt: undefined,
    })
    const beforeGuard = snapshots.length
    await coordinator.cancel('demo/WORKFLOW.md')
    expect((await store.read('demo/WORKFLOW.md'))?.status).toBe('running')
    expect(snapshots.length).toBe(beforeGuard)

    // Guard: no record at all is a no-op.
    await store.remove('demo/WORKFLOW.md')
    await coordinator.cancel('demo/WORKFLOW.md')
    expect(await store.read('demo/WORKFLOW.md')).toBeNull()
    expect(snapshots.length).toBe(beforeGuard)
  })

  it('record-level cancel does not resurrect a run after a stale continue read', async () => {
    const executor = new FakeExecutor()
    const storage = new MemoryStorage()
    const inner = createWorkflowRunStore(storage)
    // Once armed, the next read returns the record it observed and lands a
    // record-level cancel in the store before the caller's following read:
    // the store simulates a racing cancel between continueRun's read and its
    // rebuild, so the rebuild must observe the fresh cancelled record.
    let simulateCancelOnRead = false
    const store: WorkflowRunStore = {
      async read(path) {
        const record = await inner.read(path)
        if (
          simulateCancelOnRead &&
          record?.status === 'running' &&
          record.paused
        ) {
          simulateCancelOnRead = false
          await inner.write({
            ...record,
            paused: undefined,
            cancelRequested: true,
            status: 'cancelled',
            finishedAt: 5000,
          })
        }
        return record
      },
      list: () => inner.list(),
      write: (run) => inner.write(run),
      remove: (path) => inner.remove(path),
    }
    let now = 1000
    let runCounter = 0
    const coordinator = createWorkflowRunCoordinator({
      executor,
      store,
      now: () => now++,
      createRunId: () => `run-${++runCounter}`,
    })
    const snapshots: WorkflowRunSnapshot[] = []
    coordinator.subscribe((snapshot) => snapshots.push(snapshot))
    const input: WorkflowRunStartInput = {
      workflowPath: 'demo/WORKFLOW.md',
      bundle: bundle(runnableTopology()),
      modelSnapshot: modelSnapshot(),
      input: 'proceed',
    }

    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const succeeded = await store.read('demo/WORKFLOW.md')
    await store.write({
      ...succeeded!,
      status: 'running' as const,
      paused: true,
      finishedAt: undefined,
      // The resume node was mid-flight at reload, so the record is genuinely
      // continuable: without the re-check the rebuild would resurrect it.
      nodes: {
        ...succeeded!.nodes,
        draft: { status: 'running' as const, startedAt: 5 },
        gate: { status: 'pending' as const },
        yes: { status: 'pending' as const },
        no: { status: 'pending' as const },
        merged: { status: 'pending' as const },
        out: { status: 'pending' as const },
      },
    })
    const callsBefore = executor.calls.length
    const publishesBefore = snapshots.length

    simulateCancelOnRead = true
    const continued = await coordinator.continueRun('demo/WORKFLOW.md', {
      confirmSideEffects: true,
    })

    expect(continued).toEqual({ ok: false, reason: 'not-continuable' })
    const record = await store.read('demo/WORKFLOW.md')
    expect(record?.status).toBe('cancelled')
    expect(record?.paused).toBeUndefined()
    expect(executor.calls.length).toBe(callsBefore)
    expect(snapshots.length).toBe(publishesBefore)
  })

  it('continueRun on a recovered paused run rebuilds, clears paused, requires confirmation, and resumes', async () => {
    const executor = new FakeExecutor()
    const { coordinator, store, snapshots, input } = makeHarness({ executor })
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const succeeded = await store.read('demo/WORKFLOW.md')
    // Seed a recovered running+paused record whose resume node was
    // mid-flight at reload (draft running, everything after it pending).
    await store.write({
      ...succeeded!,
      status: 'running' as const,
      paused: true,
      finishedAt: undefined,
      nodes: {
        ...succeeded!.nodes,
        draft: { status: 'running' as const, startedAt: 5 },
        gate: { status: 'pending' as const },
        yes: { status: 'pending' as const },
        no: { status: 'pending' as const },
        merged: { status: 'pending' as const },
        out: { status: 'pending' as const },
      },
    })
    // The resume node may have been mid-flight at reload, so a recovered run
    // must confirm side effects even though it was paused.
    executor.hold('draft')
    const callsBeforeResume = executor.calls.length

    expect(
      await coordinator.continueRun('demo/WORKFLOW.md', {
        confirmSideEffects: false,
      }),
    ).toEqual({ ok: false, reason: 'side-effect-confirmation-required' })

    const publishesBefore = snapshots.length
    const continued = await coordinator.continueRun('demo/WORKFLOW.md', {
      confirmSideEffects: true,
    })
    expect(continued).toEqual({ ok: true, runId: succeeded!.runId })
    // The rebuilt snapshot clears paused and resets the resume node to
    // pending; the record is running again without paused.
    expect(snapshots[publishesBefore].paused).toBeUndefined()
    expect(snapshots[publishesBefore].nodes.draft.status).toBe('pending')
    let record = await store.read('demo/WORKFLOW.md')
    expect(record?.status).toBe('running')
    expect(record?.paused).toBeUndefined()

    // The re-executed resume node lands again (at-least-once), and the
    // rebuilt ActiveRun carries a real pause gate: pause parks it at the
    // next node boundary exactly like a fresh run.
    await until(
      () =>
        executor.calls.filter((call) => call.node.id === 'draft').length === 2,
    )
    expect(await coordinator.pause('demo/WORKFLOW.md')).toBe(true)
    record = await store.read('demo/WORKFLOW.md')
    expect(record?.paused).toBe(true)

    executor.releaseOne('draft')
    await until(async () => {
      const current = await store.read('demo/WORKFLOW.md')
      return (
        current?.nodes.draft.status === 'succeeded' && current.paused === true
      )
    })
    record = await store.read('demo/WORKFLOW.md')
    expect(record?.nodes.gate.status).toBe('pending')
    expect(
      executor.calls
        .slice(callsBeforeResume)
        .some((call) => call.node.id === 'yes'),
    ).toBe(false)

    // The in-memory resume of the same ActiveRun needs no confirmation.
    expect(
      await coordinator.continueRun('demo/WORKFLOW.md', {
        confirmSideEffects: false,
      }),
    ).toEqual({ ok: true, runId: succeeded!.runId })

    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    record = await store.read('demo/WORKFLOW.md')
    expect(record?.status).toBe('succeeded')
    expect(record?.paused).toBeUndefined()
    expect(record?.nodes.draft.output).toBe('late-draft')
    expect(
      executor.calls.filter((call) => call.node.id === 'draft').length,
    ).toBe(2)
  })

  it('migrates the run record and publishes it under the new path on rename', async () => {
    const { coordinator, store, snapshots, input } = makeHarness({})
    await coordinator.start(input)
    await until(
      async () =>
        (await store.read('demo/WORKFLOW.md'))?.status === 'succeeded',
    )
    const before = await store.read('demo/WORKFLOW.md')

    await coordinator.notifyRenamedWorkflow(
      'demo/WORKFLOW.md',
      'renamed/WORKFLOW.md',
    )

    const migrated = await store.read('renamed/WORKFLOW.md')
    expect(migrated).not.toBeNull()
    expect(migrated?.workflowPath).toBe('renamed/WORKFLOW.md')
    expect(migrated?.definition.workflowPath).toBe('renamed/WORKFLOW.md')
    expect(migrated?.definition.definitionHash).toBe(
      before?.definition.definitionHash,
    )
    expect(migrated?.runId).toBe(before?.runId)
    expect(await store.read('demo/WORKFLOW.md')).toBeNull()
    expect(snapshots.at(-1)?.workflowPath).toBe('renamed/WORKFLOW.md')
    expect(snapshots.at(-1)?.definition.workflowPath).toBe(
      'renamed/WORKFLOW.md',
    )
  })

  it('treats a missing run record as a no-op success', async () => {
    const { coordinator, snapshots } = makeHarness({})

    await expect(
      coordinator.notifyRenamedWorkflow(
        'missing/WORKFLOW.md',
        'renamed/WORKFLOW.md',
      ),
    ).resolves.toBeUndefined()
    expect(snapshots).toHaveLength(0)
  })

  it('refuses start and continue while the rename lease is held', async () => {
    const { coordinator, store, input } = makeHarness({})
    coordinator.beginRename('demo/WORKFLOW.md')
    expect(coordinator.isRenaming('demo/WORKFLOW.md')).toBe(true)

    await expect(coordinator.start(input)).resolves.toEqual({
      ok: false,
      reason: 'already-running',
    })
    await expect(
      coordinator.continueRun('demo/WORKFLOW.md', {
        confirmSideEffects: true,
      }),
    ).resolves.toEqual({ ok: false, reason: 'already-running' })
    expect(await store.read('demo/WORKFLOW.md')).toBeNull()

    coordinator.endRename('demo/WORKFLOW.md')
    expect(coordinator.isRenaming('demo/WORKFLOW.md')).toBe(false)
    await expect(coordinator.start(input)).resolves.toEqual({
      ok: true,
      runId: 'run-1',
    })
  })
})
