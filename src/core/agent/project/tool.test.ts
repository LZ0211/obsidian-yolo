import type { ProjectStore } from './store'
import { ProjectTool } from './tool'
import { createStore, initSimpleProject } from './projectTestUtils'

const makeTool = () => {
  const store = createStore()
  return { store, tool: new ProjectTool(store) }
}

describe('ProjectTool', () => {
  it('init creates a project', async () => {
    const { tool } = makeTool()
    const result = await tool.init({
      projectId: 'proj-x',
      projectName: 'Project X',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      // Project-level status/revision were removed from project.md: they were
      // frozen at init and never truthful.
      expect(result.project).toMatchObject({
        projectId: 'proj-x',
        projectName: 'Project X',
      })
      expect(result.project).not.toHaveProperty('status')
      expect(result.project).not.toHaveProperty('revision')
    }
  })

  it('get without taskId lists and filters by status', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)

    const all = (await tool.get({ projectId: 'proj-1' })) as {
      tasks: unknown[]
    }
    expect(all.tasks).toHaveLength(1)

    const none = (await tool.get({
      projectId: 'proj-1',
      status: ['completed'],
    })) as { tasks: unknown[] }
    expect(none.tasks).toHaveLength(0)
  })

  it('get with taskId returns the versioned task with preconditions', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)

    const data = (await tool.get({
      projectId: 'proj-1',
      taskId: 'T-001',
    })) as { revision: number; contentHash: string; task: { status: string } }
    expect(data.revision).toBe(1)
    expect(data.contentHash).toEqual(expect.any(String))
    expect(data.task.status).toBe('pending')
  })

  it('update applies a patch and reports the new revision', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)

    const read = (await tool.get({
      projectId: 'proj-1',
      taskId: 'T-001',
    })) as { revision: number; contentHash: string }
    const { revision, contentHash } = read

    const updated = await tool.update({
      projectId: 'proj-1',
      taskId: 'T-001',
      expectedRevision: revision,
      expectedContentHash: contentHash,
      patch: { status: 'in_progress' },
    })
    expect(updated).toMatchObject({
      projectId: 'proj-1',
      taskId: 'T-001',
      status: 'in_progress',
      revision: revision + 1,
    })
  })

  it('update rejects a stale precondition as a conflict', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)

    const read = (await tool.get({
      projectId: 'proj-1',
      taskId: 'T-001',
    })) as { revision: number; contentHash: string }
    const { revision, contentHash } = read

    // First update advances the task.
    const first = await tool.update({
      projectId: 'proj-1',
      taskId: 'T-001',
      expectedRevision: revision,
      expectedContentHash: contentHash,
      patch: { status: 'in_progress' },
    })
    expect(first.status).toBe('in_progress')

    // Same preconditions are now stale; `update` surfaces the conflict as an
    // error (matching `review`) instead of a "Success with ok:false" payload.
    await expect(
      tool.update({
        projectId: 'proj-1',
        taskId: 'T-001',
        expectedRevision: revision,
        expectedContentHash: contentHash,
        patch: { status: 'blocked' },
      }),
    ).rejects.toThrow(/conflict/i)
  })

  it('update with claim claims the task and reports running', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)

    const read = (await tool.get({
      projectId: 'proj-1',
      taskId: 'T-001',
    })) as { revision: number; contentHash: string }
    const { revision, contentHash } = read

    const claimed = await tool.update({
      projectId: 'proj-1',
      taskId: 'T-001',
      expectedRevision: revision,
      expectedContentHash: contentHash,
      claim: { runKey: 'run-1' },
    })
    expect(claimed).toMatchObject({
      projectId: 'proj-1',
      taskId: 'T-001',
      status: 'running',
      revision: revision + 1,
    })
    const after = await store.readTask('proj-1', 'T-001')
    expect(after?.task.claim?.runKey).toBe('run-1')
    expect(after?.task.attempts[0].status).toBe('running')
  })

  it('update patch sets blockReason when transitioning to blocked', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)

    const read = (await tool.get({
      projectId: 'proj-1',
      taskId: 'T-001',
    })) as { revision: number; contentHash: string }
    const { revision, contentHash } = read

    const updated = await tool.update({
      projectId: 'proj-1',
      taskId: 'T-001',
      expectedRevision: revision,
      expectedContentHash: contentHash,
      patch: {
        status: 'blocked',
        blockReason: { kind: 'needs_input', detail: 'blocked via tool' },
      },
    })
    expect(updated).toMatchObject({ status: 'blocked' })
    const after = await store.readTask('proj-1', 'T-001')
    expect(after?.task.blockReason).toEqual({
      kind: 'needs_input',
      detail: 'blocked via tool',
    })
    expect(after?.task.blockRecurrences).toBe(1)
  })

  it('update patch accepts the canonical block_reason field name (schema-parity)', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)

    const read = (await tool.get({
      projectId: 'proj-1',
      taskId: 'T-001',
    })) as { revision: number; contentHash: string }
    const { revision, contentHash } = read

    // The model-facing schema advertises `patch.block_reason`; a model that
    // follows the schema must be able to block a task without the handler
    // rejecting it ("blocked requires blockReason").
    const updated = await tool.update({
      projectId: 'proj-1',
      taskId: 'T-001',
      expectedRevision: revision,
      expectedContentHash: contentHash,
      patch: {
        status: 'blocked',
        block_reason: { kind: 'dependency', detail: 'waiting on T-002' },
      },
    })
    expect(updated).toMatchObject({ status: 'blocked' })
    const after = await store.readTask('proj-1', 'T-001')
    expect(after?.task.blockReason).toEqual({
      kind: 'dependency',
      detail: 'waiting on T-002',
    })
    expect(after?.task.blockRecurrences).toBe(1)
  })

  it('update patch prefers block_reason over the legacy blockReason alias', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)

    const read = (await tool.get({
      projectId: 'proj-1',
      taskId: 'T-001',
    })) as { revision: number; contentHash: string }
    const { revision, contentHash } = read

    const updated = await tool.update({
      projectId: 'proj-1',
      taskId: 'T-001',
      expectedRevision: revision,
      expectedContentHash: contentHash,
      patch: {
        status: 'blocked',
        block_reason: { kind: 'capability' },
        blockReason: { kind: 'transient' },
      },
    })
    expect(updated).toMatchObject({ status: 'blocked' })
    const after = await store.readTask('proj-1', 'T-001')
    expect(after?.task.blockReason).toEqual({ kind: 'capability' })
  })

  it('status returns derived counts and dependency blocks', async () => {
    const { store, tool } = makeTool()
    const result = await store.initProject({
      projectId: 'proj-dep',
      projectName: 'Dep',
      tasks: [
        { taskId: 'T-001', title: 'First' },
        { taskId: 'T-002', title: 'Second', dependencies: ['T-001'] },
      ],
    })
    expect(result.ok).toBe(true)

    const status = await tool.status('proj-dep')
    expect(status?.counts.pending).toBe(2)
    expect(status?.dependencyBlocks).toHaveLength(1)
  })

  it('review approves an awaiting_review task to completed', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)
    await advanceToAwaitingReview(store)

    const result = await tool.review({
      projectId: 'proj-1',
      taskId: 'T-001',
      decision: 'approved',
      evidence: [
        {
          kind: 'test',
          reference: 'npm run test',
          summary: 'All parity tests pass.',
        },
      ],
    })
    expect(result).toMatchObject({ status: 'completed' })
  })

  it('review rejects approval without evidence', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)
    await advanceToAwaitingReview(store)

    await expect(
      tool.review({
        projectId: 'proj-1',
        taskId: 'T-001',
        decision: 'approved',
        evidence: [],
      }),
    ).rejects.toThrow(/evidence/i)
  })

  it('review rejects rework without comments', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)
    await advanceToAwaitingReview(store)

    await expect(
      tool.review({
        projectId: 'proj-1',
        taskId: 'T-001',
        decision: 'rework',
        comments: [],
      }),
    ).rejects.toThrow(/comment/i)
  })

  it('review rejects reviewing a task that is not awaiting_review', async () => {
    const { store, tool } = makeTool()
    await initSimpleProject(store)

    await expect(
      tool.review({
        projectId: 'proj-1',
        taskId: 'T-001',
        decision: 'approved',
        evidence: [{ kind: 'file', reference: 'a.ts', summary: 'checked' }],
      }),
    ).rejects.toThrow(/awaiting_review/i)
  })
})

const advanceToAwaitingReview = async (store: ProjectStore) => {
  const pending = (await store.readTask('proj-1', 'T-001'))!
  const inProgress = await store.updateTask(
    'proj-1',
    'T-001',
    { expectedRevision: pending.revision, expectedContentHash: pending.contentHash },
    (current) => ({ ...current, status: 'in_progress' }),
  )
  if (!inProgress.ok) throw new Error('failed to advance to in_progress')
  const current = (await store.readTask('proj-1', 'T-001'))!
  const awaiting = await store.updateTask(
    'proj-1',
    'T-001',
    { expectedRevision: current.revision, expectedContentHash: current.contentHash },
    (task) => ({ ...task, status: 'awaiting_review' }),
  )
  if (!awaiting.ok) throw new Error('failed to advance to awaiting_review')
}
