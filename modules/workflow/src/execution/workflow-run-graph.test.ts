import type { WorkflowTopology } from '../domain/workflow-model'

import {
  activeIncomingSources,
  aggregateWorkflowOutputs,
  canonicalJsonStringify,
  evaluateWorkflowGate,
  mergeWorkflowSources,
  stableIncomingEdges,
} from './workflow-run-graph'
import type { WorkflowNodeRun } from './workflow-run-types'
import type { JsonValue, WorkflowExecutionPolicy } from './workflow-run-types'

const policy = (
  mergeStrategy: 'concat' | 'dedupe' = 'concat',
): WorkflowExecutionPolicy => ({
  capability: 'vault-write',
  mapConcurrency: 3,
  mergeStrategy,
})

const source = (nodeId: string, value: JsonValue) => ({ nodeId, value })

const conditionTopology = (): WorkflowTopology => ({
  revision: 1,
  nodes: [
    {
      id: 'a',
      kind: 'condition',
      label: 'A',
      stepPath: 'steps/a/STEP.md',
      position: { x: 0, y: 0 },
      gateType: 'ifElse',
    },
    {
      id: 'b',
      kind: 'condition',
      label: 'B',
      stepPath: 'steps/b/STEP.md',
      position: { x: 1, y: 0 },
      gateType: 'ifElse',
    },
    {
      id: 'x',
      kind: 'agent',
      label: 'X',
      stepPath: 'steps/x/STEP.md',
      position: { x: 2, y: 0 },
    },
  ],
  edges: [
    { id: 'e1', source: 'a', target: 'x', branch: 'true' },
    { id: 'e2', source: 'b', target: 'x', branch: 'false' },
    { id: 'e0', source: 'a', target: 'x', branch: 'false' },
  ],
})

const run = (
  status: WorkflowNodeRun['status'],
  output?: JsonValue,
): WorkflowNodeRun => ({
  status,
  ...(output === undefined ? {} : { output }),
})

describe('workflow run graph', () => {
  it('orders incoming edges by edge id for stable source ordering', () => {
    const edges = stableIncomingEdges(conditionTopology(), 'x')
    expect(edges.map((edge) => edge.id)).toEqual(['e0', 'e1', 'e2'])
    expect(Object.isFrozen(edges)).toBe(true)
  })

  it('selects only branch-matching active incoming sources', () => {
    const nodes: Record<string, WorkflowNodeRun> = {
      a: { ...run('succeeded', 'yes'), conditionResult: true },
      b: { ...run('succeeded', 'no'), conditionResult: true },
    }
    const topology = conditionTopology()

    const active = activeIncomingSources(topology.nodes[2], topology, nodes)
    expect(active).toEqual([
      { nodeId: 'a', value: 'yes', edgeLabel: undefined },
    ])
  })

  it('treats non-condition sources as active whenever they succeeded', () => {
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
          id: 'agent',
          kind: 'agent',
          label: 'Agent',
          stepPath: 'steps/agent/STEP.md',
          position: { x: 1, y: 0 },
        },
      ],
      edges: [{ id: 'e1', source: 'in', target: 'agent', label: 'payload' }],
    }
    const active = activeIncomingSources(topology.nodes[1], topology, {
      in: run('succeeded', { v: 1 }),
    })
    expect(active).toEqual([
      { nodeId: 'in', value: { v: 1 }, edgeLabel: 'payload' },
    ])
  })

  it.each([
    ['ifElse', [true], true],
    ['ifElse', [false], false],
    ['not', [true], false],
    ['not', [false], true],
    ['and', [true, true], true],
    ['and', [true, false], false],
    ['nand', [true, true], false],
    ['nand', [true, false], true],
    ['or', [false, true], true],
    ['or', [false, false], false],
    ['nor', [false, false], true],
    ['nor', [true, false], false],
    ['xor', [true, false], true],
    ['xor', [true, true], false],
    ['xor', [false, false, true], true],
    ['xnor', [true, true], true],
    ['xnor', [true, false], false],
    ['xnor', [false, false, true], false],
  ] as const)(
    'evaluates the %s gate truth table for %j',
    (gateType, values, expected) => {
      const result = evaluateWorkflowGate(
        gateType,
        values.map((value, index) => source(`n${index}`, value)),
      )
      expect(result.conditionResult).toBe(expected)
    },
  )

  it('keeps condition data separate from conditionResult', () => {
    const single = evaluateWorkflowGate('ifElse', [source('a', 'payload')])
    expect(single.conditionResult).toBe(true)
    expect(single.value).toBe('payload')

    const multiple = evaluateWorkflowGate('and', [
      source('a', 1),
      source('b', 2),
    ])
    expect(multiple.conditionResult).toBe(true)
    expect(multiple.value).toEqual({ a: 1, b: 2 })
  })

  it('concats one level in stable source order', () => {
    expect(
      mergeWorkflowSources(
        [source('a', [1, 2]), source('b', 3), source('c', [4])],
        'concat',
      ),
    ).toEqual([1, 2, 3, 4])
  })

  it('dedupes by canonical JSON preserving first-seen order', () => {
    expect(
      mergeWorkflowSources(
        [source('a', [{ x: 1 }, { x: 2 }]), source('b', [{ x: 1 }, { y: 3 }])],
        'dedupe',
      ),
    ).toEqual([{ x: 1 }, { x: 2 }, { y: 3 }])
  })

  it('canonicalizes JSON with sorted keys and preserved array order', () => {
    expect(canonicalJsonStringify({ b: 1, a: [2, 1], c: { z: 1, y: 2 } })).toBe(
      '{"a":[2,1],"b":1,"c":{"y":2,"z":1}}',
    )
  })

  it('aggregates output nodes with pass-through and policy merge', () => {
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
          id: 'o1',
          kind: 'output',
          label: 'One',
          stepPath: 'steps/o1/STEP.md',
          position: { x: 1, y: 0 },
        },
        {
          id: 'o2',
          kind: 'output',
          label: 'Two',
          stepPath: 'steps/o2/STEP.md',
          position: { x: 1, y: 1 },
        },
        {
          id: 'o3',
          kind: 'output',
          label: 'Three',
          stepPath: 'steps/o3/STEP.md',
          position: { x: 1, y: 2 },
        },
      ],
      edges: [
        { id: 'e1', source: 'in', target: 'o1' },
        { id: 'e2', source: 'in', target: 'o2' },
      ],
    }
    const nodeRuns: Record<string, WorkflowNodeRun> = {
      in: run('succeeded', ['a']),
      o1: run('succeeded', ['a']),
      o2: run('succeeded', ['a']),
      o3: run('skipped'),
    }
    expect(
      aggregateWorkflowOutputs(topology, nodeRuns, policy('concat')),
    ).toEqual({
      o1: ['a'],
      o2: ['a'],
    })
  })
})
