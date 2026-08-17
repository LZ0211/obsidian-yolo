import { en } from '../i18n'
import {
  type WorkflowBundle,
  type WorkflowRepository,
  type WorkflowRepositoryEvent,
} from '../domain/workflow-repository'
import type { WorkflowTopology } from '../domain/workflow-model'
import { updateWorkflowManagedBlocks } from '../domain/workflow-document'
import {
  type WorkflowEditorSnapshot,
  createWorkflowEditorModel,
} from './workflow-editor-model'

const topology: WorkflowTopology = {
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
      label: 'Draft',
      stepPath: 'steps/draft/STEP.md',
      position: { x: 315, y: 90 },
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

describe('workflow editor model', () => {
  it('loads a workflow and exposes a detached editor snapshot', async () => {
    const repository = createRepository()
    const model = createWorkflowEditorModel(repository, en)

    await expect(model.load('quality/WORKFLOW.md')).resolves.toEqual({
      ok: true,
    })

    const snapshot = model.getSnapshot()
    expect(snapshot.status).toBe('ready')
    expect(snapshot.topology).toEqual(topology)
    expect(snapshot.selectedNodeId).toBe('input')
    expect(Object.isFrozen(snapshot)).toBe(true)
    expect(Object.isFrozen(snapshot.topology)).toBe(true)
  })

  it('tracks one topology history and supports undo and redo', async () => {
    const model = createWorkflowEditorModel(createRepository(), en)
    await model.load('quality/WORKFLOW.md')
    const changed = {
      ...topology,
      nodes: [
        { ...topology.nodes[0], label: 'Changed' },
        ...topology.nodes.slice(1),
      ],
    }

    expect(model.updateTopology(changed)).toBe(true)
    expect(model.getSnapshot().dirty).toBe(true)
    expect(model.getSnapshot().canUndo).toBe(true)
    expect(model.undo()).toBe(true)
    expect(model.getSnapshot().topology?.nodes[0]?.label).toBe('Input')
    expect(model.getSnapshot().dirty).toBe(false)
    expect(model.redo()).toBe(true)
    expect(model.getSnapshot().topology?.nodes[0]?.label).toBe('Changed')
  })

  it('loads the first listed workflow when no path is provided', async () => {
    const model = createWorkflowEditorModel(createRepository(), en)

    await expect(model.load()).resolves.toEqual({ ok: true })

    expect(model.getSnapshot().status).toBe('ready')
    expect(model.getSnapshot().path).toBe('quality/WORKFLOW.md')
  })

  it('clears the previous graph while loading another workflow', async () => {
    const repository = createRepository()
    repository.setList([
      { path: 'quality/WORKFLOW.md', title: 'quality' },
      { path: 'second/WORKFLOW.md', title: 'second' },
    ])
    const pending = deferred<WorkflowBundle | null>()
    repository.read.mockImplementation(async (path) => {
      if (path === 'second/WORKFLOW.md') return pending.promise
      return repository.bundle
    })
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')

    const loading = model.load('second/WORKFLOW.md')

    expect(model.getSnapshot().status).toBe('loading')
    expect(model.getSnapshot().bundle).toBeNull()
    expect(model.getSnapshot().topology).toBeNull()

    pending.resolve(repository.bundle)
    await expect(loading).resolves.toEqual({ ok: true })
  })

  it('publishes the refreshed list together with the cleared loading state', async () => {
    const repository = createRepository()
    repository.setList([
      { path: 'quality/WORKFLOW.md', title: 'quality' },
      { path: 'second/WORKFLOW.md', title: 'second' },
    ])
    const pending = deferred<WorkflowBundle | null>()
    repository.read.mockImplementation(async (path) => {
      if (path === 'second/WORKFLOW.md') return pending.promise
      return repository.bundle
    })
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')
    const published: WorkflowEditorSnapshot[] = []
    model.subscribe(() => published.push(model.getSnapshot()))

    const loading = model.load('second/WORKFLOW.md')

    expect(published[0]).toMatchObject({
      status: 'loading',
      workflows: [
        { path: 'quality/WORKFLOW.md' },
        { path: 'second/WORKFLOW.md' },
      ],
      bundle: null,
      topology: null,
    })
    pending.resolve(repository.bundle)
    await loading
  })

  it('keeps edits made during a save dirty after the save completes', async () => {
    const repository = createRepository()
    const pending =
      deferred<Awaited<ReturnType<WorkflowRepository['replaceFile']>>>()
    repository.replaceFile.mockImplementationOnce(() => pending.promise)
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')

    const savedTopology = {
      ...topology,
      nodes: [
        { ...topology.nodes[0], label: 'Saved' },
        ...topology.nodes.slice(1),
      ],
    }
    const laterTopology = {
      ...savedTopology,
      nodes: [
        { ...savedTopology.nodes[0], label: 'Later' },
        ...savedTopology.nodes.slice(1),
      ],
    }
    model.updateTopology(savedTopology)
    const applying = model.apply()
    model.updateTopology(laterTopology)
    pending.resolve({
      ok: true,
      snapshot: {
        path: repository.manifestPath,
        content: repository.currentContent(),
      },
    })

    await expect(applying).resolves.toEqual({ ok: true })
    expect(model.getSnapshot().topology?.nodes[0]?.label).toBe('Later')
    expect(model.getSnapshot().dirty).toBe(true)
  })

  it('recovers after a repository save rejection', async () => {
    const repository = createRepository()
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')
    model.updateTopology({
      ...topology,
      nodes: [
        { ...topology.nodes[0], label: 'Retry' },
        ...topology.nodes.slice(1),
      ],
    })
    repository.replaceFile.mockRejectedValueOnce(new Error('write failed'))

    await expect(model.apply()).rejects.toThrow('write failed')
    expect(model.getSnapshot().status).toBe('error')

    await expect(model.apply()).resolves.toEqual({ ok: true })
    expect(model.getSnapshot().dirty).toBe(false)
  })

  it('keeps the baseline clean when a failed save is undone before rejection', async () => {
    const repository = createRepository()
    const pending =
      deferred<Awaited<ReturnType<WorkflowRepository['replaceFile']>>>()
    repository.replaceFile.mockImplementationOnce(() => pending.promise)
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')
    model.updateTopology({
      ...topology,
      nodes: [
        { ...topology.nodes[0], label: 'Transient' },
        ...topology.nodes.slice(1),
      ],
    })
    const applying = model.apply()
    expect(model.undo()).toBe(true)
    pending.reject(new Error('write failed'))

    await expect(applying).rejects.toThrow('write failed')
    expect(model.getSnapshot().dirty).toBe(false)
  })

  it('refuses to save a topology with validation issues', async () => {
    const repository = createRepository()
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')
    model.updateTopology({
      ...topology,
      edges: [
        ...topology.edges,
        { id: 'output-input', source: 'output', target: 'input' },
      ],
    })

    expect(model.getSnapshot().issues.map((issue) => issue.code)).toContain(
      'cycle',
    )
    await expect(model.apply()).resolves.toEqual({
      ok: false,
      reason: 'invalid',
    })
    expect(repository.replaceFile).not.toHaveBeenCalled()
  })

  it('rejects malformed topology without replacing the displayed graph', async () => {
    const model = createWorkflowEditorModel(createRepository(), en)
    await model.load('quality/WORKFLOW.md')
    const malformed = {
      ...topology,
      nodes: [
        { ...topology.nodes[0], position: { x: Number.NaN, y: 0 } },
        ...topology.nodes.slice(1),
      ],
    }

    expect(model.updateTopology(malformed)).toBe(false)
    expect(model.getSnapshot().topology).toEqual(topology)
    expect(model.getSnapshot().dirty).toBe(false)
  })

  it('rejects topology with unsupported node fields without changing state', async () => {
    const model = createWorkflowEditorModel(createRepository(), en)
    await model.load('quality/WORKFLOW.md')
    const malformed = {
      ...topology,
      nodes: [
        {
          ...topology.nodes[0],
          kind: 'unknown',
          stepPath: '../escape.md',
        },
        ...topology.nodes.slice(1),
      ],
    } as unknown as WorkflowTopology

    expect(model.updateTopology(malformed)).toBe(false)
    expect(model.getSnapshot().topology).toEqual(topology)
  })

  it('does not reread the deleted workflow when selecting the next empty state', async () => {
    const repository = createRepository()
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')
    repository.setList([])

    await expect(model.trashCurrent()).resolves.toBe(true)

    expect(model.getSnapshot().status).toBe('empty')
    expect(model.getSnapshot().path).toBeNull()
    expect(repository.read).toHaveBeenCalledTimes(1)
  })

  it('selects the next workflow after the current manifest is deleted', async () => {
    const repository = createRepository()
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')
    repository.setList([{ path: 'second/WORKFLOW.md', title: 'second' }])
    repository.read.mockImplementation(async (path) =>
      path === 'quality/WORKFLOW.md' ? null : repository.bundle,
    )

    repository.emit({
      type: 'vault',
      event: {
        type: 'delete',
        entry: {
          kind: 'folder',
          path: 'managed/workflows/quality',
          name: 'quality',
        },
      },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(model.getSnapshot().status).toBe('ready')
    expect(model.getSnapshot().path).toBe('second/WORKFLOW.md')
    expect(repository.read).toHaveBeenLastCalledWith('second/WORKFLOW.md')
  })

  it('applies through the repository compare-and-swap', async () => {
    const repository = createRepository()
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')
    model.updateTopology({
      ...topology,
      nodes: [
        { ...topology.nodes[0], label: 'Saved' },
        ...topology.nodes.slice(1),
      ],
    })

    await expect(model.apply()).resolves.toEqual({ ok: true })
    expect(model.getSnapshot().dirty).toBe(false)
    expect(repository.replaceFile).toHaveBeenCalledTimes(1)
    expect(repository.currentContent()).toContain(
      '[Saved](steps/input/STEP.md)',
    )
  })

  it('keeps dirty edits when another writer changes the manifest', async () => {
    const repository = createRepository()
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')
    model.updateTopology({
      ...topology,
      nodes: [
        { ...topology.nodes[0], label: 'Local' },
        ...topology.nodes.slice(1),
      ],
    })
    repository.emit({
      type: 'vault',
      event: {
        type: 'modify',
        entry: {
          kind: 'file',
          path: repository.manifestPath,
          name: 'WORKFLOW.md',
          ctime: 1,
          mtime: 2,
        },
      },
    })

    expect(model.getSnapshot().status).toBe('conflict')
    expect(model.getSnapshot().topology?.nodes[0]?.label).toBe('Local')
    await expect(model.apply()).resolves.toEqual({
      ok: false,
      reason: 'conflict',
    })
  })

  it('does not reread a clean workflow for an unrelated vault event', async () => {
    const repository = createRepository()
    const model = createWorkflowEditorModel(repository, en)
    await model.load('quality/WORKFLOW.md')

    repository.emit({
      type: 'vault',
      event: {
        type: 'modify',
        entry: {
          kind: 'file',
          path: 'managed/workflows/other/WORKFLOW.md',
          name: 'WORKFLOW.md',
          ctime: 1,
          mtime: 2,
        },
      },
    })
    await Promise.resolve()

    expect(repository.read).toHaveBeenCalledTimes(1)
  })
})

function createRepository(): WorkflowRepository & {
  emit(event: WorkflowRepositoryEvent): void
  currentContent(): string
  manifestPath: string
  replaceFile: jest.Mock
  read: jest.Mock
  setList(entries: readonly { path: string; title: string }[]): void
  bundle: WorkflowBundle
} {
  const manifestPath = 'managed/workflows/quality/WORKFLOW.md'
  let content = updateWorkflowManagedBlocks('', topology, en)
  let entries: readonly { path: string; title: string }[] = [
    { path: 'quality/WORKFLOW.md', title: 'quality' },
  ]
  let listener: ((event: WorkflowRepositoryEvent) => void) | null = null
  const bundle: WorkflowBundle = {
    path: 'quality/WORKFLOW.md',
    document: {
      title: 'quality',
      content,
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
        relativePath: 'quality/WORKFLOW.md',
        snapshot: { path: manifestPath, content },
      },
    ],
  }
  const replaceFile = jest.fn(async (expected, nextContent: string) => {
    if (expected.content !== content) return { ok: false, reason: 'conflict' }
    content = nextContent
    return { ok: true, snapshot: { path: manifestPath, content } }
  })
  const read = jest.fn(async () => ({
    ...bundle,
    document: { ...bundle.document, content },
    files: [{ ...bundle.files[0], snapshot: { path: manifestPath, content } }],
  }))
  return {
    manifestPath,
    list: () => entries,
    read,
    create: async () => ({ ok: false, reason: 'target-exists' }),
    importBundle: async () => ({ ok: false, reason: 'target-exists' }),
    replaceFile,
    trash: async () => true,
    subscribe: (nextListener: (event: WorkflowRepositoryEvent) => void) => {
      listener = nextListener
      return () => {
        listener = null
      }
    },
    emit: (event: WorkflowRepositoryEvent) => {
      content = `${content}\nexternal change`
      listener?.(event)
    },
    currentContent: () => content,
    setList: (nextEntries: readonly { path: string; title: string }[]) => {
      entries = nextEntries
    },
    bundle,
  } as unknown as WorkflowRepository & {
    emit(event: WorkflowRepositoryEvent): void
    currentContent(): string
    manifestPath: string
    replaceFile: jest.Mock
    read: jest.Mock
    setList(entries: readonly { path: string; title: string }[]): void
    bundle: WorkflowBundle
  }
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}
