// F7: the durable-migration leftovers with zero production consumption were
// removed from statuses.ts (AGENT_RUN_PHASE / SUBAGENT_RUN_STATUS /
// AGENT_ACTIVITY_PHASE / DIAGNOSTIC_PHASE / RUN_PHASE / ACTIVITY_* /
// SUBAGENT_*_STATE / SESSION_* / JOURNAL_* / CONVERSATION_*_* etc.), so the
// value-set tests below only cover the exports that still have a production
// consumer (types/agentRun, web runtime gateway, pending-timeout-registry,
// contracts).
import {
  AGENT_RUN_STATUS,
  APPROVAL_DECISION,
  ENTITY_TITLE_KIND,
  HYDRATION_STATUS,
  LIFECYCLE_STATE,
  LIVE_TASK_STATUS,
  TOOL_EXECUTION_STATUS,
} from './statuses'

describe('canonical state statuses', () => {
  test('centralizes the agent run status vocabulary', () => {
    expect(AGENT_RUN_STATUS).toEqual({
      IDLE: 'idle',
      RUNNING: 'running',
      COMPLETED: 'completed',
      ABORTED: 'aborted',
      ERROR: 'error',
    })
    expect(AGENT_RUN_STATUS.ERROR).toBe('error')
  })

  test('shares approval decision, tool execution, and live task vocabularies', () => {
    expect(APPROVAL_DECISION).toEqual({
      APPROVED: 'approved',
      REJECTED: 'rejected',
    })
    expect(TOOL_EXECUTION_STATUS.UNCERTAIN).toBe('uncertain')
    expect(LIVE_TASK_STATUS).toEqual({
      STARTING: 'starting',
      RUNNING: 'running',
      DONE: 'done',
    })
  })

  test('keeps hydration and entity title vocabularies explicit', () => {
    expect(HYDRATION_STATUS).toEqual({
      UNHYDRATED: 'unhydrated',
      HYDRATING: 'hydrating',
      READY: 'ready',
      FAILED: 'failed',
    })
    expect(ENTITY_TITLE_KIND.UNTITLED).toBe('untitled')
    expect(ENTITY_TITLE_KIND.NAMED).toBe('named')
  })

  test('keeps the lifecycle state vocabulary', () => {
    expect(LIFECYCLE_STATE.METADATA_READY).toBe('metadata_ready')
    expect(LIFECYCLE_STATE.STOPPING).toBe('stopping')
  })
})
