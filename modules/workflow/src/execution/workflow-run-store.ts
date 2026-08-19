import { isSafeWorkflowStepPath } from '../domain/workflow-model'

import type {
  WorkflowNodeRunStatus,
  WorkflowRunSnapshot,
  WorkflowRunStatus,
  WorkflowRunStorage,
  WorkflowTokenUsage,
} from './workflow-run-types'
import { isJsonValue } from './workflow-run-types'

export class WorkflowRunStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorkflowRunStoreError'
  }
}

export type WorkflowRunStore = Readonly<{
  read(workflowPath: string): Promise<WorkflowRunSnapshot | null>
  list(): Promise<readonly WorkflowRunSnapshot[]>
  write(run: WorkflowRunSnapshot): Promise<void>
  remove(workflowPath: string): Promise<boolean>
}>

export function createWorkflowRunStore(
  storage: WorkflowRunStorage,
): WorkflowRunStore {
  const read = async (
    workflowPath: string,
  ): Promise<WorkflowRunSnapshot | null> => {
    const raw = await storage.readText(await runKey(workflowPath))
    if (raw === null) return null
    return parseStoredSnapshot(raw)
  }
  const list = async (): Promise<readonly WorkflowRunSnapshot[]> => {
    const keys = await storage.list('runs')
    const snapshots: WorkflowRunSnapshot[] = []
    for (const key of keys) {
      const raw = await storage.readText(key)
      if (raw === null) continue
      snapshots.push(parseStoredSnapshot(raw))
    }
    snapshots.sort((left, right) =>
      left.workflowPath.localeCompare(right.workflowPath),
    )
    return Object.freeze(snapshots)
  }
  const write = async (run: WorkflowRunSnapshot): Promise<void> => {
    if (!isWorkflowRunSnapshot(run))
      throw new WorkflowRunStoreError('Workflow run record is malformed')
    let serialized: string
    try {
      serialized = JSON.stringify(run)
    } catch {
      throw new WorkflowRunStoreError(
        'Workflow run record is not JSON-compatible',
      )
    }
    await storage.writeText(await runKey(run.workflowPath), serialized)
  }
  const remove = async (workflowPath: string): Promise<boolean> =>
    storage.removeFile(await runKey(workflowPath))
  return Object.freeze({ read, list, write, remove })
}

async function runKey(workflowPath: string): Promise<string> {
  if (!isSafeWorkflowStepPath(workflowPath))
    throw new WorkflowRunStoreError(
      `Workflow path "${workflowPath}" is not a safe relative path`,
    )
  return `runs/${await sha256Hex(workflowPath)}.json`
}

function parseStoredSnapshot(raw: string): WorkflowRunSnapshot {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new WorkflowRunStoreError(
      'Stored workflow run record is malformed JSON',
    )
  }
  if (!isWorkflowRunSnapshot(value))
    throw new WorkflowRunStoreError(
      'Stored workflow run record is malformed or unsupported',
    )
  return deepFreeze(value)
}

const RUN_STATUSES: readonly WorkflowRunStatus[] = [
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'interrupted',
]
const NODE_STATUSES: readonly WorkflowNodeRunStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'skipped',
]
const ERROR_CODES = new Set([
  'invalid-definition',
  'model-unavailable',
  'agent-failed',
  'invalid-output',
  'verification-failed',
  'storage-failed',
  'cancelled',
])

export function isWorkflowRunSnapshot(
  value: unknown,
): value is WorkflowRunSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) return false
  if (typeof value.runId !== 'string' || typeof value.workflowPath !== 'string')
    return false
  if (!isRecord(value.definition)) return false
  const definition = value.definition
  if (
    typeof definition.workflowPath !== 'string' ||
    typeof definition.workflowContextMarkdown !== 'string' ||
    typeof definition.definitionHash !== 'string'
  )
    return false
  if (!isRecord(definition.topology)) return false
  if (
    definition.topology.revision !== 1 ||
    !Array.isArray(definition.topology.nodes) ||
    !Array.isArray(definition.topology.edges)
  )
    return false
  if (!isRecord(definition.stepContents) || !isRecord(definition.modelByNodeId))
    return false
  if (
    Object.values(definition.stepContents).some(
      (entry) => typeof entry !== 'string',
    ) ||
    Object.values(definition.modelByNodeId).some(
      (entry) => typeof entry !== 'string',
    )
  )
    return false
  if (!isRecord(definition.policy)) return false
  if (
    definition.policy.capability !== 'vault-write' ||
    definition.policy.mapConcurrency !== 3 ||
    (definition.policy.mergeStrategy !== 'concat' &&
      definition.policy.mergeStrategy !== 'dedupe')
  )
    return false
  if (!isJsonValue(value.input)) return false
  if (!(RUN_STATUSES as readonly unknown[]).includes(value.status)) return false
  // `paused` is only persisted as `true` on a running run; `false` is malformed.
  if (value.paused !== undefined) {
    if (typeof value.paused !== 'boolean' || !value.paused) return false
    if (value.status !== 'running') return false
  }
  if (!isRecord(value.nodes) || !isRecord(value.outputs)) return false
  for (const nodeRun of Object.values(value.nodes)) {
    if (!isNodeRun(nodeRun)) return false
  }
  if (!Object.values(value.outputs).every(isJsonValue)) return false
  if (value.error !== undefined && !isRunError(value.error)) return false
  if (
    value.cancelRequested !== undefined &&
    typeof value.cancelRequested !== 'boolean'
  )
    return false
  if (typeof value.startedAt !== 'number') return false
  if (value.finishedAt !== undefined && typeof value.finishedAt !== 'number')
    return false
  if (value.usage !== undefined && !isTokenUsage(value.usage)) return false
  return true
}

function isNodeRun(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !(NODE_STATUSES as readonly unknown[]).includes(value.status)
  )
    return false
  if (value.output !== undefined && !isJsonValue(value.output)) return false
  if (
    value.conditionResult !== undefined &&
    typeof value.conditionResult !== 'boolean'
  )
    return false
  if (value.detail !== undefined && typeof value.detail !== 'string')
    return false
  if (value.error !== undefined && !isRunError(value.error)) return false
  if (value.startedAt !== undefined && typeof value.startedAt !== 'number')
    return false
  if (value.finishedAt !== undefined && typeof value.finishedAt !== 'number')
    return false
  if (value.usage !== undefined && !isTokenUsage(value.usage)) return false
  return true
}

function isTokenUsage(value: unknown): value is WorkflowTokenUsage {
  if (!isRecord(value)) return false
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'number') return false
  }
  return true
}

function isRunError(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.code === 'string' &&
    ERROR_CODES.has(value.code) &&
    (value.nodeId === undefined || typeof value.nodeId === 'string') &&
    typeof value.message === 'string'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value)
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>))
      deepFreeze(child, seen)
  }
  return value
}
