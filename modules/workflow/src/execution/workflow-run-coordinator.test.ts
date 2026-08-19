import type { WorkflowTopology } from '../domain/workflow-model'
import type { WorkflowBundle } from '../domain/workflow-repository'

import { createWorkflowRunCoordinator } from './workflow-run-coordinator'
import { createWorkflowRunStore } from './workflow-run-store'
import type {
  JsonValue,
  WorkflowModelSnapshot,
  WorkflowNodeExecutionRequest,
  WorkflowNodeExecutor,
  WorkflowRunSnapshot,
  WorkflowRunStartInput,
  WorkflowRunStorage,
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

  async testNode(request: WorkflowNodeExecutionRequest) {
    return { value: `test-${request.node.id}` }
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

const makeHarness = (options: {
  executor?: FakeExecutor
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
})
