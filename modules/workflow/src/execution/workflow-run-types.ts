import type { WorkflowNode, WorkflowTopology } from '../domain/workflow-model'
import type { WorkflowBundle } from '../domain/workflow-repository'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>

export type WorkflowRunStatus =
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

export type WorkflowNodeRunStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'skipped'

export type WorkflowExecutionPolicy = Readonly<{
  capability: 'vault-write'
  mapConcurrency: 3
  mergeStrategy: 'concat' | 'dedupe'
}>

export type WorkflowDefinitionSnapshot = Readonly<{
  workflowPath: string
  workflowContextMarkdown: string
  topology: WorkflowTopology
  stepContents: Readonly<Record<string, string>>
  modelByNodeId: Readonly<Record<string, string>>
  policy: WorkflowExecutionPolicy
  definitionHash: string
}>

export type WorkflowRunError = Readonly<{
  code:
    | 'invalid-definition'
    | 'model-unavailable'
    | 'agent-failed'
    | 'invalid-output'
    | 'storage-failed'
    | 'cancelled'
  nodeId?: string
  message: string
}>

export type WorkflowTokenUsage = Readonly<{
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
}>

export type WorkflowNodeRun = Readonly<{
  status: WorkflowNodeRunStatus
  output?: JsonValue
  conditionResult?: boolean
  detail?: string
  error?: WorkflowRunError
  startedAt?: number
  finishedAt?: number
  usage?: WorkflowTokenUsage
}>

export type WorkflowRunSnapshot = Readonly<{
  schemaVersion: 1
  runId: string
  workflowPath: string
  definition: WorkflowDefinitionSnapshot
  input: JsonValue
  status: WorkflowRunStatus
  nodes: Readonly<Record<string, WorkflowNodeRun>>
  outputs: Readonly<Record<string, JsonValue>>
  error?: WorkflowRunError
  cancelRequested?: boolean
  startedAt: number
  finishedAt?: number
  paused?: boolean
  usage?: WorkflowTokenUsage
}>

export type WorkflowNodeExecutionRequest = Readonly<{
  definition: WorkflowDefinitionSnapshot
  node: WorkflowNode
  workflowInput: JsonValue
  upstream: readonly Readonly<{
    nodeId: string
    edgeLabel?: string
    value: JsonValue
  }>[]
  signal: AbortSignal
}>

export type WorkflowNodeExecutionResult = Readonly<{
  value: JsonValue
  conditionResult?: boolean
  /** Token usage of the node's agent calls, when the provider reported it. */
  usage?: WorkflowTokenUsage
}>

export type WorkflowNodeExecutor = Readonly<{
  execute(
    request: WorkflowNodeExecutionRequest,
  ): Promise<WorkflowNodeExecutionResult>
  testNode(
    request: WorkflowNodeExecutionRequest,
  ): Promise<WorkflowNodeExecutionResult>
}>

/** Stable codes an executor throws; the coordinator persists them as-is. */
export type WorkflowNodeExecutionErrorCode = Exclude<
  WorkflowRunError['code'],
  'storage-failed'
>

export class WorkflowNodeExecutionError extends Error {
  readonly code: WorkflowNodeExecutionErrorCode

  constructor(code: WorkflowNodeExecutionErrorCode, message: string) {
    super(message)
    this.name = 'WorkflowNodeExecutionError'
    this.code = code
  }
}

/** Structural model snapshot; `YoloModuleModelSnapshotV1` is compatible. */
export type WorkflowModelSnapshot = Readonly<{
  defaultModelId: string
  models: readonly Readonly<{ id: string; name: string; providerId: string }>[]
}>

export type WorkflowRunStorage = Readonly<{
  list(directoryPrefix?: string): Promise<readonly string[]>
  readText(key: string): Promise<string | null>
  writeText(key: string, value: string): Promise<void>
  removeFile(key: string): Promise<boolean>
}>

export type WorkflowRunStore = Readonly<{
  read(workflowPath: string): Promise<WorkflowRunSnapshot | null>
  list(): Promise<readonly WorkflowRunSnapshot[]>
  write(run: WorkflowRunSnapshot): Promise<void>
  remove(workflowPath: string): Promise<boolean>
}>

export type WorkflowRunStartInput = Readonly<{
  workflowPath: string
  bundle: WorkflowBundle
  modelSnapshot: WorkflowModelSnapshot
  input: JsonValue
}>

export type WorkflowRunStartFailureReason =
  | 'already-running'
  | 'invalid-definition'
  | 'model-unavailable'
  | 'storage-failed'

export type WorkflowRunStartResult =
  | Readonly<{ ok: true; runId: string }>
  | Readonly<{
      ok: false
      reason: WorkflowRunStartFailureReason
      error?: WorkflowRunError
    }>

export type WorkflowRunContinueConfirmation = Readonly<{
  /** The UI must explicitly accept that a resumed node may re-apply side effects. */
  confirmSideEffects: boolean
}>

export type WorkflowRunContinueResult =
  | Readonly<{ ok: true; runId: string }>
  | Readonly<{
      ok: false
      reason:
        | 'not-found'
        | 'not-continuable'
        | 'already-running'
        | 'side-effect-confirmation-required'
        | 'storage-failed'
      error?: WorkflowRunError
    }>

export type WorkflowRunBackgroundActivity = Readonly<{
  id: string
  title: string
  status: WorkflowRunStatus
}>

export type WorkflowRunBackgroundSink = Readonly<{
  upsert(activity: WorkflowRunBackgroundActivity): void
  remove(id: string): void
}>

export type WorkflowRunSnapshotListener = (
  snapshot: WorkflowRunSnapshot,
) => void

export type WorkflowRunCoordinator = Readonly<{
  start(input: WorkflowRunStartInput): Promise<WorkflowRunStartResult>
  /** Parks a running run at its next node boundary; false when there is no running run to pause. */
  pause(workflowPath: string): Promise<boolean>
  cancel(workflowPath: string): Promise<void>
  continueRun(
    workflowPath: string,
    confirmation: WorkflowRunContinueConfirmation,
  ): Promise<WorkflowRunContinueResult>
  /**
   * Migrates the run record of a renamed workflow to the new path and
   * publishes it; a no-op when no record exists for the old path.
   */
  notifyRenamedWorkflow(oldPath: string, newPath: string): Promise<void>
  /** True while a rename lease is held for the path; start and continueRun refuse such paths. */
  isRenaming(path: string): boolean
  /** True while an in-memory run (running or paused) exists for the path. */
  isActive(path: string): boolean
  /** Holds a rename lease for the path; release it with `endRename`. */
  beginRename(path: string): void
  endRename(path: string): void
  initialize(): Promise<void>
  quiesce(): Promise<void>
  subscribe(listener: WorkflowRunSnapshotListener): () => void
}>

/**
 * Sums token usage across entries. An entry without an explicit total falls
 * back to its input+output total first, so the aggregate stays consistent
 * when some entries omit `totalTokens`. Returns undefined when no entry
 * carries any usage.
 */
export function sumWorkflowTokenUsage(
  entries: readonly (WorkflowTokenUsage | undefined)[],
): WorkflowTokenUsage | undefined {
  const present = entries.filter(
    (entry): entry is WorkflowTokenUsage => entry !== undefined,
  )
  if (present.length === 0) return undefined
  const inputTokens = sumDefinedTokens(
    present.map((entry) => entry.inputTokens),
  )
  const outputTokens = sumDefinedTokens(
    present.map((entry) => entry.outputTokens),
  )
  const totalTokens = sumDefinedTokens(
    present.map(
      (entry) =>
        entry.totalTokens ??
        (entry.inputTokens !== undefined || entry.outputTokens !== undefined
          ? (entry.inputTokens ?? 0) + (entry.outputTokens ?? 0)
          : undefined),
    ),
  )
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  }
}

function sumDefinedTokens(
  values: readonly (number | undefined)[],
): number | undefined {
  const defined = values.filter((value): value is number => value !== undefined)
  if (defined.length === 0) return undefined
  return defined.reduce((sum, value) => sum + value, 0)
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string')
    return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return false
  return Object.values(value).every(isJsonValue)
}
