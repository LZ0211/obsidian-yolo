import { normalizePath } from 'obsidian'

import type { YoloSettingsLike } from '../../../types/yoloSettingsLike'
import { sha256Hex } from '../../../utils/common/content-hash'
import { getYoloProjectsDir } from '../../paths/yoloPaths'
import { ProjectParseError, extractFrontmatter, parseProjectRecord, parseTaskRecord, buildProjectFileContent, buildTaskFileContent, buildEmptyProjectBody } from './parser'
import { ProjectTransitionError, assertTaskTransition } from './transition'
import { hasHitReworkLimit } from './delivery'
import { BLOCK_RECURRENCE_LIMIT, CLAIM_DURATION_DEFAULT_MS } from './types'
import type {
  ProjectRecord,
  ProjectTaskStatus,
  ProjectReviewStatus,
  TaskAttemptStatus,
  TaskRecord,
  TaskWritePrecondition,
  VersionedTask,
} from './types'

/** Minimal path-based vault adapter the store reads/writes through. */
export type ProjectVaultAdapter = {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  write(path: string, data: string): Promise<void>
  mkdir(path: string): Promise<void>
  list(path: string): Promise<{ files: string[]; folders: string[] }>
}

export type ProjectStoreOptions = {
  getSettings: () => YoloSettingsLike | null
  adapter: ProjectVaultAdapter
  /**
   * Optional liveness probe for a delegated run. When absent, an expired
   * `running` claim is treated as a crash and reclaimed on the next `status()`.
   * When provided, a claim whose runKey returns `true` is left alone.
   */
  isRunActive?: (runKey: string) => boolean
}

export type ProjectTaskDraft = {
  taskId: string
  title: string
  dependencies?: string[]
  acceptanceCriteria?: string[]
  priority?: string
}

export type ProjectInitInput = {
  projectId: string
  projectName: string
  overview?: string
  tasks: ProjectTaskDraft[]
}

export type StoreTaskWriteResult =
  | {
      ok: true
      record: TaskRecord
      revision: number
      contentHash: string
      path: string
      noop: boolean
    }
  | {
      ok: false
      kind: 'not_found' | 'conflict'
      message: string
      current?: VersionedTask
    }

export type ProjectStatusTask = {
  taskId: string
  status: ProjectTaskStatus
  reviewStatus: ProjectReviewStatus | null
  blockedBy: string[]
  reworkCount: number
  /** Soft warning: the task has hit the consecutive-rework threshold. */
  reworkLimitHit: boolean
}

export type ProjectStatus = {
  projectId: string
  counts: Record<ProjectTaskStatus, number>
  active: ProjectStatusTask[]
  pendingReviews: string[]
  dependencyBlocks: ProjectStatusTask[]
  /** Task IDs currently `running` (post-reclaim). */
  concurrentRunning: string[]
  /** Task IDs whose block recurrences have reached the soft limit. */
  recurringBlocks: ProjectStatusTask[]
  /** Task IDs reclaimed from expired-and-inactive claims this call. */
  reclaimed: Array<{ taskId: string; reason: string }>
  /** True when the project has tasks and every one is terminal. */
  allTerminal: boolean
  /** Number of tasks that are not `completed`/`cancelled`. */
  openTaskCount: number
  invalid?: Array<{ path: string; error: string }>
}

const isDoneStatus = (status: ProjectTaskStatus): boolean =>
  status === 'completed' || status === 'cancelled'

/**
 * Enforces the kanban data-model invariants on a task write before it is
 * serialized: `running` requires a claim, `blocked` requires a reason,
 * `blockRecurrences` increments on entering `blocked` and resets on
 * `completed`/`cancelled`, and leaving `running` clears the claim while
 * terminalizing the open attempt.
 */
const normalizeTaskWrite = (current: TaskRecord, next: TaskRecord): TaskRecord => {
  let result = next
  if (result.status === 'running' && !result.claim) {
    throw new ProjectTransitionError('running requires a claim (use claimTask).')
  }
  if (result.status === 'blocked' && !result.blockReason) {
    throw new ProjectTransitionError('blocked requires blockReason.')
  }
  if (result.status === 'blocked' && current.status !== 'blocked') {
    result = { ...result, blockRecurrences: result.blockRecurrences + 1 }
  }
  if (
    (result.status === 'completed' || result.status === 'cancelled') &&
    current.status !== result.status
  ) {
    result = { ...result, blockRecurrences: 0 }
  }
  if (current.status === 'running' && result.status !== 'running') {
    const terminal: TaskAttemptStatus =
      result.status === 'blocked'
        ? 'blocked'
        : result.status === 'awaiting_review'
          ? 'done'
          : 'released'
    result = {
      ...result,
      claim: undefined,
      attempts: result.attempts.map((a) =>
        a.runKey === current.claim?.runKey && a.status === 'running'
          ? { ...a, status: terminal, completedAt: new Date().toISOString() }
          : a,
      ),
    }
  }
  return result
}

export class ProjectStore {
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly options: ProjectStoreOptions) {}

  private projectsDir(): string {
    return getYoloProjectsDir(this.options.getSettings())
  }

  private projectDir(projectId: string): string {
    return normalizePath(`${this.projectsDir()}/${projectId}`)
  }

  private projectFilePath(projectId: string): string {
    return `${this.projectDir(projectId)}/project.md`
  }

  private tasksDir(projectId: string): string {
    return `${this.projectDir(projectId)}/tasks`
  }

  private taskFilePath(projectId: string, taskId: string): string {
    return `${this.tasksDir(projectId)}/${taskId}.md`
  }

  /** Serializes agent writes per normalized vault path. */
  private serialize<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(path) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    this.queues.set(
      path,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  private async readProjectRecord(projectId: string): Promise<ProjectRecord | null> {
    const path = this.projectFilePath(projectId)
    if (!(await this.options.adapter.exists(path))) return null
    const content = await this.options.adapter.read(path)
    const split = extractFrontmatter(content)
    if (!split?.frontmatter) {
      throw new ProjectParseError('Invalid project file: missing frontmatter.', path)
    }
    return parseProjectRecord(split.frontmatter, path)
  }

  async readProject(projectId: string): Promise<ProjectRecord | null> {
    return await this.serialize(
      this.projectFilePath(projectId),
      () => this.readProjectRecord(projectId),
    )
  }

  /** Lists valid projects under the current projects directory. */
  async listProjects(): Promise<ProjectRecord[]> {
    const dir = this.projectsDir()
    if (!(await this.options.adapter.exists(dir))) return []
    const listing = await this.options.adapter.list(dir)
    const projects: ProjectRecord[] = []
    for (const folder of listing.folders.sort()) {
      const projectId = folder.slice(dir.length + 1)
      if (!projectId || projectId.includes('/')) continue
      try {
        const project = await this.readProject(projectId)
        if (project) projects.push(project)
      } catch {
        // Skip directories without a valid project.md.
      }
    }
    return projects
  }

  async readTask(projectId: string, taskId: string): Promise<VersionedTask | null> {
    const path = this.taskFilePath(projectId, taskId)
    return await this.serialize(path, async () => {
      if (!(await this.options.adapter.exists(path))) return null
      const content = await this.options.adapter.read(path)
      const split = extractFrontmatter(content)
      if (!split?.frontmatter) {
        throw new ProjectParseError('Invalid task file: missing frontmatter.', path)
      }
      const task = parseTaskRecord(split.frontmatter, path)
      return { task, revision: task.revision, contentHash: await sha256Hex(content), path }
    })
  }

  private deliverablesDir(projectId: string, taskId: string): string {
    return `${this.projectDir(projectId)}/deliverables/${taskId}`
  }

  private deliveryArtifactPath(
    projectId: string,
    taskId: string,
    runKey: string,
  ): string {
    return `${this.deliverablesDir(projectId, taskId)}/${runKey}.md`
  }

  async writeDeliveryArtifact(
    projectId: string,
    taskId: string,
    runKey: string,
    content: string,
  ): Promise<string> {
    const path = this.deliveryArtifactPath(projectId, taskId, runKey)
    await this.serialize(path, async () => {
      await this.options.adapter.mkdir(this.deliverablesDir(projectId, taskId))
      await this.options.adapter.write(path, content)
    })
    return path
  }

  async readDeliveryArtifact(
    projectId: string,
    taskId: string,
    runKey: string,
  ): Promise<string | null> {
    const path = this.deliveryArtifactPath(projectId, taskId, runKey)
    return await this.serialize(path, async () => {
      if (!(await this.options.adapter.exists(path))) return null
      return await this.options.adapter.read(path)
    })
  }

  /** Reads the markdown body (after frontmatter) of a task file. */
  async readTaskBody(projectId: string, taskId: string): Promise<string> {
    const path = this.taskFilePath(projectId, taskId)
    return await this.serialize(path, async () => {
      if (!(await this.options.adapter.exists(path))) return ''
      const content = await this.options.adapter.read(path)
      return extractFrontmatter(content)?.body ?? ''
    })
  }

  /**
   * Deterministically scans task files (sorted by path). Invalid files are
   * reported separately rather than silently dropped.
   */
  async listTasks(
    projectId: string,
  ): Promise<{ tasks: VersionedTask[]; invalid: Array<{ path: string; error: string }> }> {
    const dir = this.tasksDir(projectId)
    if (!(await this.options.adapter.exists(dir))) {
      return { tasks: [], invalid: [] }
    }
    const listing = await this.options.adapter.list(dir)
    const files = listing.files.filter((file) => file.endsWith('.md')).sort()
    const tasks: VersionedTask[] = []
    const invalid: Array<{ path: string; error: string }> = []
    for (const file of files) {
      try {
        const content = await this.options.adapter.read(file)
        const split = extractFrontmatter(content)
        if (!split?.frontmatter) {
          invalid.push({ path: file, error: 'missing frontmatter' })
          continue
        }
        const task = parseTaskRecord(split.frontmatter, file)
        if (task.projectId !== projectId) {
          invalid.push({ path: file, error: 'project_id mismatch' })
          continue
        }
        tasks.push({
          task,
          revision: task.revision,
          contentHash: await sha256Hex(content),
          path: file,
        })
      } catch (error) {
        invalid.push({
          path: file,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return { tasks, invalid }
  }

  /**
   * Reads a task file and its versioned identity inside a per-path critical
   * section (the caller owns serialization). Returns null when the file does
   * not exist and throws {@link ProjectParseError} when it cannot be parsed.
   */
  private async readVersionedLocked(path: string): Promise<VersionedTask | null> {
    if (!(await this.options.adapter.exists(path))) return null
    const content = await this.options.adapter.read(path)
    const split = extractFrontmatter(content)
    if (!split?.frontmatter) {
      throw new ProjectParseError('Invalid task file: missing frontmatter.', path)
    }
    const task = parseTaskRecord(split.frontmatter, path)
    return { task, revision: task.revision, contentHash: await sha256Hex(content), path }
  }

  /**
   * Serializes `record` to the task file and verifies the write landed. Shared
   * by `updateTask` (which handles no-op detection and normalization first)
   * and `claimTask`.
   */
  private async writeRecord(path: string, record: TaskRecord, body?: string): Promise<StoreTaskWriteResult> {
    const currentContent = await this.options.adapter.read(path)
    const split = extractFrontmatter(currentContent)
    const nextContent = buildTaskFileContent(record, body ?? split?.body ?? '')
    const nextHash = await sha256Hex(nextContent)
    await this.options.adapter.write(path, nextContent)
    const verify = await this.options.adapter.read(path)
    if ((await sha256Hex(verify)) !== nextHash) {
      return {
        ok: false,
        kind: 'conflict',
        message: 'Post-write verification failed; another writer may have interfered.',
      }
    }
    return { ok: true, record, revision: record.revision, contentHash: nextHash, path, noop: false }
  }

  /**
   * Applies `mutate` to the freshly re-read task inside the per-path critical
   * section, requiring the caller's revision/hash to match. Rejects stale
   * writes with a structured `conflict`. Bumps revision, updates timestamps,
   * writes, then verifies the result. Skips the write when the canonical
   * content is unchanged.
   */
  async updateTask(
    projectId: string,
    taskId: string,
    precondition: TaskWritePrecondition,
    mutate: (current: TaskRecord) => TaskRecord,
    body?: string,
  ): Promise<StoreTaskWriteResult> {
    const path = this.taskFilePath(projectId, taskId)
    return await this.serialize(path, async () => {
      const versioned = await this.readVersionedLocked(path)
      if (!versioned) {
        return { ok: false, kind: 'not_found', message: `Task file not found: ${path}` }
      }
      const current = versioned.task
      const currentHash = versioned.contentHash
      if (
        current.revision !== precondition.expectedRevision ||
        currentHash !== precondition.expectedContentHash
      ) {
        return {
          ok: false,
          kind: 'conflict',
          message:
            'Task changed since it was read (revision/hash mismatch). Re-read and retry.',
          current: versioned,
        }
      }

      const mutated = mutate(current)
      assertTaskTransition(current.status, mutated.status)
      let normalized: TaskRecord
      try {
        normalized = normalizeTaskWrite(current, mutated)
      } catch (error) {
        // Invariant violations (blocked without reason, running without a
        // claim) are reported as structured failures rather than thrown, so
        // the caller can surface a clear message.
        if (error instanceof ProjectTransitionError) {
          return { ok: false, kind: 'conflict', message: error.message }
        }
        throw error
      }
      // No-op detection: compare the mutation applied on top of the current
      // revision/timestamps. If canonical content is unchanged, skip the write
      // so a redundant status change does not bump the revision or touch disk.
      const existingBody = extractFrontmatter(await this.options.adapter.read(path))?.body ?? ''
      const writeBody = body ?? existingBody
      const candidateRecord: TaskRecord = {
        ...normalized,
        projectId,
        taskId,
        revision: current.revision,
        createdAt: current.createdAt,
        updatedAt: current.updatedAt,
      }
      const candidateHash = await sha256Hex(
        buildTaskFileContent(candidateRecord, writeBody),
      )
      if (candidateHash === currentHash) {
        return { ok: true, record: current, revision: current.revision, contentHash: currentHash, path, noop: true }
      }

      const nextRecord: TaskRecord = {
        ...candidateRecord,
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
      }
      return await this.writeRecord(path, nextRecord, writeBody)
    })
  }

  /**
   * Claims a task for a delegated run: sets `running` + a `claim` and appends
   * a `running` attempt. Calling it with the same `runKey` on an already-
   * running task renews the lease (extends `expiresAt`) without a new attempt.
   * Requires the caller's revision/hash precondition to match.
   */
  async claimTask(
    projectId: string,
    taskId: string,
    precondition: TaskWritePrecondition,
    claim: { runKey: string; durationMs?: number },
  ): Promise<StoreTaskWriteResult> {
    const path = this.taskFilePath(projectId, taskId)
    return await this.serialize(path, async () => {
      const versioned = await this.readVersionedLocked(path)
      if (!versioned) {
        return { ok: false, kind: 'not_found', message: `Task file not found: ${path}` }
      }
      if (
        versioned.revision !== precondition.expectedRevision ||
        versioned.contentHash !== precondition.expectedContentHash
      ) {
        return {
          ok: false,
          kind: 'conflict',
          message: 'Task changed since it was read (revision/hash mismatch). Re-read and retry.',
          current: versioned,
        }
      }
      const current = versioned.task
      const now = new Date().toISOString()
      const durationMs = claim.durationMs ?? CLAIM_DURATION_DEFAULT_MS
      const expiresAt = new Date(Date.now() + durationMs).toISOString()

      // Renew: same runKey on an already-running task.
      if (current.status === 'running' && current.claim?.runKey === claim.runKey) {
        const renewed: TaskRecord = {
          ...current,
          claim: { runKey: claim.runKey, dispatchedAt: current.claim.dispatchedAt, expiresAt },
          updatedAt: now,
          revision: current.revision + 1,
        }
        return this.writeRecord(path, renewed)
      }

      // A different runKey on an already-running task is a conflict: the prior
      // run still holds the lease. Re-claiming would orphan the still-running
      // attempt forever (running->running is "renew only" per the spec).
      if (current.status === 'running' && current.claim?.runKey !== claim.runKey) {
        return {
          ok: false,
          kind: 'conflict',
          message: `Task is already claimed by run ${current.claim?.runKey ?? '?'}; release it before re-claiming.`,
          current: versioned,
        }
      }

      assertTaskTransition(current.status, 'running')
      const claimed: TaskRecord = {
        ...current,
        status: 'running',
        claim: { runKey: claim.runKey, dispatchedAt: now, expiresAt },
        attempts: [...current.attempts, { runKey: claim.runKey, status: 'running', dispatchedAt: now }],
        updatedAt: now,
        revision: current.revision + 1,
      }
      return this.writeRecord(path, claimed)
    })
  }

  /**
   * Re-keys a live claim to the actual subagent run id. The parent claims with
   * a placeholder runKey invented before dispatch; the real run id (`sub_*`)
   * only materializes inside `runSubagent`. Renaming both the claim and the
   * running attempt lets delivery ingestion and the liveness probe match by
   * the real run id — otherwise every delivery appends a second attempt (the
   * placeholder attempt never matches the ingest runKey). No-op when the task
   * is not running/claimed (unclaimed dispatch, or already released) or the
   * runKey already matches. Conflicts on a stale precondition.
   */
  async backfillClaimRunKey(
    projectId: string,
    taskId: string,
    precondition: TaskWritePrecondition,
    runKey: string,
  ): Promise<StoreTaskWriteResult> {
    const path = this.taskFilePath(projectId, taskId)
    return await this.serialize(path, async () => {
      const versioned = await this.readVersionedLocked(path)
      if (!versioned) {
        return { ok: false, kind: 'not_found', message: `Task file not found: ${path}` }
      }
      if (
        versioned.revision !== precondition.expectedRevision ||
        versioned.contentHash !== precondition.expectedContentHash
      ) {
        return {
          ok: false,
          kind: 'conflict',
          message: 'Task changed since it was read (revision/hash mismatch). Re-read and retry.',
          current: versioned,
        }
      }
      const current = versioned.task
      if (current.status !== 'running' || !current.claim) {
        return { ok: true, record: current, revision: versioned.revision, contentHash: versioned.contentHash, path, noop: true }
      }
      if (current.claim.runKey === runKey) {
        return { ok: true, record: current, revision: versioned.revision, contentHash: versioned.contentHash, path, noop: true }
      }
      const backfilled: TaskRecord = {
        ...current,
        claim: { ...current.claim, runKey },
        attempts: current.attempts.map((attempt) =>
          attempt.runKey === current.claim!.runKey && attempt.status === 'running'
            ? { ...attempt, runKey }
            : attempt,
        ),
        updatedAt: new Date().toISOString(),
        revision: versioned.revision + 1,
      }
      return await this.writeRecord(path, backfilled)
    })
  }

  /** Validates draft IDs, self-references, unknown deps, and dependency cycles. */
  validateTaskDrafts(
    projectId: string,
    tasks: readonly ProjectTaskDraft[],
  ): Array<{ taskId: string; error: string }> {
    const errors: Array<{ taskId: string; error: string }> = []
    const ids = new Set(tasks.map((task) => task.taskId))
    for (const task of tasks) {
      const dependencies = task.dependencies ?? []
      if (dependencies.includes(task.taskId)) {
        errors.push({ taskId: task.taskId, error: 'Task cannot depend on itself.' })
        continue
      }
      for (const dependency of dependencies) {
        if (!ids.has(dependency)) {
          errors.push({ taskId: task.taskId, error: `Unknown dependency: ${dependency}.` })
        }
      }
      if (this.hasDependencyCycle(tasks, task.taskId)) {
        errors.push({ taskId: task.taskId, error: 'Dependency cycle detected.' })
      }
    }
    return errors
  }

  private hasDependencyCycle(
    tasks: readonly ProjectTaskDraft[],
    start: string,
  ): boolean {
    const byId = new Map(tasks.map((task) => [task.taskId, task]))
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const dfs = (id: string): boolean => {
      if (visiting.has(id)) return true
      if (visited.has(id)) return false
      visiting.add(id)
      for (const dependency of byId.get(id)?.dependencies ?? []) {
        if (dfs(dependency)) return true
      }
      visiting.delete(id)
      visited.add(id)
      return false
    }
    return dfs(start)
  }

  /**
   * Creates a project directory and its metadata + task files. Fails (rather
   * than merging) when a project.md already exists or drafts are invalid.
   */
  async initProject(input: ProjectInitInput): Promise<
    | { ok: true; project: ProjectRecord }
    | { ok: false; kind: 'exists' | 'invalid'; message: string; errors?: string[] }
  > {
    const projectId = input.projectId
    const projectPath = this.projectFilePath(projectId)
    return await this.serialize(projectPath, async () => {
      if (await this.options.adapter.exists(projectPath)) {
        return { ok: false, kind: 'exists', message: `Project already exists: ${projectId}` }
      }
      const draftErrors = this.validateTaskDrafts(projectId, input.tasks)
      if (draftErrors.length > 0) {
        return {
          ok: false,
          kind: 'invalid',
          message: 'Invalid task drafts.',
          errors: draftErrors.map((entry) => `${entry.taskId}: ${entry.error}`),
        }
      }
      const now = new Date().toISOString()
      const project: ProjectRecord = {
        schemaVersion: 2,
        projectId,
        projectName: input.projectName,
        status: 'in_progress',
        revision: 1,
        createdAt: now,
        updatedAt: now,
      }
      await this.options.adapter.mkdir(this.tasksDir(projectId))
      await this.options.adapter.write(
        projectPath,
        buildProjectFileContent(project, buildEmptyProjectBody(input.projectName, input.overview)),
      )
      for (const draft of input.tasks) {
        const taskRecord: TaskRecord = {
          schemaVersion: 2,
          projectId,
          taskId: draft.taskId,
          revision: 1,
          title: draft.title,
          status: 'pending',
          assignee: 'parent',
          dependencies: draft.dependencies ?? [],
          acceptanceCriteria: draft.acceptanceCriteria ?? [],
          priority: draft.priority ?? 'medium',
          reviewStatus: null,
          reworkCount: 0,
          deliveryRefs: [],
          attempts: [],
          blockRecurrences: 0,
          createdAt: now,
          updatedAt: now,
        }
        await this.options.adapter.write(
          this.taskFilePath(projectId, draft.taskId),
          buildTaskFileContent(taskRecord, ''),
        )
      }
      return { ok: true, project }
    })
  }

  /**
   * Reclaims a single expired-and-inactive `running` claim: records a
   * `timed_out` attempt, clears the claim, and returns the task to `pending`.
   * The write runs inside the per-path critical section (same lock as
   * `updateTask`/`claimTask`) and re-reads the task fresh inside the lock, so a
   * concurrent ingest update that lands between `status()`'s snapshot and the
   * write is observed and never overwritten. Persists through `writeRecord`; on
   * a failed write the task is left as-is so no reclaim is recorded. Returns the
   * (possibly reclaimed) record.
   */
  private async reclaimExpiredClaims(
    projectId: string,
    versioned: VersionedTask,
    reclaimed: Array<{ taskId: string; reason: string }>,
  ): Promise<TaskRecord> {
    const task = versioned.task
    if (task.status !== 'running' || !task.claim) return task
    const expired = new Date(task.claim.expiresAt).getTime() < Date.now()
    if (!expired) return task
    if (this.options.isRunActive?.(task.claim.runKey) === true) return task
    const path = this.taskFilePath(projectId, task.taskId)
    return await this.serialize(path, async () => {
      const fresh = await this.readVersionedLocked(path)
      if (!fresh || fresh.task.status !== 'running' || !fresh.task.claim) {
        return fresh?.task ?? task
      }
      if (new Date(fresh.task.claim.expiresAt).getTime() >= Date.now()) return fresh.task
      if (this.options.isRunActive?.(fresh.task.claim.runKey) === true) return fresh.task
      const now = new Date().toISOString()
      const next: TaskRecord = {
        ...fresh.task,
        status: 'pending',
        claim: undefined,
        attempts: fresh.task.attempts.map((a) =>
          a.runKey === fresh.task.claim!.runKey && a.status === 'running'
            ? { ...a, status: 'timed_out' as const, completedAt: now }
            : a,
        ),
        updatedAt: now,
        revision: fresh.task.revision + 1,
      }
      const write = await this.writeRecord(path, next)
      if (write.ok) {
        reclaimed.push({ taskId: fresh.task.taskId, reason: 'claim_expired' })
        return next
      }
      return fresh.task
    })
  }

  /** Derives grouped counts, active tasks, pending reviews, dependency blocks, and reclaims expired claims. */
  async status(projectId: string): Promise<ProjectStatus | null> {
    const project = await this.readProject(projectId)
    if (!project) return null
    const { tasks, invalid } = await this.listTasks(projectId)
    const byId = new Map(tasks.map((entry) => [entry.task.taskId, entry]))
    const counts = Object.fromEntries(
      (['pending', 'in_progress', 'running', 'blocked', 'awaiting_review', 'completed', 'rework', 'cancelled'] as const).map(
        (status) => [status, 0],
      ),
    ) as Record<ProjectTaskStatus, number>
    const active: ProjectStatusTask[] = []
    const pendingReviews: string[] = []
    const dependencyBlocks: ProjectStatusTask[] = []
    const concurrentRunning: string[] = []
    const recurringBlocks: ProjectStatusTask[] = []
    const reclaimed: Array<{ taskId: string; reason: string }> = []
    // Holds the post-reclaim records so derived fields reflect the sweep.
    const current: TaskRecord[] = []
    for (const entry of tasks) {
      const task = await this.reclaimExpiredClaims(projectId, entry, reclaimed)
      current.push(task)
      counts[task.status] += 1
      const statusTask: ProjectStatusTask = {
        taskId: task.taskId,
        status: task.status,
        reviewStatus: task.reviewStatus,
        blockedBy: task.dependencies.filter(
          (dependency) => !isDoneStatus(byId.get(dependency)?.task.status ?? 'completed'),
        ),
        reworkCount: task.reworkCount,
        reworkLimitHit: hasHitReworkLimit(task),
      }
      if (!isDoneStatus(task.status)) active.push(statusTask)
      if (task.status === 'awaiting_review') pendingReviews.push(task.taskId)
      if (task.status === 'running') concurrentRunning.push(task.taskId)
      if (task.blockRecurrences >= BLOCK_RECURRENCE_LIMIT) recurringBlocks.push(statusTask)
      if (statusTask.blockedBy.length > 0 && task.status !== 'blocked') {
        dependencyBlocks.push(statusTask)
      }
    }
    const allTerminal =
      current.length > 0 && current.every((task) => isDoneStatus(task.status))
    const openTaskCount = current.filter((task) => !isDoneStatus(task.status)).length
    return {
      projectId,
      counts,
      active,
      pendingReviews,
      dependencyBlocks,
      concurrentRunning,
      recurringBlocks,
      reclaimed,
      allTerminal,
      openTaskCount,
      ...(invalid.length > 0 ? { invalid } : {}),
    }
  }
}
