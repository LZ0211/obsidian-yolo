import { en } from '../i18n'

import {
  exportDshFlowJson,
  parseDshFlowJson,
  parseWorkflowDocument,
  updateWorkflowManagedBlocks,
} from './workflow-document'
import type { WorkflowTopology } from './workflow-model'

const topology: WorkflowTopology = {
  revision: 1,
  nodes: [
    {
      id: 'input',
      kind: 'input',
      label: 'Request [v1]',
      stepPath: 'steps/input/STEP.md',
      position: { x: 0, y: 0 },
    },
    {
      id: 'agent',
      kind: 'agent',
      label: 'Draft',
      stepPath: 'steps/draft/STEP.md',
      position: { x: 1, y: 0 },
      modelId: 'model-a',
    },
    {
      id: 'output',
      kind: 'output',
      label: 'Result',
      stepPath: 'steps/output/STEP.md',
      position: { x: 2, y: 0 },
    },
  ],
  edges: [
    { id: 'input-agent', source: 'input', target: 'agent' },
    { id: 'agent-output', source: 'agent', target: 'output' },
  ],
}

describe('workflow document', () => {
  it('appends YOLO managed blocks and preserves prose byte-for-byte on updates', () => {
    const prose = '# My workflow\n\nKeep  two spaces.\n'
    const initial = updateWorkflowManagedBlocks(prose, topology, en)
    const updated = updateWorkflowManagedBlocks(
      initial,
      {
        ...topology,
        nodes: [
          { ...topology.nodes[0], label: 'Changed' },
          ...topology.nodes.slice(1),
        ],
      },
      en,
    )

    expect(initial).toContain('<!-- yolo:workflow-structure:start -->')
    expect(initial).toContain('[Request \\[v1\\]](steps/input/STEP.md)')
    expect(updated.startsWith(prose)).toBe(true)
    expect(updated).toContain('[Changed](steps/input/STEP.md)')
    expect(parseWorkflowDocument(updated).topology?.nodes[0].label).toBe(
      'Changed',
    )
  })

  it('preserves prose on both sides of replaced managed blocks', () => {
    const before = '# Title\n\nBefore prose.\n\n'
    const after = '\n\nAfter prose with  two spaces.\n'
    const initial = `${before}${updateWorkflowManagedBlocks('', topology, en)}${after}`

    expect(updateWorkflowManagedBlocks(initial, topology, en)).toBe(initial)
  })

  it('round-trips right parentheses in Markdown labels and step paths', () => {
    const parenthesized: WorkflowTopology = {
      ...topology,
      nodes: [
        {
          ...topology.nodes[0],
          label: 'Request (v2)',
          stepPath: 'steps/input (draft)/STEP.md',
        },
        ...topology.nodes.slice(1),
      ],
    }
    const document = parseWorkflowDocument(
      updateWorkflowManagedBlocks('', parenthesized, en),
    )
    expect(document.steps[0]).toEqual({
      nodeId: 'input',
      label: 'Request (v2)',
      stepPath: 'steps/input (draft)/STEP.md',
    })
  })

  it('encodes every Markdown-sensitive step path segment without changing the step field', () => {
    const specialPath: WorkflowTopology = {
      ...topology,
      nodes: [
        {
          ...topology.nodes[0],
          label: 'Request ](v2)',
          stepPath: 'steps/a](b)/STEP).md',
        },
        ...topology.nodes.slice(1),
      ],
    }
    const rendered = updateWorkflowManagedBlocks('', specialPath, en)

    expect(rendered).toContain('(steps/a%5D%28b%29/STEP%29.md)')
    expect(rendered).toContain('step: steps/a](b)/STEP).md')
    expect(parseWorkflowDocument(rendered).steps[0]).toEqual({
      nodeId: 'input',
      label: 'Request ](v2)',
      stepPath: 'steps/a](b)/STEP).md',
    })
  })

  it('chooses the earliest complete matching marker pair and ignores mixed pairs', () => {
    const content = [
      'before',
      '<!-- deepseek-flow:structure:start -->',
      '- id: legacy',
      '  kind: input',
      '  label: Legacy',
      '  step: steps/legacy/STEP.md',
      '<!-- deepseek-flow:structure:end -->',
      '<!-- yolo:workflow-topology:start -->',
      JSON.stringify(topology),
      '<!-- deepseek-flow:structure:end -->',
    ].join('\n')

    const document = parseWorkflowDocument(content)
    expect(document.steps).toEqual([
      { nodeId: 'legacy', label: 'Legacy', stepPath: 'steps/legacy/STEP.md' },
    ])
    expect(document.topology).toBeNull()
    expect(document.issues).toContain('invalidTopology')
  })

  it('reports invalidStructure and keeps the topology fallback when a structure block is malformed', () => {
    const content = [
      '<!-- yolo:workflow-structure:start -->',
      '- id: input',
      '  label: Missing step',
      '<!-- yolo:workflow-structure:end -->',
      '<!-- yolo:workflow-topology:start -->',
      JSON.stringify(topology),
      '<!-- yolo:workflow-topology:end -->',
    ].join('\n')

    const document = parseWorkflowDocument(content)
    expect(document.issues).toContain('invalidStructure')
    expect(document.issues).not.toContain('invalidTopology')
    expect(document.steps).toEqual(
      topology.nodes.map((node) => ({
        nodeId: node.id,
        label: node.label,
        stepPath: node.stepPath,
      })),
    )
  })

  it('reports unclosed and inconsistent structure blocks without returning conflicting topology', () => {
    const unclosed = parseWorkflowDocument(
      '<!-- yolo:workflow-structure:start -->\n- id: input',
    )
    expect(unclosed.issues).toContain('invalidStructure')

    const inconsistent = updateWorkflowManagedBlocks('', topology, en)
      .replace('steps/input/STEP.md', 'steps/other/STEP.md')
      .replace('steps/input/STEP.md', 'steps/other/STEP.md')
    const document = parseWorkflowDocument(inconsistent)
    expect(document.issues).toContain('invalidStructure')
    expect(document.topology).toBeNull()
    expect(document.steps[0].stepPath).toBe('steps/other/STEP.md')
    expect(Object.isFrozen(document.steps[0])).toBe(true)
  })

  it('reports dangling and trailing markers while retaining the earliest complete block', () => {
    const complete = updateWorkflowManagedBlocks('', topology, en)
    const danglingStructure = parseWorkflowDocument(
      `${complete}\n<!-- yolo:workflow-structure:end -->`,
    )
    const danglingTopology = parseWorkflowDocument(
      '<!-- deepseek-flow:topology:end -->',
    )
    const unclosedStructure = parseWorkflowDocument(
      '<!-- deepseek-flow:structure:start -->\ncontent',
    )

    expect(danglingStructure.issues).toContain('invalidStructure')
    expect(danglingTopology.issues).toContain('invalidTopology')
    expect(unclosedStructure.issues).toContain('invalidStructure')
    expect(danglingStructure.topology).toEqual(topology)
  })

  it.each([
    [
      'an unclosed topology start',
      '<!-- yolo:workflow-topology:start -->\n{}',
      'invalidTopology',
    ],
    [
      'a dangling structure end',
      '<!-- deepseek-flow:structure:end -->',
      'invalidStructure',
    ],
    [
      'a trailing topology end after a complete block',
      `${updateWorkflowManagedBlocks('', topology, en)}\n<!-- yolo:workflow-topology:end -->`,
      'invalidTopology',
    ],
  ])('reports %s', (_name, content, issue) => {
    expect(parseWorkflowDocument(content).issues).toContain(issue)
  })

  it('does not consume malformed marker bytes across repeated managed updates', () => {
    const malformed = [
      '# Title',
      '<!-- yolo:workflow-structure:start -->',
      'keep this broken suffix  exactly',
    ].join('\n')
    const once = updateWorkflowManagedBlocks(malformed, topology, en)
    const twice = updateWorkflowManagedBlocks(once, topology, en)

    expect(once.startsWith(malformed)).toBe(true)
    expect(twice.startsWith(malformed)).toBe(true)
    expect(twice).toContain('keep this broken suffix  exactly')
  })

  it('derives steps from a valid topology-only document', () => {
    const content = [
      'Intro prose',
      '<!-- yolo:workflow-topology:start -->',
      JSON.stringify(topology),
      '<!-- yolo:workflow-topology:end -->',
    ].join('\n')
    const document = parseWorkflowDocument(content)

    expect(document.topology).toEqual(topology)
    expect(document.steps).toEqual(
      topology.nodes.map((node) => ({
        nodeId: node.id,
        label: node.label,
        stepPath: node.stepPath,
      })),
    )
    expect(document.issues).not.toContain('invalidStructure')
  })

  it('uses copy text for document fallbacks and generated managed blocks', () => {
    const copy = {
      ...en,
      document: {
        ...en.document,
        workflowTitle: 'Fallback workflow',
        structureTitle: 'Custom structure',
        topologyTitle: 'Custom topology',
      },
    }
    expect(parseWorkflowDocument('', copy).title).toBe('Fallback workflow')
    expect(
      parseDshFlowJson(
        {
          nodes: topology.nodes.map((node) => ({
            id: node.id,
            kind: node.kind,
            position: node.position,
            data: { label: node.label },
          })),
          edges: topology.edges,
          docs: Object.fromEntries(
            topology.nodes.map((node) => [node.id, node.stepPath]),
          ),
        },
        copy,
      )?.title,
    ).toBe('Fallback workflow')
    const rendered = updateWorkflowManagedBlocks('', topology, copy)
    expect(rendered).toContain('## Custom structure')
    expect(rendered).toContain('## Custom topology')
  })

  it('imports and exports the canonical dsh bundle with condition branches and without provider state', () => {
    const branched: WorkflowTopology = {
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
          label: 'Gate',
          stepPath: 'steps/gate/STEP.md',
          position: { x: 1, y: 0 },
          gateType: 'ifElse',
        },
        {
          id: 'true',
          kind: 'agent',
          label: 'True path',
          stepPath: 'steps/true/STEP.md',
          position: { x: 2, y: 0 },
        },
        {
          id: 'false',
          kind: 'agent',
          label: 'False path',
          stepPath: 'steps/false/STEP.md',
          position: { x: 2, y: 1 },
        },
        {
          id: 'output',
          kind: 'output',
          label: 'Output',
          stepPath: 'steps/output/STEP.md',
          position: { x: 3, y: 0 },
        },
      ],
      edges: [
        { id: 'input-gate', source: 'input', target: 'gate' },
        { id: 'gate-true', source: 'gate', target: 'true', branch: 'true' },
        { id: 'gate-false', source: 'gate', target: 'false', branch: 'false' },
        { id: 'true-output', source: 'true', target: 'output' },
        { id: 'false-output', source: 'false', target: 'output' },
      ],
    }
    const stepContents = Object.fromEntries(
      branched.nodes.map((node) => [node.id, `# ${node.label}\n\nKeep this.`]),
    )
    const imported = parseDshFlowJson({
      id: 'flow-1',
      name: 'Imported',
      workflowContent: '# Imported',
      stepContents,
      nodes: branched.nodes.map((node) => ({
        id: node.id,
        kind: node.kind,
        position: node.position,
        data: {
          label: node.label,
          gateType: node.gateType,
          model: node.modelId,
          provider: 'discarded',
        },
      })),
      edges: branched.edges.map((edge) => ({
        ...edge,
        sourceHandle: edge.branch,
      })),
      docs: Object.fromEntries(
        branched.nodes.map((node) => [node.id, node.stepPath]),
      ),
    })

    expect(imported?.topology).toEqual(branched)
    expect(imported?.content).toBe('# Imported')
    expect(imported).toMatchObject({ stepContents })
    const exported = exportDshFlowJson(imported!)
    expect(exported).toMatchObject({ stepContents })
    expect(JSON.stringify(exported)).not.toContain('provider')
    expect(parseDshFlowJson(exported)).toEqual(imported)
  })

  it('round-trips verification through DSH import and export', () => {
    const withVerification: WorkflowTopology = {
      ...topology,
      nodes: [
        topology.nodes[0],
        {
          ...topology.nodes[1],
          verification: { schema: { type: 'object' }, mode: 'hard' },
        },
        topology.nodes[2],
      ],
    }
    const exported = exportDshFlowJson({
      title: 'Demo workflow',
      content: '# Demo',
      topology: withVerification,
    })
    expect(
      (
        exported.nodes as ReadonlyArray<{
          data: Readonly<Record<string, unknown>>
        }>
      )[1].data.verification,
    ).toEqual({ schema: { type: 'object' }, mode: 'hard' })

    const imported = parseDshFlowJson(exported)
    expect(imported?.topology.nodes[1].verification).toEqual({
      schema: { type: 'object' },
      mode: 'hard',
    })
  })

  it('rejects invalid and path-escaping dsh imports before a repository write', () => {
    expect(parseDshFlowJson('{bad json')).toBeNull()
    expect(
      parseDshFlowJson({
        nodes: [
          {
            id: 'input',
            kind: 'input',
            position: { x: 0, y: 0 },
            data: { label: 'Input' },
          },
        ],
        edges: [],
        docs: { input: '../STEP.md' },
      }),
    ).toBeNull()
  })
})
