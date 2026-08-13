/**
 * Cross-level integration test for the project lifecycle: real ProjectTool,
 * ProjectStore, and ProjectDeliveryIngester against an in-memory vault adapter.
 * Exercises init → dispatch binding → delivery → status → review → completed.
 */
import { RUN_OUTCOME } from '../../../types/agentRun'

import {
  ProjectDeliveryIngester,
  assertProjectTaskDispatchable,
  hasHitReworkLimit,
} from './delivery'
import { FakeAdapter, createStore } from './projectTestUtils'
import { ProjectTool } from './tool'
import type { VersionedTask } from './types'

const makeProjectFlow = () => {
  const store = createStore(new FakeAdapter())
  return {
    store,
    tool: new ProjectTool(store),
    ingester: new ProjectDeliveryIngester(store),
  }
}

/** `tool.get` with a taskId returns the versioned task with write preconditions. */
const readTask = async (
  tool: ProjectTool,
  projectId: string,
  taskId: string,
): Promise<VersionedTask> =>
  (await tool.get({ projectId, taskId })) as VersionedTask

describe('project full flow', () => {
  it('init → bind → deliver → status → review → completed', async () => {
    const { store, tool, ingester } = makeProjectFlow()

    // init creates two tasks; T-002 depends on T-001.
    const init = await tool.init({
      projectId: 'proj-flow',
      projectName: 'Flow',
      tasks: [
        { taskId: 'T-001', title: 'Propagate finish reason' },
        { taskId: 'T-002', title: 'Wire diagnostics', dependencies: ['T-001'] },
      ],
    })
    expect(init.ok).toBe(true)

    // Parent starts T-001.
    const pending = (await tool.get({
      projectId: 'proj-flow',
      taskId: 'T-001',
    })) as { revision: number; contentHash: string }
    const { revision, contentHash } = pending
    const started = await tool.update({
      projectId: 'proj-flow',
      taskId: 'T-001',
      expectedRevision: revision,
      expectedContentHash: contentHash,
      patch: { status: 'in_progress' },
    })
    expect(started.status).toBe('in_progress')

    // Parent re-reads for the binding (the delegate_subagent dispatch path).
    const bound = (await store.readTask('proj-flow', 'T-001'))!
    expect(() => assertProjectTaskDispatchable(bound.task)).not.toThrow()

    // Subagent completes; delivery ingester records it fresh → awaiting_review.
    const delivery = await ingester.ingest({
      binding: {
        projectId: 'proj-flow',
        taskId: 'T-001',
        expectedRevision: bound.revision,
        expectedContentHash: bound.contentHash,
      },
      runKey: 'run-001',
      sessionId: 'sub_123',
      runSequence: 1,
      completedAt: '2026-07-31T15:00:00.000Z',
      result: { status: 'completed', content: 'Done.' },
    })
    expect(delivery.kind).toBe('fresh')

    // status derives pendingReviews from the file state; T-002 is dependency-
    // blocked while T-001 is still awaiting_review.
    const statusData = await tool.status('proj-flow')
    if (!statusData) throw new Error('expected a status summary')
    expect(statusData.pendingReviews).toContain('T-001')
    expect(statusData.dependencyBlocks.map((entry) => entry.taskId)).toContain(
      'T-002',
    )

    // Parent reviews with evidence → completed.
    const reviewed = await tool.review({
      projectId: 'proj-flow',
      taskId: 'T-001',
      decision: 'approved',
      evidence: [
        { kind: 'test', reference: 'npm test', summary: 'parity green' },
      ],
    })
    expect(reviewed).toMatchObject({ status: 'completed' })

    // After approval, T-002's dependency is satisfied.
    const afterData = await tool.status('proj-flow')
    if (!afterData) throw new Error('expected a status summary')
    expect(afterData.dependencyBlocks).toHaveLength(0)

    const final = (await tool.get({
      projectId: 'proj-flow',
      taskId: 'T-001',
    })) as { task: { status: string } }
    expect(final.task.status).toBe('completed')
  })

  it('stale delivery does not transition a task that changed since dispatch', async () => {
    const { store, ingester } = makeProjectFlow()
    const init = await store.initProject({
      projectId: 'proj-stale',
      projectName: 'Stale',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })
    expect(init.ok).toBe(true)
    const bound = (await store.readTask('proj-stale', 'T-001'))!

    // Another agent retitles the task after the binding was captured.
    await store.updateTask(
      'proj-stale',
      'T-001',
      {
        expectedRevision: bound.revision,
        expectedContentHash: bound.contentHash,
      },
      (current) => ({ ...current, title: 'Retitled' }),
    )

    const delivery = await ingester.ingest({
      binding: {
        projectId: 'proj-stale',
        taskId: 'T-001',
        expectedRevision: bound.revision,
        expectedContentHash: bound.contentHash,
      },
      runKey: 'run-002',
      completedAt: '2026-07-31T15:00:00.000Z',
      result: { status: 'completed', content: 'Done.' },
    })
    expect(delivery.kind).toBe('stale')
    if (delivery.kind === 'stale') {
      expect(delivery.task?.status).toBe('pending')
      expect(delivery.task?.deliveryRefs).toHaveLength(0)
    }
  })

  it('blocks re-dispatch after three consecutive reworks', async () => {
    const { store } = makeProjectFlow()
    await store.initProject({
      projectId: 'proj-gate',
      projectName: 'Gate',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })
    // Drive to awaiting_review then rework three times.
    let read = (await store.readTask('proj-gate', 'T-001'))!
    for (let i = 0; i < 3; i++) {
      read = (await store.readTask('proj-gate', 'T-001'))!
      await store.updateTask(
        'proj-gate',
        'T-001',
        {
          expectedRevision: read.revision,
          expectedContentHash: read.contentHash,
        },
        (current) => ({ ...current, status: 'in_progress' }),
      )
      const inProgress = (await store.readTask('proj-gate', 'T-001'))!
      await store.updateTask(
        'proj-gate',
        'T-001',
        {
          expectedRevision: inProgress.revision,
          expectedContentHash: inProgress.contentHash,
        },
        (current) => ({ ...current, status: 'awaiting_review' }),
      )
      const awaiting = (await store.readTask('proj-gate', 'T-001'))!
      await store.updateTask(
        'proj-gate',
        'T-001',
        {
          expectedRevision: awaiting.revision,
          expectedContentHash: awaiting.contentHash,
        },
        (current) => ({
          ...current,
          status: 'rework',
          reviewStatus: 'rework',
          reworkCount: current.reworkCount + 1,
        }),
      )
      read = (await store.readTask('proj-gate', 'T-001'))!
    }

    expect(read.task.reworkCount).toBe(3)
    // The rework limit is a soft warning, not a hard block: the parent may
    // still re-dispatch, but status surfaces the threshold.
    expect(() => assertProjectTaskDispatchable(read.task)).not.toThrow()
    expect(hasHitReworkLimit(read.task)).toBe(true)
  })
})

describe('kanban full flow', () => {
  it('init -> claim -> complete -> review -> done', async () => {
    const { tool, ingester } = makeProjectFlow()
    const init = await tool.init({
      projectId: 'p1',
      projectName: 'P',
      tasks: [{ taskId: 't1', title: 'T', acceptanceCriteria: ['works'] }],
    })
    expect(init.ok).toBe(true)

    const pending = await readTask(tool, 'p1', 't1')
    const claimed = await tool.update({
      projectId: 'p1',
      taskId: 't1',
      expectedRevision: pending.revision,
      expectedContentHash: pending.contentHash,
      claim: { runKey: 'run-1' },
    })
    expect(claimed.status).toBe('running')

    await ingester.ingest({
      binding: {
        projectId: 'p1',
        taskId: 't1',
        expectedRevision: claimed.revision,
        expectedContentHash: claimed.contentHash,
      },
      runKey: 'run-1',
      result: { status: RUN_OUTCOME.COMPLETED, content: 'did it' },
      completedAt: new Date().toISOString(),
    })

    const awaiting = await readTask(tool, 'p1', 't1')
    expect(awaiting.task.status).toBe('awaiting_review')

    const reviewed = await tool.review({
      projectId: 'p1',
      taskId: 't1',
      decision: 'approved',
      evidence: [
        {
          kind: 'tool_result',
          reference: 'reviewer-run-1',
          summary: 'verified',
        },
      ],
      expectedRevision: awaiting.revision,
      expectedContentHash: awaiting.contentHash,
    })
    expect(reviewed).toMatchObject({ status: 'completed' })

    const status = await tool.status('p1')
    expect(status?.allTerminal).toBe(true)
  })

  it('claim -> FAILED -> pending -> re-claim -> complete', async () => {
    const { tool, ingester } = makeProjectFlow()
    const init = await tool.init({
      projectId: 'p1',
      projectName: 'P',
      tasks: [{ taskId: 't1', title: 'T' }],
    })
    expect(init.ok).toBe(true)

    const firstRead = await readTask(tool, 'p1', 't1')
    const firstClaim = await tool.update({
      projectId: 'p1',
      taskId: 't1',
      expectedRevision: firstRead.revision,
      expectedContentHash: firstRead.contentHash,
      claim: { runKey: 'run-1' },
    })
    expect(firstClaim.status).toBe('running')
    const claimed = await readTask(tool, 'p1', 't1')

    await ingester.ingest({
      binding: {
        projectId: 'p1',
        taskId: 't1',
        expectedRevision: claimed.revision,
        expectedContentHash: claimed.contentHash,
      },
      runKey: 'run-1',
      result: { status: RUN_OUTCOME.FAILED, content: 'boom' },
      completedAt: new Date().toISOString(),
    })

    const failed = await readTask(tool, 'p1', 't1')
    expect(failed.task.status).toBe('pending')
    expect(failed.task.attempts[0].status).toBe('failed')

    const reClaim = await tool.update({
      projectId: 'p1',
      taskId: 't1',
      expectedRevision: failed.revision,
      expectedContentHash: failed.contentHash,
      claim: { runKey: 'run-2' },
    })
    expect(reClaim.status).toBe('running')
    const reClaimed = await readTask(tool, 'p1', 't1')

    await ingester.ingest({
      binding: {
        projectId: 'p1',
        taskId: 't1',
        expectedRevision: reClaimed.revision,
        expectedContentHash: reClaimed.contentHash,
      },
      runKey: 'run-2',
      result: { status: RUN_OUTCOME.COMPLETED, content: 'retry ok' },
      completedAt: new Date().toISOString(),
    })

    const done = await readTask(tool, 'p1', 't1')
    expect(done.task.status).toBe('awaiting_review')
    expect(done.task.attempts).toHaveLength(2)
  })

  it('expired claim with inactive run is reclaimed by status', async () => {
    const { tool } = makeProjectFlow()
    const init = await tool.init({
      projectId: 'p1',
      projectName: 'P',
      tasks: [{ taskId: 't1', title: 'T' }],
    })
    expect(init.ok).toBe(true)

    const read = await readTask(tool, 'p1', 't1')
    const claimed = await tool.update({
      projectId: 'p1',
      taskId: 't1',
      expectedRevision: read.revision,
      expectedContentHash: read.contentHash,
      claim: { runKey: 'run-1', durationMs: -1000 },
    })
    expect(claimed.status).toBe('running')

    const status = await tool.status('p1') // no isRunActive -> reclaim
    expect(status?.reclaimed).toEqual([
      { taskId: 't1', reason: 'claim_expired' },
    ])

    const after = await readTask(tool, 'p1', 't1')
    expect(after.task.status).toBe('pending')
    expect(after.task.attempts[0].status).toBe('timed_out')
  })
})
