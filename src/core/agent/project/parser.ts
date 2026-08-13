import { parseYaml, stringifyYaml } from 'obsidian'

import {
  BLOCK_KINDS,
  PROJECT_SCHEMA_VERSION,
  PROJECT_STATUSES,
  REVIEW_STATUSES,
  TASK_ATTEMPT_STATUSES,
  type BlockKind,
  type BlockReason,
  type ProjectRecord,
  type ProjectTaskStatus,
  type ProjectReviewStatus,
  type ReviewEvidence,
  type TaskAttempt,
  type TaskAttemptStatus,
  type TaskClaim,
  type TaskRecord,
  type TaskReviewRecord,
} from './types'

export class ProjectParseError extends Error {
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message)
    this.name = 'ProjectParseError'
  }
}

const readString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

const readNumber = (value: unknown): number | undefined =>
  typeof value === 'number' ? value : undefined

const readStringArray = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []

const readEvidence = (value: unknown): ReviewEvidence[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          kind: readString(item.kind) as ReviewEvidence['kind'],
          reference: readString(item.reference) ?? '',
          summary: readString(item.summary) ?? '',
          ...(readString(item.timestamp)
            ? { timestamp: readString(item.timestamp)! }
            : {}),
        }))
        .filter(
          (evidence): evidence is ReviewEvidence =>
            ['test', 'file', 'tool_result', 'human_decision'].includes(
              evidence.kind,
            ) && evidence.reference.length > 0,
        )
    : []

const readReviewHistory = (value: unknown): TaskReviewRecord[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          decision: readString(item.decision) as TaskReviewRecord['decision'],
          evidence: readEvidence(item.evidence),
          comments: readStringArray(item.comments),
          at: readString(item.at) ?? '',
        }))
        .filter((record) => isReviewStatus(record.decision))
    : []

const readAttempts = (value: unknown): TaskAttempt[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => isRecord(item))
        .map((item) => ({
          runKey: readString(item.run_key) ?? '',
          status: readString(item.status) as TaskAttemptStatus,
          dispatchedAt: readString(item.dispatched_at) ?? '',
          ...(readString(item.completed_at)
            ? { completedAt: readString(item.completed_at)! }
            : {}),
          ...(readString(item.result) ? { result: readString(item.result)! } : {}),
          ...(readString(item.error) ? { error: readString(item.error)! } : {}),
        }))
        .filter(
          (attempt) =>
            attempt.runKey.length > 0 &&
            (TASK_ATTEMPT_STATUSES as readonly string[]).includes(attempt.status),
        )
    : []

const readClaim = (value: unknown): TaskClaim | undefined => {
  if (!isRecord(value)) return undefined
  const runKey = readString(value.run_key)
  const dispatchedAt = readString(value.dispatched_at)
  const expiresAt = readString(value.expires_at)
  if (!runKey || !dispatchedAt || !expiresAt) return undefined
  return { runKey, dispatchedAt, expiresAt }
}

const readBlockReason = (value: unknown): BlockReason | undefined => {
  if (!isRecord(value)) return undefined
  const kind = readString(value.kind) as BlockKind | undefined
  if (!kind || !(BLOCK_KINDS as readonly string[]).includes(kind)) return undefined
  return { kind, ...(readString(value.detail) ? { detail: readString(value.detail)! } : {}) }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

function isTaskStatus(value: unknown): value is ProjectTaskStatus {
  return typeof value === 'string' && (PROJECT_STATUSES as readonly string[]).includes(value)
}

function isReviewStatus(value: unknown): value is ProjectReviewStatus {
  return (
    value === null ||
    (typeof value === 'string' &&
      (REVIEW_STATUSES as readonly string[]).includes(value))
  )
}

const requireString = (
  value: unknown,
  field: string,
  path?: string,
): string => {
  const result = readString(value)
  if (result === undefined || result.length === 0) {
    throw new ProjectParseError(`Invalid project file: missing "${field}".`, path)
  }
  return result
}

const requireNumber = (value: unknown, field: string, path?: string): number => {
  const result = readNumber(value)
  if (result === undefined || !Number.isInteger(result) || result < 0) {
    throw new ProjectParseError(`Invalid project file: bad "${field}".`, path)
  }
  return result
}

const requireTaskStatus = (
  value: unknown,
  field: string,
  path?: string,
): ProjectTaskStatus => {
  if (!isTaskStatus(value)) {
    throw new ProjectParseError(`Invalid project file: bad "${field}".`, path)
  }
  return value
}

const requireReviewStatus = (
  value: unknown,
  path?: string,
): ProjectReviewStatus | null => {
  if (!isReviewStatus(value)) {
    throw new ProjectParseError(
      'Invalid project file: bad "review_status".',
      path,
    )
  }
  return value
}

const toIsoString = (value: string): string => {
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString()
}

// js-yaml (and Obsidian's parseYaml) auto-converts timestamp-looking scalars to
// Date objects, so accept both the raw string and a parsed Date.
const requireTimestamp = (
  value: unknown,
  field: string,
  path?: string,
): string => {
  if (typeof value === 'string') return toIsoString(value)
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString()
  }
  throw new ProjectParseError(`Invalid project file: missing "${field}".`, path)
}

/** Splits a markdown file into its YAML frontmatter block and body. */
export const extractFrontmatter = (
  markdown: string,
): { frontmatter: string | null; body: string } | null => {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(markdown)
  if (!match) return { frontmatter: null, body: markdown }
  return {
    frontmatter: match[1],
    body: markdown.slice(match[0].length),
  }
}

export const parseProjectRecord = (
  frontmatter: string,
  path?: string,
): ProjectRecord => {
  let parsed: unknown
  try {
    parsed = parseYaml(frontmatter)
  } catch (error) {
    throw new ProjectParseError(
      `Invalid project file: frontmatter is not valid YAML.`,
      path,
    )
  }
  if (!isRecord(parsed)) {
    throw new ProjectParseError(
      'Invalid project file: frontmatter must be a YAML object.',
      path,
    )
  }
  if (parsed.schema_version !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectParseError(
      `Unsupported schema_version: ${String(parsed.schema_version)}.`,
      path,
    )
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: requireString(parsed.project_id, 'project_id', path),
    projectName: requireString(parsed.project_name, 'project_name', path),
    status: requireTaskStatus(parsed.status, 'status', path),
    revision: requireNumber(parsed.revision, 'revision', path),
    createdAt: requireTimestamp(parsed.created_at, 'created_at', path),
    updatedAt: requireTimestamp(parsed.updated_at, 'updated_at', path),
  }
}

export const parseTaskRecord = (
  frontmatter: string,
  path?: string,
): TaskRecord => {
  let parsed: unknown
  try {
    parsed = parseYaml(frontmatter)
  } catch {
    throw new ProjectParseError(
      'Invalid project file: frontmatter is not valid YAML.',
      path,
    )
  }
  if (!isRecord(parsed)) {
    throw new ProjectParseError(
      'Invalid project file: frontmatter must be a YAML object.',
      path,
    )
  }
  if (parsed.schema_version !== PROJECT_SCHEMA_VERSION) {
    throw new ProjectParseError(
      `Unsupported schema_version: ${String(parsed.schema_version)}.`,
      path,
    )
  }
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    projectId: requireString(parsed.project_id, 'project_id', path),
    taskId: requireString(parsed.task_id, 'task_id', path),
    revision: requireNumber(parsed.revision, 'revision', path),
    title: requireString(parsed.title, 'title', path),
    status: requireTaskStatus(parsed.status, 'status', path),
    assignee: readString(parsed.assignee) ?? 'parent',
    dependencies: readStringArray(parsed.dependencies),
    acceptanceCriteria: readStringArray(parsed.acceptance_criteria),
    priority: readString(parsed.priority) ?? 'medium',
    reviewStatus: requireReviewStatus(parsed.review_status, path),
    reworkCount: readNumber(parsed.rework_count) ?? 0,
    deliveryRefs: readStringArray(parsed.delivery_refs),
    attempts: readAttempts(parsed.attempts),
    reviewHistory: readReviewHistory(parsed.review_history),
    claim: readClaim(parsed.claim),
    blockReason: readBlockReason(parsed.block_reason),
    blockRecurrences: readNumber(parsed.block_recurrences) ?? 0,
    createdAt: requireTimestamp(parsed.created_at, 'created_at', path),
    updatedAt: requireTimestamp(parsed.updated_at, 'updated_at', path),
  }
}

const buildProjectFrontmatterObject = (record: ProjectRecord): Record<string, unknown> => ({
  schema_version: record.schemaVersion,
  project_id: record.projectId,
  project_name: record.projectName,
  status: record.status,
  revision: record.revision,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
})

export const serializeProjectFrontmatter = (record: ProjectRecord): string =>
  stringifyYaml(buildProjectFrontmatterObject(record)).trimEnd()

const buildTaskFrontmatterObject = (record: TaskRecord): Record<string, unknown> => ({
  schema_version: record.schemaVersion,
  project_id: record.projectId,
  task_id: record.taskId,
  revision: record.revision,
  title: record.title,
  status: record.status,
  assignee: record.assignee,
  dependencies: record.dependencies,
  acceptance_criteria: record.acceptanceCriteria,
  priority: record.priority,
  review_status: record.reviewStatus,
  rework_count: record.reworkCount,
  delivery_refs: record.deliveryRefs,
  attempts: record.attempts.map((attempt) => ({
    run_key: attempt.runKey,
    status: attempt.status,
    dispatched_at: attempt.dispatchedAt,
    ...(attempt.completedAt ? { completed_at: attempt.completedAt } : {}),
    ...(attempt.result ? { result: attempt.result } : {}),
    ...(attempt.error ? { error: attempt.error } : {}),
  })),
  ...(record.reviewHistory && record.reviewHistory.length > 0
    ? {
        review_history: record.reviewHistory.map((review) => ({
          decision: review.decision,
          evidence: review.evidence,
          comments: review.comments,
          at: review.at,
        })),
      }
    : {}),
  ...(record.claim
    ? {
        claim: {
          run_key: record.claim.runKey,
          dispatched_at: record.claim.dispatchedAt,
          expires_at: record.claim.expiresAt,
        },
      }
    : {}),
  ...(record.blockReason
    ? {
        block_reason: {
          kind: record.blockReason.kind,
          ...(record.blockReason.detail ? { detail: record.blockReason.detail } : {}),
        },
      }
    : {}),
  block_recurrences: record.blockRecurrences,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
})

export const serializeTaskFrontmatter = (record: TaskRecord): string =>
  stringifyYaml(buildTaskFrontmatterObject(record)).trimEnd()

export const buildTaskFileContent = (
  record: TaskRecord,
  body: string,
): string =>
  `---\n${serializeTaskFrontmatter(record)}\n---\n${body.trimStart()}`

export const buildProjectFileContent = (
  record: ProjectRecord,
  body: string,
): string =>
  `---\n${serializeProjectFrontmatter(record)}\n---\n${body.trimStart()}`

export const buildEmptyProjectBody = (
  projectName: string,
  overview = '',
): string =>
  [
    `# ${projectName}`,
    '',
    ...(overview ? [overview, ''] : []),
  ].join('\n')
