import { en } from '../i18n'
import {
  parseWorkflowDocument,
  updateWorkflowManagedBlocks,
} from '../domain/workflow-document'
import type { WorkflowTopology } from '../domain/workflow-model'
import type {
  WorkflowBundle,
  WorkflowRepository,
  WorkflowRepositoryEvent,
} from '../domain/workflow-repository'
import { createWorkflowEditorModel } from './workflow-editor-model'

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
      id: 'agent',
      kind: 'agent',
      label: 'Agent',
      stepPath: 'steps/agent/STEP.md',
      position: { x: 1, y: 0 },
    },
    {
      id: 'output',
      kind: 'output',
      label: 'Output',
      stepPath: 'steps/output/STEP.md',
      position: { x: 2, y: 0 },
    },
  ],
  edges: [
    { id: 'input-agent', source: 'input', target: 'agent' },
    { id: 'agent-output', source: 'agent', target: 'output' },
  ],
}

describe('workflow editor model', () => {
  it('loads a bundle into an immutable ready snapshot', async () => {
    const repository = createRepository(bundleFor(topology))
    const model = createWorkflowEditorModel(repository)

    expect(model.getSnapshot()).toMatchObject({
      status: 'loading',
      workflows: [{ path: 'alpha/WORKFLOW.md', title: 'Alpha' }],
      path: null,
      bundle: null,
      topology: null,
      selectedNodeId: null,
      dirty: false,
      history: { canUndo: false, canRedo: false },
    })

    await model.load('alpha/WORKFLOW.md')

    const snapshot = model.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.path).toBe('alpha/WORKFLOW.md')
    expect(snapshot.topology).toEqual(topology)
    expect(snapshot.issues).toEqual([])
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.topology)).toBe(true)
    model.dispose()
  })

  it('builds a laid-out topology from structure steps when topology is absent', async () => {
    const content = [
      '# Alpha',
      '<!-- yolo:workflow-structure:start -->',
      '## Structure',
      '',
      '- id: input',
      '  kind: input',
      '  label: [Input](steps/input/STEP.md)',
      '  step: steps/input/STEP.md',
      '- id: output',
      '  kind: output',
      '  label: [Output](steps/output/STEP.md)',
      '  step: steps/output/STEP.md',
      '<!-- yolo:workflow-structure:end -->',
    ].join('\n')
    const repository = createRepository(bundleFor(null, content))
    const model = createWorkflowEditorModel(repository)

    await model.load('alpha/WORKFLOW.md')

    expect(model.getSnapshot().topology).toMatchObject({
      nodes: [
        { id: 'input', kind: 'input', stepPath: 'steps/input/STEP.md' },
        { id: 'output', kind: 'output', stepPath: 'steps/output/STEP.md' },
      ],
      edges: [{ source: 'input', target: 'output' }],
    })
    expect(model.getSnapshot().topology?.nodes[0]?.position).toEqual({
      x: 70,
      y: 90,
    })
    model.dispose()
  })

  it('selects nodes and keeps undo and redo history coherent', async () => {
    const repository = createRepository(bundleFor(topology))
    const model = createWorkflowEditorModel(repository)
    await model.load('alpha/WORKFLOW.md')

    model.selectNode('agent')
    expect(model.getSnapshot().selectedNodeId).toBe('agent')

    const changedTopology: WorkflowTopology = {
      ...topology,
      nodes: [
        topology.nodes[0],
        { ...topology.nodes[1], label: 'Changed' },
        topology.nodes[2],
      ],
    }
    expect(model.updateTopology(changedTopology)).toBe(true)
    expect(model.getSnapshot()).toMatchObject({
      selectedNodeId: 'agent',
      dirty: true,
      history: { canUndo: true, canRedo: false },
    })

    expect(model.undo()).toBe(true)
    expect(model.getSnapshot()).toMatchObject({
      dirty: false,
      selectedNodeId: 'agent',
      history: { canUndo: false, canRedo: true },
    })
    expect(model.getSnapshot().topology).toEqual(topology)

    expect(model.redo()).toBe(true)
    expect(model.getSnapshot().topology?.nodes[1]?.label).toBe('Changed')
    expect(model.getSnapshot().dirty).toBe(true)
    model.dispose()
  })

  it('replays multiple undo and redo steps in edit order', async () => {
    const repository = createRepository(bundleFor(topology))
    const model = createWorkflowEditorModel(repository)
    await model.load('alpha/WORKFLOW.md')
    const changedTopology: WorkflowTopology = {
      ...topology,
      nodes: [
        topology.nodes[0],
        { ...topology.nodes[1], label: 'Changed once' },
        topology.nodes[2],
      ],
    }
    const changedAgain: WorkflowTopology = {
      ...changedTopology,
      nodes: [
        changedTopology.nodes[0],
        { ...changedTopology.nodes[1], label: 'Changed twice' },
        changedTopology.nodes[2],
      ],
    }
    model.updateTopology(changedTopology)
    model.updateTopology(changedAgain)

    model.undo()
    expect(model.getSnapshot().topology?.nodes[1]?.label).toBe('Changed once')
    model.undo()
    expect(model.getSnapshot().topology).toEqual(topology)
    model.redo()
    expect(model.getSnapshot().topology?.nodes[1]?.label).toBe('Changed once')
    model.redo()
    expect(model.getSnapshot().topology?.nodes[1]?.label).toBe('Changed twice')
    model.dispose()
  })

  it('rejects malformed topology without replacing the displayed graph', async () => {
    const repository = createRepository(bundleFor(topology))
    const model = createWorkflowEditorModel(repository)
    await model.load('alpha/WORKFLOW.md')

    const malformedTopology = {
      ...topology,
      nodes: [{ ...topology.nodes[0], position: { x: Number.NaN, y: 0 } }],
    } as WorkflowTopology

    expect(model.updateTopology(malformedTopology)).toBe(false)
    expect(model.getSnapshot().topology).toEqual(topology)
    expect(model.getSnapshot().dirty).toBe(false)
    model.dispose()
  })

  it('applies the manifest with CAS and refreshes the saved bundle', async () => {
    const repository = createRepository(bundleFor(topology))
    const changedTopology: WorkflowTopology = {
      ...topology,
      nodes: [
        topology.nodes[0],
        { ...topology.nodes[1], label: 'Changed' },
        topology.nodes[2],
      ],
    }
    const refreshedBundle = bundleFor(changedTopology)
    repository.read.mockResolvedValueOnce(bundleFor(topology))
    repository.read.mockResolvedValueOnce(refreshedBundle)
    const model = createWorkflowEditorModel(repository)
    await model.load('alpha/WORKFLOW.md')
    model.updateTopology(changedTopology)

    await expect(model.apply()).resolves.toBe(true)

    expect(repository.replaceFile).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'managed/workflows/alpha/WORKFLOW.md',
      }),
      expect.stringContaining('"label": "Changed"'),
    )
    expect(model.getSnapshot()).toMatchObject({
      status: 'ready',
      dirty: false,
      bundle: refreshedBundle,
    })
    model.dispose()
  })

  it('enters conflict and keeps local edits when CAS fails', async () => {
    const repository = createRepository(bundleFor(topology))
    repository.replaceFile.mockResolvedValue({
      ok: false,
      reason: 'conflict',
    } as Awaited<ReturnType<WorkflowRepository['replaceFile']>>)
    const model = createWorkflowEditorModel(repository)
    await model.load('alpha/WORKFLOW.md')
    const changedTopology: WorkflowTopology = {
      ...topology,
      nodes: [
        topology.nodes[0],
        { ...topology.nodes[1], label: 'Local edit' },
        topology.nodes[2],
      ],
    }
    model.updateTopology(changedTopology)

    await expect(model.apply()).resolves.toBe(false)

    expect(model.getSnapshot()).toMatchObject({
      status: 'conflict',
      dirty: true,
      topology: changedTopology,
    })
    expect(repository.read).toHaveBeenCalledTimes(1)
    model.dispose()
  })

  it('marks dirty edits as conflicted without reloading on external changes', async () => {
    const repository = createRepository(bundleFor(topology))
    const model = createWorkflowEditorModel(repository)
    await model.load('alpha/WORKFLOW.md')
    const changedTopology: WorkflowTopology = {
      ...topology,
      nodes: [
        topology.nodes[0],
        { ...topology.nodes[1], label: 'Local edit' },
        topology.nodes[2],
      ],
    }
    model.updateTopology(changedTopology)
    repository.emit({
      type: 'vault',
      event: {
        type: 'modify',
        entry: {
          kind: 'file',
          path: 'managed/workflows/alpha/WORKFLOW.md',
          name: 'WORKFLOW.md',
          ctime: 1,
          mtime: 2,
        },
      },
    })

    await Promise.resolve()

    expect(repository.read).toHaveBeenCalledTimes(1)
    expect(model.getSnapshot()).toMatchObject({
      status: 'conflict',
      dirty: true,
      topology: changedTopology,
    })
    model.dispose()
  })
})

function bundleFor(
  currentTopology: WorkflowTopology | null,
  content = currentTopology
    ? updateWorkflowManagedBlocks('# Alpha', currentTopology, en)
    : '# Alpha',
): WorkflowBundle {
  const document = parseWorkflowDocument(content)
  return {
    path: 'alpha/WORKFLOW.md',
    document,
    files: [
      {
        nodeId: 'workflow',
        relativePath: 'alpha/WORKFLOW.md',
        snapshot: {
          path: 'managed/workflows/alpha/WORKFLOW.md',
          content,
        },
      },
    ],
  }
}

function createRepository(initialBundle: WorkflowBundle) {
  let currentBundle: WorkflowBundle | null = initialBundle
  const listeners = new Set<(event: WorkflowRepositoryEvent) => void>()
  const replaceFile: jest.MockedFunction<WorkflowRepository['replaceFile']> =
    jest.fn(async (expected, content) => ({
      ok: true as const,
      snapshot: { path: expected.path, content },
    }))
  const repository = {
    list: jest.fn(() => [{ path: 'alpha/WORKFLOW.md', title: 'Alpha' }]),
    read: jest.fn(async () => currentBundle),
    create: jest.fn(),
    importBundle: jest.fn(),
    replaceFile,
    trash: jest.fn(),
    subscribe: jest.fn((listener: (event: WorkflowRepositoryEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }),
    emit: (event: WorkflowRepositoryEvent) => {
      for (const listener of listeners) listener(event)
    },
    setBundle: (bundle: WorkflowBundle | null) => {
      currentBundle = bundle
    },
  }
  return repository as typeof repository & WorkflowRepository
}
