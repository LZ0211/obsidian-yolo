export const PROJECT_SCHEMA_VERSION = 2 as const

export const CLAIM_DURATION_DEFAULT_MS = 30 * 60 * 1000
export const BLOCK_RECURRENCE_LIMIT = 3

export const PROJECT_STATUSES = [
  'pending',
  'in_progress',
  'running',
  'blocked',
  'awaiting_review',
  'completed',
  'rework',
  'cancelled',
] as const
export type ProjectTaskStatus = (typeof PROJECT_STATUSES)[number]

export const TASK_ATTEMPT_STATUSES = [
  'running',
  'done',
  'blocked',
  'crashed',
  'timed_out',
  'failed',
  'released',
] as const
export type TaskAttemptStatus = (typeof TASK_ATTEMPT_STATUSES)[number]

export const BLOCK_KINDS = [
  'dependency',
  'needs_input',
  'capability',
  'transient',
] as const
export type BlockKind = (typeof BLOCK_KINDS)[number]

/** Lease a delegated run holds while it owns a `running` task. */
export type TaskClaim = {
  runKey: string
  dispatchedAt: string
  expiresAt: string
}

export type BlockReason = {
  kind: BlockKind
  detail?: string
}

export type TaskAttempt = {
  runKey: string
  status: TaskAttemptStatus
  dispatchedAt: string
  completedAt?: string
  result?: string
  error?: string
}

export const REVIEW_STATUSES = [
  'pending',
  'approved',
  'rework',
  'escalated',
] as const
export type ProjectReviewStatus = (typeof REVIEW_STATUSES)[number]

/**
 * `project.md` frontmatter — metadata only, no copied task index. No
 * project-level `status`/`revision`: the only writer is `initProject`, so any
 * such fields would be frozen at `in_progress`/`1` forever and lie about the
 * project state. Truthful project-level state is derived per-read by
 * `ProjectStore.status()` from the task files.
 */
export type ProjectRecord = {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  projectId: string
  projectName: string
  createdAt: string
  updatedAt: string
}

export type ReviewEvidence = {
  kind: 'test' | 'file' | 'tool_result' | 'human_decision'
  reference: string
  summary: string
  timestamp?: string
}

/** One durable review decision with its evidence and comments. */
export type TaskReviewRecord = {
  decision: ProjectReviewStatus
  evidence: ReviewEvidence[]
  comments: string[]
  at: string
}

/** A single task file's frontmatter record. */
export type TaskRecord = {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION
  projectId: string
  taskId: string
  revision: number
  title: string
  status: ProjectTaskStatus
  assignee: string
  dependencies: string[]
  acceptanceCriteria: string[]
  priority: string
  reviewStatus: ProjectReviewStatus | null
  reworkCount: number
  deliveryRefs: string[]
  attempts: TaskAttempt[]
  reviewHistory?: TaskReviewRecord[]
  claim?: TaskClaim
  blockReason?: BlockReason
  blockRecurrences: number
  createdAt: string
  updatedAt: string
}

/** A read with the revision and exact content hash the record was read from. */
export type VersionedTask = {
  task: TaskRecord
  revision: number
  contentHash: string
  path: string
}

/** Both values must match the current file for a write to proceed. */
export type TaskWritePrecondition = {
  expectedRevision: number
  expectedContentHash: string
}

/**
 * Durable binding of a delegated subagent run to a project task. `taskId` alone
 * is not globally unique; the parent resolves the full task context before
 * dispatch and completion ingestion authenticates by runKey.
 */
export type ProjectTaskBinding = TaskWritePrecondition & {
  projectId: string
  taskId: string
  /**
   * When true the delegate run is an independent review of an `awaiting_review`
   * task instead of an implementer run: the child prompt is composed from the
   * task body, delivery artifacts, and review history, and no task binding is
   * attached (the parent records the verdict itself). Optional so delivery
   * ingestion and implementer dispatches are unaffected.
   */
  review?: boolean
}
