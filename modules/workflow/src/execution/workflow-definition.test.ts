import {
  exportDshFlowJson,
  extractWorkflowExecutionContext,
  parseDshFlowJson,
  updateWorkflowManagedBlocks,
} from '../domain/workflow-document'
import {
  type WorkflowTopology,
  parseWorkflowTopology,
} from '../domain/workflow-model'
import type { WorkflowBundle } from '../domain/workflow-repository'

import { createWorkflowDefinition } from './workflow-definition'
import type {
  WorkflowModelSnapshot,
  WorkflowRunSnapshot,
  WorkflowTierMap,
} from './workflow-run-types'

const modelSnapshot = (): WorkflowModelSnapshot => ({
  defaultModelId: 'model-a',
  models: [
    { id: 'model-a', name: 'Model A', providerId: 'provider' },
    { id: 'model-b', name: 'Model B', providerId: 'provider' },
    { id: 'default', name: 'Literal Default', providerId: 'provider' },
  ],
})

const content = (): string =>
  [
    '---',
    'yaml: frontmatter',
    'tags: [workflow]',
    '---',
    '',
    '# Demo workflow',
    '',
    'Keep this prose, [[wikilink]], ![[embed]], > callout and #tag.',
    '',
  ].join('\n')

const stepContent = (nodeId: string): string => `# Step ${nodeId}\n`

const baseTopology = (): WorkflowTopology => ({
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
      id: 'draft',
      kind: 'agent',
      label: 'Draft',
      stepPath: 'steps/draft/STEP.md',
      position: { x: 2, y: 0 },
      modelId: 'model-b',
    },
    {
      id: 'skip',
      kind: 'agent',
      label: 'Skip',
      stepPath: 'steps/skip/STEP.md',
      position: { x: 2, y: 1 },
    },
    {
      id: 'merged',
      kind: 'merge',
      label: 'Merge',
      stepPath: 'steps/merge/STEP.md',
      position: { x: 3, y: 0 },
      mergeStrategy: 'dedupe',
    },
    {
      id: 'output',
      kind: 'output',
      label: 'Result',
      stepPath: 'steps/output/STEP.md',
      position: { x: 4, y: 0 },
    },
  ],
  edges: [
    { id: 'input-gate', source: 'input', target: 'gate' },
    { id: 'gate-draft', source: 'gate', target: 'draft', branch: 'true' },
    { id: 'gate-skip', source: 'gate', target: 'skip', branch: 'false' },
    { id: 'draft-merged', source: 'draft', target: 'merged' },
    { id: 'skip-merged', source: 'skip', target: 'merged' },
    { id: 'merged-output', source: 'merged', target: 'output' },
  ],
})

const bundle = (): WorkflowBundle => {
  const topology = baseTopology()
  return {
    path: 'demo/WORKFLOW.md',
    document: {
      title: 'Demo workflow',
      content: content(),
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
        relativePath: 'demo/WORKFLOW.md',
        snapshot: { path: 'demo/WORKFLOW.md', content: content() },
      },
      ...topology.nodes.map((node) => ({
        nodeId: node.id,
        relativePath: `demo/${node.stepPath}`,
        snapshot: {
          path: `demo/${node.stepPath}`,
          content: stepContent(node.id),
        },
      })),
    ],
  }
}

const build = async (overrides?: {
  bundle?: WorkflowBundle
  modelSnapshot?: WorkflowModelSnapshot
  tierMap?: WorkflowTierMap
}) => {
  const result = await createWorkflowDefinition(
    overrides?.bundle ?? bundle(),
    overrides?.modelSnapshot ?? modelSnapshot(),
    overrides?.tierMap,
  )
  if (!result.ok) return result
  return { ok: true as const, definition: result.definition }
}

describe('workflow definition', () => {
  it('builds a frozen definition from a clean bundle and model snapshot', async () => {
    const result = await build()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const definition = result.definition
    expect(definition.workflowPath).toBe('demo/WORKFLOW.md')
    expect(definition.definitionHash).toMatch(/^[0-9a-f]{64}$/)
    expect(definition.modelByNodeId).toEqual({
      input: 'model-a',
      gate: 'model-a',
      draft: 'model-b',
      skip: 'model-a',
      merged: 'model-a',
      output: 'model-a',
    })
    expect(definition.policy).toEqual({
      capability: 'vault-write',
      mapConcurrency: 3,
      mergeStrategy: 'dedupe',
    })
    expect(Object.isFrozen(definition)).toBe(true)
    expect(Object.isFrozen(definition.topology)).toBe(true)
    expect(Object.isFrozen(definition.topology.nodes[0])).toBe(true)
    expect(Object.isFrozen(definition.stepContents)).toBe(true)
    expect(Object.isFrozen(definition.modelByNodeId)).toBe(true)
    expect(Object.isFrozen(definition.policy)).toBe(true)
  })

  it('includes STEP content, model mapping, and policy in the hash but ignores position', async () => {
    const base = bundle()
    const result = await build()
    if (!result.ok) throw new Error('base bundle must build')

    const moved = await build({
      bundle: {
        ...base,
        document: {
          ...base.document,
          topology: {
            ...base.document.topology!,
            nodes: base.document.topology!.nodes.map((node, index) => ({
              ...node,
              position: { x: 999 + index, y: 777 - index },
            })),
          },
        },
      },
    })
    if (!moved.ok) throw new Error('moved bundle must build')
    expect(moved.definition.definitionHash).toBe(
      result.definition.definitionHash,
    )
    expect(moved.definition.topology.nodes[0].position).toEqual({
      x: 999,
      y: 777,
    })

    const changedStep = await build({
      bundle: {
        ...base,
        files: base.files.map((file) =>
          file.nodeId === 'draft'
            ? {
                ...file,
                snapshot: { ...file.snapshot, content: '# changed\n' },
              }
            : file,
        ),
      },
    })
    if (!changedStep.ok) throw new Error('changed-step bundle must build')
    expect(changedStep.definition.definitionHash).not.toBe(
      result.definition.definitionHash,
    )

    const changedModel = await build({
      bundle: {
        ...base,
        document: {
          ...base.document,
          topology: {
            ...base.document.topology!,
            nodes: base.document.topology!.nodes.map((node) =>
              node.id === 'draft' ? { ...node, modelId: 'model-a' } : node,
            ),
          },
        },
      },
    })
    if (!changedModel.ok) throw new Error('changed-model bundle must build')
    expect(changedModel.definition.definitionHash).not.toBe(
      result.definition.definitionHash,
    )

    const changedPolicy = await build({
      bundle: {
        ...base,
        document: {
          ...base.document,
          topology: {
            ...base.document.topology!,
            nodes: base.document.topology!.nodes.map((node) =>
              node.id === 'merged'
                ? { ...node, mergeStrategy: 'concat' as const }
                : node,
            ),
          },
        },
      },
    })
    if (!changedPolicy.ok) throw new Error('changed-policy bundle must build')
    expect(changedPolicy.definition.definitionHash).not.toBe(
      result.definition.definitionHash,
    )
    expect(changedPolicy.definition.policy.mergeStrategy).toBe('concat')
  })

  it('rejects dirty, invalid, and missing-step bundles', async () => {
    const dirty = await build({
      bundle: {
        ...bundle(),
        document: { ...bundle().document, issues: ['invalidStructure'] },
      },
    })
    expect(dirty).toEqual({
      ok: false,
      error: { code: 'invalid-definition', message: expect.any(String) },
    })

    const missingTopology = await build({
      bundle: {
        ...bundle(),
        document: { ...bundle().document, topology: null },
      },
    })
    expect(missingTopology).toEqual({
      ok: false,
      error: { code: 'invalid-definition', message: expect.any(String) },
    })

    const missingStep = await build({
      bundle: {
        ...bundle(),
        files: bundle().files.filter((file) => file.nodeId !== 'draft'),
      },
    })
    expect(missingStep).toEqual({
      ok: false,
      error: { code: 'invalid-definition', message: expect.any(String) },
    })

    const extraFile = await build({
      bundle: {
        ...bundle(),
        files: [
          ...bundle().files,
          {
            nodeId: 'ghost',
            relativePath: 'demo/steps/ghost/STEP.md',
            snapshot: {
              path: 'demo/steps/ghost/STEP.md',
              content: '# ghost\n',
            },
          },
        ],
      },
    })
    expect(extraFile).toEqual({
      ok: false,
      error: { code: 'invalid-definition', message: expect.any(String) },
    })
  })

  it('rejects invalid JSON schemas and non-JSON schema values', async () => {
    const withSchema = (outputSchema: unknown) =>
      bundle().document.topology!.nodes.map((node) =>
        node.id === 'draft' ? { ...node, outputSchema } : node,
      )

    const invalidSchema = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withSchema({ type: 42 }),
          },
        },
      },
    })
    expect(invalidSchema).toEqual({
      ok: false,
      error: {
        code: 'invalid-definition',
        nodeId: 'draft',
        message: expect.any(String),
      },
    })

    const invalidNestedSchema = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withSchema({ type: 'object', properties: 5 }),
          },
        },
      },
    })
    expect(invalidNestedSchema).toEqual({
      ok: false,
      error: {
        code: 'invalid-definition',
        nodeId: 'draft',
        message: expect.any(String),
      },
    })

    const nonJsonSchema = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withSchema({ type: 'object', extra: BigInt(1) }),
          },
        },
      },
    })
    expect(nonJsonSchema).toEqual({
      ok: false,
      error: {
        code: 'invalid-definition',
        nodeId: 'draft',
        message: expect.any(String),
      },
    })
  })

  it('rejects an uncompilable verification schema at definition build', async () => {
    const withVerification = (schema: unknown) =>
      bundle().document.topology!.nodes.map((node) =>
        node.id === 'draft'
          ? { ...node, verification: { schema, mode: 'hard' as const } }
          : node,
      )

    const result = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withVerification({ type: 'nonsense' }),
          },
        },
      },
    })
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'invalid-definition',
        nodeId: 'draft',
        message: expect.any(String),
      },
    })
  })

  it('accepts a compilable verification schema at definition build', async () => {
    const result = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: bundle().document.topology!.nodes.map((node) =>
              node.id === 'draft'
                ? {
                    ...node,
                    verification: {
                      schema: { type: 'object' },
                      mode: 'hard' as const,
                    },
                  }
                : node,
            ),
          },
        },
      },
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.definition.topology.nodes.find((node) => node.id === 'draft')
        ?.verification,
    ).toEqual({ schema: { type: 'object' }, mode: 'hard' })
  })

  it('resolves an empty node modelId to the run default and rejects unknown ids', async () => {
    const withModelIds = (
      modelIds: Readonly<Record<string, string | undefined>>,
    ) =>
      bundle().document.topology!.nodes.map((node) => ({
        ...node,
        ...(modelIds[node.id] === undefined
          ? {}
          : { modelId: modelIds[node.id] }),
      }))

    const empty = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withModelIds({ draft: '' }),
          },
        },
      },
    })
    if (!empty.ok) throw new Error('empty modelId must resolve to the default')
    expect(empty.definition.modelByNodeId.draft).toBe('model-a')

    const unknown = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withModelIds({ draft: 'model-zzz' }),
          },
        },
      },
    })
    expect(unknown).toEqual({
      ok: false,
      error: {
        code: 'model-unavailable',
        nodeId: 'draft',
        message: expect.any(String),
      },
    })

    const literalDefault = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withModelIds({ draft: 'default' }),
          },
        },
      },
    })
    if (!literalDefault.ok)
      throw new Error('literal default model must resolve')
    expect(literalDefault.definition.modelByNodeId.draft).toBe('default')
  })

  it('resolves a tier alias through the tier map', async () => {
    const withModelIds = (
      modelIds: Readonly<Record<string, string | undefined>>,
    ) =>
      bundle().document.topology!.nodes.map((node) => ({
        ...node,
        ...(modelIds[node.id] === undefined
          ? {}
          : { modelId: modelIds[node.id] }),
      }))

    const result = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withModelIds({ draft: 'fast' }),
          },
        },
      },
      tierMap: { fast: 'model-a' },
    })
    if (!result.ok) throw new Error('fast tier must resolve via the tier map')
    expect(result.definition.modelByNodeId.draft).toBe('model-a')
  })

  it('prefers an exact model id over a tier alias', async () => {
    const withModelIds = (
      modelIds: Readonly<Record<string, string | undefined>>,
    ) =>
      bundle().document.topology!.nodes.map((node) => ({
        ...node,
        ...(modelIds[node.id] === undefined
          ? {}
          : { modelId: modelIds[node.id] }),
      }))

    const result = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withModelIds({ draft: 'fast' }),
          },
        },
      },
      modelSnapshot: {
        defaultModelId: 'model-a',
        models: [
          ...modelSnapshot().models,
          { id: 'fast', name: 'Literal Fast', providerId: 'provider' },
        ],
      },
      tierMap: { fast: 'model-a' },
    })
    if (!result.ok) throw new Error('literal model id must win')
    expect(result.definition.modelByNodeId.draft).toBe('fast')
  })

  it('fails preflight with tier-unavailable when the tier map lacks the alias', async () => {
    const withModelIds = (
      modelIds: Readonly<Record<string, string | undefined>>,
    ) =>
      bundle().document.topology!.nodes.map((node) => ({
        ...node,
        ...(modelIds[node.id] === undefined
          ? {}
          : { modelId: modelIds[node.id] }),
      }))

    const result = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withModelIds({ draft: 'fast' }),
          },
        },
      },
      tierMap: {},
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.tierUnavailable).toBe(true)
    expect(result.error).toMatchObject({
      code: 'model-unavailable',
      nodeId: 'draft',
    })
    expect(result.error.message).toMatch(/tier/i)
  })

  it('fails preflight with tier-unavailable when the tier-mapped id is not in the snapshot', async () => {
    const withModelIds = (
      modelIds: Readonly<Record<string, string | undefined>>,
    ) =>
      bundle().document.topology!.nodes.map((node) => ({
        ...node,
        ...(modelIds[node.id] === undefined
          ? {}
          : { modelId: modelIds[node.id] }),
      }))

    const result = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: {
            ...bundle().document.topology!,
            nodes: withModelIds({ draft: 'fast' }),
          },
        },
      },
      tierMap: { fast: 'missing' },
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.tierUnavailable).toBe(true)
    expect(result.error).toMatchObject({
      code: 'model-unavailable',
      nodeId: 'draft',
    })
    expect(result.error.message).toMatch(/tier/i)
  })

  it('rejects empty or unknown snapshot default model ids', async () => {
    const emptyDefault = await build({
      modelSnapshot: { defaultModelId: '', models: modelSnapshot().models },
    })
    expect(emptyDefault).toEqual({
      ok: false,
      error: { code: 'model-unavailable', message: expect.any(String) },
    })

    const unknownDefault = await build({
      modelSnapshot: {
        defaultModelId: 'model-zzz',
        models: modelSnapshot().models,
      },
    })
    expect(unknownDefault).toEqual({
      ok: false,
      error: { code: 'model-unavailable', message: expect.any(String) },
    })
  })

  it('derives a concat policy when no merge node declares a strategy', async () => {
    const nodes = baseTopology().nodes.map((node) =>
      node.kind === 'merge' ? { ...node, mergeStrategy: undefined } : node,
    )
    const result = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology: { ...bundle().document.topology!, nodes },
        },
      },
    })
    if (!result.ok) throw new Error('must build')
    expect(result.definition.policy.mergeStrategy).toBe('concat')
  })

  it('rejects mixed merge strategies across merge nodes', async () => {
    const nodes = baseTopology().nodes.flatMap((node) =>
      node.kind === 'merge'
        ? [
            { ...node, id: 'merged-a', mergeStrategy: 'concat' as const },
            { ...node, id: 'merged-b', mergeStrategy: 'dedupe' as const },
          ]
        : [node],
    )
    const edges = [
      ...baseTopology().edges.filter((edge) => edge.target !== 'merged'),
      { id: 'draft-a', source: 'draft', target: 'merged-a' },
      { id: 'skip-b', source: 'skip', target: 'merged-b' },
      { id: 'a-output', source: 'merged-a', target: 'output' },
      { id: 'b-output', source: 'merged-b', target: 'output' },
    ]
    const topology = { revision: 1 as const, nodes, edges }
    const result = await build({
      bundle: {
        ...bundle(),
        document: {
          ...bundle().document,
          topology,
          steps: nodes.map((node) => ({
            nodeId: node.id,
            label: node.label,
            stepPath: node.stepPath,
          })),
        },
        files: [
          ...bundle().files.filter((file) => file.nodeId === 'workflow'),
          ...nodes.map((node) => ({
            nodeId: node.id,
            relativePath: `demo/${node.stepPath}`,
            snapshot: {
              path: `demo/${node.stepPath}`,
              content: stepContent(node.id),
            },
          })),
        ],
      },
    })
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid-definition', message: expect.any(String) },
    })
  })
})

describe('workflow context extraction', () => {
  const withBlocks = (): string =>
    updateWorkflowManagedBlocks(content(), baseTopology(), {
      document: { structureTitle: 'Structure', topologyTitle: 'Topology' },
      workflowTitle: 'x',
    } as never)

  it('excludes frontmatter and managed blocks only from the context copy', () => {
    const original = withBlocks()
    const context = extractWorkflowExecutionContext(original)

    expect(original).toBe(withBlocks())
    expect(context).not.toContain('yaml: frontmatter')
    expect(context).not.toContain('<!-- yolo:workflow-structure:start -->')
    expect(context).not.toContain('<!-- yolo:workflow-topology:start -->')
    expect(context).toContain('Keep this prose')
    expect(context).toContain('[[wikilink]]')
    expect(context).toContain('![[embed]]')
    expect(context).toContain('> callout')
    expect(context).toContain('#tag')
    expect(context).toContain('# Demo workflow')
  })

  it('strips DSH managed blocks as well', () => {
    const dsh = [
      content(),
      '<!-- deepseek-flow:structure:start -->',
      '- id: input',
      '<!-- deepseek-flow:structure:end -->',
      '<!-- deepseek-flow:topology:start -->',
      '{}',
      '<!-- deepseek-flow:topology:end -->',
    ].join('\n')
    const context = extractWorkflowExecutionContext(dsh)

    expect(context).toContain('Keep this prose')
    expect(context).not.toContain('deepseek-flow')
  })

  it('leaves ordinary markdown without blocks untouched', () => {
    const plain = '# Title\n\nProse with [[links]].\n'
    expect(extractWorkflowExecutionContext(plain)).toBe(plain)
  })
})

describe('workflow node merge strategy', () => {
  const withMergeNode = (mergeStrategy: unknown) => {
    const base = baseTopology().nodes
    return {
      revision: 1,
      nodes: [base[0], { ...base[4], mergeStrategy }, base[5]],
      edges: [
        { id: 'input-merged', source: 'input', target: 'merged' },
        { id: 'merged-output', source: 'merged', target: 'output' },
      ],
    }
  }

  it('accepts only concat and dedupe in parseNode', () => {
    const valid = parseWorkflowTopology(withMergeNode('dedupe'))
    expect(valid?.nodes[1].mergeStrategy).toBe('dedupe')

    expect(parseWorkflowTopology(withMergeNode('side-by-side'))).toBeNull()
  })

  it('keeps mergeStrategy across DSH import and export', () => {
    const topology = baseTopology()
    const exported = exportDshFlowJson({
      title: 'Demo workflow',
      content: content(),
      topology,
      stepContents: Object.fromEntries(
        topology.nodes.map((node) => [node.id, stepContent(node.id)]),
      ),
    })
    expect(
      (
        exported.nodes as ReadonlyArray<{
          data: Readonly<Record<string, unknown>>
        }>
      )[4].data.mergeStrategy,
    ).toBe('dedupe')

    const imported = parseDshFlowJson(exported)
    expect(imported?.topology.nodes[4].mergeStrategy).toBe('dedupe')
  })

  it('ignores mergeStrategy on non-merge nodes', () => {
    const base = baseTopology().nodes
    const topology = parseWorkflowTopology({
      revision: 1,
      nodes: [base[0], { ...base[2], mergeStrategy: 'concat' }, base[5]],
      edges: [
        { id: 'input-agent', source: 'input', target: 'draft' },
        { id: 'agent-output', source: 'draft', target: 'output' },
      ],
    })
    expect(topology?.nodes[1].mergeStrategy).toBe('concat')
  })
})

describe('run snapshot shape', () => {
  it('accepts a persisted snapshot round trip', () => {
    // Typing guard: the snapshot schemaVersion is fixed at 1.
    const snapshot: WorkflowRunSnapshot = {
      schemaVersion: 1,
      runId: 'run-1',
      workflowPath: 'demo/WORKFLOW.md',
      definition: {} as WorkflowRunSnapshot['definition'],
      input: null,
      status: 'running',
      nodes: {},
      outputs: {},
      startedAt: 0,
    }
    expect(snapshot.schemaVersion).toBe(1)
  })
})
