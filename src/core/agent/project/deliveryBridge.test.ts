import { RUN_OUTCOME } from '../../../types/agentRun'
import type { BackgroundTaskCompletedEvent } from '../background-task/completion-bus'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import type { SubagentTaskCompletionRecord } from '../subagent/types'

import { ProjectDeliveryBridge } from './deliveryBridge'
import { FakeAdapter } from './projectTestUtils'
import { ProjectStore } from './store'
import type { ProjectTaskBinding } from './types'

const defaultSettings = {} as never

const binding: ProjectTaskBinding = {
  projectId: 'proj-1',
  taskId: 'T-001',
  expectedRevision: 2,
  expectedContentHash: 'placeholder',
}

const completion = (
  overrides: Partial<SubagentTaskCompletionRecord> = {},
): BackgroundTaskCompletedEvent => ({
  kind: 'subagent',
  taskId: 'sub_1',
  conversationId: 'conv-1',
  record: {
    taskId: 'sub_1',
    conversationId: 'conv-1',
    source: {
      type: 'llm_tool_call',
      toolCallId: 'tool-1',
      assistantMessageId: 'msg-1',
    },
    title: 'Test subagent',
    status: 'completed',
    createdAt: 0,
    completedAt: Date.now(),
    prompt: 'do the task',
    runKey: 'run-001',
    sessionId: 'sub_1',
    runSequence: 1,
    projectTask: binding,
    result: {
      taskId: 'sub_1',
      status: 'completed',
      content: 'Finished.',
      durationMs: 100,
      toolUseCount: 2,
    },
    ...overrides,
  } as SubagentTaskCompletionRecord,
})

const waitForTaskStatus = async (
  store: ProjectStore,
  status: string,
): Promise<Awaited<ReturnType<ProjectStore['readTask']>>> => {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const read = await store.readTask('proj-1', 'T-001')
    if (read?.task.status === status) return read
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return await store.readTask('proj-1', 'T-001')
}

describe('ProjectDeliveryBridge', () => {
  it('ingests a bound subagent completion into a fresh delivery', async () => {
    const adapter = new FakeAdapter()
    const store = new ProjectStore({ getSettings: () => defaultSettings, adapter })
    const init = await store.initProject({
      projectId: 'proj-1',
      projectName: 'P',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })
    expect(init.ok).toBe(true)

    // Advance T-001 to in_progress and capture the binding.
    const pending = (await store.readTask('proj-1', 'T-001'))!
    await store.updateTask(
      'proj-1',
      'T-001',
      { expectedRevision: pending.revision, expectedContentHash: pending.contentHash },
      (current) => ({ ...current, status: 'in_progress' }),
    )
    const bound = (await store.readTask('proj-1', 'T-001'))!

    const bridge = new ProjectDeliveryBridge({
      getSettings: () => defaultSettings,
      adapter,
    })
    bridge.start()
    try {
      backgroundTaskCompletionBus.pushCompleted(
        completion({
          projectTask: {
            projectId: 'proj-1',
            taskId: 'T-001',
            expectedRevision: bound.revision,
            expectedContentHash: bound.contentHash,
          },
        }),
      )
      const after = await waitForTaskStatus(store, 'awaiting_review')
      expect(after?.task.status).toBe('awaiting_review')
      expect(after?.task.deliveryRefs).toContain('deliverables/T-001/run-001.md')
      expect(
        await store.readDeliveryArtifact('proj-1', 'T-001', 'run-001'),
      ).toContain('Finished.')
    } finally {
      bridge.stop()
    }
  })

  it('passes a failed subagent outcome through and returns the task to pending', async () => {
    const adapter = new FakeAdapter()
    const store = new ProjectStore({ getSettings: () => defaultSettings, adapter })
    await store.initProject({
      projectId: 'proj-1',
      projectName: 'P',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })

    // Claim T-001 so the run is recorded as a running attempt.
    const pending = (await store.readTask('proj-1', 'T-001'))!
    await store.claimTask(
      'proj-1',
      'T-001',
      { expectedRevision: pending.revision, expectedContentHash: pending.contentHash },
      { runKey: 'run-002' },
    )
    const bound = (await store.readTask('proj-1', 'T-001'))!

    const bridge = new ProjectDeliveryBridge({
      getSettings: () => defaultSettings,
      adapter,
    })
    bridge.start()
    try {
      backgroundTaskCompletionBus.pushCompleted(
        completion({
          runKey: 'run-002',
          projectTask: {
            projectId: 'proj-1',
            taskId: 'T-001',
            expectedRevision: bound.revision,
            expectedContentHash: bound.contentHash,
          },
          result: {
            taskId: 'sub_1',
            status: RUN_OUTCOME.FAILED,
            content: 'boom',
            durationMs: 100,
            toolUseCount: 2,
          },
        }),
      )
      const after = await waitForTaskStatus(store, 'pending')
      expect(after?.task.status).toBe('pending')
      expect(after?.task.claim).toBeUndefined()
      expect(after?.task.attempts[0].status).toBe('failed')
      expect(after?.task.attempts[0].error).toBe('boom')
    } finally {
      bridge.stop()
    }
  })

  it('ignores non-subagent and unbound completions', async () => {
    const adapter = new FakeAdapter()
    const store = new ProjectStore({ getSettings: () => defaultSettings, adapter })
    await store.initProject({
      projectId: 'proj-1',
      projectName: 'P',
      tasks: [{ taskId: 'T-001', title: 'First' }],
    })
    const bridge = new ProjectDeliveryBridge({
      getSettings: () => defaultSettings,
      adapter,
    })
    bridge.start()
    try {
      backgroundTaskCompletionBus.pushCompleted({
        kind: 'terminal_command',
        taskId: 'bash-1',
        conversationId: 'conv-1',
        record: {} as never,
      })
      backgroundTaskCompletionBus.pushCompleted(
        completion({ projectTask: undefined }),
      )
      await new Promise((resolve) => setTimeout(resolve, 0))

      const task = (await store.readTask('proj-1', 'T-001'))!
      expect(task.task.deliveryRefs).toHaveLength(0)
    } finally {
      bridge.stop()
    }
  })
})
