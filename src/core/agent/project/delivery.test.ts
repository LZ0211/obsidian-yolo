import { RUN_OUTCOME } from '../../../types/agentRun'

import {
  ProjectDeliveryIngester,
  assertProjectTaskDispatchable,
  hasHitReworkLimit,
} from './delivery'
import { FakeAdapter, createStore, initSimpleProject } from './projectTestUtils'
import type { TaskRecord, VersionedTask } from './types'

const makeIngester = () => {
  const store = createStore()
  return { store, adapter: new FakeAdapter(), ingester: new ProjectDeliveryIngester(store) }
}

const delivery = (binding: Parameters<ProjectDeliveryIngester['ingest']>[0]['binding']) => ({
  binding,
  runKey: 'run-abc',
  sessionId: 'sub_123',
  runSequence: 1,
  completedAt: '2026-07-31T15:00:00.000Z',
  result: { status: 'completed', content: 'Finished the finish-reason propagation.' },
})

const makeProjectWithTask = async (store: ReturnType<typeof createStore>) => {
  const r = await store.initProject({
    projectId: 'p1',
    projectName: 'P',
    tasks: [{ taskId: 't1', title: 'T' }],
  })
  if (!r.ok) throw new Error('setup failed')
}

const preconditionOf = (v: VersionedTask | null) => {
  if (!v) throw new Error('expected a task read')
  return { expectedRevision: v.revision, expectedContentHash: v.contentHash }
}

describe('ProjectDeliveryIngester', () => {
  it('records a fresh delivery and transitions the task to awaiting_review', async () => {
    const { store, ingester } = makeIngester()
    await initSimpleProject(store)

    // Claim T-001 so a running attempt exists to terminalize on completion.
    const pending = (await store.readTask('proj-1', 'T-001'))!
    await store.claimTask(
      'proj-1',
      'T-001',
      preconditionOf(pending),
      { runKey: 'run-abc' },
    )
    const bound = (await store.readTask('proj-1', 'T-001'))!

    const result = await ingester.ingest(
      delivery({
        projectId: 'proj-1',
        taskId: 'T-001',
        expectedRevision: bound.revision,
        expectedContentHash: bound.contentHash,
      }),
    )

    expect(result.kind).toBe('fresh')
    if (result.kind === 'fresh') {
      expect(result.task.status).toBe('awaiting_review')
      expect(result.task.claim).toBeUndefined()
      expect(result.task.deliveryRefs).toContain('deliverables/T-001/run-abc.md')
      expect(result.task.attempts).toHaveLength(1)
      expect(result.task.attempts[0].status).toBe('done')
    }
    expect(
      await store.readDeliveryArtifact('proj-1', 'T-001', 'run-abc'),
    ).toContain('Finished the finish-reason propagation.')
  })

  it('classifies a replay against the original binding as stale', async () => {
    const { store, ingester } = makeIngester()
    await initSimpleProject(store)
    const pending = (await store.readTask('proj-1', 'T-001'))!
    await store.updateTask(
      'proj-1',
      'T-001',
      { expectedRevision: pending.revision, expectedContentHash: pending.contentHash },
      (current) => ({ ...current, status: 'in_progress' }),
    )
    const bound = (await store.readTask('proj-1', 'T-001'))!

    const first = await ingester.ingest(
      delivery({
        projectId: 'proj-1',
        taskId: 'T-001',
        expectedRevision: bound.revision,
        expectedContentHash: bound.contentHash,
      }),
    )
    expect(first.kind).toBe('fresh')

    // Same binding, replayed: the task advanced, so it is now stale.
    const replay = await ingester.ingest(
      delivery({
        projectId: 'proj-1',
        taskId: 'T-001',
        expectedRevision: bound.revision,
        expectedContentHash: bound.contentHash,
      }),
    )
    expect(replay.kind).toBe('stale')
    if (replay.kind === 'stale') {
      expect(replay.task?.deliveryRefs).toHaveLength(1)
    }
  })

  it('records a stale delivery when the task changed since dispatch', async () => {
    const { store, ingester } = makeIngester()
    await initSimpleProject(store)
    const bound = (await store.readTask('proj-1', 'T-001'))!

    // Task advanced (user/parent edit) after the binding was captured.
    await store.updateTask(
      'proj-1',
      'T-001',
      { expectedRevision: bound.revision, expectedContentHash: bound.contentHash },
      (current) => ({ ...current, title: 'Retitled by another agent' }),
    )

    const result = await ingester.ingest(
      delivery({
        projectId: 'proj-1',
        taskId: 'T-001',
        expectedRevision: bound.revision,
        expectedContentHash: bound.contentHash,
      }),
    )
    expect(result.kind).toBe('stale')
    if (result.kind === 'stale') {
      expect(result.task?.status).toBe('pending')
      expect(result.task?.deliveryRefs).toHaveLength(0)
    }
    expect(
      await store.readDeliveryArtifact('proj-1', 'T-001', 'run-abc'),
    ).toContain('classification: stale')
  })
})

describe('ingest outcomes', () => {
  it('failed outcome returns the task to pending and records a failed attempt', async () => {
    const store = createStore()
    const ingester = new ProjectDeliveryIngester(store)
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    await store.claimTask('p1', 't1', preconditionOf(read), { runKey: 'run-1' })
    const claimed = await store.readTask('p1', 't1')
    const result = await ingester.ingest({
      binding: {
        projectId: 'p1',
        taskId: 't1',
        expectedRevision: claimed?.revision ?? 0,
        expectedContentHash: claimed?.contentHash ?? '',
      },
      runKey: 'run-1',
      result: { status: RUN_OUTCOME.FAILED, content: 'boom' },
      completedAt: new Date().toISOString(),
    })
    expect(result.kind).toBe('fresh')
    const after = await store.readTask('p1', 't1')
    expect(after?.task.status).toBe('pending')
    expect(after?.task.claim).toBeUndefined()
    expect(after?.task.attempts[0].status).toBe('failed')
    expect(after?.task.attempts[0].error).toBe('boom')
  })

  it('aborted outcome records a crashed attempt and returns to pending', async () => {
    const store = createStore()
    const ingester = new ProjectDeliveryIngester(store)
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    await store.claimTask('p1', 't1', preconditionOf(read), { runKey: 'run-1' })
    const claimed = await store.readTask('p1', 't1')
    const result = await ingester.ingest({
      binding: {
        projectId: 'p1',
        taskId: 't1',
        expectedRevision: claimed?.revision ?? 0,
        expectedContentHash: claimed?.contentHash ?? '',
      },
      runKey: 'run-1',
      result: { status: RUN_OUTCOME.ABORTED, content: 'cancelled mid-run' },
      completedAt: new Date().toISOString(),
    })
    expect(result.kind).toBe('fresh')
    const after = await store.readTask('p1', 't1')
    expect(after?.task.status).toBe('pending')
    expect(after?.task.claim).toBeUndefined()
    expect(after?.task.attempts[0].status).toBe('crashed')
    expect(after?.task.attempts[0].error).toBe('cancelled mid-run')
  })

  it('appends a terminal attempt when the run was never claimed', async () => {
    const store = createStore()
    const ingester = new ProjectDeliveryIngester(store)
    await makeProjectWithTask(store)
    const pending = await store.readTask('p1', 't1')
    const completedAt = '2026-08-02T09:00:00.000Z'
    const result = await ingester.ingest({
      binding: {
        projectId: 'p1',
        taskId: 't1',
        expectedRevision: pending?.revision ?? 0,
        expectedContentHash: pending?.contentHash ?? '',
      },
      runKey: 'run-1',
      result: { status: RUN_OUTCOME.COMPLETED, content: 'done without a claim' },
      completedAt,
    })
    expect(result.kind).toBe('fresh')
    const after = await store.readTask('p1', 't1')
    // An unclaimed completed run still lands the task in review: pending ->
    // awaiting_review is a legal transition (regression guard — the task used
    // to stay pending forever because the transition was missing).
    expect(after?.task.status).toBe('awaiting_review')
    expect(after?.task.attempts).toHaveLength(1)
    expect(after?.task.attempts[0].runKey).toBe('run-1')
    expect(after?.task.attempts[0].status).toBe('done')
    expect(after?.task.attempts[0].completedAt).toBe(completedAt)
    expect(after?.task.attempts[0].result).toBe('done without a claim')
    expect(after?.task.deliveryRefs).toContain('deliverables/t1/run-1.md')
  })

  it('completed ingest on a claimed running task clears the claim and terminalizes the single attempt', async () => {
    const store = createStore()
    const ingester = new ProjectDeliveryIngester(store)
    await makeProjectWithTask(store)
    const read = await store.readTask('p1', 't1')
    await store.claimTask('p1', 't1', preconditionOf(read), { runKey: 'run-1' })
    const claimed = await store.readTask('p1', 't1')
    const completedAt = '2026-08-01T10:00:00.000Z'
    const result = await ingester.ingest({
      binding: {
        projectId: 'p1',
        taskId: 't1',
        expectedRevision: claimed?.revision ?? 0,
        expectedContentHash: claimed?.contentHash ?? '',
      },
      runKey: 'run-1',
      result: { status: RUN_OUTCOME.COMPLETED, content: 'done' },
      completedAt,
    })
    expect(result.kind).toBe('fresh')
    const after = await store.readTask('p1', 't1')
    expect(after?.task.status).toBe('awaiting_review')
    expect(after?.task.claim).toBeUndefined()
    expect(after?.task.attempts).toHaveLength(1)
    expect(after?.task.attempts[0].status).toBe('done')
    expect(after?.task.attempts[0].completedAt).toBe(completedAt)
    expect(after?.task.deliveryRefs).toContain('deliverables/t1/run-1.md')
  })
})

describe('assertProjectTaskDispatchable', () => {
  const makeTask = (overrides: Partial<TaskRecord> = {}): TaskRecord => ({
    schemaVersion: 2,
    projectId: 'proj-1',
    taskId: 'T-001',
    revision: 1,
    title: 'Task',
    status: 'pending',
    assignee: 'parent',
    dependencies: [],
    acceptanceCriteria: [],
    priority: 'medium',
    reviewStatus: null,
    reworkCount: 0,
    deliveryRefs: [],
    attempts: [],
    blockRecurrences: 0,
    createdAt: '2026-07-31T09:00:00.000Z',
    updatedAt: '2026-07-31T09:00:00.000Z',
    ...overrides,
  })

  it('allows an open task under the rework limit', () => {
    expect(() => assertProjectTaskDispatchable(makeTask())).not.toThrow()
  })

  it('blocks terminal tasks', () => {
    expect(() =>
      assertProjectTaskDispatchable(makeTask({ status: 'completed' })),
    ).toThrow(/cannot be dispatched/i)
  })

  it('warns but does not block re-dispatch after three consecutive reworks', () => {
    const task = makeTask({ status: 'rework', reworkCount: 3 })
    expect(() => assertProjectTaskDispatchable(task)).not.toThrow()
    expect(hasHitReworkLimit(task)).toBe(true)
  })
})
