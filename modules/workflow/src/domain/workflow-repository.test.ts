import { updateWorkflowManagedBlocks } from './workflow-document'
import type { WorkflowTopology } from './workflow-model'
import { createWorkflowRepository } from './workflow-repository'

type VaultEvent = Parameters<
  YoloModuleHostApiV1['vault']['subscribe']
>[1] extends (event: infer Event) => unknown
  ? Event
  : never

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
  ],
  edges: [],
}

const manifest = (title = 'Workflow') =>
  updateWorkflowManagedBlocks(`# ${title}`, topology, {
    document: {
      workflowTitle: 'Workflow',
      structureTitle: 'Structure',
      topologyTitle: 'Topology',
    },
  } as never)

describe('workflow repository', () => {
  it('lists only direct workflow manifests in sorted public paths', () => {
    const fake = new MemoryHost('managed/workflows')
    fake.folder('managed/workflows/a')
    fake.file('managed/workflows/a/WORKFLOW.md', manifest('A'))
    fake.folder('managed/workflows/z')
    fake.file('managed/workflows/z/WORKFLOW.md', manifest('Z'))
    fake.file('managed/workflows/loose.md', manifest())
    fake.folder('managed/workflows/a/nested')
    fake.file('managed/workflows/a/nested/WORKFLOW.md', manifest())

    expect(createWorkflowRepository(fake.host).list()).toEqual([
      { path: 'a/WORKFLOW.md', title: 'a' },
      { path: 'z/WORKFLOW.md', title: 'z' },
    ])
  })

  it('rejects non-direct manifest paths and reports missing declared steps', async () => {
    const fake = new MemoryHost('managed/workflows')
    fake.file('managed/workflows/alpha/WORKFLOW.md', manifest())
    const repository = createWorkflowRepository(fake.host)

    await expect(repository.read('../alpha/WORKFLOW.md')).resolves.toBeNull()
    await expect(
      repository.read('alpha/nested/WORKFLOW.md'),
    ).resolves.toBeNull()
    await expect(repository.read('alpha\\WORKFLOW.md')).resolves.toBeNull()
    const bundle = await repository.read('alpha/WORKFLOW.md')

    expect(bundle?.document.issues).toContain('missingStep')
    expect(bundle?.files).toEqual([
      expect.objectContaining({
        nodeId: 'workflow',
        relativePath: 'alpha/WORKFLOW.md',
      }),
    ])
  })

  it('reads distinct step snapshots without duplicating shared paths', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repeated = updateWorkflowManagedBlocks(
      '# Shared',
      {
        ...topology,
        nodes: [
          ...topology.nodes,
          {
            ...topology.nodes[0],
            id: 'again',
            stepPath: 'steps/input/STEP.md',
          },
        ],
      },
      {
        document: {
          workflowTitle: 'Workflow',
          structureTitle: 'Structure',
          topologyTitle: 'Topology',
        },
      } as never,
    )
    fake.file('managed/workflows/alpha/WORKFLOW.md', repeated)
    fake.file('managed/workflows/alpha/steps/input/STEP.md', 'input')

    const bundle = await createWorkflowRepository(fake.host).read(
      'alpha/WORKFLOW.md',
    )

    expect(bundle?.files).toHaveLength(2)
    expect(bundle?.files[1]).toMatchObject({
      nodeId: 'input',
      relativePath: 'alpha/steps/input/STEP.md',
      snapshot: {
        path: 'managed/workflows/alpha/steps/input/STEP.md',
        content: 'input',
      },
    })
  })

  it('uses one root snapshot for the complete asynchronous read', async () => {
    const fake = new MemoryHost('first')
    fake.file('first/a/WORKFLOW.md', manifest('First'))
    fake.file('first/a/steps/input/STEP.md', 'first step')
    fake.file('second/a/WORKFLOW.md', manifest('Second'))
    fake.file('second/a/steps/input/STEP.md', 'second step')
    fake.readSnapshotHook = (path) => {
      if (path === 'first/a/WORKFLOW.md') fake.changeRoot('second')
    }

    const bundle = await createWorkflowRepository(fake.host).read(
      'a/WORKFLOW.md',
    )

    expect(bundle?.document.title).toBe('First')
    expect(bundle?.files[1].snapshot.content).toBe('first step')
  })

  it('creates steps before the manifest and refuses an occupied target', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)
    const input = {
      slug: 'alpha',
      manifestContent: manifest(),
      stepFiles: [{ relativePath: 'steps/input/STEP.md', content: 'input' }],
    }

    expect(await repository.create(input)).toMatchObject({ ok: true })
    expect(fake.createCalls).toEqual([
      'managed/workflows/alpha/steps/input/STEP.md',
      'managed/workflows/alpha/WORKFLOW.md',
    ])
    expect(await repository.create(input)).toEqual({
      ok: false,
      reason: 'target-exists',
    })
  })

  it('creates and trashes one step through the workflow-owned path', async () => {
    const fake = new MemoryHost('managed/workflows')
    fake.file('managed/workflows/alpha/WORKFLOW.md', manifest())
    const repository = createWorkflowRepository(fake.host)

    await expect(
      repository.createStep(
        'alpha/WORKFLOW.md',
        'steps/next/STEP.md',
        '# Next\n',
      ),
    ).resolves.toMatchObject({ ok: true, snapshot: { content: '# Next\n' } })
    await expect(
      repository.createStep(
        'alpha/WORKFLOW.md',
        'steps/next/STEP.md',
        '# Duplicate\n',
      ),
    ).resolves.toEqual({ ok: false, reason: 'target-exists' })
    await expect(
      repository.trashStep('alpha/WORKFLOW.md', 'steps/next/STEP.md'),
    ).resolves.toBe(true)
    expect(fake.trashCalls).toEqual([
      'managed/workflows/alpha/steps/next/STEP.md',
    ])
  })

  it('rejects duplicate step paths before writing anything', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)

    await expect(
      repository.create({
        slug: 'duplicate',
        manifestContent: manifest(),
        stepFiles: [
          { relativePath: 'steps/input/STEP.md', content: 'first' },
          { relativePath: 'steps/input/STEP.md', content: 'second' },
        ],
      }),
    ).resolves.toEqual({ ok: false, reason: 'invalid-input' })
    expect(fake.createCalls).toEqual([])
  })

  it('reports a root switch during create as stale and cleans created steps', async () => {
    const fake = new MemoryHost('first')
    fake.createHook = (path) => {
      if (path === 'first/workflow/steps/input/STEP.md')
        fake.changeRoot('second')
    }
    const repository = createWorkflowRepository(fake.host)

    await expect(
      repository.create({
        slug: 'workflow',
        manifestContent: manifest(),
        stepFiles: [{ relativePath: 'steps/input/STEP.md', content: 'input' }],
      }),
    ).resolves.toEqual({ ok: false, reason: 'stale' })
    expect(fake.files.has('first/workflow/steps/input/STEP.md')).toBe(false)
    expect(fake.files.has('first/workflow/WORKFLOW.md')).toBe(false)
  })

  it('does not report a CAS write as successful after the root changes', async () => {
    const fake = new MemoryHost('first')
    fake.file('first/workflow/WORKFLOW.md', 'old')
    const repository = createWorkflowRepository(fake.host)
    fake.replaceHook = () => fake.changeRoot('second')

    await expect(
      repository.replaceFile(
        { path: 'first/workflow/WORKFLOW.md', content: 'old' },
        'new',
      ),
    ).resolves.toEqual({ ok: false, reason: 'conflict' })
  })

  it('returns invalid-input for blank slugs and unsafe step paths', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)
    const manifestContent = manifest()

    await expect(
      repository.create({ slug: '   ', manifestContent, stepFiles: [] }),
    ).resolves.toEqual({ ok: false, reason: 'invalid-input' })
    await expect(
      repository.create({
        slug: 'valid',
        manifestContent,
        stepFiles: [{ relativePath: '../escape/STEP.md', content: 'bad' }],
      }),
    ).resolves.toEqual({ ok: false, reason: 'invalid-input' })
    expect(fake.lockNamespaces).toHaveLength(0)
  })

  it('maps null STEP and manifest creation results to target-exists', async () => {
    const stepFake = new MemoryHost('managed/workflows')
    stepFake.createNullPaths.add(
      'managed/workflows/step-null/steps/input/STEP.md',
    )
    await expect(
      createWorkflowRepository(stepFake.host).create({
        slug: 'step-null',
        manifestContent: manifest(),
        stepFiles: [{ relativePath: 'steps/input/STEP.md', content: 'input' }],
      }),
    ).resolves.toEqual({ ok: false, reason: 'target-exists' })

    const manifestFake = new MemoryHost('managed/workflows')
    manifestFake.createNullPaths.add(
      'managed/workflows/manifest-null/WORKFLOW.md',
    )
    await expect(
      createWorkflowRepository(manifestFake.host).create({
        slug: 'manifest-null',
        manifestContent: manifest(),
        stepFiles: [],
      }),
    ).resolves.toEqual({ ok: false, reason: 'target-exists' })
  })

  it('serializes same-slug create and import with exactly one success', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)
    const input = {
      slug: 'same-slug',
      manifestContent: manifest(),
      stepFiles: [],
    }

    const results = await Promise.all([
      repository.create(input),
      repository.importBundle(input),
    ])
    fake.createResults.push(...results)

    expect(fake.lockNamespaces).toEqual(['workflows', 'workflows'])
    expect(fake.maxConcurrentLocks).toBe(1)
    expect(fake.createResults.filter((result) => result.ok)).toHaveLength(1)
    expect(fake.createResults.filter((result) => !result.ok)).toEqual([
      { ok: false, reason: 'target-exists' },
    ])
  })

  it('maps every CAS null to conflict, including a file disappearance race', async () => {
    const fake = new MemoryHost('managed/workflows')
    fake.file('managed/workflows/a/WORKFLOW.md', 'old')
    const repository = createWorkflowRepository(fake.host)
    const expected = { path: 'managed/workflows/a/WORKFLOW.md', content: 'old' }

    fake.replaceResult = null
    expect(await repository.replaceFile(expected, 'new')).toEqual({
      ok: false,
      reason: 'conflict',
    })
    expect(fake.replaceCalls).toBe(1)
    fake.delete('managed/workflows/a/WORKFLOW.md')
    expect(await repository.replaceFile(expected, 'new')).toEqual({
      ok: false,
      reason: 'conflict',
    })
    expect(fake.replaceCalls).toBe(2)
    expect(fake.statCalls).toBe(0)
  })

  it('treats an already-missing STEP as an idempotent cleanup', async () => {
    const fake = new MemoryHost('managed/workflows')
    const stepPath = 'managed/workflows/a/steps/input/STEP.md'
    fake.file(stepPath, 'old')
    fake.trashResult = false
    fake.trashHook = (path) => fake.delete(path)
    const repository = createWorkflowRepository(fake.host)

    await expect(
      repository.trashStep('a/WORKFLOW.md', 'steps/input/STEP.md'),
    ).resolves.toBe(true)
    expect(fake.files.has(stepPath)).toBe(false)
  })

  it('conflicts without CAS for snapshots outside the current workflow root', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)

    await expect(
      repository.replaceFile(
        { path: 'managed/other/a/WORKFLOW.md', content: 'old' },
        'new',
      ),
    ).resolves.toEqual({ ok: false, reason: 'conflict' })
    await expect(
      repository.replaceFile(
        {
          path: 'managed/workflows/a/../b/WORKFLOW.md',
          content: 'old',
        },
        'new',
      ),
    ).resolves.toEqual({ ok: false, reason: 'conflict' })
    expect(fake.replaceCalls).toBe(0)

    fake.file('managed/workflows/a/steps/input/STEP.md', 'old')
    const expected = (await fake.host.vault.readTextSnapshot(
      'managed/workflows/a/steps/input/STEP.md',
    ))!
    await expect(repository.replaceFile(expected, 'new')).resolves.toEqual({
      ok: true,
      snapshot: {
        path: 'managed/workflows/a/steps/input/STEP.md',
        content: 'new',
      },
    })
    expect(fake.replaceCalls).toBe(1)
  })

  it('cleans already-created steps when a later step write throws', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)
    const failure = new Error('step write failed')
    fake.createFailurePath = 'managed/workflows/partial/steps/second/STEP.md'
    fake.createFailure = failure

    await expect(
      repository.create({
        slug: 'partial',
        manifestContent: manifest(),
        stepFiles: [
          { relativePath: 'steps/first/STEP.md', content: 'first' },
          { relativePath: 'steps/second/STEP.md', content: 'second' },
        ],
      }),
    ).rejects.toBe(failure)
    expect(
      fake.files.has('managed/workflows/partial/steps/first/STEP.md'),
    ).toBe(false)
    expect(fake.files.has('managed/workflows/partial/WORKFLOW.md')).toBe(false)
    expect(fake.deleteCalls).toEqual([
      'managed/workflows/partial/steps/first/STEP.md',
    ])
  })

  it('propagates Host errors from read, create, trash, and replace', async () => {
    const fake = new MemoryHost('managed/workflows')
    fake.file('managed/workflows/a/WORKFLOW.md', manifest())
    const repository = createWorkflowRepository(fake.host)
    const readError = new Error('read failed')
    fake.readError = readError
    await expect(repository.read('a/WORKFLOW.md')).rejects.toBe(readError)

    const createError = new Error('create failed')
    fake.readError = undefined
    fake.createError = createError
    await expect(
      repository.create({
        slug: 'b',
        manifestContent: manifest(),
        stepFiles: [],
      }),
    ).rejects.toBe(createError)

    const trashError = new Error('trash failed')
    fake.createError = undefined
    fake.trashError = trashError
    await expect(repository.trash('a/WORKFLOW.md')).rejects.toBe(trashError)

    const replaceError = new Error('replace failed')
    fake.trashError = undefined
    fake.replaceError = replaceError
    await expect(
      repository.replaceFile(
        { path: 'managed/workflows/a/WORKFLOW.md', content: 'old' },
        'new',
      ),
    ).rejects.toBe(replaceError)
  })

  it('trashes only validated direct workflow folders', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)

    await expect(repository.trash('a/WORKFLOW.md')).resolves.toBe(true)
    await expect(repository.trash('a/nested/WORKFLOW.md')).resolves.toBe(false)
    expect(fake.trashCalls).toEqual(['managed/workflows/a'])
  })

  it('switches roots immediately, classifies events, and disposes idempotently', () => {
    const fake = new MemoryHost('first')
    fake.folder('first/a')
    fake.file('first/a/WORKFLOW.md', manifest('First'))
    fake.folder('second/b')
    fake.file('second/b/WORKFLOW.md', manifest('Second'))
    const repository = createWorkflowRepository(fake.host)
    const events: string[] = []
    const dispose = repository.subscribe((event) => events.push(event.type))

    fake.emitVault('first', {
      type: 'modify',
      entry: fake.entry('first/a/WORKFLOW.md')!,
    })
    fake.changeRoot('second')
    fake.emitVault('first', {
      type: 'modify',
      entry: fake.entry('first/a/WORKFLOW.md')!,
    })
    fake.emitVault('second', {
      type: 'create',
      entry: fake.entry('second/b/WORKFLOW.md')!,
    })

    expect(repository.list()).toEqual([{ path: 'b/WORKFLOW.md', title: 'b' }])
    expect(events).toEqual(['vault', 'root-changed', 'vault'])
    dispose()
    dispose()
    expect(fake.pathDisposes).toBe(1)
    expect(fake.vaultDisposes).toBe(2)
  })

  it('does not create a vault subscription when initial path subscription fails', () => {
    const fake = new MemoryHost('first')
    const failure = new Error('paths subscribe failed')
    fake.pathSubscribeError = failure

    expect(() =>
      createWorkflowRepository(fake.host).subscribe(() => undefined),
    ).toThrow(failure)
    expect(fake.vaultSubscribeCalls).toBe(0)
    expect(fake.vaultDisposes).toBe(0)
  })

  it('cleans the path subscription when initial vault subscription fails', () => {
    const fake = new MemoryHost('first')
    const failure = new Error('vault subscribe failed')
    fake.vaultSubscribeErrors.set('first', failure)

    expect(() =>
      createWorkflowRepository(fake.host).subscribe(() => undefined),
    ).toThrow(failure)
    expect(fake.pathDisposes).toBe(1)
  })

  it('tracks a root change during initial subscription before subscribing the vault', () => {
    const fake = new MemoryHost('first')
    fake.pathSubscribeHook = () => fake.changeRoot('second')
    const events: string[] = []

    const dispose = createWorkflowRepository(fake.host).subscribe((event) =>
      events.push(event.type),
    )

    fake.emitVault('first', {
      type: 'modify',
      entry: fake.entry('first/file.md')!,
    })
    fake.emitVault('second', {
      type: 'modify',
      entry: fake.entry('second/file.md')!,
    })
    expect(fake.vaultSubscribeCalls).toBe(1)
    expect(events).toEqual(['root-changed', 'vault'])
    dispose()
  })

  it('keeps the old subscription when the new root subscription fails', () => {
    const fake = new MemoryHost('first')
    const failure = new Error('new root subscribe failed')
    fake.vaultSubscribeErrors.set('second', failure)
    const events: string[] = []
    const dispose = createWorkflowRepository(fake.host).subscribe((event) =>
      events.push(event.type),
    )

    expect(() => fake.changeRoot('second')).not.toThrow()
    expect(fake.callbackErrors).toEqual([failure])
    fake.emitVault('first', {
      type: 'modify',
      entry: fake.entry('first/file.md')!,
    })
    expect(events).toEqual(['vault'])
    expect(fake.vaultDisposes).toBe(0)
    fake.vaultSubscribeErrors.delete('second')
    expect(() => fake.changeRoot('second')).not.toThrow()
    expect(events).toEqual(['vault', 'root-changed'])
    dispose()
  })

  it('retries failed disposers without repeating successful cleanup', () => {
    const fake = new MemoryHost('first')
    fake.vaultDisposerFailures.set('first', 1)
    const events: string[] = []
    const dispose = createWorkflowRepository(fake.host).subscribe((event) =>
      events.push(event.type),
    )

    expect(() => fake.changeRoot('second')).not.toThrow()
    expect(events).toEqual(['root-changed'])
    fake.emitVault('first', {
      type: 'modify',
      entry: fake.entry('first/file.md')!,
    })
    fake.emitVault('second', {
      type: 'modify',
      entry: fake.entry('second/file.md')!,
    })
    expect(events).toEqual(['root-changed', 'vault'])
    expect(fake.vaultDisposeAttempts).toBe(1)
    expect(() => dispose()).not.toThrow()
    expect(fake.vaultDisposes).toBe(2)
    expect(fake.vaultDisposeAttempts).toBe(3)
    dispose()
    expect(fake.vaultDisposes).toBe(2)
    expect(fake.vaultDisposeAttempts).toBe(3)
  })

  it('renames a workflow directory with step files first and WORKFLOW.md last', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)
    await repository.create({
      slug: 'demo',
      manifestContent: manifest('Demo'),
      stepFiles: [
        { relativePath: 'steps/input/STEP.md', content: 'input' },
        { relativePath: 'steps/draft/STEP.md', content: 'draft' },
      ],
    })

    await expect(
      repository.renameWorkflow('demo/WORKFLOW.md', 'alpha'),
    ).resolves.toEqual({ ok: true, nextPath: 'alpha/WORKFLOW.md' })

    expect(fake.renameCalls).toEqual([
      'managed/workflows/demo/steps/input/STEP.md -> managed/workflows/alpha/steps/input/STEP.md',
      'managed/workflows/demo/steps/draft/STEP.md -> managed/workflows/alpha/steps/draft/STEP.md',
      'managed/workflows/demo/WORKFLOW.md -> managed/workflows/alpha/WORKFLOW.md',
    ])
    expect(repository.list()).toEqual([
      { path: 'alpha/WORKFLOW.md', title: 'alpha' },
    ])
    expect(fake.files.has('managed/workflows/demo/WORKFLOW.md')).toBe(false)
    expect(fake.files.get('managed/workflows/alpha/WORKFLOW.md')).toBe(
      manifest('Demo'),
    )
    expect(fake.files.get('managed/workflows/alpha/steps/draft/STEP.md')).toBe(
      'draft',
    )
  })

  it('rejects rename when the target slug exists', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)
    await repository.create({
      slug: 'demo',
      manifestContent: manifest(),
      stepFiles: [],
    })
    await repository.create({
      slug: 'alpha',
      manifestContent: manifest(),
      stepFiles: [],
    })

    await expect(
      repository.renameWorkflow('demo/WORKFLOW.md', 'alpha'),
    ).resolves.toEqual({ ok: false, reason: 'target-exists' })
    expect(fake.renameCalls).toEqual([])
  })

  it('rejects invalid slugs and unknown paths before moving anything', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)

    await expect(
      repository.renameWorkflow('demo/WORKFLOW.md', 'a/b'),
    ).resolves.toEqual({ ok: false, reason: 'invalid-slug' })
    await expect(
      repository.renameWorkflow('missing/WORKFLOW.md', 'alpha'),
    ).resolves.toEqual({ ok: false, reason: 'not-found' })
    expect(fake.renameCalls).toEqual([])
  })

  it('compensates by moving files back when a later move fails', async () => {
    const fake = new MemoryHost('managed/workflows')
    const repository = createWorkflowRepository(fake.host)
    await repository.create({
      slug: 'demo',
      manifestContent: manifest('Demo'),
      stepFiles: [
        { relativePath: 'first.md', content: 'first' },
        { relativePath: 'second.md', content: 'second' },
      ],
    })
    fake.renameErrorAtCall = 3

    await expect(
      repository.renameWorkflow('demo/WORKFLOW.md', 'alpha'),
    ).resolves.toEqual({ ok: false, reason: 'failed' })

    expect(fake.renameCalls).toEqual([
      'managed/workflows/demo/first.md -> managed/workflows/alpha/first.md',
      'managed/workflows/demo/second.md -> managed/workflows/alpha/second.md',
      'managed/workflows/alpha/second.md -> managed/workflows/demo/second.md',
      'managed/workflows/alpha/first.md -> managed/workflows/demo/first.md',
    ])
    expect(fake.files.get('managed/workflows/demo/WORKFLOW.md')).toBe(
      manifest('Demo'),
    )
    expect(fake.files.get('managed/workflows/demo/first.md')).toBe('first')
    expect(fake.files.get('managed/workflows/demo/second.md')).toBe('second')
    expect(fake.files.has('managed/workflows/alpha/WORKFLOW.md')).toBe(false)
    expect(fake.folders.has('managed/workflows/alpha')).toBe(false)
  })
})

class MemoryHost {
  readonly files = new Map<string, string>()
  readonly folders = new Set<string>()
  readonly createCalls: string[] = []
  readonly createResults: Array<{ ok: boolean; reason?: string }> = []
  readonly deleteCalls: string[] = []
  readonly trashCalls: string[] = []
  readonly renameCalls: string[] = []
  /** 1-based renamePath call index at which the fake throws. */
  renameErrorAtCall: number | undefined
  private renameCallCount = 0
  trashResult = true
  trashHook: ((path: string) => void) | undefined
  readonly lockNamespaces: string[] = []
  replaceCalls = 0
  vaultSubscribeCalls = 0
  readonly callbackErrors: unknown[] = []
  vaultDisposeAttempts = 0
  statCalls = 0
  replaceResult: { path: string; content: string } | null | undefined
  readError: Error | undefined
  createError: Error | undefined
  createFailurePath: string | undefined
  createFailure: Error | undefined
  createHook: ((path: string) => void) | undefined
  trashError: Error | undefined
  replaceError: Error | undefined
  replaceHook: (() => void) | undefined
  maxConcurrentLocks = 0
  pathDisposes = 0
  vaultDisposes = 0
  private activeLocks = 0
  private lockTail: Promise<void> = Promise.resolve()
  private rootListeners = new Set<() => void>()
  private vaultListeners = new Map<string, Set<(event: VaultEvent) => void>>()
  private root: string
  readSnapshotHook: ((path: string) => void) | undefined
  pathSubscribeError: Error | undefined
  pathDisposerError: Error | undefined
  pathSubscribeHook: (() => void) | undefined
  readonly vaultSubscribeErrors = new Map<string, Error>()
  readonly vaultDisposerFailures = new Map<string, number>()
  readonly createNullPaths = new Set<string>()

  constructor(root: string) {
    this.root = root
    this.folder(root)
  }
  readonly host = {
    paths: {
      getSnapshot: () => ({ contentRoot: this.root }),
      subscribe: (listener: () => void) => {
        if (this.pathSubscribeError) throw this.pathSubscribeError
        this.rootListeners.add(listener)
        this.pathSubscribeHook?.()
        this.pathSubscribeHook = undefined
        return () => {
          if (this.rootListeners.delete(listener)) this.pathDisposes++
          if (this.pathDisposerError) throw this.pathDisposerError
        }
      },
      runExclusive: async <T>(
        namespace: string,
        operation: () => T | PromiseLike<T>,
      ) => {
        const previous = this.lockTail
        let release!: () => void
        this.lockTail = new Promise<void>((resolve) => {
          release = resolve
        })
        await previous
        this.lockNamespaces.push(namespace)
        this.activeLocks++
        this.maxConcurrentLocks = Math.max(
          this.maxConcurrentLocks,
          this.activeLocks,
        )
        try {
          return await operation()
        } finally {
          this.activeLocks--
          release()
        }
      },
    },
    vault: {
      getEntry: (path: string) => this.entry(path),
      listChildren: (folder: string) => this.children(folder),
      exists: async (path: string) =>
        this.files.has(path) || this.folders.has(path),
      stat: async (path: string) => {
        this.statCalls++
        return this.entry(path)
      },
      readText: async (path: string) =>
        this.files.get(path) ?? Promise.reject(new Error('missing')),
      ensureFolder: async (path: string) => {
        this.folder(path)
      },
      createTextIfAbsent: async (path: string, content: string) => {
        this.createHook?.(path)
        this.createHook = undefined
        if (this.createError) throw this.createError
        if (path === this.createFailurePath && this.createFailure)
          throw this.createFailure
        if (this.createNullPaths.has(path)) return null
        if (this.files.has(path)) return null
        this.file(path, content)
        this.createCalls.push(path)
        return { path, content }
      },
      readTextSnapshot: async (path: string) => {
        this.readSnapshotHook?.(path)
        this.readSnapshotHook = undefined
        if (this.readError) throw this.readError
        return this.files.has(path)
          ? { path, content: this.files.get(path)! }
          : null
      },
      replaceTextIfUnchanged: async (
        expected: { path: string; content: string },
        content: string,
      ) => {
        this.replaceHook?.()
        this.replaceHook = undefined
        if (this.replaceError) throw this.replaceError
        this.replaceCalls++
        if (this.replaceResult !== undefined) return this.replaceResult
        if (this.files.get(expected.path) !== expected.content) return null
        this.file(expected.path, content)
        return { path: expected.path, content }
      },
      trashPath: async (path: string) => {
        if (this.trashError) throw this.trashError
        this.trashCalls.push(path)
        this.trashHook?.(path)
        this.trashHook = undefined
        return this.trashResult
      },
      removeFileExact: async (path: string) => {
        this.deleteCalls.push(path)
        return this.files.delete(path)
      },
      renamePath: async (oldPath: string, newPath: string) => {
        this.renameCallCount++
        if (this.renameErrorAtCall === this.renameCallCount)
          throw new Error(`rename failed: ${oldPath}`)
        this.renameCalls.push(`${oldPath} -> ${newPath}`)
        if (!this.files.has(oldPath))
          throw new Error(`Module vault file not found: ${oldPath}`)
        if (this.files.has(newPath) || this.folders.has(newPath))
          throw new Error(`Module vault destination already exists: ${newPath}`)
        const content = this.files.get(oldPath)!
        this.files.delete(oldPath)
        this.file(newPath, content)
      },
      removeEmptyFolderExact: async (path: string) => {
        if (!this.folders.has(path)) return false
        // Mirrors the host: only a folder without direct children is removed.
        if (this.children(path).length > 0) return false
        this.folders.delete(path)
        return true
      },
      subscribe: (scope: string, listener: (event: VaultEvent) => void) => {
        this.vaultSubscribeCalls++
        const subscribeError = this.vaultSubscribeErrors.get(scope)
        if (subscribeError) throw subscribeError
        const listeners =
          this.vaultListeners.get(scope) ??
          new Set<(event: VaultEvent) => void>()
        let subscribed = true
        const wrappedListener = (event: VaultEvent) => {
          if (subscribed) listener(event)
        }
        listeners.add(wrappedListener)
        this.vaultListeners.set(scope, listeners)
        return () => {
          this.vaultDisposeAttempts++
          subscribed = false
          const failures = this.vaultDisposerFailures.get(scope) ?? 0
          if (failures > 0) {
            this.vaultDisposerFailures.set(scope, failures - 1)
            throw new Error(`${scope} vault disposer failed`)
          }
          if (listeners.delete(wrappedListener)) this.vaultDisposes++
        }
      },
    },
  } as unknown as Pick<YoloModuleHostApiV1, 'paths' | 'vault'>

  folder(path: string) {
    for (
      let current = path;
      current;
      current = current.slice(0, current.lastIndexOf('/'))
    )
      this.folders.add(current)
  }
  file(path: string, content: string) {
    this.folder(path.slice(0, path.lastIndexOf('/')))
    this.files.set(path, content)
  }
  delete(path: string) {
    this.deleteCalls.push(path)
    this.files.delete(path)
  }
  entry(path: string) {
    if (this.files.has(path))
      return {
        kind: 'file' as const,
        path,
        name: path.split('/').at(-1)!,
        ctime: 0,
        mtime: 0,
      }
    if (this.folders.has(path))
      return { kind: 'folder' as const, path, name: path.split('/').at(-1)! }
    return null
  }
  children(folder: string) {
    const prefix = `${folder}/`
    return [
      ...new Set(
        [...this.folders, ...this.files.keys()].filter(
          (path) =>
            path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
        ),
      ),
    ]
      .map((path) => this.entry(path)!)
      .filter(Boolean)
  }
  changeRoot(root: string) {
    this.root = root
    this.rootListeners.forEach((listener) => {
      try {
        listener()
      } catch (error) {
        this.callbackErrors.push(error)
      }
    })
  }
  emitVault(scope: string, event: VaultEvent) {
    this.vaultListeners.get(scope)?.forEach((listener) => listener(event))
  }
}
