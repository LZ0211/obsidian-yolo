import {
  type WorkflowTopology,
  connectionProblem,
  layoutWorkflowNodes,
  parseWorkflowTopology,
  validateWorkflowTopology,
} from './workflow-model'

const validTopology = (): WorkflowTopology => ({
  revision: 1,
  nodes: [
    {
      id: 'input',
      kind: 'input',
      label: 'Request',
      stepPath: 'steps/input/STEP.md',
      position: { x: 0, y: 0 },
    },
    {
      id: 'gate',
      kind: 'condition',
      label: 'Check',
      stepPath: 'steps/check/STEP.md',
      position: { x: 1, y: 0 },
      gateType: 'ifElse',
    },
    {
      id: 'yes',
      kind: 'agent',
      label: 'Repair',
      stepPath: 'steps/repair/STEP.md',
      position: { x: 2, y: 0 },
    },
    {
      id: 'no',
      kind: 'agent',
      label: 'Report',
      stepPath: 'steps/report/STEP.md',
      position: { x: 2, y: 1 },
    },
    {
      id: 'output',
      kind: 'output',
      label: 'Result',
      stepPath: 'steps/output/STEP.md',
      position: { x: 3, y: 0 },
    },
  ],
  edges: [
    { id: 'input-gate', source: 'input', target: 'gate' },
    { id: 'gate-yes', source: 'gate', target: 'yes', branch: 'true' },
    { id: 'gate-no', source: 'gate', target: 'no', branch: 'false' },
    { id: 'yes-output', source: 'yes', target: 'output' },
    { id: 'no-output', source: 'no', target: 'output' },
  ],
})

describe('workflow topology', () => {
  it('parses a detached, deeply frozen canonical topology', () => {
    const source = JSON.parse(JSON.stringify(validTopology()))
    const parsed = parseWorkflowTopology(source)

    expect(parsed).toEqual(source)
    expect(parsed).not.toBe(source)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.nodes[0].position)).toBe(true)
    source.nodes[0].label = 'Changed'
    expect(parsed?.nodes[0].label).toBe('Request')
  })

  it('rejects cyclic output schemas and does not freeze a layout caller schema', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const invalid = validTopology()
    expect(
      parseWorkflowTopology({
        ...invalid,
        nodes: [
          { ...invalid.nodes[0], outputSchema: cyclic },
          ...invalid.nodes.slice(1),
        ],
      }),
    ).toBeNull()

    const schema = { properties: { result: { type: 'string' } } }
    const source = validTopology()
    const laidOut = layoutWorkflowNodes({
      ...source,
      nodes: [
        { ...source.nodes[0], outputSchema: schema },
        ...source.nodes.slice(1),
      ],
    })
    expect(laidOut.nodes[0].outputSchema).toEqual(schema)
    expect(laidOut.nodes[0].outputSchema).not.toBe(schema)
    expect(Object.isFrozen(schema)).toBe(false)
    expect(Object.isFrozen(laidOut.nodes[0].outputSchema as object)).toBe(true)
  })

  it.each([BigInt(1), Symbol('schema'), () => 'schema', undefined])(
    'rejects non-JSON output schema values without throwing',
    (outputSchema) => {
      const source = validTopology()
      const invalid = {
        ...source,
        nodes: [{ ...source.nodes[0], outputSchema }, ...source.nodes.slice(1)],
      }

      expect(() => parseWorkflowTopology(invalid)).not.toThrow()
      expect(parseWorkflowTopology(invalid)).toBeNull()
    },
  )

  it.each(['cyclic', 'bigint'] as const)(
    'reports invalidTopology for runtime %s output schemas',
    (kind) => {
      const cyclic: Record<string, unknown> = {}
      cyclic.self = cyclic
      const outputSchema = kind === 'cyclic' ? cyclic : { count: BigInt(1) }
      const source = validTopology()
      const runtime = {
        ...source,
        nodes: [{ ...source.nodes[0], outputSchema }, ...source.nodes.slice(1)],
      } as WorkflowTopology

      expect(
        validateWorkflowTopology(runtime).map((issue) => issue.code),
      ).toContain('invalidTopology')
    },
  )

  it('preserves __proto__ schema keys as frozen own data properties', () => {
    const schema = Object.create(null) as Record<string, unknown>
    Object.defineProperty(schema, '__proto__', {
      value: { type: 'string' },
      enumerable: true,
    })
    const source = validTopology()
    const topologyWithSchema = {
      ...source,
      nodes: [
        { ...source.nodes[0], outputSchema: schema },
        ...source.nodes.slice(1),
      ],
    }
    const parsed = parseWorkflowTopology(topologyWithSchema)
    const laidOut = layoutWorkflowNodes(topologyWithSchema)

    for (const outputSchema of [
      parsed?.nodes[0].outputSchema,
      laidOut.nodes[0].outputSchema,
    ]) {
      expect(
        Object.prototype.hasOwnProperty.call(outputSchema, '__proto__'),
      ).toBe(true)
      expect((outputSchema as Record<string, unknown>).__proto__).toEqual({
        type: 'string',
      })
      expect(Object.isFrozen(outputSchema as object)).toBe(true)
    }
  })

  it.each([
    [
      'unsupported-kind',
      (topology: WorkflowTopology) => ({
        ...topology,
        nodes: [
          { ...topology.nodes[0], kind: 'task' },
          ...topology.nodes.slice(1),
        ],
      }),
    ],
    [
      'non-finite-position',
      (topology: WorkflowTopology) => ({
        ...topology,
        nodes: [
          { ...topology.nodes[0], position: { x: Infinity, y: 0 } },
          ...topology.nodes.slice(1),
        ],
      }),
    ],
  ])('rejects %s during parsing', (_name, mutate) => {
    expect(parseWorkflowTopology(mutate(validTopology()))).toBeNull()
  })

  it.each([
    '../escape/STEP.md',
    '/absolute/STEP.md',
    'C:/absolute/STEP.md',
    'steps\\input\\STEP.md',
    './STEP.md',
    'steps/../STEP.md',
  ])('rejects unsafe stepPath %s during parsing', (stepPath) => {
    const source = validTopology()
    expect(
      parseWorkflowTopology({
        ...source,
        nodes: [{ ...source.nodes[0], stepPath }, ...source.nodes.slice(1)],
      }),
    ).toBeNull()
  })

  it('rejects labels and edge labels containing line breaks', () => {
    const source = validTopology()

    expect(
      parseWorkflowTopology({
        ...source,
        nodes: [{ ...source.nodes[0], label: 'Request\nInjected' }, ...source.nodes.slice(1)],
      }),
    ).toBeNull()
    expect(
      parseWorkflowTopology({
        ...source,
        edges: [{ ...source.edges[0], label: 'edge\r\nlabel' }, ...source.edges.slice(1)],
      }),
    ).toBeNull()
  })

  it('rejects edges entering inputs or leaving outputs', () => {
    const source = validTopology()
    const invalid: WorkflowTopology = {
      ...source,
      edges: [
        ...source.edges,
        { id: 'output-input', source: 'output', target: 'input' },
      ],
    }

    expect(validateWorkflowTopology(invalid)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'invalidEndpoint', nodeId: 'output' }),
        expect.objectContaining({ code: 'invalidEndpoint', nodeId: 'input' }),
      ]),
    )
    expect(
      connectionProblem(source, {
        id: 'into-input',
        source: 'output',
        target: 'input',
      }),
    ).toEqual({ code: 'invalidConnection' })
  })

  it('reports malformed runtime topology values without throwing', () => {
    const malformed = {
      revision: 1,
      nodes: [
        {
          id: '',
          kind: 'task',
          label: '',
          stepPath: '../escape.md',
          position: { x: Infinity, y: 0 },
        },
      ],
      edges: [],
    } as unknown as WorkflowTopology

    expect(() => validateWorkflowTopology(malformed)).not.toThrow()
    expect(
      validateWorkflowTopology(malformed).map((issue) => issue.code),
    ).toContain('invalidTopology')
  })

  it('reports graph, reachability, and gate rule violations', () => {
    const topology = validTopology()
    const invalid: WorkflowTopology = {
      ...topology,
      nodes: [
        ...topology.nodes,
        {
          id: 'orphan',
          kind: 'agent',
          label: 'Orphan',
          stepPath: 'steps/orphan/STEP.md',
          position: { x: 0, y: 9 },
        },
      ],
      edges: [
        ...topology.edges,
        { id: 'gate-again', source: 'gate', target: 'yes', branch: 'true' },
        { id: 'cycle', source: 'output', target: 'input' },
      ],
    }

    expect(
      validateWorkflowTopology(invalid).map((issue) => issue.code),
    ).toEqual(
      expect.arrayContaining([
        'duplicateConnection',
        'branchUsed',
        'cycle',
        'unreachable',
      ]),
    )
  })

  it('enforces gate input arity and connection branch availability', () => {
    const unary = validTopology()
    const withoutInput = {
      ...unary,
      edges: unary.edges.filter((edge) => edge.id !== 'input-gate'),
    }
    expect(
      validateWorkflowTopology(withoutInput).map((issue) => issue.code),
    ).toContain('invalidGateArity')
    expect(
      connectionProblem(validTopology(), {
        id: 'again',
        source: 'gate',
        target: 'output',
        branch: 'true',
      }),
    ).toMatchObject({ code: 'branchUsed' })
    expect(
      connectionProblem(validTopology(), {
        id: 'and',
        source: 'input',
        target: 'output',
        branch: 'and',
      }),
    ).toMatchObject({ code: 'invalidConnection' })
    const branchRequired = connectionProblem(validTopology(), {
      id: 'choose',
      source: 'gate',
      target: 'output',
    })
    expect(branchRequired).toMatchObject({
      code: 'branchRequired',
      gateType: 'ifElse',
      available: [],
    })
    expect(Object.isFrozen(branchRequired)).toBe(true)
    expect(Object.isFrozen(branchRequired?.available)).toBe(true)
    expect(branchRequired).not.toHaveProperty('valid')
  })

  it('reports a NOT gate outgoing limit once and freezes issues', () => {
    const topology: WorkflowTopology = {
      revision: 1,
      nodes: [
        {
          id: 'input',
          kind: 'input',
          label: 'Input',
          stepPath: 'steps/input/STEP.md',
          position: { x: 0, y: 0 },
        },
        {
          id: 'gate',
          kind: 'condition',
          label: 'Not',
          stepPath: 'steps/gate/STEP.md',
          position: { x: 1, y: 0 },
          gateType: 'not',
        },
        {
          id: 'left',
          kind: 'agent',
          label: 'Left',
          stepPath: 'steps/left/STEP.md',
          position: { x: 2, y: 0 },
        },
        {
          id: 'output',
          kind: 'output',
          label: 'Output',
          stepPath: 'steps/output/STEP.md',
          position: { x: 2, y: 1 },
        },
      ],
      edges: [
        { id: 'input-gate', source: 'input', target: 'gate' },
        { id: 'gate-left', source: 'gate', target: 'left', branch: 'not' },
        { id: 'gate-output', source: 'gate', target: 'output', branch: 'not' },
      ],
    }
    const issues = validateWorkflowTopology(topology)
    expect(issues.filter((issue) => issue.code === 'gateLimit')).toHaveLength(1)
    expect(Object.isFrozen(issues[0])).toBe(true)
  })

  it('lays out equivalent graphs deterministically by topological columns and rows', () => {
    const first = layoutWorkflowNodes(validTopology())
    const second = layoutWorkflowNodes(validTopology())

    expect(first).toEqual(second)
    expect(first.nodes.map((node) => node.position)).toEqual([
      { x: 70, y: 90 },
      { x: 315, y: 90 },
      { x: 560, y: 90 },
      { x: 560, y: 250 },
      { x: 805, y: 90 },
    ])
  })
})
