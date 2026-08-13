/**
 * Persisted state uses strings so Journal records, diagnostics, and replay
 * fixtures remain readable. These const objects are the runtime counterpart
 * of the string-union types; they are intentionally not TypeScript enums.
 *
 * F7: the durable-migration leftovers with zero production consumption
 * (AGENT_RUN_PHASE / SUBAGENT_RUN_STATUS / AGENT_ACTIVITY_PHASE /
 * DIAGNOSTIC_PHASE / RUN_PHASE / ACTIVITY_* / SUBAGENT_*_STATE /
 * SESSION_* / JOURNAL_* / CONVERSATION_*_* and friends) were removed — each
 * variant was grepped for production references and had none outside this
 * module and its test. Only exports with a production consumer remain.
 */

export const AGENT_RUN_STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  COMPLETED: 'completed',
  ABORTED: 'aborted',
  ERROR: 'error',
} as const

export type AgentRunStatus =
  (typeof AGENT_RUN_STATUS)[keyof typeof AGENT_RUN_STATUS]

export const TOOL_EXECUTION_STATUS = {
  REQUESTED: 'requested',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  UNCERTAIN: 'uncertain',
} as const

export type ToolExecutionStatus =
  (typeof TOOL_EXECUTION_STATUS)[keyof typeof TOOL_EXECUTION_STATUS]

export const APPROVAL_DECISION = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const

export type ApprovalDecision =
  (typeof APPROVAL_DECISION)[keyof typeof APPROVAL_DECISION]

export const LIVE_TASK_STATUS = {
  STARTING: 'starting',
  RUNNING: 'running',
  DONE: 'done',
} as const

export type LiveTaskStatus =
  (typeof LIVE_TASK_STATUS)[keyof typeof LIVE_TASK_STATUS]

export const HYDRATION_STATUS = {
  UNHYDRATED: 'unhydrated',
  HYDRATING: 'hydrating',
  READY: 'ready',
  FAILED: 'failed',
} as const

export type HydrationStatus =
  (typeof HYDRATION_STATUS)[keyof typeof HYDRATION_STATUS]

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
