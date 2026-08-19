import type { WorkflowNode } from '../domain/workflow-model'

import {
  WORKFLOW_AGENT_SYSTEM_PROTOCOL,
  createWorkflowNodeExecutor,
} from './workflow-node-executor'
import type {
  WorkflowAgent,
  WorkflowAgentEvent,
  WorkflowAgentRequest,
  WorkflowAgentTool,
  WorkflowAgentToolResult,
} from './workflow-node-executor'
import { WorkflowNodeExecutionError } from './workflow-run-types'
import type {
  JsonValue,
  WorkflowDefinitionSnapshot,
  WorkflowNodeExecutionRequest,
  WorkflowNodeExecutionResult,
} from './workflow-run-types'

type StreamScript = (
  request: WorkflowAgentRequest,
) => AsyncIterable<WorkflowAgentEvent>

class FakeAgent implements WorkflowAgent {
  readonly calls: WorkflowAgentRequest[] = []

  constructor(private readonly script: StreamScript) {}

  async *stream(
    request: WorkflowAgentRequest,
  ): AsyncIterable<WorkflowAgentEvent> {
    this.calls.push(request)
    yield* this.script(request)
  }
}

const stepContents: Readonly<Record<string, string>> = Object.freeze({
  in: '# Request step\n',
  agent: '# Agent step\n\nProduce the draft.\n',
  map: '# Map step\n\nTransform each item.\n',
  gate: '# Condition step\n\nJudge each source.\n',
  merged: '# Merge step\n',
  out: '# Output step\n',
})

const nodeIds = Object.freeze([
  'in',
  'agent',
  'map',
  'gate',
  'merged',
  'out',
] as const)

const definition = (): WorkflowDefinitionSnapshot =>
  Object.freeze({
    workflowPath: 'demo/WORKFLOW.md',
    workflowContextMarkdown:
      '# Demo workflow context\n\nContext prose before the step text.\n',
    topology: Object.freeze({
      revision: 1,
      nodes: Object.freeze(
        nodeIds.map((id) =>
          Object.freeze({
            id,
            kind: (id === 'gate'
              ? 'condition'
              : id === 'map'
                ? 'mapAgent'
                : id === 'merged'
                  ? 'merge'
                  : id === 'out'
                    ? 'output'
                    : id === 'in'
                      ? 'input'
                      : 'agent') as WorkflowNode['kind'],
            label: id,
            stepPath: `steps/${id}/STEP.md`,
            position: { x: 0, y: 0 },
          }),
        ),
      ),
      edges: Object.freeze([]),
    }),
    stepContents,
    modelByNodeId: Object.freeze(
      Object.fromEntries(nodeIds.map((id) => [id, 'model-a'])),
    ),
    policy: Object.freeze({
      capability: 'vault-write',
      mapConcurrency: 3,
      mergeStrategy: 'concat',
    }),
    definitionHash: 'def-hash',
  })

const node = (
  id: string,
  kind: WorkflowNode['kind'],
  stepPath: string,
  extra: Readonly<Partial<WorkflowNode>> = {},
): WorkflowNode => ({
  id,
  kind,
  label: id,
  stepPath,
  position: { x: 0, y: 0 },
  ...extra,
})

const makeRequest = (
  overrides: Readonly<Partial<WorkflowNodeExecutionRequest>> &
    Readonly<{ node?: WorkflowNode }>,
): WorkflowNodeExecutionRequest => ({
  definition: definition(),
  node: node('agent', 'agent', 'steps/agent/STEP.md'),
  workflowInput: { topic: 'draft a plan' },
  upstream: [],
  signal: new AbortController().signal,
  ...overrides,
})

const makeExecutor = (script: StreamScript) => {
  const agent = new FakeAgent(script)
  const executor = createWorkflowNodeExecutor({ agent })
  return { agent, executor }
}

/** A script that fails the test if the executor ever pulls from it. */
const neverAgent: StreamScript = async function* () {
  throw new Error('the Agent must not be called')
  // Unreachable; the throw above fires on the first pull.
  yield { type: 'completed', text: '' }
}

const lastTool = (agent: FakeAgent): WorkflowAgentTool => {
  const tool = agent.calls[agent.calls.length - 1]?.tools?.[0]
  if (!tool) throw new Error('the last agent call had no tool')
  return tool
}

const outputSchema = (): unknown => ({
  type: 'object',
  properties: { plan: { type: 'string' } },
  required: ['plan'],
  additionalProperties: false,
})

const completed = (text = ''): WorkflowAgentEvent => ({
  type: 'completed',
  text,
})

const deferred = (): { promise: Promise<void>; resolve: () => void } => {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const until = async (
  predicate: () => boolean,
  timeoutMs = 3000,
): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('workflow node executor', () => {
  it('input returns the run input without an Agent call', async () => {
    const { agent, executor } = makeExecutor(neverAgent)
    const input = { topic: 'draft a plan' }
    const result = await executor.execute(
      makeRequest({
        node: node('in', 'input', 'steps/in/STEP.md'),
        workflowInput: input,
      }),
    )
    expect(result).toEqual({ value: input })
    expect(agent.calls.length).toBe(0)
  })

  it('builds stable agent requests with dynamic input only in the prompt', async () => {
    const { agent, executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (tool) await tool.handler({ value: { plan: 'x' } })
      yield completed()
    })
    const schema = outputSchema()
    const nodeWithSchema = node('agent', 'agent', 'steps/agent/STEP.md', {
      outputSchema: schema,
    })
    const signal = new AbortController().signal
    const first = await executor.execute(
      makeRequest({
        node: nodeWithSchema,
        workflowInput: { topic: 'alpha' },
        upstream: [{ nodeId: 'in', value: 'v1' }],
        signal,
      }),
    )
    const second = await executor.execute(
      makeRequest({
        node: nodeWithSchema,
        workflowInput: { topic: 'beta' },
        upstream: [{ nodeId: 'in', value: 'v2' }],
      }),
    )
    expect(first.value).toEqual({ plan: 'x' })
    expect(second.value).toEqual({ plan: 'x' })

    expect(agent.calls.length).toBe(2)
    const [callA, callB] = agent.calls
    // The system prompt is stable across calls; only the prompt carries input.
    expect(callA.systemPrompt).toBe(callB.systemPrompt)
    expect(callA.prompt).toBe(
      JSON.stringify({
        workflowInput: { topic: 'alpha' },
        upstream: [{ nodeId: 'in', value: 'v1' }],
      }),
    )
    expect(callB.prompt).toBe(
      JSON.stringify({
        workflowInput: { topic: 'beta' },
        upstream: [{ nodeId: 'in', value: 'v2' }],
      }),
    )
    expect(callA.systemPrompt).not.toContain('alpha')
    expect(callB.systemPrompt).not.toContain('beta')

    // Stable protocol, then the Workflow context, then the STEP text, then the
    // output instruction.
    const context = definition().workflowContextMarkdown
    const step = stepContents['agent']
    expect(callA.systemPrompt.startsWith(WORKFLOW_AGENT_SYSTEM_PROTOCOL)).toBe(
      true,
    )
    expect(callA.systemPrompt.indexOf(context)).toBeGreaterThan(
      callA.systemPrompt.indexOf(WORKFLOW_AGENT_SYSTEM_PROTOCOL),
    )
    expect(callA.systemPrompt.indexOf(step)).toBeGreaterThan(
      callA.systemPrompt.indexOf(context),
    )
    expect(
      callA.systemPrompt.startsWith(
        [WORKFLOW_AGENT_SYSTEM_PROTOCOL, context, step].join('\n\n') + '\n\n',
      ),
    ).toBe(true)

    // Fixed request fields.
    expect(callA.modelId).toBe('model-a')
    expect(callA.capability).toBe('vault-write')
    expect(callA.activity).toEqual({
      title: 'demo/WORKFLOW.md',
      detail: 'agent',
    })
    expect(callA.signal).toBe(signal)

    // No run id, timestamp, or provider metadata anywhere in the request.
    expect(callA).not.toHaveProperty('runId')
    expect(callA).not.toHaveProperty('providerId')
    expect(callA).not.toHaveProperty('startedAt')
    expect(callA).not.toHaveProperty('messages')
    expect(JSON.stringify(callA)).not.toMatch(/run-\d+/)
    expect(JSON.stringify(callA)).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('agent with outputSchema requires exactly one valid submit_workflow_output call', async () => {
    const schema = outputSchema()
    const { agent, executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (!tool) throw new Error('expected a submit tool')
      expect(tool.name).toBe('submit_workflow_output')
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { value: schema },
        required: ['value'],
        additionalProperties: false,
      })
      const accepted = await tool.handler({ value: { plan: 'draft' } })
      expect(accepted.isError).not.toBe(true)
      yield { type: 'tool', name: tool.name, status: 'completed' }
      yield completed('ignored model text')
    })
    const result = await executor.execute(
      makeRequest({
        node: node('agent', 'agent', 'steps/agent/STEP.md', {
          outputSchema: schema,
        }),
        upstream: [{ nodeId: 'in', value: 'v1' }],
      }),
    )
    expect(result).toEqual({ value: { plan: 'draft' } })
    expect(agent.calls.length).toBe(1)
  })

  it('agent without outputSchema returns completed.text as a string and never parses JSON text', async () => {
    const { agent, executor } = makeExecutor(async function* () {
      yield { type: 'text', text: '{"answer": ', delta: '{"answer": ' }
      yield { type: 'text', text: '{"answer": 42}', delta: '42}' }
      yield completed('{"answer": 42}')
    })
    const result = await executor.execute(makeRequest({}))
    expect(result).toEqual({ value: '{"answer": 42}' })
    expect(agent.calls[0].tools).toBeUndefined()
  })

  it('passes completed usage through to the node result', async () => {
    const { executor } = makeExecutor(async function* () {
      yield {
        type: 'completed',
        text: 'x',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
      }
    })
    const result = await executor.execute(makeRequest({}))
    expect(result).toEqual({
      value: 'x',
      usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10 },
    })
  })

  it('omits usage from the node result when the completed event carries none', async () => {
    const { executor } = makeExecutor(async function* () {
      yield completed('x')
    })
    const result = await executor.execute(makeRequest({}))
    expect(result).toEqual({ value: 'x' })
    expect(result).not.toHaveProperty('usage')
  })

  it('sums per-item usage across mapAgent workers with a total fallback', async () => {
    const { executor } = makeExecutor(async function* (request) {
      const parsed = JSON.parse(request.prompt ?? '{}') as { index: number }
      yield {
        type: 'completed',
        text: `r-${parsed.index}`,
        usage: { inputTokens: 2, outputTokens: 1 },
      }
    })
    const result = await executor.execute(
      makeRequest({
        node: node('map', 'mapAgent', 'steps/map/STEP.md'),
        upstream: [{ nodeId: 'a', value: ['i0', 'i1'] }],
      }),
    )
    expect(result.value).toEqual(['r-0', 'r-1'])
    // Each call has no explicit total; the per-call input+output fallback
    // (3) sums across the two workers.
    expect(result.usage).toEqual({
      inputTokens: 4,
      outputTokens: 2,
      totalTokens: 6,
    })
  })

  it('duplicate or invalid output submissions return tool errors and do not overwrite the first value', async () => {
    const schema = outputSchema()
    const outcomes: WorkflowAgentToolResult[] = []
    const { executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (!tool) throw new Error('expected a submit tool')
      outcomes.push(await tool.handler({ value: { plan: 'first' } }))
      outcomes.push(await tool.handler({ value: { plan: 'second' } }))
      outcomes.push(await tool.handler({ value: { count: 1 } }))
      outcomes.push(
        await tool.handler({ value: { plan: 'third' }, extra: true }),
      )
      yield completed()
    })
    const result = await executor.execute(
      makeRequest({
        node: node('agent', 'agent', 'steps/agent/STEP.md', {
          outputSchema: schema,
        }),
      }),
    )
    expect(result).toEqual({ value: { plan: 'first' } })
    expect(outcomes[0].isError).toBeUndefined()
    expect(outcomes[1].isError).toBe(true)
    expect(outcomes[2].isError).toBe(true)
    expect(outcomes[3].isError).toBe(true)
  })

  it('condition requires one boolean per active source through submit_workflow_condition', async () => {
    const outcomes: WorkflowAgentToolResult[] = []
    const { executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (!tool) throw new Error('expected a condition tool')
      expect(tool.name).toBe('submit_workflow_condition')
      expect(tool.inputSchema).toEqual({
        type: 'object',
        properties: { a: { type: 'boolean' }, b: { type: 'boolean' } },
        required: ['a', 'b'],
        additionalProperties: false,
      })
      outcomes.push(await tool.handler({ a: true }))
      outcomes.push(await tool.handler({ a: true, b: true, c: true }))
      outcomes.push(await tool.handler({ a: 'yes', b: true }))
      outcomes.push(await tool.handler({ a: true, b: false }))
      yield completed()
    })
    const result = await executor.execute(
      makeRequest({
        node: node('gate', 'condition', 'steps/gate/STEP.md', {
          gateType: 'and',
        }),
        upstream: [
          { nodeId: 'a', value: 'x' },
          { nodeId: 'b', value: 5 },
        ],
      }),
    )
    expect(result.conditionResult).toBe(false)
    expect(result.value).toEqual({ a: 'x', b: 5 })
    expect(outcomes.map((entry) => entry.isError ?? false)).toEqual([
      true,
      true,
      true,
      false,
    ])
  })

  it('condition computes the gate in deterministic code and preserves source data as output', async () => {
    const runCondition = (
      gateType: WorkflowNode['gateType'],
      upstream: readonly Readonly<{ nodeId: string; value: JsonValue }>[],
      booleans: Readonly<Record<string, boolean>>,
    ): Promise<WorkflowNodeExecutionResult> => {
      const { executor } = makeExecutor(async function* (request) {
        const tool = request.tools?.[0]
        if (!tool) throw new Error('expected a condition tool')
        await tool.handler(booleans as Readonly<Record<string, unknown>>)
        yield completed()
      })
      return executor.execute(
        makeRequest({
          node: node('gate', 'condition', 'steps/gate/STEP.md', { gateType }),
          upstream: upstream.map((source) => ({ ...source })),
        }),
      )
    }

    const andResult = await runCondition(
      'and',
      [
        { nodeId: 'a', value: 'x' },
        { nodeId: 'b', value: { n: 1 } },
      ],
      { a: true, b: true },
    )
    expect(andResult).toEqual({
      value: { a: 'x', b: { n: 1 } },
      conditionResult: true,
    })

    const xorResult = await runCondition(
      'xor',
      [
        { nodeId: 'a', value: 1 },
        { nodeId: 'b', value: 2 },
      ],
      { a: true, b: false },
    )
    expect(xorResult.conditionResult).toBe(true)

    const ifElseResult = await runCondition(
      'ifElse',
      [{ nodeId: 'a', value: 'x' }],
      {
        a: true,
      },
    )
    expect(ifElseResult).toEqual({ value: 'x', conditionResult: true })
  })

  it('mapAgent rejects non-arrays and multiple active upstreams', async () => {
    const mapNode = node('map', 'mapAgent', 'steps/map/STEP.md')
    const { agent, executor } = makeExecutor(neverAgent)
    await expect(
      executor.execute(makeRequest({ node: mapNode, upstream: [] })),
    ).rejects.toMatchObject({ code: 'invalid-output' })
    await expect(
      executor.execute(
        makeRequest({
          node: mapNode,
          upstream: [
            { nodeId: 'a', value: [1] },
            { nodeId: 'b', value: [2] },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-output' })
    await expect(
      executor.execute(
        makeRequest({
          node: mapNode,
          upstream: [{ nodeId: 'a', value: 'nope' }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-output' })
    expect(agent.calls.length).toBe(0)
  })

  it('mapAgent runs at most three calls concurrently and preserves input order', async () => {
    const items = ['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6']
    const gates = items.map(() => deferred())
    let active = 0
    let maxActive = 0
    const { executor } = makeExecutor(async function* (request) {
      const parsed = JSON.parse(request.prompt ?? '{}') as {
        workflowInput: unknown
        index: number
        item: unknown
      }
      expect(parsed.workflowInput).toEqual({ topic: 'draft a plan' })
      expect(parsed.item).toBe(items[parsed.index])
      active += 1
      maxActive = Math.max(maxActive, active)
      await gates[parsed.index].promise
      active -= 1
      yield completed(`result-${parsed.index}`)
    })
    const run = executor.execute(
      makeRequest({
        node: node('map', 'mapAgent', 'steps/map/STEP.md'),
        upstream: [{ nodeId: 'a', value: items }],
      }),
    )
    await until(() => active === 3)
    expect(maxActive).toBe(3)
    gates[1].resolve()
    gates[2].resolve()
    await until(() => active === 3)
    gates[3].resolve()
    gates[4].resolve()
    await until(() => active === 3)
    gates[5].resolve()
    gates[6].resolve()
    await until(() => active === 1)
    gates[0].resolve()
    const result = await run
    expect(maxActive).toBe(3)
    expect(result.value).toEqual([
      'result-0',
      'result-1',
      'result-2',
      'result-3',
      'result-4',
      'result-5',
      'result-6',
    ])
  })

  it('mapAgent aborts sibling calls and rejects the whole node after the first item error', async () => {
    const interrupted: number[] = []
    const { agent, executor } = makeExecutor(async function* (request) {
      const parsed = JSON.parse(request.prompt ?? '{}') as { index: number }
      if (parsed.index === 3)
        throw new WorkflowNodeExecutionError('invalid-output', 'item failed')
      if (parsed.index >= 4) {
        // In-flight siblings stop when the shared abort signal fires.
        const signal = request.signal
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          else
            signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        interrupted.push(parsed.index)
        yield { type: 'aborted' }
        return
      }
      yield completed(`result-${parsed.index}`)
    })
    const run = executor.execute(
      makeRequest({
        node: node('map', 'mapAgent', 'steps/map/STEP.md'),
        upstream: [
          { nodeId: 'a', value: ['i0', 'i1', 'i2', 'i3', 'i4', 'i5', 'i6'] },
        ],
      }),
    )
    // Attach the rejection handler before polling so a fast rejection cannot
    // surface as an unhandled rejection while `until` waits.
    const rejection = run.then(
      () => new Error('mapAgent run unexpectedly succeeded'),
      (error: unknown) => error,
    )
    await until(() => agent.calls.length === 6)
    await expect(rejection).resolves.toMatchObject({
      code: 'invalid-output',
      message: 'item failed',
    })
    // Items 0-2 completed first; the failing item 3 aborted the in-flight
    // siblings (4 and 5) and item 6 never started.
    expect([...interrupted].sort()).toEqual([4, 5])
    expect(agent.calls.length).toBe(6)
  })

  it('mapAgent with an empty array makes zero Agent calls', async () => {
    const { agent, executor } = makeExecutor(neverAgent)
    const result = await executor.execute(
      makeRequest({
        node: node('map', 'mapAgent', 'steps/map/STEP.md'),
        upstream: [{ nodeId: 'a', value: [] }],
      }),
    )
    expect(result).toEqual({ value: [] })
    expect(agent.calls.length).toBe(0)
  })

  it('mapAgent validates the assembled array against the node output schema', async () => {
    const mapNode = node('map', 'mapAgent', 'steps/map/STEP.md', {
      outputSchema: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
      },
    })
    const { executor } = makeExecutor(async function* (request) {
      const parsed = JSON.parse(request.prompt ?? '{}') as { index: number }
      expect(request.tools).toBeUndefined()
      yield completed(`result-${parsed.index}`)
    })
    const ok = await executor.execute(
      makeRequest({
        node: mapNode,
        upstream: [{ nodeId: 'a', value: ['i0', 'i1'] }],
      }),
    )
    expect(ok.value).toEqual(['result-0', 'result-1'])

    const failing = makeExecutor(async function* () {
      yield completed('not a number')
    })
    await expect(
      failing.executor.execute(
        makeRequest({
          node: node('map', 'mapAgent', 'steps/map/STEP.md', {
            outputSchema: { type: 'array', items: { type: 'integer' } },
          }),
          upstream: [{ nodeId: 'a', value: ['i0', 'i1'] }],
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('merge never calls the Agent and supports concat and dedupe', async () => {
    const { agent, executor } = makeExecutor(neverAgent)
    const concat = await executor.execute(
      makeRequest({
        node: node('merged', 'merge', 'steps/merged/STEP.md'),
        upstream: [
          { nodeId: 'a', value: [1, 2] },
          { nodeId: 'b', value: [2, 3] },
        ],
      }),
    )
    expect(concat.value).toEqual([1, 2, 2, 3])

    const dedupe = await executor.execute(
      makeRequest({
        node: node('merged', 'merge', 'steps/merged/STEP.md', {
          mergeStrategy: 'dedupe',
        }),
        upstream: [
          { nodeId: 'a', value: [1, 2] },
          { nodeId: 'b', value: [2, 3] },
        ],
      }),
    )
    expect(dedupe.value).toEqual([1, 2, 3])

    const single = await executor.execute(
      makeRequest({
        node: node('merged', 'merge', 'steps/merged/STEP.md'),
        upstream: [{ nodeId: 'a', value: 42 }],
      }),
    )
    expect(single.value).toBe(42)
    expect(agent.calls.length).toBe(0)
  })

  it('output never calls the Agent and preserves single-source values', async () => {
    const { agent, executor } = makeExecutor(neverAgent)
    const single = await executor.execute(
      makeRequest({
        node: node('out', 'output', 'steps/out/STEP.md'),
        upstream: [{ nodeId: 'a', value: 42 }],
      }),
    )
    expect(single.value).toBe(42)

    const multi = await executor.execute(
      makeRequest({
        node: node('out', 'output', 'steps/out/STEP.md'),
        upstream: [
          { nodeId: 'a', value: [1] },
          { nodeId: 'b', value: [2, 3] },
        ],
      }),
    )
    expect(multi.value).toEqual([1, 2, 3])
    expect(agent.calls.length).toBe(0)
  })

  it('invalid output and schema errors use stable error codes', async () => {
    const mapNode = node('map', 'mapAgent', 'steps/map/STEP.md')
    const schemaNode = node('agent', 'agent', 'steps/agent/STEP.md', {
      outputSchema: outputSchema(),
    })

    // A schema node without a successful submission is agent-failed.
    const noSubmission = makeExecutor(async function* () {
      yield completed('model prose without a submission')
    })
    await expect(
      noSubmission.executor.execute(makeRequest({ node: schemaNode })),
    ).rejects.toBeInstanceOf(WorkflowNodeExecutionError)
    await expect(
      noSubmission.executor.execute(makeRequest({ node: schemaNode })),
    ).rejects.toMatchObject({ code: 'agent-failed' })

    // Agent error events are agent-failed.
    const errorEvent = makeExecutor(async function* () {
      yield { type: 'error', message: 'provider exploded' }
    })
    await expect(
      errorEvent.executor.execute(makeRequest({ node: schemaNode })),
    ).rejects.toMatchObject({
      code: 'agent-failed',
      message: 'Agent failed: provider exploded',
    })

    // An aborted event without a cancelled signal is agent-failed.
    const aborted = makeExecutor(async function* () {
      yield { type: 'aborted' }
    })
    await expect(
      aborted.executor.execute(makeRequest({ node: schemaNode })),
    ).rejects.toMatchObject({ code: 'agent-failed' })

    // An aborted event on a cancelled signal is cancelled.
    const cancelled = makeExecutor(async function* () {
      yield { type: 'aborted' }
    })
    const controller = new AbortController()
    const cancelledRun = cancelled.executor.execute(
      makeRequest({ node: schemaNode, signal: controller.signal }),
    )
    controller.abort()
    await expect(cancelledRun).rejects.toMatchObject({ code: 'cancelled' })

    // A stream that ends without a completion is agent-failed.
    const silent = makeExecutor(async function* () {})
    await expect(
      silent.executor.execute(makeRequest({ node: schemaNode })),
    ).rejects.toMatchObject({ code: 'agent-failed' })

    // A condition without a submission is agent-failed.
    const gate = node('gate', 'condition', 'steps/gate/STEP.md', {
      gateType: 'ifElse',
    })
    const conditionNoSubmit = makeExecutor(async function* () {
      yield completed()
    })
    await expect(
      conditionNoSubmit.executor.execute(
        makeRequest({ node: gate, upstream: [{ nodeId: 'a', value: 'x' }] }),
      ),
    ).rejects.toMatchObject({ code: 'agent-failed' })

    // A condition with no active sources is invalid-output.
    const conditionNoSources = makeExecutor(neverAgent)
    await expect(
      conditionNoSources.executor.execute(
        makeRequest({ node: gate, upstream: [] }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-output' })

    // mapAgent validation failures are invalid-output.
    const mapFailure = makeExecutor(neverAgent)
    await expect(
      mapFailure.executor.execute(
        makeRequest({ node: mapNode, upstream: [{ nodeId: 'a', value: 7 }] }),
      ),
    ).rejects.toMatchObject({ code: 'invalid-output' })
  })

  it('the submit tool of the last call can be driven by the host on behalf of the model', async () => {
    // The fake records requests and exposes the request-scoped tool handler so
    // tests simulate the host invoking the tool serially per run.
    const { agent, executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (!tool) throw new Error('expected a submit tool')
      const result = await tool.handler({ value: { plan: 'host-driven' } })
      expect(result.isError).not.toBe(true)
      yield { type: 'tool', name: tool.name, status: 'completed' }
      yield completed()
    })
    await executor.execute(
      makeRequest({
        node: node('agent', 'agent', 'steps/agent/STEP.md', {
          outputSchema: outputSchema(),
        }),
      }),
    )
    const tool = lastTool(agent)
    expect(tool.name).toBe('submit_workflow_output')
    expect(typeof tool.handler).toBe('function')
  })

  it('repairs exactly once after a rejected submission, then succeeds', async () => {
    const schema = outputSchema()
    const { agent, executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (!tool) throw new Error('expected a submit tool')
      if (agent.calls.length === 1) {
        // First round: one schema rejection and no valid submission, so the
        // repair round is the one that submits the accepted value.
        const rejected = await tool.handler({ value: { plan: 42 } })
        expect(rejected.isError).toBe(true)
      } else {
        const accepted = await tool.handler({ value: { plan: 'draft' } })
        expect(accepted.isError).not.toBe(true)
      }
      yield completed()
    })
    const result = await executor.execute(
      makeRequest({
        node: node('agent', 'agent', 'steps/agent/STEP.md', {
          outputSchema: schema,
        }),
        upstream: [{ nodeId: 'in', value: 'v1' }],
      }),
    )
    expect(result).toEqual({ value: { plan: 'draft' } })
    expect(agent.calls.length).toBe(2)
    // The repair round keeps the stable system prompt and only changes the
    // prompt with the rejection feedback.
    expect(agent.calls[1].systemPrompt).toBe(agent.calls[0].systemPrompt)
    expect(agent.calls[1].prompt).toContain('previous submission was rejected')
    expect(agent.calls[1].prompt).toContain('Rejected value: {"plan":42}')
  })

  it('does not repair when the stream ends without any submission', async () => {
    const { agent, executor } = makeExecutor(async function* () {
      yield completed('model prose without a submission')
    })
    await expect(
      executor.execute(
        makeRequest({
          node: node('agent', 'agent', 'steps/agent/STEP.md', {
            outputSchema: outputSchema(),
          }),
        }),
      ),
    ).rejects.toMatchObject({ code: 'agent-failed' })
    expect(agent.calls.length).toBe(1)
  })

  it('does not repair when the first round ended with error or aborted', async () => {
    const schemaNode = node('agent', 'agent', 'steps/agent/STEP.md', {
      outputSchema: outputSchema(),
    })

    // Error event ends the first round: agent-failed, single call.
    const errorRound = makeExecutor(async function* () {
      yield { type: 'error', message: 'provider exploded' }
    })
    await expect(
      errorRound.executor.execute(makeRequest({ node: schemaNode })),
    ).rejects.toMatchObject({
      code: 'agent-failed',
      message: 'Agent failed: provider exploded',
    })
    expect(errorRound.agent.calls.length).toBe(1)

    // Aborted event without a cancelled signal: agent-failed, single call.
    const abortedRound = makeExecutor(async function* () {
      yield { type: 'aborted' }
    })
    await expect(
      abortedRound.executor.execute(makeRequest({ node: schemaNode })),
    ).rejects.toMatchObject({ code: 'agent-failed' })
    expect(abortedRound.agent.calls.length).toBe(1)

    // Aborted event on a cancelled signal: cancelled, single call.
    const cancelled = makeExecutor(async function* () {
      yield { type: 'aborted' }
    })
    const controller = new AbortController()
    const cancelledRun = cancelled.executor.execute(
      makeRequest({ node: schemaNode, signal: controller.signal }),
    )
    controller.abort()
    await expect(cancelledRun).rejects.toMatchObject({ code: 'cancelled' })
    expect(cancelled.agent.calls.length).toBe(1)
  })

  it('does not repair when an earlier invalid submission was followed by a valid one', async () => {
    const schema = outputSchema()
    const { agent, executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (!tool) throw new Error('expected a submit tool')
      const rejected = await tool.handler({ value: { plan: 42 } })
      expect(rejected.isError).toBe(true)
      const accepted = await tool.handler({ value: { plan: 'draft' } })
      expect(accepted.isError).not.toBe(true)
      yield completed()
    })
    const result = await executor.execute(
      makeRequest({
        node: node('agent', 'agent', 'steps/agent/STEP.md', {
          outputSchema: schema,
        }),
      }),
    )
    expect(result).toEqual({ value: { plan: 'draft' } })
    // The same-round valid submission wins; no repair round runs.
    expect(agent.calls.length).toBe(1)
  })

  it('does not count duplicate submissions as schema rejections', async () => {
    const schema = outputSchema()
    const { agent, executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (!tool) throw new Error('expected a submit tool')
      const accepted = await tool.handler({ value: { plan: 'draft' } })
      expect(accepted.isError).not.toBe(true)
      const duplicate = await tool.handler({ value: { plan: 'second' } })
      expect(duplicate.isError).toBe(true)
      yield completed()
    })
    const result = await executor.execute(
      makeRequest({
        node: node('agent', 'agent', 'steps/agent/STEP.md', {
          outputSchema: schema,
        }),
      }),
    )
    expect(result).toEqual({ value: { plan: 'draft' } })
    // The duplicate is a tool error, not a schema rejection: no repair round.
    expect(agent.calls.length).toBe(1)
  })

  it('includes the rejected value and Ajv message in the final error after a failed repair', async () => {
    const schema = outputSchema()
    const { agent, executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (!tool) throw new Error('expected a submit tool')
      // Both rounds submit the same schema-invalid value.
      const rejected = await tool.handler({ value: { plan: 42 } })
      expect(rejected.isError).toBe(true)
      yield completed()
    })
    const run = executor.execute(
      makeRequest({
        node: node('agent', 'agent', 'steps/agent/STEP.md', {
          outputSchema: schema,
        }),
      }),
    )
    const rejection = run.then(
      () => new Error('schema agent unexpectedly succeeded'),
      (error: unknown) => error,
    )
    await until(() => agent.calls.length === 2)
    const error = (await rejection) as WorkflowNodeExecutionError
    expect(error).toBeInstanceOf(WorkflowNodeExecutionError)
    expect(error.code).toBe('agent-failed')
    expect(error.message).toBe(
      'Agent output rejected twice. Round 1: /value/plan must be string (value: {"plan":42}); after repair attempt: rejected (/value/plan must be string)',
    )
    expect(agent.calls.length).toBe(2)
  })

  it('shares the abort signal with the repair round', async () => {
    const schema = outputSchema()
    const { agent, executor } = makeExecutor(async function* (request) {
      const tool = request.tools?.[0]
      if (!tool) throw new Error('expected a submit tool')
      await tool.handler({ value: { plan: 42 } })
      if (agent.calls.length === 2) {
        // The repair round blocks until the run is cancelled mid-stream.
        const signal = request.signal
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve()
          else
            signal?.addEventListener('abort', () => resolve(), { once: true })
        })
        yield { type: 'aborted' }
        return
      }
      yield completed()
    })
    const controller = new AbortController()
    const run = executor.execute(
      makeRequest({
        node: node('agent', 'agent', 'steps/agent/STEP.md', {
          outputSchema: schema,
        }),
        signal: controller.signal,
      }),
    )
    const rejection = run.then(
      () => new Error('schema agent unexpectedly succeeded'),
      (error: unknown) => error,
    )
    await until(() => agent.calls.length === 2)
    // The repair round runs under the same abort signal as the first round.
    expect(agent.calls[1].signal).toBe(controller.signal)
    controller.abort()
    await expect(rejection).resolves.toMatchObject({ code: 'cancelled' })
    expect(agent.calls.length).toBe(2)
  })
})
