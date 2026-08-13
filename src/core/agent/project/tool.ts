import type {
  BlockReason,
  ProjectReviewStatus,
  ProjectTaskStatus,
  ReviewEvidence,
  TaskRecord,
} from './types'
import { applyReviewDecision } from './transition'
import type {
  ProjectTaskDraft,
  ProjectStore,
  StoreTaskWriteResult,
} from './store'

const REVIEW_DECISIONS: readonly ProjectReviewStatus[] = [
  'approved',
  'rework',
  'escalated',
]

export type ProjectTaskPatch = {
  status?: ProjectTaskStatus
  title?: string
  assignee?: string
  dependencies?: string[]
  acceptanceCriteria?: string[]
  priority?: string
  body?: string
  /**
   * Canonical blocked reason field — matches the model-facing schema
   * (`block_reason`) and the on-disk frontmatter key. `blockReason` remains
   * accepted as a legacy alias; models may send either.
   */
  block_reason?: BlockReason
  /** @deprecated Legacy alias for `block_reason`. */
  blockReason?: BlockReason
}

/** Successful `update`/`review` result surfaced to callers (failures throw). */
export type ProjectToolWriteSuccess = {
  projectId: string
  taskId: string
  revision: number
  contentHash: string
  noop: boolean
  status: ProjectTaskStatus
}

const requireProjectId = (input: { projectId?: string }): string => {
  if (!input.projectId || input.projectId.trim().length === 0) {
    throw new Error('projectId is required.')
  }
  return input.projectId.trim()
}

const requireTaskId = (input: { taskId?: string }): string => {
  if (!input.taskId || input.taskId.trim().length === 0) {
    throw new Error('taskId is required.')
  }
  return input.taskId.trim()
}

/**
 * Parent-only `project_ops` tool actions backed by the {@link ProjectStore}. The
 * store enforces revision/hash preconditions, so concurrent agents and direct
 * user edits surface as structured conflicts instead of silent overwrites.
 */
export class ProjectTool {
  constructor(private readonly store: ProjectStore) {}

  init(input: {
    projectId: string
    projectName: string
    overview?: string
    tasks: ProjectTaskDraft[]
  }) {
    return this.store.initProject(input)
  }

  async get(input: {
    projectId: string
    taskId?: string
    status?: ProjectTaskStatus[]
  }) {
    if (input.taskId) {
      const versioned = await this.store.readTask(input.projectId, input.taskId)
      if (!versioned) throw new Error(`Task not found: ${input.taskId}`)
      return {
        projectId: input.projectId,
        task: versioned.task,
        revision: versioned.revision,
        contentHash: versioned.contentHash,
        path: versioned.path,
      }
    }
    const { tasks, invalid } = await this.store.listTasks(input.projectId)
    const filtered =
      input.status && input.status.length > 0
        ? tasks.filter((entry) => input.status!.includes(entry.task.status))
        : tasks
    return {
      projectId: input.projectId,
      tasks: filtered.map((entry) => ({
        taskId: entry.task.taskId,
        title: entry.task.title,
        status: entry.task.status,
        reviewStatus: entry.task.reviewStatus,
        revision: entry.revision,
        contentHash: entry.contentHash,
        dependencies: entry.task.dependencies,
        priority: entry.task.priority,
      })),
      ...(invalid.length > 0 ? { invalid } : {}),
    }
  }

  status(projectId: string) {
    return this.store.status(projectId)
  }

  async update(input: {
    projectId: string
    taskId: string
    expectedRevision: number
    expectedContentHash: string
    patch?: ProjectTaskPatch
    claim?: { runKey: string; durationMs?: number }
  }) {
    const precondition = {
      expectedRevision: input.expectedRevision,
      expectedContentHash: input.expectedContentHash,
    }
    let result: StoreTaskWriteResult
    if (input.claim) {
      result = await this.store.claimTask(
        input.projectId,
        input.taskId,
        precondition,
        input.claim,
      )
    } else {
      if (!input.patch) {
        throw new Error('project_ops update requires patch or claim.')
      }
      result = await this.store.updateTask(
        input.projectId,
        input.taskId,
        precondition,
        (current) => applyPatch(current, input.patch!),
        input.patch.body,
      )
    }
    // Surface store failures (stale/conflict writes) as thrown errors, matching
    // `review`, instead of returning a "Success with ok:false" payload.
    return this.writeResult(input.projectId, input.taskId, result)
  }

  async review(input: {
    projectId: string
    taskId: string
    decision: ProjectReviewStatus
    evidence?: ReviewEvidence[]
    comments?: string[]
    expectedRevision?: number
    expectedContentHash?: string
  }) {
    const projectId = requireProjectId(input)
    const taskId = requireTaskId(input)
    if (!input.decision || !REVIEW_DECISIONS.includes(input.decision)) {
      throw new Error('decision must be one of: approved, rework, escalated.')
    }
    const evidence = input.evidence ?? []
    if (input.decision === 'approved' && evidence.length === 0) {
      throw new Error('Approval requires at least one evidence record.')
    }
    if (
      input.decision === 'rework' &&
      (!input.comments || input.comments.length === 0)
    ) {
      throw new Error('Rework requires at least one actionable comment.')
    }
    const versioned = await this.store.readTask(projectId, taskId)
    if (!versioned) throw new Error(`Task not found: ${taskId}`)
    const expectedRevision = input.expectedRevision ?? versioned.revision
    const expectedContentHash =
      input.expectedContentHash ?? versioned.contentHash
    if (
      expectedRevision !== versioned.revision ||
      expectedContentHash !== versioned.contentHash
    ) {
      throw new Error(
        'Task changed since it was read; re-read via project_ops get and retry.',
      )
    }
    const result = await this.store.updateTask(
      projectId,
      taskId,
      { expectedRevision, expectedContentHash },
      (current) =>
        applyReviewDecision(
          current,
          input.decision,
          input.comments ?? [],
          evidence,
          new Date().toISOString(),
        ),
    )
    return this.writeResult(projectId, taskId, result)
  }

  private writeResult(
    projectId: string,
    taskId: string,
    result: StoreTaskWriteResult,
  ): ProjectToolWriteSuccess {
    if (result.ok) {
      return {
        projectId,
        taskId,
        revision: result.revision,
        contentHash: result.contentHash,
        noop: result.noop,
        status: result.record.status,
      }
    }
    throw new Error(
      result.kind === 'conflict'
        ? `Conflict: ${result.message} Current revision ${result.current?.revision ?? '?'}.`
        : result.message,
    )
  }
}

const applyPatch = (
  current: TaskRecord,
  patch: ProjectTaskPatch,
): TaskRecord => {
  const next = { ...current }
  if (patch.status !== undefined) next.status = patch.status
  if (patch.title !== undefined) next.title = patch.title
  if (patch.assignee !== undefined) next.assignee = patch.assignee
  if (patch.dependencies !== undefined) next.dependencies = patch.dependencies
  if (patch.acceptanceCriteria !== undefined) {
    next.acceptanceCriteria = patch.acceptanceCriteria
  }
  if (patch.priority !== undefined) next.priority = patch.priority
  // Canonical name wins when both are present; `blockReason` is the legacy
  // alias some models still send.
  const blockReason = patch.block_reason ?? patch.blockReason
  if (blockReason !== undefined) next.blockReason = blockReason
  return next
}
