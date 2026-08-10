/**
 * Persisted state uses strings so Journal records, diagnostics, and replay
 * fixtures remain readable. These const objects are the runtime counterpart
 * of the string-union types; they are intentionally not TypeScript enums.
 */

export const RUN_PHASE = {
  QUEUED: 'queued',
  PREPARING: 'preparing',
  RUNNING: 'running',
  AWAITING_APPROVAL: 'awaiting_approval',
  SETTLING: 'settling',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
  INTERRUPTED: 'interrupted',
} as const

export type RunPhase = (typeof RUN_PHASE)[keyof typeof RUN_PHASE]

export const RUN_PHASE_VALUES: readonly RunPhase[] = Object.values(RUN_PHASE)

export const RUN_TERMINAL_PHASES: ReadonlySet<RunPhase> = new Set([
  RUN_PHASE.COMPLETED,
  RUN_PHASE.FAILED,
  RUN_PHASE.ABORTED,
  RUN_PHASE.INTERRUPTED,
])

export const isRunPhase = (value: unknown): value is RunPhase =>
  typeof value === 'string' && RUN_PHASE_VALUES.includes(value as RunPhase)

/**
 * The legacy foreground activity/checkpoint adapter has a finer-grained
 * provider vocabulary. It is separate from RunPhase, but still has one
 * canonical definition shared by its types, checkpoint validation, and UI.
 */
export const AGENT_RUN_PHASE = {
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  REQUESTING: 'requesting',
  STREAMING: 'streaming',
  TOOL: 'tool',
  WAITING_APPROVAL: 'waiting_approval',
  COMPACTING: 'compacting',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
  ERROR: 'error',
} as const

export type AgentRunPhase =
  (typeof AGENT_RUN_PHASE)[keyof typeof AGENT_RUN_PHASE]

export const AGENT_RUN_PHASE_VALUES: readonly AgentRunPhase[] =
  Object.values(AGENT_RUN_PHASE)

export const isAgentRunPhase = (value: unknown): value is AgentRunPhase =>
  typeof value === 'string' &&
  AGENT_RUN_PHASE_VALUES.includes(value as AgentRunPhase)

export const AGENT_RUN_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
  ERROR: 'error',
} as const

export type AgentRunStatus =
  (typeof AGENT_RUN_STATUS)[keyof typeof AGENT_RUN_STATUS]

export const ASSISTANT_GENERATION_STATE = {
  STREAMING: 'streaming',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
  ERROR: 'error',
} as const

export type AssistantGenerationState =
  (typeof ASSISTANT_GENERATION_STATE)[keyof typeof ASSISTANT_GENERATION_STATE]

export const TOOL_EXECUTION_STATUS = {
  REQUESTED: 'requested',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
} as const

export type ToolExecutionStatus =
  (typeof TOOL_EXECUTION_STATUS)[keyof typeof TOOL_EXECUTION_STATUS]

export const APPROVAL_STATUS = {
  AWAITING: 'awaiting',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const

export type ApprovalStatus =
  (typeof APPROVAL_STATUS)[keyof typeof APPROVAL_STATUS]

export const APPROVAL_DECISION = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const

export type ApprovalDecision =
  (typeof APPROVAL_DECISION)[keyof typeof APPROVAL_DECISION]

export const CHILD_RELATION_STATUS = {
  ATTACHED: 'attached',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
} as const

export type ChildRelationStatus =
  (typeof CHILD_RELATION_STATUS)[keyof typeof CHILD_RELATION_STATUS]

export const ACTIVITY_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  WAITING: 'waiting',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
  ERROR: 'error',
} as const

export type ActivityStatus =
  (typeof ACTIVITY_STATUS)[keyof typeof ACTIVITY_STATUS]

export type ActiveActivityStatus = Exclude<
  ActivityStatus,
  typeof ACTIVITY_STATUS.IDLE
>

export const LIVE_TASK_STATUS = {
  STARTING: 'starting',
  RUNNING: 'running',
  DONE: 'done',
} as const

export type LiveTaskStatus =
  (typeof LIVE_TASK_STATUS)[keyof typeof LIVE_TASK_STATUS]

export const ACTIVITY_PHASE = {
  IDLE: 'idle',
} as const

export type ActivityPhase =
  | RunPhase
  | (typeof ACTIVITY_PHASE)[keyof typeof ACTIVITY_PHASE]

export const HYDRATION_STATUS = {
  UNHYDRATED: 'unhydrated',
  HYDRATING: 'hydrating',
  READY: 'ready',
  FAILED: 'failed',
} as const

export type HydrationStatus =
  (typeof HYDRATION_STATUS)[keyof typeof HYDRATION_STATUS]

export const CONVERSATION_SUBMISSION_STATE = {
  RECEIVED: 'received',
  DURABLY_ACCEPTED: 'durably_accepted',
  REJECTED: 'rejected',
} as const

export type ConversationSubmissionStateStatus =
  (typeof CONVERSATION_SUBMISSION_STATE)[keyof typeof CONVERSATION_SUBMISSION_STATE]

export const CONVERSATION_SUBMISSION_STATUS = {
  ADMITTING: 'admitting',
  ACCEPTED: 'accepted',
  FAILED: 'failed',
} as const

export type ConversationSubmissionStatus =
  (typeof CONVERSATION_SUBMISSION_STATUS)[keyof typeof CONVERSATION_SUBMISSION_STATUS]

export const DURABILITY_STATUS = {
  DURABLE: 'durable',
  ADMITTING: 'admitting',
  FAILED: 'failed',
} as const

export type DurabilityStatus =
  (typeof DURABILITY_STATUS)[keyof typeof DURABILITY_STATUS]

export const SUBMISSION_DURABILITY_STATUS: Readonly<
  Record<ConversationSubmissionStatus, DurabilityStatus>
> = {
  [CONVERSATION_SUBMISSION_STATUS.ADMITTING]: DURABILITY_STATUS.ADMITTING,
  [CONVERSATION_SUBMISSION_STATUS.ACCEPTED]: DURABILITY_STATUS.DURABLE,
  [CONVERSATION_SUBMISSION_STATUS.FAILED]: DURABILITY_STATUS.FAILED,
}

export const durabilityStatusForSubmissionStatus = (
  status: ConversationSubmissionStatus,
): DurabilityStatus => SUBMISSION_DURABILITY_STATUS[status]

export const ENTITY_TITLE_KIND = {
  UNTITLED: 'untitled',
  NAMED: 'named',
} as const

export type EntityTitleKind =
  (typeof ENTITY_TITLE_KIND)[keyof typeof ENTITY_TITLE_KIND]

export const LIFECYCLE_STATE = {
  COLD: 'cold',
  METADATA_READY: 'metadata_ready',
  OPENING: 'opening',
  READY: 'ready',
  DEGRADED: 'degraded',
  INDEXING: 'indexing',
  STOPPING: 'stopping',
} as const

export type LifecycleState =
  (typeof LIFECYCLE_STATE)[keyof typeof LIFECYCLE_STATE]

export const AGENT_SESSION_STATUS = {
  NEW: 'new',
  IDLE: 'idle',
  RUNNING: 'running',
  CLOSING: 'closing',
  NEEDS_RESUME: 'needs_resume',
  ORPHANED: 'orphaned',
  ARCHIVED: 'archived',
  CLOSED: 'closed',
} as const

export type AgentSessionStatus =
  (typeof AGENT_SESSION_STATUS)[keyof typeof AGENT_SESSION_STATUS]

export const SUBAGENT_TASK_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  ABORTED: 'aborted',
} as const

export type SubagentTaskStatus =
  (typeof SUBAGENT_TASK_STATUS)[keyof typeof SUBAGENT_TASK_STATUS]

export const SUBAGENT_SESSION_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  CLOSING: 'closing',
  NEEDS_RESUME: 'needs_resume',
  ORPHANED: 'orphaned',
  ARCHIVED: 'archived',
} as const

export type SubagentSessionStatus =
  (typeof SUBAGENT_SESSION_STATUS)[keyof typeof SUBAGENT_SESSION_STATUS]

export const SUBAGENT_RUN_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  INTERRUPTED: 'interrupted',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
  FAILED: 'failed',
} as const

export type SubagentRunStatus =
  (typeof SUBAGENT_RUN_STATUS)[keyof typeof SUBAGENT_RUN_STATUS]

export const SUBAGENT_MESSAGE_INTENT_STATE = {
  PENDING: 'pending',
  CLAIMED: 'claimed',
  RECOVERY_REQUIRED: 'recovery_required',
  COMMITTED: 'committed',
  DROPPED: 'dropped',
} as const

export type SubagentMessageIntentState =
  (typeof SUBAGENT_MESSAGE_INTENT_STATE)[keyof typeof SUBAGENT_MESSAGE_INTENT_STATE]

export const SUBAGENT_CASCADE_STATE = {
  PENDING: 'pending',
  PARENT_COMMITTED: 'parent_committed',
  COMPLETED: 'completed',
} as const

export type SubagentCascadeState =
  (typeof SUBAGENT_CASCADE_STATE)[keyof typeof SUBAGENT_CASCADE_STATE]

export const SESSION_QUEUE_ITEM_STATE = {
  PENDING: 'pending',
  CLAIMED: 'claimed',
  RECOVERY_REQUIRED: 'recovery_required',
  COMMITTED: 'committed',
  DROPPED: 'dropped',
} as const

export type SessionQueueItemState =
  (typeof SESSION_QUEUE_ITEM_STATE)[keyof typeof SESSION_QUEUE_ITEM_STATE]

/** Durable conversation intent state. This is distinct from command results. */
export const CONVERSATION_INTENT_STATE = {
  PENDING: 'pending',
  CLAIMED: 'claimed',
  RECOVERY_REQUIRED: 'recovery_required',
  COMMITTED: 'committed',
  CANCELLED: 'cancelled',
} as const

export type ConversationIntentState =
  (typeof CONVERSATION_INTENT_STATE)[keyof typeof CONVERSATION_INTENT_STATE]

export const CONVERSATION_QUEUE_MUTATION_STATUS = {
  ENQUEUED: 'enqueued',
  ALREADY_PRESENT: 'already_present',
  OPERATION_ID_REUSED: 'operation_id_reused',
  EDITED: 'edited',
  CANCELLED: 'cancelled',
  CLAIMED: 'claimed',
  RETURNED_PENDING: 'returned_pending',
  RECOVERY_REQUIRED: 'recovery_required',
  COMMITTED: 'committed',
  RESOLVED_DISCARDED: 'resolved_discarded',
  RESOLVED_RESEND: 'resolved_resend',
  CONFLICT: 'conflict',
  INVALID_TRANSITION: 'invalid_transition',
  MISSING: 'missing',
} as const

export type ConversationQueueMutationStatus =
  (typeof CONVERSATION_QUEUE_MUTATION_STATUS)[keyof typeof CONVERSATION_QUEUE_MUTATION_STATUS]

/** Public action outcomes returned by the conversation queue service. */
export const DURABLE_QUEUE_ACTION_STATUS = {
  UPDATED: 'updated',
  CANCELLED: 'cancelled',
  RESOLVED_DISCARDED: 'resolved_discarded',
  RESOLVED_RESEND: 'resolved_resend',
  CONFLICT: 'conflict',
  INVALID_TRANSITION: 'invalid_transition',
  MISSING: 'missing',
} as const

export type DurableQueueActionStatus =
  (typeof DURABLE_QUEUE_ACTION_STATUS)[keyof typeof DURABLE_QUEUE_ACTION_STATUS]

/** In-memory handoff state before a durable intent is acknowledged. */
export const CONVERSATION_HANDOFF_STATE = {
  IN_FLIGHT: 'handoff_in_flight',
  CLAIMABLE: 'claimable',
  CLAIMED: 'claimed',
} as const

export type ConversationHandoffState =
  (typeof CONVERSATION_HANDOFF_STATE)[keyof typeof CONVERSATION_HANDOFF_STATE]

export const CONVERSATION_OPERATION_STATUS = {
  PRESENT: 'present',
  DELETED: 'deleted',
} as const

export type ConversationOperationStatus =
  (typeof CONVERSATION_OPERATION_STATUS)[keyof typeof CONVERSATION_OPERATION_STATUS]

export const CONVERSATION_INTENT_JOURNAL_STATUS = {
  WRITTEN: 'written',
  ALREADY_PRESENT: 'already_present',
  REQUEST_ID_REUSED: 'request_id_reused',
  UPDATED: 'updated',
  ALREADY_IN_STATE: 'already_in_state',
  CONFLICT: 'conflict',
  MISSING: 'missing',
  COMMIT_ID_REUSED: 'commit_id_reused',
} as const

export type ConversationIntentJournalStatus =
  (typeof CONVERSATION_INTENT_JOURNAL_STATUS)[keyof typeof CONVERSATION_INTENT_JOURNAL_STATUS]

export const CONVERSATION_QUEUE_STORE_STATUS = {
  WRITTEN: 'written',
  ALREADY_PRESENT: 'already_present',
  OPERATION_ID_REUSED: 'operation_id_reused',
  UPDATED: 'updated',
  CONFLICT: 'conflict',
  RESOLVED: 'resolved',
} as const

export type ConversationQueueStoreStatus =
  (typeof CONVERSATION_QUEUE_STORE_STATUS)[keyof typeof CONVERSATION_QUEUE_STORE_STATUS]

export const JOURNAL_APPEND_STATUS = {
  APPENDED: 'appended',
  ALREADY_APPLIED: 'already_applied',
  CONFLICT: 'conflict',
  COMMAND_ID_REUSED: 'command_id_reused',
} as const

export type JournalAppendStatus =
  (typeof JOURNAL_APPEND_STATUS)[keyof typeof JOURNAL_APPEND_STATUS]

export const JOURNAL_RECOVERY_STATUS = {
  CLEAN: 'clean',
  RECOVERED_ROTATION: 'recovered_rotation',
  QUARANTINED_ORPHAN: 'quarantined_orphan',
  CORRUPT: 'corrupt',
} as const

export type JournalRecoveryStatus =
  (typeof JOURNAL_RECOVERY_STATUS)[keyof typeof JOURNAL_RECOVERY_STATUS]

export const SESSION_JOURNAL_APPEND_STATUS = {
  APPENDED: 'appended',
  ALREADY_APPLIED: 'already_applied',
  CONFLICT: 'conflict',
  COMMAND_ID_REUSED: 'command_id_reused',
} as const

export type SessionJournalAppendStatus =
  (typeof SESSION_JOURNAL_APPEND_STATUS)[keyof typeof SESSION_JOURNAL_APPEND_STATUS]

export const SESSION_JOURNAL_RECOVERY_STATUS = {
  CLEAN: 'clean',
  RECOVERED_SEGMENT_ATTACHMENT: 'recovered_segment_attachment',
  ORPHANED_SEGMENT: 'orphaned_segment',
  CORRUPT: 'corrupt',
} as const

export type SessionJournalRecoveryStatus =
  (typeof SESSION_JOURNAL_RECOVERY_STATUS)[keyof typeof SESSION_JOURNAL_RECOVERY_STATUS]

export const SESSION_TRANSCRIPT_ATTACHMENT_STATUS = {
  ATTACHED: 'attached',
  ALREADY_ATTACHED: 'already_attached',
  CONFLICT: 'conflict',
} as const

export type SessionTranscriptAttachmentStatus =
  (typeof SESSION_TRANSCRIPT_ATTACHMENT_STATUS)[keyof typeof SESSION_TRANSCRIPT_ATTACHMENT_STATUS]

export const ATOMIC_RECORD_REMOVAL_STATUS = {
  REMOVED: 'removed',
  KEPT: 'kept',
  UNCERTAIN: 'uncertain',
} as const

export type AtomicRecordRemovalStatus =
  (typeof ATOMIC_RECORD_REMOVAL_STATUS)[keyof typeof ATOMIC_RECORD_REMOVAL_STATUS]

export const SESSION_RECOVERY_STATUS = {
  REQUIRED: 'required',
  FAILED: 'failed',
} as const

export type SessionRecoveryStatus =
  (typeof SESSION_RECOVERY_STATUS)[keyof typeof SESSION_RECOVERY_STATUS]

export const AGENT_ACTIVITY_KIND = {
  FOREGROUND_RUN: 'foreground_run',
  PERSISTENCE: 'persistence',
  MEMORY: 'memory',
  SUBAGENT: 'subagent',
  BACKGROUND_TASK: 'background_task',
} as const

export type AgentActivityKind =
  (typeof AGENT_ACTIVITY_KIND)[keyof typeof AGENT_ACTIVITY_KIND]

export const AGENT_ACTIVITY_PHASE = {
  QUEUED: 'queued',
  ACCEPTED: 'accepted',
  PREPARING: 'preparing',
  RUNNING: 'running',
  REQUESTING: 'requesting',
  STREAMING: 'streaming',
  TOOL: 'tool',
  WAITING_APPROVAL: 'waiting_approval',
  COMPACTING: 'compacting',
  SETTLING: 'settling',
  COMMITTING: 'committing',
  PERSISTENCE: 'persistence',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
  ERROR: 'error',
} as const

export type AgentActivityPhase =
  (typeof AGENT_ACTIVITY_PHASE)[keyof typeof AGENT_ACTIVITY_PHASE]

export const DIAGNOSTIC_PHASE = {
  ACCEPTANCE: 'acceptance',
  HANDOFF: 'handoff',
} as const

export type DiagnosticPhase =
  | AgentActivityPhase
  | (typeof DIAGNOSTIC_PHASE)[keyof typeof DIAGNOSTIC_PHASE]
