/**
 * Migration Task 4 e2e test: the full delegate_subagent -> delivery chain.
 *
 * Path 1 (tool chain): a real `executeBuiltinTool` dispatch of
 * `delegate_subagent` carrying a full projectTask binding. runSubagent is
 * mocked so the dispatch params can be captured; the test asserts the binding
 * chain from T2 Step 6b actually forwarded the resolved binding and the
 * composed implementer prompt (task title/body + acceptance criteria) into
 * the subagent run. If the binding wiring is removed this test fails.
 *
 * Path 2 (bridge chain): a full subagent completion record (projectTask +
 * sessionId/runKey/runSequence) pushed onto the background completion bus
 * flows through the real ProjectDeliveryBridge into the real ProjectStore on
 * a FakeAdapter: pending -> awaiting_review plus a durable delivery artifact,
 * and a failed outcome returns the task to pending. If the bridge is not
 * wired the task state never changes.
 */
jest.mock('../subagent/runner', () => ({
  runSubagent: jest.fn().mockResolvedValue({
    accepted: true,
    taskId: 'sub_e2e',
    title: 'E2E',
    status: 'running',
    note: 'accepted',
    modelName: 'mock',
  }),
}))

import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import { RUN_OUTCOME } from '../../../types/agentRun'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { executeBuiltinTool } from '../../tools/dispatcher'
import { backgroundTaskCompletionBus } from '../background-task/completion-bus'
import type { BackgroundTaskCompletedEvent } from '../background-task/completion-bus'
import { runSubagent } from '../subagent/runner'
import type {
  SubagentTaskCompletionRecord,
  SubagentTaskRecord,
} from '../subagent/types'

import { ProjectDeliveryBridge } from './deliveryBridge'
import { FakeAdapter } from './projectTestUtils'
import { ProjectStore } from './store'
import type { ProjectTaskBinding } from './types'

const buildSettings = (): YoloSettings =>
  ({
    providers: [
      {
        id: 'openai',
        presetType: 'openai',
        apiType: 'openai-compatible',
        apiKey: 'token',
      },
    ],
    chatModelId: 'openai/gpt-5',
    chatModels: [
      {
        id: 'openai/gpt-5',
        providerId: 'openai',
        model: 'gpt-5',
        enable: true,
      },
      {
        id: 'openai/gpt-4.1-mini',
        providerId: 'openai',
        model: 'gpt-4.1-mini',
        enable: true,
      },
    ],
    mcp: {
      servers: [],
      enableToolDisclosure: false,
      builtinCapabilityOptions: {
        subagent_delegation: {
          allowedModelIds: ['openai/gpt-5', 'openai/gpt-4.1-mini'],
          preferredModelId: 'openai/gpt-4.1-mini',
        },
      },
    },
  }) as unknown as YoloSettings

/** Seeds a project with one task and returns the store + adapter. */
const seedProject = async (projectId: string, taskId: string) => {
  const adapter = new FakeAdapter()
  const settings = buildSettings()
  const store = new ProjectStore({ getSettings: () => settings, adapter })
  const init = await store.initProject({
    projectId,
    projectName: 'E2E',
    tasks: [
      {
        taskId,
        title: 'Implement the thing',
        acceptanceCriteria: ['works on mobile'],
      },
    ],
  })
  expect(init.ok).toBe(true)
  return { adapter, settings, store }
}

/**
 * pending -> in_progress without a claim (the parent marks the task as being
 * worked on; the runner never claims — claiming is a separate project_ops
 * `update` the parent may or may not issue before dispatch) and re-reads the
 * binding.
 */
const advanceToInProgress = async (
  store: ProjectStore,
  projectId: string,
  taskId: string,
): Promise<ProjectTaskBinding> => {
  const pending = (await store.readTask(projectId, taskId))!
  const moved = await store.updateTask(
    projectId,
    taskId,
    {
      expectedRevision: pending.revision,
      expectedContentHash: pending.contentHash,
    },
    (current) => ({ ...current, status: 'in_progress' }),
  )
  expect(moved.ok).toBe(true)
  const bound = (await store.readTask(projectId, taskId))!
  return {
    projectId,
    taskId,
    expectedRevision: bound.revision,
    expectedContentHash: bound.contentHash,
  }
}

/**
 * A complete subagent completion record shaped exactly like the runner's
 * registry projection plus the T2 Step 8 parity fields. The full
 * SubagentTaskRecord (with abortController) is built so the e2e contract is
 * literal; the abortController is stripped on push because the completion
 * event carries the registry-facing projection.
 */
const buildCompletionRecord = (
  overrides: Partial<SubagentTaskRecord>,
): { event: BackgroundTaskCompletedEvent; record: SubagentTaskRecord } => {
  const record: SubagentTaskRecord = {
    taskId: 'sub_e2e_1',
    conversationId: 'conv-1',
    source: {
      type: 'llm_tool_call',
      toolCallId: 'tool-1',
      assistantMessageId: 'msg-1',
    },
    title: 'Implement',
    status: 'completed',
    createdAt: 0,
    completedAt: Date.now(),
    prompt: 'Make it work',
    runKey: 'run-001',
    sessionId: 'sub_e2e_1',
    runSequence: 1,
    projectTask: {
      projectId: 'e2e-proj',
      taskId: 'T-001',
      expectedRevision: 2,
      expectedContentHash: 'hash',
    },
    result: {
      taskId: 'sub_e2e_1',
      status: 'completed',
      content: 'Finished.',
      durationMs: 100,
      toolUseCount: 1,
    },
    abortController: new AbortController(),
    ...overrides,
  }
  const { abortController: _abortController, ...projection } = record
  const completionRecord = projection as SubagentTaskCompletionRecord
  return {
    record,
    event: {
      kind: 'subagent',
      taskId: record.taskId,
      conversationId: record.conversationId,
      record: completionRecord,
    },
  }
}

const waitForTaskStatus = async (
  store: ProjectStore,
  projectId: string,
  taskId: string,
  status: string,
): Promise<Awaited<ReturnType<ProjectStore['readTask']>>> => {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    const read = await store.readTask(projectId, taskId)
    if (read?.task.status === status) return read
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return await store.readTask(projectId, taskId)
}

afterEach(() => {
  ;(runSubagent as jest.Mock).mockClear()
})

describe('project e2e — tool chain (executeBuiltinTool -> delegate_subagent)', () => {
  it('forwards the resolved projectTask binding and composed prompt to runSubagent', async () => {
    const { adapter, settings, store } = await seedProject('e2e-proj', 'T-001')
    const binding = await advanceToInProgress(store, 'e2e-proj', 'T-001')

    const result = await executeBuiltinTool(
      'delegate_subagent',
      {
        description: 'Implement',
        prompt: 'Make it work',
        projectTask: binding,
      },
      {
        app: { vault: { adapter } } as unknown as App,
        settings,
        conversationId: 'conv-1',
        conversationMessages: [],
        toolCallId: 'tool-1',
        subagentParentContext: {} as never,
        runSubagent: runSubagent as never,
      },
    )

    expect(result.status).toBe(ToolCallResponseStatus.Success)
    const params = (runSubagent as jest.Mock).mock.calls.at(-1)?.[0]
    expect(params).toBeDefined()
    // T2 Step 6b binding chain: the tool resolves the task and forwards the
    // binding to the subagent run. A broken binding wiring makes this fail.
    expect(params.projectTask).toEqual(binding)
    // buildProjectTaskPrompt embeds the task title, acceptance criteria, and
    // the parent's own instructions into the child prompt.
    expect(params.prompt).toContain('Implement the thing')
    expect(params.prompt).toContain('works on mobile')
    expect(params.prompt).toContain('Make it work')
    // Session parity fields (sessionId/runKey/runSequence) are runner-side
    // defaults (T2 Step 8) — the tool's contract stops at the binding.
  })
})

describe('project e2e — bridge chain (completion bus -> ProjectDeliveryBridge)', () => {
  it('delivers an unclaimed completed run: pending -> awaiting_review + artifact', async () => {
    // Production shape: the parent dispatched an implementer run WITHOUT
    // claiming the task (claiming is optional pre-dispatch). The ingest must
    // still land the completed run in review instead of leaving the task
    // stuck in pending forever (regression: pending->awaiting_review was not
    // in the transition table, so ingest kept the status).
    const { adapter, settings, store } = await seedProject('e2e-proj', 'T-001')
    const bound = (await store.readTask('e2e-proj', 'T-001'))!
    expect(bound.task.status).toBe('pending')

    const bridge = new ProjectDeliveryBridge({
      getSettings: () => settings,
      adapter,
    })
    bridge.start()
    try {
      const { event, record } = buildCompletionRecord({
        runKey: 'run-001',
        sessionId: 'sub_e2e_1',
        runSequence: 1,
        projectTask: {
          projectId: 'e2e-proj',
          taskId: 'T-001',
          expectedRevision: bound.revision,
          expectedContentHash: bound.contentHash,
        },
        result: {
          taskId: 'sub_e2e_1',
          status: 'completed',
          content: 'Finished.',
          durationMs: 100,
          toolUseCount: 1,
        },
      })
      backgroundTaskCompletionBus.pushCompleted(event)
      void record

      const after = await waitForTaskStatus(
        store,
        'e2e-proj',
        'T-001',
        'awaiting_review',
      )
      expect(after?.task.status).toBe('awaiting_review')
      expect(after?.task.deliveryRefs).toContain(
        'deliverables/T-001/run-001.md',
      )
      // The durable artifact embeds the result plus the parity identifiers.
      const artifact = await store.readDeliveryArtifact(
        'e2e-proj',
        'T-001',
        'run-001',
      )
      expect(artifact).toContain('Finished.')
      expect(artifact).toContain('session_id: sub_e2e_1')
      expect(artifact).toContain('run_sequence: 1')
    } finally {
      bridge.stop()
    }
  })

  it('returns the task to pending when the subagent run failed', async () => {
    const { adapter, settings, store } = await seedProject('e2e-proj', 'T-001')
    const bound = (await store.readTask('e2e-proj', 'T-001'))!
    await store.claimTask(
      'e2e-proj',
      'T-001',
      {
        expectedRevision: bound.revision,
        expectedContentHash: bound.contentHash,
      },
      { runKey: 'run-002' },
    )
    const claimed = (await store.readTask('e2e-proj', 'T-001'))!

    const bridge = new ProjectDeliveryBridge({
      getSettings: () => settings,
      adapter,
    })
    bridge.start()
    try {
      const { event } = buildCompletionRecord({
        runKey: 'run-002',
        sessionId: 'sub_e2e_2',
        runSequence: 1,
        projectTask: {
          projectId: 'e2e-proj',
          taskId: 'T-001',
          expectedRevision: claimed.revision,
          expectedContentHash: claimed.contentHash,
        },
        result: {
          taskId: 'sub_e2e_2',
          status: RUN_OUTCOME.FAILED,
          content: 'boom',
          durationMs: 100,
          toolUseCount: 0,
        },
      })
      backgroundTaskCompletionBus.pushCompleted(event)

      const after = await waitForTaskStatus(
        store,
        'e2e-proj',
        'T-001',
        'pending',
      )
      expect(after?.task.status).toBe('pending')
      expect(after?.task.claim).toBeUndefined()
      expect(after?.task.attempts[0].status).toBe('failed')
      expect(after?.task.attempts[0].error).toBe('boom')
    } finally {
      bridge.stop()
    }
  })
})
