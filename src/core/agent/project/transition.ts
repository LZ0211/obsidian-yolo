import type {
  ProjectReviewStatus,
  ProjectTaskStatus,
  ReviewEvidence,
  TaskRecord,
  TaskReviewRecord,
} from './types'

export const ALLOWED_TASK_TRANSITIONS: Record<
  ProjectTaskStatus,
  readonly ProjectTaskStatus[]
> = {
  pending: [
    'in_progress',
    'running',
    'blocked',
    'cancelled',
    // Delivery without a prior claim (the parent dispatched an implementer run
    // without claiming the task) lands a completed run directly in review; the
    // ingester appends the terminal attempt so the run's outcome is not lost.
    'awaiting_review',
  ],
  in_progress: ['running', 'awaiting_review', 'blocked', 'cancelled', 'pending'],
  running: ['in_progress', 'awaiting_review', 'blocked', 'pending', 'cancelled', 'running'],
  blocked: ['pending', 'in_progress', 'running', 'cancelled'],
  awaiting_review: ['completed', 'rework', 'in_progress'],
  rework: ['in_progress', 'running', 'blocked', 'cancelled'],
  completed: [],
  cancelled: [],
}

export class ProjectTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProjectTransitionError'
  }
}

export const canTransitionTask = (
  from: ProjectTaskStatus,
  to: ProjectTaskStatus,
): boolean =>
  from === to || (ALLOWED_TASK_TRANSITIONS[from] ?? []).includes(to)

export const assertTaskTransition = (
  from: ProjectTaskStatus,
  to: ProjectTaskStatus,
): void => {
  if (from === to) return
  if (!canTransitionTask(from, to)) {
    throw new ProjectTransitionError(
      `Invalid task transition: ${from} -> ${to}.`,
    )
  }
}

export const assertReviewable = (record: TaskRecord): void => {
  if (record.status !== 'awaiting_review') {
    throw new ProjectTransitionError(
      `Cannot review task in status "${record.status}"; it must be awaiting_review.`,
    )
  }
}

/**
 * Applies an explicit parent/user review decision. `rework` requires at least
 * one actionable comment and increments `reworkCount`. Every decision is
 * appended to the durable `reviewHistory`.
 */
export const applyReviewDecision = (
  record: TaskRecord,
  decision: ProjectReviewStatus,
  comments: readonly string[],
  evidence: readonly ReviewEvidence[] = [],
  at?: string,
): TaskRecord => {
  assertReviewable(record)
  const reviewRecord: TaskReviewRecord = {
    decision,
    evidence: [...evidence],
    comments: [...comments],
    at: at ?? new Date().toISOString(),
  }
  const reviewHistory = [...(record.reviewHistory ?? []), reviewRecord]
  if (decision === 'approved') {
    return {
      ...record,
      reviewStatus: 'approved',
      status: 'completed',
      reviewHistory,
    }
  }
  if (decision === 'rework') {
    if (comments.length === 0) {
      throw new ProjectTransitionError(
        'Rework requires at least one actionable comment.',
      )
    }
    return {
      ...record,
      reviewStatus: 'rework',
      status: 'rework',
      reworkCount: record.reworkCount + 1,
      reviewHistory,
    }
  }
  return { ...record, reviewStatus: 'escalated', reviewHistory }
}
