// Note (migration from backup/pre-rollback-2026-08-10): the backup test also
// covered ./stateMappings (mapState / mapAgentRuntimePhase /
// mapAgentActivityPhaseToRunPhase / STATE_MAPPING_TARGET) — that module is part
// of the event-sourcing kernel that master has not migrated, so those three
// test blocks are dropped here (semantic-preserving minimal adaptation).
import {
  ACTIVITY_PHASE,
  ACTIVITY_STATUS,
  AGENT_ACTIVITY_PHASE,
  AGENT_RUN_PHASE,
  AGENT_RUN_STATUS,
  APPROVAL_DECISION,
  APPROVAL_STATUS,
  ASSISTANT_GENERATION_STATE,
  ATOMIC_RECORD_REMOVAL_STATUS,
  CHILD_RELATION_STATUS,
  CONVERSATION_HANDOFF_STATE,
  CONVERSATION_INTENT_JOURNAL_STATUS,
  CONVERSATION_INTENT_STATE,
  CONVERSATION_OPERATION_STATUS,
  CONVERSATION_QUEUE_MUTATION_STATUS,
  CONVERSATION_QUEUE_STORE_STATUS,
  CONVERSATION_SUBMISSION_STATUS,
  DIAGNOSTIC_PHASE,
  DURABILITY_STATUS,
  DURABLE_QUEUE_ACTION_STATUS,
  ENTITY_TITLE_KIND,
  HYDRATION_STATUS,
  JOURNAL_APPEND_STATUS,
  JOURNAL_RECOVERY_STATUS,
  LIFECYCLE_STATE,
  RUN_PHASE,
  SESSION_JOURNAL_APPEND_STATUS,
  SESSION_JOURNAL_RECOVERY_STATUS,
  SESSION_QUEUE_ITEM_STATE,
  SESSION_TRANSCRIPT_ATTACHMENT_STATUS,
  SUBAGENT_CASCADE_STATE,
  SUBAGENT_MESSAGE_INTENT_STATE,
  SUBAGENT_RUN_STATUS,
  SUBAGENT_SESSION_STATUS,
  SUBAGENT_TASK_STATUS,
  TOOL_EXECUTION_STATUS,
  durabilityStatusForSubmissionStatus,
  isAgentRunPhase,
  isRunPhase,
} from './statuses'

describe('canonical state statuses', () => {
  test('uses one serializable value set for the shared run lifecycle', () => {
    expect(RUN_PHASE).toEqual({
      QUEUED: 'queued',
      PREPARING: 'preparing',
      RUNNING: 'running',
      AWAITING_APPROVAL: 'awaiting_approval',
      SETTLING: 'settling',
      COMPLETED: 'completed',
      FAILED: 'failed',
      ABORTED: 'aborted',
      INTERRUPTED: 'interrupted',
    })
    expect(isRunPhase(RUN_PHASE.RUNNING)).toBe(true)
    expect(isRunPhase('streaming')).toBe(false)
  })

  test('centralizes legacy agent and activity values without runtime enum objects', () => {
    expect(AGENT_RUN_PHASE.REQUESTING).toBe('requesting')
    expect(ACTIVITY_STATUS.WAITING).toBe('waiting')
    expect(isAgentRunPhase(AGENT_RUN_PHASE.COMPACTING)).toBe(true)
    expect(isAgentRunPhase('awaiting_approval')).toBe(false)
  })

  test('keeps diagnostic-only phases distinct from lifecycle phases', () => {
    expect(DIAGNOSTIC_PHASE).toEqual({
      ACCEPTANCE: 'acceptance',
      HANDOFF: 'handoff',
    })
  })

  test('shares approval, child relation, activity, and hydration vocabularies', () => {
    expect(APPROVAL_STATUS).toEqual({
      AWAITING: 'awaiting',
      APPROVED: 'approved',
      REJECTED: 'rejected',
    })
    expect(APPROVAL_DECISION).toEqual({
      APPROVED: 'approved',
      REJECTED: 'rejected',
    })
    expect(CHILD_RELATION_STATUS).toEqual({
      ATTACHED: 'attached',
      COMPLETED: 'completed',
      FAILED: 'failed',
      ABORTED: 'aborted',
    })
    expect(ACTIVITY_STATUS).toEqual({
      IDLE: 'idle',
      RUNNING: 'running',
      WAITING: 'waiting',
      COMPLETED: 'completed',
      FAILED: 'failed',
      ABORTED: 'aborted',
      ERROR: 'error',
    })
    expect(HYDRATION_STATUS).toEqual({
      UNHYDRATED: 'unhydrated',
      HYDRATING: 'hydrating',
      READY: 'ready',
      FAILED: 'failed',
    })
  })

  test('maps submission durability without reinterpreting submission state', () => {
    expect(
      durabilityStatusForSubmissionStatus(
        CONVERSATION_SUBMISSION_STATUS.ADMITTING,
      ),
    ).toBe(DURABILITY_STATUS.ADMITTING)
    expect(
      durabilityStatusForSubmissionStatus(
        CONVERSATION_SUBMISSION_STATUS.ACCEPTED,
      ),
    ).toBe(DURABILITY_STATUS.DURABLE)
    expect(
      durabilityStatusForSubmissionStatus(
        CONVERSATION_SUBMISSION_STATUS.FAILED,
      ),
    ).toBe(DURABILITY_STATUS.FAILED)
  })

  test('keeps journal append and recovery outcomes explicit', () => {
    expect(JOURNAL_APPEND_STATUS).toEqual({
      APPENDED: 'appended',
      ALREADY_APPLIED: 'already_applied',
      CONFLICT: 'conflict',
      COMMAND_ID_REUSED: 'command_id_reused',
    })
    expect(JOURNAL_RECOVERY_STATUS).toEqual({
      CLEAN: 'clean',
      RECOVERED_ROTATION: 'recovered_rotation',
      QUARANTINED_ORPHAN: 'quarantined_orphan',
      CORRUPT: 'corrupt',
    })
    expect(CONVERSATION_QUEUE_MUTATION_STATUS.CONFLICT).toBe('conflict')
    expect(CONVERSATION_QUEUE_MUTATION_STATUS.RETURNED_PENDING).toBe(
      'returned_pending',
    )
    expect(CONVERSATION_INTENT_JOURNAL_STATUS.COMMIT_ID_REUSED).toBe(
      'commit_id_reused',
    )
    expect(CONVERSATION_QUEUE_STORE_STATUS).toEqual({
      WRITTEN: 'written',
      ALREADY_PRESENT: 'already_present',
      OPERATION_ID_REUSED: 'operation_id_reused',
      UPDATED: 'updated',
      CONFLICT: 'conflict',
      RESOLVED: 'resolved',
    })
  })

  test('keeps storage vocabularies explicit per journal and record operation', () => {
    expect(SESSION_JOURNAL_APPEND_STATUS).toEqual({
      APPENDED: 'appended',
      ALREADY_APPLIED: 'already_applied',
      CONFLICT: 'conflict',
      COMMAND_ID_REUSED: 'command_id_reused',
    })
    expect(SESSION_JOURNAL_RECOVERY_STATUS).toEqual({
      CLEAN: 'clean',
      RECOVERED_SEGMENT_ATTACHMENT: 'recovered_segment_attachment',
      ORPHANED_SEGMENT: 'orphaned_segment',
      CORRUPT: 'corrupt',
    })
    expect(ATOMIC_RECORD_REMOVAL_STATUS).toEqual({
      REMOVED: 'removed',
      KEPT: 'kept',
      UNCERTAIN: 'uncertain',
    })
    expect(SESSION_TRANSCRIPT_ATTACHMENT_STATUS).toEqual({
      ATTACHED: 'attached',
      ALREADY_ATTACHED: 'already_attached',
      CONFLICT: 'conflict',
    })
  })

  test('owns state values that were previously repeated in domain types', () => {
    expect(ACTIVITY_PHASE.IDLE).toBe('idle')
    expect(ASSISTANT_GENERATION_STATE.STREAMING).toBe('streaming')
    expect(AGENT_RUN_STATUS.ERROR).toBe('error')
    expect(TOOL_EXECUTION_STATUS.UNCERTAIN).toBe('uncertain')
    expect(ENTITY_TITLE_KIND.UNTITLED).toBe('untitled')
    expect(LIFECYCLE_STATE.METADATA_READY).toBe('metadata_ready')
    expect(SESSION_QUEUE_ITEM_STATE.RECOVERY_REQUIRED).toBe('recovery_required')
    expect(CONVERSATION_INTENT_STATE).toEqual({
      PENDING: 'pending',
      CLAIMED: 'claimed',
      RECOVERY_REQUIRED: 'recovery_required',
      COMMITTED: 'committed',
      CANCELLED: 'cancelled',
    })
    expect(CONVERSATION_HANDOFF_STATE).toEqual({
      IN_FLIGHT: 'handoff_in_flight',
      CLAIMABLE: 'claimable',
      CLAIMED: 'claimed',
    })
    expect(CONVERSATION_OPERATION_STATUS).toEqual({
      PRESENT: 'present',
      DELETED: 'deleted',
    })
  })

  test('separates queue mutation outcomes from public queue action outcomes', () => {
    expect(DURABLE_QUEUE_ACTION_STATUS).toEqual({
      UPDATED: 'updated',
      CANCELLED: 'cancelled',
      RESOLVED_DISCARDED: 'resolved_discarded',
      RESOLVED_RESEND: 'resolved_resend',
      CONFLICT: 'conflict',
      INVALID_TRANSITION: 'invalid_transition',
      MISSING: 'missing',
    })
  })

  test('keeps subagent lifecycle vocabularies in one domain namespace', () => {
    expect(SUBAGENT_TASK_STATUS).toEqual({
      RUNNING: 'running',
      COMPLETED: 'completed',
      FAILED: 'failed',
      ABORTED: 'aborted',
    })
    expect(SUBAGENT_SESSION_STATUS).toEqual({
      IDLE: 'idle',
      RUNNING: 'running',
      CLOSING: 'closing',
      NEEDS_RESUME: 'needs_resume',
      ORPHANED: 'orphaned',
      ARCHIVED: 'archived',
    })
    expect(SUBAGENT_RUN_STATUS).toEqual({
      QUEUED: 'queued',
      RUNNING: 'running',
      WAITING_APPROVAL: 'waiting_approval',
      INTERRUPTED: 'interrupted',
      COMPLETED: 'completed',
      ABORTED: 'aborted',
      FAILED: 'failed',
    })
    expect(SUBAGENT_MESSAGE_INTENT_STATE).toEqual({
      PENDING: 'pending',
      CLAIMED: 'claimed',
      RECOVERY_REQUIRED: 'recovery_required',
      COMMITTED: 'committed',
      DROPPED: 'dropped',
    })
    expect(SUBAGENT_CASCADE_STATE).toEqual({
      PENDING: 'pending',
      PARENT_COMMITTED: 'parent_committed',
      COMPLETED: 'completed',
    })
  })
})
