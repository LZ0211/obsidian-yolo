import { topologicalWorkflowOrder } from '../domain/workflow-model'
import type { WorkflowNode, WorkflowTopology } from '../domain/workflow-model'

import { createWorkflowDefinition } from './workflow-definition'
import {
  activeIncomingSources,
  aggregateWorkflowOutputs,
  evaluateWorkflowGate,
  mergeWorkflowSources,
  stableIncomingEdges,
} from './workflow-run-graph'
import type { WorkflowSourceValue } from './workflow-run-graph'
import { WorkflowNodeExecutionError, isJsonValue } from './workflow-run-types'
import type {
  JsonValue,
  WorkflowNodeExecutionRequest,
  WorkflowNodeExecutionResult,
  WorkflowNodeExecutor,
  WorkflowNodeRun,
  WorkflowNodeRunStatus,
  WorkflowRunBackgroundSink,
  WorkflowRunContinueConfirmation,
  WorkflowRunContinueResult,
  WorkflowRunCoordinator,
  WorkflowRunError,
  WorkflowRunSnapshot,
  WorkflowRunSnapshotListener,
  WorkflowRunStartInput,
  WorkflowRunStartResult,
  WorkflowRunStatus,
  WorkflowRunStore,
} from './workflow-run-types'
import { validateJsonSchemaOutput } from './workflow-schema'

export type WorkflowRunCoordinatorOptions = Readonly<{
  executor: WorkflowNodeExecutor
  store: WorkflowRunStore
  background?: WorkflowRunBackgroundSink
  now?: () => number
  createRunId?: () => string
}>

export type WorkflowNodeTestRequest = Readonly<{
  workflowPath: string
  nodeId: string
  input: JsonValue
}>

/** The view-scoped node-test surface of the Coordinator. */
export type WorkflowRunCoordinatorWithNodeTests = WorkflowRunCoordinator &
  Readonly<{
    testNode(
      viewId: string,
      request: WorkflowNodeTestRequest,
    ): Promise<WorkflowNodeExecutionResult>
    cancelNodeTest(viewId: string): void
  }>

/**
 * Node id used for the single synthetic upstream value of non-condition and
 * non-merge node tests. Condition and merge tests instead use the real
 * predecessor node ids so the gate and the executor build the same inputs as
 * a full run.
 */
const SYNTHETIC_TEST_UPSTREAM_NODE_ID = 'test-input'

type TransitionGuard = Readonly<{
  nodeId?: string
  expectedNodeStatus?: WorkflowNodeRunStatus
  /** Only the cancel transition itself may apply while cancelRequested. */
  allowCancel?: boolean
}>

type ActiveRun = {
  workflowPath: string
  runId: string
  controller: AbortController
  snapshot: WorkflowRunSnapshot | null
  /** Resolves when the run's first snapshot has been materialized. */
  materialized: Promise<void>
  /** Serial control promise; one run step at a time. */
  serial: Promise<void>
  /** Serialized store writes in transition order. */
  persistChain: Promise<void>
  terminal: boolean
  cancelRequested: boolean
}

export function createWorkflowRunCoordinator(
  options: WorkflowRunCoordinatorOptions,
): WorkflowRunCoordinatorWithNodeTests {
  const { executor, store } = options
  const now = options.now ?? Date.now
  const createRunId = options.createRunId ?? (() => crypto.randomUUID())
  const background = options.background
  const activeRuns = new Map<string, ActiveRun>()
  const listeners = new Set<WorkflowRunSnapshotListener>()
  /** One active ephemeral node test per view id; disposal aborts it. */
  const activeNodeTests = new Map<string, AbortController>()

  const subscribe = (listener: WorkflowRunSnapshotListener): (() => void) => {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }

  const publish = (snapshot: WorkflowRunSnapshot): void => {
    for (const listener of [...listeners]) {
      try {
        listener(snapshot)
      } catch {
        // A subscriber failure must not corrupt the run or its persistence.
      }
    }
    if (background)
      background.upsert({
        id: snapshot.runId,
        title: snapshot.workflowPath,
        status: snapshot.status,
      })
  }

  /** The only writer to a run snapshot; refuses late or foreign transitions. */
  const transition = (
    run: ActiveRun,
    guard: TransitionGuard,
    apply: (current: WorkflowRunSnapshot) => WorkflowRunSnapshot,
  ): WorkflowRunSnapshot | null => {
    if (run.terminal || run.snapshot === null) return null
    if (
      !guard.allowCancel &&
      (run.cancelRequested || run.controller.signal.aborted)
    )
      return null
    if (guard.nodeId !== undefined) {
      const current = run.snapshot.nodes[guard.nodeId]
      if (
        current === undefined ||
        (guard.expectedNodeStatus !== undefined &&
          current.status !== guard.expectedNodeStatus)
      )
        return null
    }
    const next = freezeRun(apply(run.snapshot))
    run.snapshot = next
    if (isTerminalStatus(next.status)) run.terminal = true
    if (next.cancelRequested) run.cancelRequested = true
    publish(next)
    return next
  }

  const enqueuePersist = (
    run: ActiveRun,
    snapshot: WorkflowRunSnapshot,
  ): Promise<void> => {
    const pending = run.persistChain.then(async () => {
      await store.write(snapshot)
    })
    run.persistChain = pending.catch(() => undefined)
    return pending
  }

  const persistOrFail = async (
    run: ActiveRun,
    snapshot: WorkflowRunSnapshot,
  ): Promise<void> => {
    try {
      await enqueuePersist(run, snapshot)
    } catch {
      if (run.terminal) return
      const failed = transition(run, {}, (current) =>
        freezeRun({
          ...current,
          status: 'failed',
          finishedAt: now(),
          error: {
            code: 'storage-failed',
            message: 'Failed to persist the workflow run record',
          },
        }),
      )
      if (failed) await enqueuePersist(run, failed).catch(() => undefined)
    }
  }

  const withNodeRun = (
    snapshot: WorkflowRunSnapshot,
    nodeId: string,
    patch: Readonly<Partial<WorkflowNodeRun>>,
  ): WorkflowRunSnapshot => ({
    ...snapshot,
    nodes: {
      ...snapshot.nodes,
      [nodeId]: { ...snapshot.nodes[nodeId], ...patch },
    },
  })

  const failNode = async (
    run: ActiveRun,
    nodeId: string,
    code: WorkflowRunError['code'],
    message: string,
  ): Promise<void> => {
    const next = transition(run, { nodeId }, (snapshot) =>
      freezeRun({
        ...snapshot,
        status: 'failed',
        finishedAt: now(),
        error: { code, nodeId, message },
        nodes: {
          ...snapshot.nodes,
          [nodeId]: {
            ...snapshot.nodes[nodeId],
            status: 'failed',
            finishedAt: now(),
            error: { code, nodeId, message },
          },
        },
      }),
    )
    if (next) await persistOrFail(run, next)
  }

  const markSkipped = async (run: ActiveRun, nodeId: string): Promise<void> => {
    const next = transition(
      run,
      { nodeId, expectedNodeStatus: 'pending' },
      (snapshot) => withNodeRun(snapshot, nodeId, { status: 'skipped' }),
    )
    if (next) await persistOrFail(run, next)
  }

  const executeAgent = async (
    run: ActiveRun,
    node: WorkflowNode,
    sources: ReturnType<typeof activeIncomingSources>,
  ): Promise<void> => {
    const running = transition(
      run,
      { nodeId: node.id, expectedNodeStatus: 'pending' },
      (snapshot) =>
        withNodeRun(snapshot, node.id, { status: 'running', startedAt: now() }),
    )
    if (!running) return
    await persistOrFail(run, running)
    if (run.terminal || run.cancelRequested || run.controller.signal.aborted)
      return
    const request: WorkflowNodeExecutionRequest = {
      definition: run.snapshot!.definition,
      node,
      workflowInput: run.snapshot!.input,
      upstream: sources,
      signal: run.controller.signal,
    }
    let result: WorkflowNodeExecutionResult
    try {
      result = await executor.execute(request)
    } catch (error) {
      if (run.terminal || run.cancelRequested || run.controller.signal.aborted)
        return
      await failNode(
        run,
        node.id,
        error instanceof WorkflowNodeExecutionError
          ? error.code
          : 'agent-failed',
        error instanceof Error ? error.message : String(error),
      )
      return
    }
    if (run.terminal || run.cancelRequested || run.controller.signal.aborted)
      return
    if (!isJsonValue(result.value)) {
      await failNode(
        run,
        node.id,
        'invalid-output',
        `Node "${node.id}" produced a non-JSON value`,
      )
      return
    }
    if (node.outputSchema !== undefined) {
      const schemaErrors = validateJsonSchemaOutput(
        node.outputSchema,
        result.value,
      )
      if (schemaErrors.length > 0) {
        await failNode(
          run,
          node.id,
          'invalid-output',
          `Node "${node.id}" output failed its schema: ${schemaErrors.slice(0, 3).join('; ')}`,
        )
        return
      }
    }
    const succeeded = transition(
      run,
      { nodeId: node.id, expectedNodeStatus: 'running' },
      (snapshot) =>
        withNodeRun(snapshot, node.id, {
          status: 'succeeded',
          output: cloneJsonValue(result.value),
          finishedAt: now(),
        }),
    )
    if (succeeded) await persistOrFail(run, succeeded)
  }

  const processNode = async (
    run: ActiveRun,
    node: WorkflowNode,
  ): Promise<void> => {
    const topology = run.snapshot!.definition.topology
    const sources = activeIncomingSources(node, topology, run.snapshot!.nodes)
    if (node.kind === 'input') {
      const next = transition(
        run,
        { nodeId: node.id, expectedNodeStatus: 'pending' },
        (snapshot) =>
          withNodeRun(snapshot, node.id, {
            status: 'succeeded',
            output: cloneJsonValue(snapshot.input),
            startedAt: now(),
            finishedAt: now(),
          }),
      )
      if (next) await persistOrFail(run, next)
      return
    }
    if (sources.length === 0) {
      await markSkipped(run, node.id)
      return
    }
    if (node.kind === 'condition') {
      let gate: Readonly<{ conditionResult: boolean; value: JsonValue }>
      try {
        gate = evaluateWorkflowGate(node.gateType ?? 'ifElse', sources)
      } catch (error) {
        await failNode(
          run,
          node.id,
          'invalid-output',
          error instanceof Error ? error.message : String(error),
        )
        return
      }
      const next = transition(
        run,
        { nodeId: node.id, expectedNodeStatus: 'pending' },
        (snapshot) =>
          withNodeRun(snapshot, node.id, {
            status: 'succeeded',
            output: cloneJsonValue(gate.value),
            conditionResult: gate.conditionResult,
            startedAt: now(),
            finishedAt: now(),
          }),
      )
      if (next) await persistOrFail(run, next)
      return
    }
    if (node.kind === 'merge') {
      const strategy =
        node.mergeStrategy ?? run.snapshot!.definition.policy.mergeStrategy
      const value =
        sources.length === 1
          ? sources[0].value
          : mergeWorkflowSources(sources, strategy)
      const next = transition(
        run,
        { nodeId: node.id, expectedNodeStatus: 'pending' },
        (snapshot) =>
          withNodeRun(snapshot, node.id, {
            status: 'succeeded',
            output: cloneJsonValue(value),
            startedAt: now(),
            finishedAt: now(),
          }),
      )
      if (next) await persistOrFail(run, next)
      return
    }
    if (node.kind === 'output') {
      const strategy = run.snapshot!.definition.policy.mergeStrategy
      const value =
        sources.length === 1
          ? sources[0].value
          : mergeWorkflowSources(sources, strategy)
      const next = transition(
        run,
        { nodeId: node.id, expectedNodeStatus: 'pending' },
        (snapshot) =>
          withNodeRun(snapshot, node.id, {
            status: 'succeeded',
            output: cloneJsonValue(value),
            startedAt: now(),
            finishedAt: now(),
          }),
      )
      if (next) await persistOrFail(run, next)
      return
    }
    await executeAgent(run, node, sources)
  }

  const processRun = async (run: ActiveRun): Promise<void> => {
    const topology = run.snapshot!.definition.topology
    const order = topologicalWorkflowOrder(topology)
    for (const node of order) {
      if (run.terminal || run.controller.signal.aborted) return
      if (run.snapshot!.nodes[node.id]?.status !== 'pending') continue
      await processNode(run, node)
    }
    if (run.terminal || run.cancelRequested || run.controller.signal.aborted)
      return
    const outputs = aggregateWorkflowOutputs(
      topology,
      run.snapshot!.nodes,
      run.snapshot!.definition.policy,
    )
    const succeeded = transition(run, {}, (snapshot) =>
      freezeRun({
        ...snapshot,
        outputs,
        status: 'succeeded',
        finishedAt: now(),
      }),
    )
    if (succeeded) await persistOrFail(run, succeeded)
  }

  const enqueueRun = (run: ActiveRun): void => {
    run.serial = run.serial
      .then(async () => {
        try {
          await processRun(run)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          const failed = transition(run, {}, (snapshot) =>
            freezeRun({
              ...snapshot,
              status: 'failed',
              finishedAt: now(),
              error: {
                code: 'agent-failed',
                message: `Internal workflow execution error: ${message}`,
              },
            }),
          )
          if (failed) await enqueuePersist(run, failed).catch(() => undefined)
        }
      })
      .then(() => {
        if (activeRuns.get(run.workflowPath) === run)
          activeRuns.delete(run.workflowPath)
      })
  }

  const start = async (
    input: WorkflowRunStartInput,
  ): Promise<WorkflowRunStartResult> => {
    const { workflowPath } = input
    if (activeRuns.has(workflowPath))
      return { ok: false, reason: 'already-running' }
    // A full run supersedes every pending node test, in every view: a stale
    // test result must never land while the run is executing.
    for (const controller of activeNodeTests.values()) controller.abort()
    let materialize!: () => void
    const run: ActiveRun = {
      workflowPath,
      runId: createRunId(),
      controller: new AbortController(),
      snapshot: null,
      materialized: new Promise<void>((resolve) => {
        materialize = resolve
      }),
      serial: Promise.resolve(),
      persistChain: Promise.resolve(),
      terminal: false,
      cancelRequested: false,
    }
    activeRuns.set(workflowPath, run)

    const built = await createWorkflowDefinition(
      input.bundle,
      input.modelSnapshot,
    )
    if (!built.ok) {
      if (activeRuns.get(workflowPath) === run) activeRuns.delete(workflowPath)
      return {
        ok: false,
        reason:
          built.error.code === 'model-unavailable'
            ? 'model-unavailable'
            : 'invalid-definition',
        error: built.error,
      }
    }
    if (!isJsonValue(input.input)) {
      if (activeRuns.get(workflowPath) === run) activeRuns.delete(workflowPath)
      return {
        ok: false,
        reason: 'invalid-definition',
        error: {
          code: 'invalid-definition',
          message: 'Workflow input must be JSON-compatible',
        },
      }
    }
    const pendingNodes: Record<string, WorkflowNodeRun> = {}
    for (const node of built.definition.topology.nodes)
      pendingNodes[node.id] = { status: 'pending' }
    const snapshot = freezeRun({
      schemaVersion: 1,
      runId: run.runId,
      workflowPath,
      definition: built.definition,
      input: cloneJsonValue(input.input),
      status: 'running',
      nodes: pendingNodes,
      outputs: {},
      startedAt: now(),
    })
    run.snapshot = snapshot
    materialize()
    publish(snapshot)
    try {
      await enqueuePersist(run, snapshot)
    } catch {
      if (activeRuns.get(workflowPath) === run) activeRuns.delete(workflowPath)
      return {
        ok: false,
        reason: 'storage-failed',
        error: {
          code: 'storage-failed',
          message: 'Failed to persist the workflow run record',
        },
      }
    }
    enqueueRun(run)
    return { ok: true, runId: run.runId }
  }

  const cancel = async (workflowPath: string): Promise<void> => {
    const run = activeRuns.get(workflowPath)
    if (!run) return
    run.controller.abort()
    if (run.snapshot === null) await run.materialized
    if (activeRuns.get(workflowPath) !== run || run.snapshot === null) return
    const next = transition(run, { allowCancel: true }, (snapshot) =>
      freezeRun({
        ...snapshot,
        cancelRequested: true,
        status: 'cancelled',
        finishedAt: now(),
      }),
    )
    if (next) await enqueuePersist(run, next).catch(() => undefined)
  }

  const continueRun = async (
    workflowPath: string,
    confirmation: WorkflowRunContinueConfirmation,
  ): Promise<WorkflowRunContinueResult> => {
    if (activeRuns.has(workflowPath))
      return { ok: false, reason: 'already-running' }
    if (!confirmation.confirmSideEffects)
      return { ok: false, reason: 'side-effect-confirmation-required' }
    let record: WorkflowRunSnapshot | null
    try {
      record = await store.read(workflowPath)
    } catch {
      return {
        ok: false,
        reason: 'storage-failed',
        error: {
          code: 'storage-failed',
          message: 'Failed to read the workflow run record',
        },
      }
    }
    if (!record) return { ok: false, reason: 'not-found' }
    if (record.status === 'succeeded')
      return { ok: false, reason: 'not-continuable' }
    const resumeNodeId = topologicalWorkflowOrder(
      record.definition.topology,
    ).find((node) => {
      const status = record.nodes[node.id]?.status
      return status !== 'succeeded' && status !== 'skipped'
    })?.id
    if (!resumeNodeId) return { ok: false, reason: 'not-continuable' }
    let materialize!: () => void
    const run: ActiveRun = {
      workflowPath,
      runId: record.runId,
      controller: new AbortController(),
      snapshot: null,
      materialized: new Promise<void>((resolve) => {
        materialize = resolve
      }),
      serial: Promise.resolve(),
      persistChain: Promise.resolve(),
      terminal: false,
      cancelRequested: false,
    }
    activeRuns.set(workflowPath, run)
    const snapshot = freezeRun({
      ...record,
      status: 'running',
      cancelRequested: false,
      error: undefined,
      finishedAt: undefined,
      nodes: { ...record.nodes, [resumeNodeId]: { status: 'pending' } },
    })
    run.snapshot = snapshot
    materialize()
    publish(snapshot)
    try {
      await enqueuePersist(run, snapshot)
    } catch {
      if (activeRuns.get(workflowPath) === run) activeRuns.delete(workflowPath)
      return {
        ok: false,
        reason: 'storage-failed',
        error: {
          code: 'storage-failed',
          message: 'Failed to persist the workflow run record',
        },
      }
    }
    enqueueRun(run)
    return { ok: true, runId: run.runId }
  }

  const initialize = async (): Promise<void> => {
    const records = await store.list()
    for (const record of records) {
      if (record.status !== 'running') continue
      const interrupted = freezeRun({
        ...record,
        status: 'interrupted',
        finishedAt: now(),
      })
      await store.write(interrupted)
      for (const listener of [...listeners]) {
        try {
          listener(interrupted)
        } catch {
          // Subscriber isolation, same as publish.
        }
      }
    }
  }

  const quiesce = async (): Promise<void> => {
    const persists: Promise<void>[] = []
    for (const run of [...activeRuns.values()]) {
      run.controller.abort()
      const next = transition(run, { allowCancel: true }, (snapshot) =>
        freezeRun({ ...snapshot, status: 'interrupted', finishedAt: now() }),
      )
      if (next) persists.push(enqueuePersist(run, next).catch(() => undefined))
    }
    await Promise.all(persists)
  }

  /**
   * Runs one node through the same execution path as a full run without
   * creating a run snapshot, persisting, publishing, or executing
   * dependencies. The definition comes from the persisted run record of the
   * same workflow, so the test exercises the exact frozen definition,
   * resolved models, prompts, schema validation, and vault-write capability
   * of the last full run. Condition nodes are the one exception: they are
   * judged by the coordinator's deterministic local gate exactly like a full
   * run, so the preview never consults the model. The executor result is
   * returned directly; the signal is the view's own controller, aborted by
   * `cancelNodeTest`.
   */
  const testNode = async (
    viewId: string,
    request: WorkflowNodeTestRequest,
  ): Promise<WorkflowNodeExecutionResult> => {
    const { workflowPath, nodeId, input } = request
    if (activeRuns.has(workflowPath))
      throw new WorkflowNodeExecutionError(
        'cancelled',
        `A full run is already active for "${workflowPath}"`,
      )
    // One active test per view: a new test replaces (aborts) the previous.
    activeNodeTests.get(viewId)?.abort()
    const controller = new AbortController()
    activeNodeTests.set(viewId, controller)
    try {
      if (!isJsonValue(input))
        throw new WorkflowNodeExecutionError(
          'invalid-definition',
          'Workflow input must be JSON-compatible',
        )
      const record = await store.read(workflowPath)
      if (record === null)
        throw new WorkflowNodeExecutionError(
          'invalid-definition',
          `No run record for "${workflowPath}"; run the workflow once before testing a node`,
        )
      const node = record.definition.topology.nodes.find(
        (candidate) => candidate.id === nodeId,
      )
      if (node === undefined)
        throw new WorkflowNodeExecutionError(
          'invalid-definition',
          `Node "${nodeId}" is not part of workflow "${workflowPath}"`,
        )
      // Same deterministic local gate as the full-run condition branch; the
      // executor's model-judged condition path stays out of run and testNode.
      if (node.kind === 'condition') {
        const sources = nodeTestUpstream(
          node,
          record.definition.topology,
          input,
        )
        if (sources.length === 0)
          throw new WorkflowNodeExecutionError(
            'invalid-output',
            `Condition node "${node.id}" requires at least one active source`,
          )
        try {
          const gate = evaluateWorkflowGate(node.gateType ?? 'ifElse', sources)
          return { value: gate.value, conditionResult: gate.conditionResult }
        } catch (error) {
          throw new WorkflowNodeExecutionError(
            'invalid-output',
            error instanceof Error ? error.message : String(error),
          )
        }
      }
      const executionRequest: WorkflowNodeExecutionRequest = {
        definition: record.definition,
        node,
        workflowInput: input,
        upstream: nodeTestUpstream(node, record.definition.topology, input),
        signal: controller.signal,
      }
      let result: WorkflowNodeExecutionResult
      try {
        result = await executor.testNode(executionRequest)
      } catch (error) {
        throw error instanceof WorkflowNodeExecutionError
          ? error
          : new WorkflowNodeExecutionError(
              'agent-failed',
              error instanceof Error ? error.message : String(error),
            )
      }
      if (controller.signal.aborted)
        throw new WorkflowNodeExecutionError('cancelled', 'Node test cancelled')
      if (!isJsonValue(result.value))
        throw new WorkflowNodeExecutionError(
          'invalid-output',
          `Node "${nodeId}" produced a non-JSON value`,
        )
      if (node.outputSchema !== undefined) {
        const schemaErrors = validateJsonSchemaOutput(
          node.outputSchema,
          result.value,
        )
        if (schemaErrors.length > 0)
          throw new WorkflowNodeExecutionError(
            'invalid-output',
            `Node "${nodeId}" output failed its schema: ${schemaErrors.slice(0, 3).join('; ')}`,
          )
      }
      return result
    } finally {
      if (activeNodeTests.get(viewId) === controller)
        activeNodeTests.delete(viewId)
    }
  }

  const cancelNodeTest = (viewId: string): void => {
    activeNodeTests.get(viewId)?.abort()
  }

  return Object.freeze({
    start,
    cancel,
    continueRun,
    initialize,
    quiesce,
    subscribe,
    testNode,
    cancelNodeTest,
  })
}

/**
 * Builds the synthetic upstream for a node test. Condition and merge nodes
 * use their real predecessor node ids exactly as a full run does: a single
 * incoming edge carries the test input under the predecessor id, and
 * multi-incoming-edge tests take an object keyed by those ids (stable edge
 * id order, missing keys contribute nothing). Every other kind receives one
 * synthetic predecessor holding the plain input.
 */
function nodeTestUpstream(
  node: WorkflowNode,
  topology: WorkflowTopology,
  input: JsonValue,
): readonly WorkflowSourceValue[] {
  const incoming = stableIncomingEdges(topology, node.id)
  if (node.kind === 'condition' || node.kind === 'merge') {
    if (incoming.length <= 1)
      return Object.freeze(
        incoming.length === 0
          ? []
          : [{ nodeId: incoming[0].source, value: input }],
      )
    if (!isJsonRecord(input))
      throw new WorkflowNodeExecutionError(
        'invalid-definition',
        `Node "${node.id}" test input must be an object keyed by its incoming node ids: ${incoming.map((edge) => edge.source).join(', ')}`,
      )
    return Object.freeze(
      incoming.flatMap((edge) => {
        const value = input[edge.source]
        return value === undefined ? [] : [{ nodeId: edge.source, value }]
      }),
    )
  }
  return Object.freeze([
    { nodeId: SYNTHETIC_TEST_UPSTREAM_NODE_ID, value: input },
  ])
}

function isTerminalStatus(status: WorkflowRunStatus): boolean {
  return status !== 'running'
}

function freezeRun(snapshot: WorkflowRunSnapshot): WorkflowRunSnapshot {
  return deepFreeze(snapshot)
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJsonValue))
  if (isJsonRecord(value)) {
    const cloned: Record<string, JsonValue> = {}
    for (const [key, child] of Object.entries(value)) {
      Object.defineProperty(cloned, key, {
        value: cloneJsonValue(child),
        enumerable: true,
        configurable: true,
        writable: true,
      })
    }
    return Object.freeze(cloned)
  }
  return value
}

function isJsonRecord(
  value: unknown,
): value is Readonly<Record<string, JsonValue>> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  )
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
