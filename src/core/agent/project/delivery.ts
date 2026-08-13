import { RUN_OUTCOME } from '../../../types/agentRun'

import type { ProjectStore } from './store'
import { canTransitionTask } from './transition'
import type {
  ProjectTaskBinding,
  ProjectTaskStatus,
  TaskAttempt,
  TaskAttemptStatus,
  TaskRecord,
} from './types'

/** Consecutive rework decisions before a human decision gates re-dispatch. */
export const THREE_REWORK_DISPATCH_LIMIT = 3

/**
 * Rejects dispatching a bound task that cannot be worked on: only terminal
 * tasks are hard-blocked. Tasks past the consecutive-rework limit remain
 * dispatchable — the parent agent is the review authority and may judge
 * whether to re-dispatch; the limit is surfaced as a soft warning in status.
 */
export const assertProjectTaskDispatchable = (task: TaskRecord): void => {
  if (task.status === 'completed' || task.status === 'cancelled') {
    throw new Error(
      `Project task ${task.taskId} is ${task.status}; it cannot be dispatched.`,
    )
  }
}

/** True when a task has hit the consecutive-rework warning threshold. */
export const hasHitReworkLimit = (task: TaskRecord): boolean =>
  task.reworkCount >= THREE_REWORK_DISPATCH_LIMIT

export type ProjectDeliveryInput = {
  binding: ProjectTaskBinding
  runKey: string
  sessionId?: string
  runSequence?: number
  result: { status: string; content: string }
  completedAt: string
}

export type ProjectDeliveryResult =
  | { kind: 'fresh'; deliveryRef: string; task: TaskRecord }
  | { kind: 'stale'; deliveryRef: string; task: TaskRecord | null }

const buildDeliveryArtifactContent = (
  input: ProjectDeliveryInput,
  classification: 'fresh' | 'stale',
  currentTask: TaskRecord | null,
): string => {
  const { binding, runKey, sessionId, runSequence, result, completedAt } = input
  const lines: Array<string | null> = [
    `# Delivery ${runKey}`,
    ``,
    `- project_id: ${binding.projectId}`,
    `- task_id: ${binding.taskId}`,
    `- run_key: ${runKey}`,
    `- expected_revision: ${binding.expectedRevision}`,
    `- classification: ${classification}`,
    `- completed_at: ${completedAt}`,
    sessionId ? `- session_id: ${sessionId}` : null,
    typeof runSequence === 'number' ? `- run_sequence: ${runSequence}` : null,
    `- terminal_state: ${result.status}`,
    ``,
    `## Result`,
    result.content,
    currentTask
      ? [``, `## Task revision at completion`, `revision: ${currentTask.revision}`].join('\n')
      : null,
  ]
  return lines.filter((line): line is string => line !== null).join('\n')
}

const deliveryRef = (taskId: string, runKey: string): string =>
  `deliverables/${taskId}/${runKey}.md`

/**
 * Idempotent parent/store bridge that records a terminal subagent outcome as a
 * durable delivery artifact. When the task is still at the bound revision it
 * terminalizes the matching attempt and returns the task to `pending` on
 * failure/abort, or appends the delivery reference and transitions to
 * `awaiting_review` on completion. A task that changed since dispatch is
 * classified `stale` and left untouched.
 */
export class ProjectDeliveryIngester {
  constructor(private readonly store: ProjectStore) {}

  async ingest(input: ProjectDeliveryInput): Promise<ProjectDeliveryResult> {
    const { binding, runKey } = input
    const ref = deliveryRef(binding.taskId, runKey)
    const versioned = await this.store.readTask(binding.projectId, binding.taskId)

    if (!versioned) {
      await this.store.writeDeliveryArtifact(
        binding.projectId,
        binding.taskId,
        runKey,
        buildDeliveryArtifactContent(input, 'stale', null),
      )
      return { kind: 'stale', deliveryRef: ref, task: null }
    }

    const fresh =
      versioned.revision === binding.expectedRevision &&
      versioned.contentHash === binding.expectedContentHash

    await this.store.writeDeliveryArtifact(
      binding.projectId,
      binding.taskId,
      runKey,
      buildDeliveryArtifactContent(input, fresh ? 'fresh' : 'stale', versioned.task),
    )

    if (!fresh) {
      return { kind: 'stale', deliveryRef: ref, task: versioned.task }
    }

    const outcomeStatus = input.result.status // 'completed' | 'failed' | 'aborted'
    const attemptStatus: TaskAttemptStatus =
      outcomeStatus === RUN_OUTCOME.COMPLETED
        ? 'done'
        : outcomeStatus === RUN_OUTCOME.FAILED
          ? 'failed'
          : 'crashed'

    const terminalAttempt = (attempt: TaskAttempt): TaskAttempt => ({
      ...attempt,
      status: attemptStatus,
      completedAt: input.completedAt,
      ...(outcomeStatus === RUN_OUTCOME.COMPLETED
        ? { result: input.result.content.slice(0, 200) }
        : { error: input.result.content.slice(0, 200) }),
    })

    const targetStatus: ProjectTaskStatus =
      outcomeStatus === RUN_OUTCOME.COMPLETED ? 'awaiting_review' : 'pending'

    const updated = await this.store.updateTask(
      binding.projectId,
      binding.taskId,
      { expectedRevision: versioned.revision, expectedContentHash: versioned.contentHash },
      (current) => {
        // Terminalize the matching running attempt; when there is no attempt for
        // this runKey (e.g. the parent dispatched an implementer without
        // claiming), append one so the run's outcome is not silently lost. No-op
        // when a terminal attempt for this runKey already exists.
        const runningIndex = current.attempts.findIndex(
          (a) => a.runKey === runKey && a.status === 'running',
        )
        let attempts = current.attempts
        if (runningIndex >= 0) {
          attempts = current.attempts.map((a, i) =>
            i === runningIndex ? terminalAttempt(a) : a,
          )
        } else if (
          !current.attempts.some(
            (a) => a.runKey === runKey && a.status !== 'running',
          )
        ) {
          attempts = [
            ...current.attempts,
            terminalAttempt({
              runKey,
              status: 'running',
              dispatchedAt: input.completedAt,
            }),
          ]
        }
        const next = {
          ...current,
          claim: undefined,
          attempts,
          ...(outcomeStatus === RUN_OUTCOME.COMPLETED
            ? { deliveryRefs: [...current.deliveryRefs, ref] }
            : {}),
        }
        // Only transition when the state machine allows it; a task that cannot
        // move (e.g. already terminal) keeps its status but still records the
        // delivery and terminalizes the attempt.
        return canTransitionTask(current.status, targetStatus)
          ? { ...next, status: targetStatus }
          : { ...next, status: current.status }
      },
    )

    if (!updated.ok) {
      return { kind: 'stale', deliveryRef: ref, task: versioned.task }
    }
    return { kind: 'fresh', deliveryRef: ref, task: updated.record }
  }
}
