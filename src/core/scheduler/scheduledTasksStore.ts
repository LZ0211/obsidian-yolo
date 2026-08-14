import {
  type SqliteNativeRuntimeFacade,
  openSqliteRuntime,
} from '../../database/sqlite/sqliteNativeRuntime'
import { loadDesktopNodeModuleSync } from '../../utils/platform/desktopNodeModule'

export type ScheduledTaskType =
  | 'script'
  | 'agent'
  | 'ragIndex'
  | 'ragAutoUpdate'
export type ScheduledTaskCreatedBy = 'user' | 'agent'
export type ScheduleType = 'once' | 'cron' | 'interval'
export type TaskTriggeredBy = 'schedule' | 'manual' | 'agent' | 'retry'

export enum TaskRunStatus {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELLED = 'cancelled',
  TIMED_OUT = 'timed_out',
}

/**
 * Minimal per-task agent binding. No `AgentConfig` type exists elsewhere in
 * the codebase to reuse — this mirrors `BotPlatformConfig.assistantId`
 * (`src/settings/schema/setting.types.ts`), which is the closest existing
 * precedent for "bind this automated agent turn to one assistant, or fall
 * back to the user's current default assistant".
 */
export type ScheduledTaskAgentConfig = {
  assistantId?: string
  /** Per-task, ephemeral tool approvals. These are applied only to the run
   * that this task starts and never mutate the assistant's saved policy. */
  temporaryApprovedToolNames?: string[]
}

const MAX_TASK_TOOL_GRANTS = 64

export function normalizeScheduledTaskAgentConfig(
  config: ScheduledTaskAgentConfig | null | undefined,
): ScheduledTaskAgentConfig | null {
  if (!config) return null

  const assistantId = config.assistantId?.trim()
  const temporaryApprovedToolNames = [
    ...new Set(
      (config.temporaryApprovedToolNames ?? [])
        .filter((toolName): toolName is string => typeof toolName === 'string')
        .map((toolName) => toolName.trim())
        .filter(Boolean),
    ),
  ].slice(0, MAX_TASK_TOOL_GRANTS)

  if (!assistantId && temporaryApprovedToolNames.length === 0) return null

  return {
    ...(assistantId ? { assistantId } : {}),
    ...(temporaryApprovedToolNames.length
      ? { temporaryApprovedToolNames }
      : {}),
  }
}

export type ScheduledTask = {
  id: string
  name: string
  type: ScheduledTaskType
  createdBy: ScheduledTaskCreatedBy

  scheduleType: ScheduleType
  /** IANA timezone for cron schedules; null means the host local timezone. */
  timezone?: string | null
  cronExpression: string | null
  intervalSeconds: number | null
  oneTimeDateTime: number | null
  nextRunTime: number | null

  scriptPath: string | null
  agentPrompt: string | null
  agentConfig: ScheduledTaskAgentConfig | null

  queueGroup: string | null
  dependsOn: string[] | null
  continueOnDependencyFailure: boolean
  priority: number

  timeoutSeconds: number
  maxRetries: number

  enabled: boolean
  notifyOn: ('success' | 'failure')[]
  createdAt: number
  updatedAt: number
  lastRunAt: number | null
  lastRunStatus: TaskRunStatus | null
  lastError: string | null
}

/**
 * Input shape for creating a task. `nextRunTime` is required (not optional)
 * so that "forgot to compute nextRunTime" is a compile-time error instead of
 * a task that silently never gets picked up by `checkAndEnqueueScheduledTasks`.
 */
export type TaskConfig = Omit<
  ScheduledTask,
  'id' | 'createdAt' | 'updatedAt' | 'lastRunAt' | 'lastRunStatus' | 'lastError'
>

export type TaskUpdate = Partial<Omit<ScheduledTask, 'id' | 'createdAt'>>

export type TaskRunLogEntry = {
  timestamp: number
  level: 'info' | 'warn' | 'error'
  message: string
}

export type TaskRun = {
  id: string
  taskId: string

  status: TaskRunStatus
  result: string | null
  error: string | null

  scheduledFor: number
  triggeredBy: TaskTriggeredBy
  startedAt: number | null
  completedAt: number | null
  durationMs: number | null

  /** When the scheduler's catch-up pass enqueued this run to make up a trigger
   * that was missed while the process wasn't polling. Non-null only on
   * catch-up runs (see scheduler.ts isMissedTrigger/catchUpMissedTasks) —
   * run history can distinguish a make-up fire from a regular scheduled one
   * by `catchUpRunAt` alone; `scheduledFor` still carries the missed trigger
   * point. */
  catchUpRunAt: number | null

  attempt: number
  batchId: string

  conversationId: string | null

  output: string | null
  exitCode: number | null

  logs: TaskRunLogEntry[] | null
}

export type TaskRunInsert = Omit<TaskRun, never>

export type TaskStatistics = {
  totalRuns: number
  successCount: number
  failureCount: number
  /** 0-100, rounded to 1 decimal place; 0 when totalRuns is 0. */
  successRate: number
  /** Average of completed runs' durationMs; null when no completed run has a recorded duration. */
  averageDurationMs: number | null
}

/** Execution-time in-memory state: only the fields scheduling/execution logic needs. */
export type TaskRunRuntimeState = {
  runId: string
  taskId: string
  batchId: string
  attempt: number
  triggeredBy: TaskTriggeredBy
  scheduledFor: number
  status: TaskRunStatus
  startedAt?: number
  completedAt?: number
  result?: string
  error?: string
  output?: string
  exitCode?: number
  conversationId?: string
  catchUpRunAt?: number
  logs?: TaskRunLogEntry[]
}

/** Explicit conversion before persisting: missing fields fail at compile time, not silently at runtime. */
export function toTaskRunInsert(state: TaskRunRuntimeState): TaskRunInsert {
  return {
    id: state.runId,
    taskId: state.taskId,
    status: state.status,
    result: state.result ?? null,
    error: state.error ?? null,
    scheduledFor: state.scheduledFor,
    triggeredBy: state.triggeredBy,
    startedAt: state.startedAt ?? null,
    completedAt: state.completedAt ?? null,
    durationMs:
      state.startedAt != null && state.completedAt != null
        ? state.completedAt - state.startedAt
        : null,
    attempt: state.attempt,
    batchId: state.batchId,
    conversationId: state.conversationId ?? null,
    output: state.output ?? null,
    exitCode: state.exitCode ?? null,
    catchUpRunAt: state.catchUpRunAt ?? null,
    logs: state.logs ?? null,
  }
}

type ScheduledTaskDbRow = {
  id: string
  name: string
  type: ScheduledTaskType
  created_by: ScheduledTaskCreatedBy
  schedule_type: ScheduleType
  timezone?: string | null
  cron_expression: string | null
  interval_seconds: number | null
  one_time_date_time: number | null
  next_run_time: number | null
  script_path: string | null
  agent_prompt: string | null
  agent_config: string | null
  queue_group: string | null
  depends_on: string | null
  continue_on_dependency_failure: number
  priority: number
  timeout_seconds: number
  max_retries: number
  enabled: number
  notify_on: string
  created_at: number
  updated_at: number
  last_run_at: number | null
  last_run_status: TaskRunStatus | null
  last_error: string | null
}

type TaskRunDbRow = {
  id: string
  task_id: string
  status: TaskRunStatus
  result: string | null
  error: string | null
  scheduled_for: number
  triggered_by: TaskTriggeredBy
  started_at: number | null
  completed_at: number | null
  duration_ms: number | null
  attempt: number
  batch_id: string
  conversation_id: string | null
  output: string | null
  exit_code: number | null
  catch_up_run_at: number | null
  logs: string | null
}

const CREATE_SCHEMA_SQL = `
  create table if not exists scheduled_tasks (
    id text primary key,
    name text not null,
    type text not null check (type in ('script', 'agent', 'ragIndex', 'ragAutoUpdate')),
    created_by text not null default 'user' check (created_by in ('user', 'agent')),

    schedule_type text not null check (schedule_type in ('once', 'cron', 'interval')),
    timezone text,
    cron_expression text,
    interval_seconds integer,
    one_time_date_time integer,
    next_run_time integer,

    script_path text,
    agent_prompt text,
    agent_config text,

    queue_group text,
    depends_on text,
    continue_on_dependency_failure integer not null default 0,
    priority integer not null default 5,

    timeout_seconds integer not null default 300,
    max_retries integer not null default 3,

    enabled integer not null default 1,
    notify_on text not null default '[]',
    created_at integer not null,
    updated_at integer not null,
    last_run_at integer,
    last_run_status text check (
      last_run_status in ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out')
    ),
    last_error text
  );

  -- on delete set null (NOT cascade): deleting a task must not silently
  -- destroy its RUNNING run row while the run is still executing — the run
  -- would keep running, write to a deleted row (0-row updates) and emit a
  -- false-success notice. The scheduler cancels in-flight runs first; the
  -- store deletes the remaining run rows explicitly (see deleteTask), and
  -- the cancelled in-flight rows the scheduler asks to keep survive the task
  -- deletion with task_id nulled by the FK.
  create table if not exists task_runs (
    id text primary key,
    task_id text references scheduled_tasks(id) on delete set null,

    status text not null check (
      status in ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out')
    ),
    result text,
    error text,

    scheduled_for integer not null,
    triggered_by text not null default 'schedule' check (
      triggered_by in ('schedule', 'manual', 'agent', 'retry')
    ),
    started_at integer,
    completed_at integer,
    duration_ms integer,

    attempt integer not null default 1,
    batch_id text not null,

    conversation_id text,

    output text,
    exit_code integer,

    catch_up_run_at integer,
    logs text
  );

  create index if not exists idx_scheduled_tasks_next_run_time
    on scheduled_tasks(next_run_time);
  create index if not exists idx_scheduled_tasks_queue_group
    on scheduled_tasks(queue_group);

  create index if not exists idx_task_runs_task_started
    on task_runs(task_id, started_at);
  create index if not exists idx_task_runs_batch
    on task_runs(batch_id);
  create index if not exists idx_task_runs_status
    on task_runs(status);

  create table if not exists task_execution_claims (
    task_id text primary key,
    owner_id text not null,
    claimed_at integer not null,
    expires_at integer not null
  );
`

export class ScheduledTasksStore {
  private runtime: SqliteNativeRuntimeFacade | null = null

  /** Public so callers (e.g. the scheduler's leader-election lock name) can derive a vault-scoped identifier without a separate accessor. */
  constructor(public readonly rootDir: string) {}

  open(): void {
    if (this.runtime != null) return
    // `node:path` is desktop-only; load it lazily so the mobile bundle never
    // statically pulls in a Node built-in (same pattern as sqliteNativeRuntime).
    const path =
      loadDesktopNodeModuleSync<typeof import('node:path')>('node:path')
    this.runtime = openSqliteRuntime({
      dbPath: path.join(this.rootDir, 'scheduled-tasks.sqlite'),
    })
    this.runtime.exec(CREATE_SCHEMA_SQL)
    try {
      this.runtime.exec('alter table scheduled_tasks add column timezone text')
    } catch {
      // Existing databases already have the additive column.
    }
    try {
      this.runtime.exec(
        'alter table task_runs add column catch_up_run_at integer',
      )
    } catch {
      // Existing databases already have the additive column.
    }
    this.migrateTaskTypeConstraint()
    this.migrateTaskRunsTable()
  }

  /**
   * Widens the tasks-table type CHECK for databases created before the RAG
   * action types (`ragIndex`/`ragAutoUpdate`). SQLite cannot alter a CHECK
   * constraint, so the table is rebuilt in place using the standard FK-safe
   * rebuild pattern: FK enforcement is suspended around the rebuild and
   * restored afterwards — it cannot be toggled inside a transaction.
   *
   * The rebuild order is load-bearing: the new table is created under a
   * distinct name, data is copied, the OLD table is dropped, and only then is
   * the new one renamed into place. Renaming the old table out of the way
   * first would make SQLite rewrite `task_runs`'s FK to reference
   * `scheduled_tasks_old`, and dropping that table would leave `task_runs`
   * pointing at a table that no longer exists — every run insert/update would
   * then fail with "no such table". Renaming a *newly created* table into the
   * canonical name rewrites nothing (no FK references the temp name), and the
   * existing FK string `references scheduled_tasks(id)` matches the recreated
   * table again. The same ordering keeps the indexes: they are dropped with
   * the old table and re-created explicitly on the new one (the
   * `create index if not exists` in CREATE_SCHEMA_SQL would be skipped while
   * the old table still owns the names).
   *
   * Runs only when the existing table SQL still carries the original
   * two-value constraint; databases created from `CREATE_SCHEMA_SQL` already
   * have the widened one and are skipped. The table is small (one row per
   * task) and the rebuild is transactional.
   */
  private migrateTaskTypeConstraint(): void {
    const row = this.db.queryOne<{ sql: string | null }>(
      "select sql from sqlite_master where type = 'table' and name = 'scheduled_tasks'",
    )
    const tableSql = row?.sql ?? ''
    if (tableSql.includes('ragIndex')) return
    this.db.exec('pragma foreign_keys = off;')
    try {
      this.db.transaction(() => {
        this.db.exec(`
          create table scheduled_tasks_new (
            id text primary key,
            name text not null,
            type text not null check (type in ('script', 'agent', 'ragIndex', 'ragAutoUpdate')),
            created_by text not null default 'user' check (created_by in ('user', 'agent')),

            schedule_type text not null check (schedule_type in ('once', 'cron', 'interval')),
            timezone text,
            cron_expression text,
            interval_seconds integer,
            one_time_date_time integer,
            next_run_time integer,

            script_path text,
            agent_prompt text,
            agent_config text,

            queue_group text,
            depends_on text,
            continue_on_dependency_failure integer not null default 0,
            priority integer not null default 5,

            timeout_seconds integer not null default 300,
            max_retries integer not null default 3,

            enabled integer not null default 1,
            notify_on text not null default '[]',
            created_at integer not null,
            updated_at integer not null,
            last_run_at integer,
            last_run_status text check (
              last_run_status in ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out')
            ),
            last_error text
          )
        `)
        this.db.exec(`
          insert into scheduled_tasks_new (
            id, name, type, created_by,
            schedule_type, timezone, cron_expression, interval_seconds, one_time_date_time, next_run_time,
            script_path, agent_prompt, agent_config,
            queue_group, depends_on, continue_on_dependency_failure, priority,
            timeout_seconds, max_retries,
            enabled, notify_on, created_at, updated_at,
            last_run_at, last_run_status, last_error
          )
          select
            id, name, type, created_by,
            schedule_type, timezone, cron_expression, interval_seconds, one_time_date_time, next_run_time,
            script_path, agent_prompt, agent_config,
            queue_group, depends_on, continue_on_dependency_failure, priority,
            timeout_seconds, max_retries,
            enabled, notify_on, created_at, updated_at,
            last_run_at, last_run_status, last_error
          from scheduled_tasks
        `)
        this.db.exec('drop table scheduled_tasks')
        this.db.exec(
          'alter table scheduled_tasks_new rename to scheduled_tasks',
        )
        // The old indexes were dropped with the old table; re-create them on
        // the rebuilt table (names are free again now).
        this.db.exec(
          'create index if not exists idx_scheduled_tasks_next_run_time on scheduled_tasks(next_run_time)',
        )
        this.db.exec(
          'create index if not exists idx_scheduled_tasks_queue_group on scheduled_tasks(queue_group)',
        )
      })
    } finally {
      this.db.exec('pragma foreign_keys = on;')
    }
  }

  /**
   * Rebuilds the `task_runs` table for databases created before the T1
   * fix-batch: (1) the FK was `on delete cascade`, which silently destroyed a
   * RUNNING run row when its task was deleted — the run kept executing and
   * emitted a false-success notice; it must be `on delete set null` so the
   * scheduler can cancel in-flight runs and their records survive the task
   * deletion. (2) the `parent_run_id` / `messages_count` columns were never
   * written by any code path and are dropped in the same rebuild.
   *
   * Same FK-safe rebuild pattern as migrateTaskTypeConstraint: FK enforcement
   * is suspended around the rebuild (it cannot be toggled inside a
   * transaction), a new table is created under a distinct name, data is
   * copied, the OLD table is dropped, and only then is the new one renamed
   * into place — renaming the old table out of the way first would make
   * SQLite rewrite its FK references and leave dangling constraints. Indexes
   * are dropped with the old table and re-created explicitly on the new one.
   *
   * Runs only when the existing table SQL still carries the old
   * `on delete cascade` FK; databases created from CREATE_SCHEMA_SQL are
   * skipped. The rebuild is transactional.
   */
  private migrateTaskRunsTable(): void {
    const row = this.db.queryOne<{ sql: string | null }>(
      "select sql from sqlite_master where type = 'table' and name = 'task_runs'",
    )
    const tableSql = row?.sql ?? ''
    if (!tableSql.includes('on delete cascade')) return
    this.db.exec('pragma foreign_keys = off;')
    try {
      this.db.transaction(() => {
        this.db.exec(`
          create table task_runs_new (
            id text primary key,
            task_id text references scheduled_tasks(id) on delete set null,

            status text not null check (
              status in ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out')
            ),
            result text,
            error text,

            scheduled_for integer not null,
            triggered_by text not null default 'schedule' check (
              triggered_by in ('schedule', 'manual', 'agent', 'retry')
            ),
            started_at integer,
            completed_at integer,
            duration_ms integer,

            attempt integer not null default 1,
            batch_id text not null,

            conversation_id text,

            output text,
            exit_code integer,

            catch_up_run_at integer,
            logs text
          )
        `)
        this.db.exec(`
          insert into task_runs_new (
            id, task_id, status, result, error,
            scheduled_for, triggered_by, started_at, completed_at, duration_ms,
            attempt, batch_id,
            conversation_id,
            output, exit_code, catch_up_run_at, logs
          )
          select
            id, task_id, status, result, error,
            scheduled_for, triggered_by, started_at, completed_at, duration_ms,
            attempt, batch_id,
            conversation_id,
            output, exit_code, catch_up_run_at, logs
          from task_runs
        `)
        this.db.exec('drop table task_runs')
        this.db.exec('alter table task_runs_new rename to task_runs')
        // The old indexes were dropped with the old table; re-create them on
        // the rebuilt table (names are free again now).
        this.db.exec(
          'create index if not exists idx_task_runs_task_started on task_runs(task_id, started_at)',
        )
        this.db.exec(
          'create index if not exists idx_task_runs_batch on task_runs(batch_id)',
        )
        this.db.exec(
          'create index if not exists idx_task_runs_status on task_runs(status)',
        )
      })
    } finally {
      this.db.exec('pragma foreign_keys = on;')
    }
  }

  close(): void {
    this.runtime?.close()
    this.runtime = null
  }

  tryClaimTaskExecution(
    taskId: string,
    ownerId: string,
    claimedAt: number,
    expiresAt: number,
  ): boolean {
    return this.db.transaction((database) => {
      database.exec(
        `
          insert into task_execution_claims(task_id, owner_id, claimed_at, expires_at)
          values (?, ?, ?, ?)
          on conflict(task_id) do update set
            owner_id = excluded.owner_id,
            claimed_at = excluded.claimed_at,
            expires_at = excluded.expires_at
          where task_execution_claims.expires_at <= excluded.claimed_at
        `,
        [taskId, ownerId, claimedAt, expiresAt],
      )
      const row = database.queryOne<{ owner_id: string }>(
        'select owner_id from task_execution_claims where task_id = ?',
        [taskId],
      )
      return row?.owner_id === ownerId
    })
  }

  releaseTaskExecutionClaim(taskId: string, ownerId: string): void {
    this.db.exec(
      'delete from task_execution_claims where task_id = ? and owner_id = ?',
      [taskId, ownerId],
    )
  }

  createTask(id: string, config: TaskConfig, now: number): ScheduledTask {
    const agentConfig = normalizeScheduledTaskAgentConfig(config.agentConfig)
    this.db.exec(
      `
        insert into scheduled_tasks (
          id, name, type, created_by,
          schedule_type, timezone, cron_expression, interval_seconds, one_time_date_time, next_run_time,
          script_path, agent_prompt, agent_config,
          queue_group, depends_on, continue_on_dependency_failure, priority,
          timeout_seconds, max_retries,
          enabled, notify_on, created_at, updated_at
        ) values (
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?,
          ?, ?, ?, ?, ?
        )
      `,
      [
        id,
        config.name,
        config.type,
        config.createdBy,
        config.scheduleType,
        config.timezone ?? null,
        config.cronExpression,
        config.intervalSeconds,
        config.oneTimeDateTime,
        config.nextRunTime,
        config.scriptPath,
        config.agentPrompt,
        agentConfig ? JSON.stringify(agentConfig) : null,
        config.queueGroup,
        config.dependsOn ? JSON.stringify(config.dependsOn) : null,
        config.continueOnDependencyFailure ? 1 : 0,
        config.priority,
        config.timeoutSeconds,
        config.maxRetries,
        config.enabled ? 1 : 0,
        JSON.stringify(config.notifyOn ?? []),
        now,
        now,
      ],
    )
    const task = this.getTask(id)
    if (!task) {
      throw new Error(`failed to create scheduled task ${id}`)
    }
    return task
  }

  updateTask(id: string, patch: TaskUpdate, now: number): void {
    const fields: string[] = []
    const params: unknown[] = []

    const setColumn = (column: string, value: unknown) => {
      fields.push(`${column} = ?`)
      params.push(value)
    }

    if (patch.name !== undefined) setColumn('name', patch.name)
    if (patch.type !== undefined) setColumn('type', patch.type)
    if (patch.createdBy !== undefined) setColumn('created_by', patch.createdBy)
    if (patch.scheduleType !== undefined)
      setColumn('schedule_type', patch.scheduleType)
    if (patch.timezone !== undefined) setColumn('timezone', patch.timezone)
    if (patch.cronExpression !== undefined)
      setColumn('cron_expression', patch.cronExpression)
    if (patch.intervalSeconds !== undefined)
      setColumn('interval_seconds', patch.intervalSeconds)
    if (patch.oneTimeDateTime !== undefined)
      setColumn('one_time_date_time', patch.oneTimeDateTime)
    if (patch.nextRunTime !== undefined)
      setColumn('next_run_time', patch.nextRunTime)
    if (patch.scriptPath !== undefined)
      setColumn('script_path', patch.scriptPath)
    if (patch.agentPrompt !== undefined)
      setColumn('agent_prompt', patch.agentPrompt)
    if (patch.agentConfig !== undefined)
      setColumn(
        'agent_config',
        (() => {
          const agentConfig = normalizeScheduledTaskAgentConfig(
            patch.agentConfig,
          )
          return agentConfig ? JSON.stringify(agentConfig) : null
        })(),
      )
    if (patch.queueGroup !== undefined)
      setColumn('queue_group', patch.queueGroup)
    if (patch.dependsOn !== undefined)
      setColumn(
        'depends_on',
        patch.dependsOn ? JSON.stringify(patch.dependsOn) : null,
      )
    if (patch.continueOnDependencyFailure !== undefined)
      setColumn(
        'continue_on_dependency_failure',
        patch.continueOnDependencyFailure ? 1 : 0,
      )
    if (patch.priority !== undefined) setColumn('priority', patch.priority)
    if (patch.timeoutSeconds !== undefined)
      setColumn('timeout_seconds', patch.timeoutSeconds)
    if (patch.maxRetries !== undefined)
      setColumn('max_retries', patch.maxRetries)
    if (patch.enabled !== undefined) setColumn('enabled', patch.enabled ? 1 : 0)
    if (patch.notifyOn !== undefined)
      setColumn('notify_on', JSON.stringify(patch.notifyOn))
    if (patch.lastRunAt !== undefined) setColumn('last_run_at', patch.lastRunAt)
    if (patch.lastRunStatus !== undefined)
      setColumn('last_run_status', patch.lastRunStatus)
    if (patch.lastError !== undefined) setColumn('last_error', patch.lastError)

    if (fields.length === 0) return

    setColumn('updated_at', now)
    params.push(id)

    this.db.exec(
      `update scheduled_tasks set ${fields.join(', ')} where id = ?`,
      params,
    )
  }

  getTask(id: string): ScheduledTask | null {
    const row = this.db.queryOne<ScheduledTaskDbRow>(
      'select * from scheduled_tasks where id = ?',
      [id],
    )
    return row == null ? null : fromTaskDbRow(row)
  }

  listTasks(options: { enabledOnly?: boolean } = {}): ScheduledTask[] {
    const rows =
      options.enabledOnly === true
        ? this.db.query<ScheduledTaskDbRow>(
            'select * from scheduled_tasks where enabled = 1 order by created_at desc',
          )
        : this.db.query<ScheduledTaskDbRow>(
            'select * from scheduled_tasks order by created_at desc',
          )
    return rows.map(fromTaskDbRow)
  }

  listDueTasks(now: number): ScheduledTask[] {
    const rows = this.db.query<ScheduledTaskDbRow>(
      `
        select * from scheduled_tasks
        where enabled = 1 and next_run_time is not null and next_run_time <= ?
        order by priority desc, next_run_time asc
      `,
      [now],
    )
    return rows.map(fromTaskDbRow)
  }

  /**
   * Deletes a task. The FK is `on delete set null` (not cascade), so run rows
   * are deleted here explicitly rather than by cascade — except
   * `keepRunIds`, which the scheduler passes for in-flight runs it has
   * already cancelled: those terminal CANCELLED records survive the task
   * deletion for audit (their task_id is nulled by the FK), so deleting an
   * executing task cannot lose the run record or let the run complete with a
   * false-success notice.
   */
  deleteTask(id: string, options: { keepRunIds?: string[] } = {}): void {
    const keepRunIds = options.keepRunIds ?? []
    if (keepRunIds.length > 0) {
      const placeholders = keepRunIds.map(() => '?').join(', ')
      this.db.exec(
        `delete from task_runs where task_id = ? and id not in (${placeholders})`,
        [id, ...keepRunIds],
      )
    } else {
      this.db.exec('delete from task_runs where task_id = ?', [id])
    }
    this.db.exec('delete from scheduled_tasks where id = ?', [id])
  }

  insertRun(run: TaskRunInsert): void {
    this.db.exec(
      `
        insert into task_runs (
          id, task_id, status, result, error,
          scheduled_for, triggered_by, started_at, completed_at, duration_ms,
          attempt, batch_id,
          conversation_id,
          output, exit_code, catch_up_run_at, logs
        ) values (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?,
          ?,
          ?, ?, ?, ?
        )
      `,
      [
        run.id,
        run.taskId,
        run.status,
        run.result,
        run.error,
        run.scheduledFor,
        run.triggeredBy,
        run.startedAt,
        run.completedAt,
        run.durationMs,
        run.attempt,
        run.batchId,
        run.conversationId,
        run.output,
        run.exitCode,
        run.catchUpRunAt,
        run.logs ? JSON.stringify(run.logs) : null,
      ],
    )
  }

  updateRun(id: string, patch: Partial<Omit<TaskRun, 'id' | 'taskId'>>): void {
    const fields: string[] = []
    const params: unknown[] = []

    const setColumn = (column: string, value: unknown) => {
      fields.push(`${column} = ?`)
      params.push(value)
    }

    if (patch.status !== undefined) setColumn('status', patch.status)
    if (patch.result !== undefined) setColumn('result', patch.result)
    if (patch.error !== undefined) setColumn('error', patch.error)
    if (patch.scheduledFor !== undefined)
      setColumn('scheduled_for', patch.scheduledFor)
    if (patch.triggeredBy !== undefined)
      setColumn('triggered_by', patch.triggeredBy)
    if (patch.startedAt !== undefined) setColumn('started_at', patch.startedAt)
    if (patch.completedAt !== undefined)
      setColumn('completed_at', patch.completedAt)
    if (patch.durationMs !== undefined)
      setColumn('duration_ms', patch.durationMs)
    if (patch.attempt !== undefined) setColumn('attempt', patch.attempt)
    if (patch.batchId !== undefined) setColumn('batch_id', patch.batchId)
    if (patch.conversationId !== undefined)
      setColumn('conversation_id', patch.conversationId)
    if (patch.output !== undefined) setColumn('output', patch.output)
    if (patch.exitCode !== undefined) setColumn('exit_code', patch.exitCode)
    if (patch.catchUpRunAt !== undefined)
      setColumn('catch_up_run_at', patch.catchUpRunAt)
    if (patch.logs !== undefined)
      setColumn('logs', patch.logs ? JSON.stringify(patch.logs) : null)

    if (fields.length === 0) return

    params.push(id)
    this.db.exec(
      `update task_runs set ${fields.join(', ')} where id = ?`,
      params,
    )
  }

  getRun(id: string): TaskRun | null {
    const row = this.db.queryOne<TaskRunDbRow>(
      'select * from task_runs where id = ?',
      [id],
    )
    return row == null ? null : fromRunDbRow(row)
  }

  listRunsByTask(
    taskId: string,
    options: { status?: TaskRunStatus; limit?: number; offset?: number } = {},
  ): { runs: TaskRun[]; total: number } {
    const limit = options.limit ?? 20
    const offset = options.offset ?? 0
    // status is optional, so the WHERE clause (and its param list) is built once and reused
    // for both the page query and the count query — keeping "total" scoped to the same filter
    // as the page itself (see the design doc's §7 note on why total must reflect the filter).
    const where = options.status ? 'task_id = ? and status = ?' : 'task_id = ?'
    const whereParams = options.status ? [taskId, options.status] : [taskId]

    const rows = this.db.query<TaskRunDbRow>(
      `
        select * from task_runs
        where ${where}
        order by started_at desc, scheduled_for desc
        limit ? offset ?
      `,
      [...whereParams, limit, offset],
    )
    const totalRow = this.db.queryOne<{ count: number }>(
      `select count(*) as count from task_runs where ${where}`,
      whereParams,
    )
    return { runs: rows.map(fromRunDbRow), total: totalRow?.count ?? 0 }
  }

  /** Full-history aggregate (not scoped to any page/filter) — used for the "success rate / avg duration" summary in the UI, which must stay accurate regardless of the current run-history pagination/filter. */
  getTaskStatistics(taskId: string): TaskStatistics {
    const row = this.db.queryOne<{
      total: number
      succeeded: number
      failed: number
      avg_duration: number | null
    }>(
      `
        select
          count(*) as total,
          sum(case when status = 'completed' then 1 else 0 end) as succeeded,
          sum(case when status in ('failed', 'timed_out', 'cancelled') then 1 else 0 end) as failed,
          avg(case when status = 'completed' then duration_ms end) as avg_duration
        from task_runs
        where task_id = ?
      `,
      [taskId],
    )
    const totalRuns = row?.total ?? 0
    const successCount = row?.succeeded ?? 0
    const failureCount = row?.failed ?? 0
    return {
      totalRuns,
      successCount,
      failureCount,
      successRate:
        totalRuns === 0
          ? 0
          : Math.round((successCount / totalRuns) * 1000) / 10,
      averageDurationMs:
        row?.avg_duration != null ? Math.round(row.avg_duration) : null,
    }
  }

  /** All runs across every task, newest first — the "All runs" history view. The status filter and its count query share one WHERE clause, mirroring listRunsByTask. */
  listAllRuns(
    options: { status?: TaskRunStatus; limit?: number; offset?: number } = {},
  ): { runs: TaskRun[]; total: number } {
    const limit = options.limit ?? 20
    const offset = options.offset ?? 0
    const where = options.status ? 'status = ?' : ''
    const whereParams = options.status ? [options.status] : []

    const rows = this.db.query<TaskRunDbRow>(
      `
        select * from task_runs
        ${where ? `where ${where}` : ''}
        order by started_at desc, scheduled_for desc
        limit ? offset ?
      `,
      [...whereParams, limit, offset],
    )
    const totalRow = this.db.queryOne<{ count: number }>(
      `select count(*) as count from task_runs ${where ? `where ${where}` : ''}`,
      whereParams,
    )
    return { runs: rows.map(fromRunDbRow), total: totalRow?.count ?? 0 }
  }

  /** Used at startup to find runs left behind in RUNNING state by a previous crash/force-quit (see ScheduledTasksService.recoverOrphanedRuns). */
  listRunningRuns(): TaskRun[] {
    const rows = this.db.query<TaskRunDbRow>(
      'select * from task_runs where status = ? order by started_at asc',
      [TaskRunStatus.RUNNING],
    )
    return rows.map(fromRunDbRow)
  }

  /**
   * Bounded run-history retention — pure deletion, no migration needed. A hard
   * age cutoff first drops runs older than `olderThanMs` (recency falls back to
   * scheduled_for for legacy rows without started_at), then each task is capped
   * at its `keepLastNPerTask` most recent runs (same recency order as
   * listRunsByTask), so a long-lived vault can't grow task_runs without bound.
   * Only TERMINAL runs are ever pruned (same rule as cherry-studio's
   * JobManager GC): a RUNNING row is live state that crash-recovery
   * (recoverOrphanedRuns) must still find, whatever its age. Returns the total
   * number of deleted rows.
   */
  pruneRuns(options: {
    olderThanMs: number
    keepLastNPerTask: number
  }): number {
    const now = Date.now()
    const ageCutoff = now - options.olderThanMs
    const terminalStatuses = [
      TaskRunStatus.COMPLETED,
      TaskRunStatus.FAILED,
      TaskRunStatus.CANCELLED,
      TaskRunStatus.TIMED_OUT,
    ]
      .map((status) => `'${status}'`)
      .join(', ')
    this.db.exec(
      `delete from task_runs where status in (${terminalStatuses}) and coalesce(started_at, scheduled_for) < ?`,
      [ageCutoff],
    )
    const ageDeleted =
      this.db.queryOne<{ n: number }>('select changes() as n')?.n ?? 0
    this.db.exec(
      `
        delete from task_runs where id in (
          select id from (
            select
              id,
              row_number() over (
                partition by task_id
                order by coalesce(started_at, scheduled_for) desc, scheduled_for desc, id desc
              ) as rn
            from task_runs
            where status in (${terminalStatuses})
          )
          where rn > ?
        )
      `,
      [options.keepLastNPerTask],
    )
    const keepDeleted =
      this.db.queryOne<{ n: number }>('select changes() as n')?.n ?? 0
    return ageDeleted + keepDeleted
  }

  private get db(): SqliteNativeRuntimeFacade {
    if (this.runtime == null) {
      throw new Error('scheduled tasks store is not open')
    }
    return this.runtime
  }
}

export function createScheduledTasksStore(
  rootDir: string,
): ScheduledTasksStore {
  const store = new ScheduledTasksStore(rootDir)
  store.open()
  return store
}

function fromTaskDbRow(row: ScheduledTaskDbRow): ScheduledTask {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    createdBy: row.created_by,
    scheduleType: row.schedule_type,
    timezone: row.timezone ?? null,
    cronExpression: row.cron_expression,
    intervalSeconds: row.interval_seconds,
    oneTimeDateTime: row.one_time_date_time,
    nextRunTime: row.next_run_time,
    scriptPath: row.script_path,
    agentPrompt: row.agent_prompt,
    agentConfig: normalizeScheduledTaskAgentConfig(
      row.agent_config
        ? (JSON.parse(row.agent_config) as ScheduledTaskAgentConfig)
        : null,
    ),
    queueGroup: row.queue_group,
    dependsOn: row.depends_on ? (JSON.parse(row.depends_on) as string[]) : null,
    continueOnDependencyFailure: row.continue_on_dependency_failure === 1,
    priority: row.priority,
    timeoutSeconds: row.timeout_seconds,
    maxRetries: row.max_retries,
    enabled: row.enabled === 1,
    notifyOn: JSON.parse(row.notify_on) as ('success' | 'failure')[],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastRunAt: row.last_run_at,
    lastRunStatus: row.last_run_status,
    lastError: row.last_error,
  }
}

function fromRunDbRow(row: TaskRunDbRow): TaskRun {
  return {
    id: row.id,
    taskId: row.task_id,
    status: row.status,
    result: row.result,
    error: row.error,
    scheduledFor: row.scheduled_for,
    triggeredBy: row.triggered_by,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration_ms,
    attempt: row.attempt,
    batchId: row.batch_id,
    conversationId: row.conversation_id,
    output: row.output,
    exitCode: row.exit_code,
    catchUpRunAt: row.catch_up_run_at,
    logs: row.logs ? (JSON.parse(row.logs) as TaskRunLogEntry[]) : null,
  }
}
