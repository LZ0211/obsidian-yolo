/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { openSqliteRuntime } from '../../database/sqlite/sqliteNativeRuntime'

import {
  type TaskConfig,
  type TaskRunInsert,
  TaskRunStatus,
  createScheduledTasksStore,
} from './scheduledTasksStore'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-tasks-store-'))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  })
}

function makeTaskConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    name: 'Nightly summary',
    type: 'agent',
    createdBy: 'user',
    scheduleType: 'cron',
    cronExpression: '0 9 * * *',
    intervalSeconds: null,
    oneTimeDateTime: null,
    nextRunTime: 1000,
    scriptPath: null,
    agentPrompt: 'summarize today',
    agentConfig: {
      assistantId: 'assistant-1',
      temporaryApprovedToolNames: ['yolo_local__fs_read'],
    },
    queueGroup: null,
    dependsOn: null,
    continueOnDependencyFailure: false,
    priority: 5,
    timeoutSeconds: 300,
    maxRetries: 3,
    enabled: true,
    notifyOn: [],
    ...overrides,
  }
}

function makeRunInsert(overrides: Partial<TaskRunInsert> = {}): TaskRunInsert {
  return {
    id: 'run-1',
    taskId: 'task-1',
    status: TaskRunStatus.COMPLETED,
    result: 'ok',
    error: null,
    scheduledFor: 1000,
    triggeredBy: 'schedule',
    startedAt: 1000,
    completedAt: 1100,
    durationMs: 100,
    attempt: 1,
    batchId: 'batch-1',
    conversationId: 'conv-1',
    output: null,
    exitCode: null,
    catchUpRunAt: null,
    logs: null,
    ...overrides,
  }
}

describe('ScheduledTasksStore', () => {
  it('creates a task and round-trips JSON-typed columns', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const created = store.createTask(
        'task-1',
        makeTaskConfig({
          dependsOn: ['task-0'],
          notifyOn: ['failure'],
          agentConfig: {
            assistantId: ' assistant-1 ',
            temporaryApprovedToolNames: [
              ' yolo_local__fs_read ',
              'yolo_local__fs_read',
            ],
          },
        }),
        1000,
      )

      expect(created).toMatchObject({
        id: 'task-1',
        name: 'Nightly summary',
        agentConfig: {
          assistantId: 'assistant-1',
          temporaryApprovedToolNames: ['yolo_local__fs_read'],
        },
        dependsOn: ['task-0'],
        notifyOn: ['failure'],
        continueOnDependencyFailure: false,
        enabled: true,
        createdAt: 1000,
        updatedAt: 1000,
      })

      expect(store.getTask('task-1')).toEqual(created)
      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('normalizes task-scoped grants at the storage boundary', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const toolNames = Array.from(
        { length: 70 },
        (_, index) => `server__tool_${index}`,
      )
      store.createTask(
        'task-1',
        makeTaskConfig({
          agentConfig: { temporaryApprovedToolNames: toolNames },
        }),
        1000,
      )

      expect(
        store.getTask('task-1')?.agentConfig?.temporaryApprovedToolNames,
      ).toHaveLength(64)
      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('updates only the provided fields and bumps updatedAt', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)

      store.updateTask(
        'task-1',
        { enabled: false, lastRunStatus: TaskRunStatus.FAILED },
        2000,
      )

      const updated = store.getTask('task-1')
      expect(updated?.enabled).toBe(false)
      expect(updated?.lastRunStatus).toBe(TaskRunStatus.FAILED)
      expect(updated?.updatedAt).toBe(2000)
      expect(updated?.name).toBe('Nightly summary')

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('lists only due, enabled tasks ordered by priority then nextRunTime', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask(
        'due-low-priority',
        makeTaskConfig({ nextRunTime: 500, priority: 3 }),
        1,
      )
      store.createTask(
        'due-high-priority',
        makeTaskConfig({ nextRunTime: 900, priority: 8 }),
        1,
      )
      store.createTask(
        'not-due-yet',
        makeTaskConfig({ nextRunTime: 5000, priority: 9 }),
        1,
      )
      store.createTask(
        'disabled',
        makeTaskConfig({ nextRunTime: 100, priority: 9, enabled: false }),
        1,
      )

      const due = store.listDueTasks(1000)
      expect(due.map((t) => t.id)).toEqual([
        'due-high-priority',
        'due-low-priority',
      ])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('deletes a task and its run history', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.insertRun(makeRunInsert({ taskId: 'task-1' }))

      expect(store.getRun('run-1')).not.toBeNull()

      store.deleteTask('task-1')

      expect(store.getRun('run-1')).toBeNull()
      expect(store.getTask('task-1')).toBeNull()
      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('migrates nullable task runs back to a required cascading task relation', () => {
    const dir = makeTempDir()
    try {
      // Hand-build the temporary nullable shape used by the T1 fix batch.
      const dbPath = path.join(dir, 'scheduled-tasks.sqlite')
      const legacy = openSqliteRuntime({ dbPath })
      legacy.exec('pragma foreign_keys = on;')
      legacy.exec(`
        create table scheduled_tasks (
          id text primary key,
          name text not null,
          type text not null,
          created_by text not null,
          schedule_type text not null,
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
          last_run_status text,
          last_error text
        )
      `)
      legacy.exec(`
        create table task_runs (
          id text primary key,
          task_id text references scheduled_tasks(id) on delete set null,
          status text not null,
          result text,
          error text,
          scheduled_for integer not null,
          triggered_by text not null,
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
      legacy.exec(
        "insert into scheduled_tasks (id, name, type, created_by, schedule_type, notify_on, created_at, updated_at) values ('task-1', 'Legacy', 'agent', 'user', 'cron', '[]', 1000, 1000)",
      )
      legacy.exec(`
        insert into task_runs (
          id, task_id, status, result, error,
          scheduled_for, triggered_by, started_at, completed_at, duration_ms,
          attempt, batch_id,
          conversation_id,
          output, exit_code, catch_up_run_at, logs
        ) values (
          'run-1', 'task-1', 'completed', 'ok', null,
          1000, 'schedule', 1000, 1100, 100,
          1, 'batch-1',
          null,
          null, 0, null, null
        )
      `)
      legacy.exec(`
        insert into task_runs (
          id, task_id, status, result, error,
          scheduled_for, triggered_by, started_at, completed_at, duration_ms,
          attempt, batch_id, conversation_id,
          output, exit_code, catch_up_run_at, logs
        ) values (
          'run-orphan', null, 'cancelled', null, null,
          1000, 'manual', 1000, 1001, 1,
          1, 'batch-orphan', null,
          null, null, null, null
        )
      `)
      legacy.close()

      const store = createScheduledTasksStore(dir)
      const migratedRun = store.getRun('run-1')
      const orphanedRun = store.getRun('run-orphan')
      store.close()

      // Data survived the rebuild.
      expect(migratedRun).toMatchObject({
        id: 'run-1',
        taskId: 'task-1',
        status: TaskRunStatus.COMPLETED,
        result: 'ok',
      })
      expect(orphanedRun).toBeNull()

      // The table is back to the domain model: every run belongs to a task,
      // and deleting that task deletes its history.
      const raw = openSqliteRuntime({ dbPath })
      const tableSql =
        raw.queryOne<{ sql: string | null }>(
          "select sql from sqlite_master where type = 'table' and name = 'task_runs'",
        )?.sql ?? ''
      expect(tableSql).toContain('task_id text not null')
      expect(tableSql).toContain('on delete cascade')
      expect(tableSql).not.toContain('on delete set null')
      raw.exec('delete from scheduled_tasks where id = ?', ['task-1'])
      expect(
        raw.queryOne('select id from task_runs where id = ?', ['run-1']),
      ).toBeUndefined()
      raw.close()
    } finally {
      cleanup(dir)
    }
  })

  it('paginates runs by task with a total count', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      for (let i = 0; i < 5; i++) {
        store.insertRun(
          makeRunInsert({
            id: `run-${i}`,
            taskId: 'task-1',
            batchId: `batch-${i}`,
            startedAt: 1000 + i,
          }),
        )
      }

      const page1 = store.listRunsByTask('task-1', { limit: 2, offset: 0 })
      expect(page1.total).toBe(5)
      expect(page1.runs).toHaveLength(2)

      const page3 = store.listRunsByTask('task-1', { limit: 2, offset: 4 })
      expect(page3.runs).toHaveLength(1)

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('lists runs across every task, newest first, with optional status filter', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.createTask('task-2', makeTaskConfig(), 1000)
      store.insertRun(
        makeRunInsert({
          id: 'run-a',
          taskId: 'task-1',
          status: TaskRunStatus.COMPLETED,
          startedAt: 3000,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 'run-b',
          taskId: 'task-2',
          status: TaskRunStatus.FAILED,
          startedAt: 2000,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 'run-c',
          taskId: 'task-1',
          status: TaskRunStatus.FAILED,
          startedAt: 1000,
        }),
      )

      const all = store.listAllRuns({ limit: 10, offset: 0 })
      expect(all.total).toBe(3)
      expect(all.runs.map((r) => r.id)).toEqual(['run-a', 'run-b', 'run-c'])

      const failed = store.listAllRuns({ status: TaskRunStatus.FAILED })
      expect(failed.total).toBe(2)
      expect(failed.runs.map((r) => r.id)).toEqual(['run-b', 'run-c'])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('updates run status and reads back JSON logs', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.insertRun(
        makeRunInsert({ taskId: 'task-1', status: TaskRunStatus.RUNNING }),
      )

      store.updateRun('run-1', {
        status: TaskRunStatus.COMPLETED,
        completedAt: 2000,
        logs: [{ timestamp: 1500, level: 'info', message: 'done' }],
      })

      const run = store.getRun('run-1')
      expect(run?.status).toBe(TaskRunStatus.COMPLETED)
      expect(run?.logs).toEqual([
        { timestamp: 1500, level: 'info', message: 'done' },
      ])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('paginates runs by task filtered by status, with total scoped to that filter', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.insertRun(
        makeRunInsert({
          id: 'run-completed-1',
          status: TaskRunStatus.COMPLETED,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 'run-completed-2',
          status: TaskRunStatus.COMPLETED,
        }),
      )
      store.insertRun(
        makeRunInsert({ id: 'run-failed-1', status: TaskRunStatus.FAILED }),
      )

      const failedOnly = store.listRunsByTask('task-1', {
        status: TaskRunStatus.FAILED,
      })
      expect(failedOnly.total).toBe(1)
      expect(failedOnly.runs.map((r) => r.id)).toEqual(['run-failed-1'])

      const completedOnly = store.listRunsByTask('task-1', {
        status: TaskRunStatus.COMPLETED,
        limit: 1,
      })
      expect(completedOnly.total).toBe(2)
      expect(completedOnly.runs).toHaveLength(1)

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('computes task statistics across the full run history, ignoring pagination', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)

      expect(store.getTaskStatistics('task-1')).toEqual({
        totalRuns: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        averageDurationMs: null,
      })

      store.insertRun(
        makeRunInsert({
          id: 'run-1',
          status: TaskRunStatus.COMPLETED,
          startedAt: 1000,
          completedAt: 1100,
          durationMs: 100,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 'run-2',
          status: TaskRunStatus.COMPLETED,
          startedAt: 1000,
          completedAt: 1300,
          durationMs: 300,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 'run-3',
          status: TaskRunStatus.FAILED,
          startedAt: 1000,
          completedAt: null,
          durationMs: null,
        }),
      )

      expect(store.getTaskStatistics('task-1')).toEqual({
        totalRuns: 3,
        successCount: 2,
        failureCount: 1,
        successRate: 66.7,
        averageDurationMs: 200,
      })

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('lists only runs left in RUNNING status, for crash-recovery scans', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.insertRun(
        makeRunInsert({
          id: 'run-running',
          taskId: 'task-1',
          status: TaskRunStatus.RUNNING,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 'run-completed',
          taskId: 'task-1',
          status: TaskRunStatus.COMPLETED,
        }),
      )

      const running = store.listRunningRuns()
      expect(running.map((r) => r.id)).toEqual(['run-running'])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('prunes runs by age and keeps only the last N per task', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.createTask('task-2', makeTaskConfig({ name: 'Task 2' }), 1000)

      const now = Date.now()
      const dayMs = 24 * 60 * 60 * 1000
      const olderThanMs = 30 * dayMs

      // task-1: 2 runs older than 30 days, 1 recent run, and 1 legacy-shaped
      // run with no started_at (only scheduled_for) that is also over-age.
      store.insertRun(
        makeRunInsert({
          id: 't1-old-1',
          taskId: 'task-1',
          startedAt: now - 35 * dayMs,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 't1-old-2',
          taskId: 'task-1',
          startedAt: now - 32 * dayMs,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 't1-recent',
          taskId: 'task-1',
          startedAt: now - 1 * dayMs,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 't1-legacy-old',
          taskId: 'task-1',
          startedAt: null,
          scheduledFor: now - 40 * dayMs,
        }),
      )

      // task-2: 1 old run + 3 recent runs — keep-last-N must trim the oldest recent one.
      store.insertRun(
        makeRunInsert({
          id: 't2-old',
          taskId: 'task-2',
          startedAt: now - 31 * dayMs,
        }),
      )
      // A RUNNING run is live state, never pruned — however old it is
      // (crash-recovery must still find it; same rule as cherry's JobManager GC).
      store.insertRun(
        makeRunInsert({
          id: 't1-running-ancient',
          taskId: 'task-1',
          status: TaskRunStatus.RUNNING,
          startedAt: now - 40 * dayMs,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 't2-recent-1',
          taskId: 'task-2',
          startedAt: now - 2 * dayMs,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 't2-recent-2',
          taskId: 'task-2',
          startedAt: now - 3 * dayMs,
        }),
      )
      store.insertRun(
        makeRunInsert({
          id: 't2-recent-3',
          taskId: 'task-2',
          startedAt: now - 4 * dayMs,
        }),
      )

      const deleted = store.pruneRuns({ olderThanMs, keepLastNPerTask: 2 })

      // Age cutoff deletes t1-old-1 / t1-old-2 / t1-legacy-old / t2-old (4);
      // keep-last-N(2) then trims the oldest remaining task-2 run (t2-recent-3).
      // The ancient RUNNING run survives — only terminal runs are pruned.
      expect(deleted).toBe(5)
      expect(store.getRun('t1-running-ancient')).toMatchObject({
        status: TaskRunStatus.RUNNING,
      })
      // task-1 keeps its recent terminal run AND the untouched RUNNING one.
      expect(store.listRunsByTask('task-1').runs.map((r) => r.id)).toEqual([
        't1-recent',
        't1-running-ancient',
      ])
      expect(store.listRunsByTask('task-2').runs.map((r) => r.id)).toEqual([
        't2-recent-1',
        't2-recent-2',
      ])
      expect(store.getRun('t1-old-1')).toBeNull()
      expect(store.getRun('t1-legacy-old')).toBeNull()
      expect(store.getRun('t2-old')).toBeNull()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('persists across reopen against the same rootDir', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.close()

      const reopened = createScheduledTasksStore(dir)
      expect(reopened.getTask('task-1')).not.toBeNull()
      reopened.close()
    } finally {
      cleanup(dir)
    }
  })

  it('rebuilds the tasks table so databases created before the RAG action types accept them', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.close()

      // Simulate a database from before the RAG action types: the tasks table
      // only accepts ('script', 'agent') and already holds a task plus a run
      // row referencing it (exercises FK-safe rebuild).
      const runtime = openSqliteRuntime({
        dbPath: path.join(dir, 'scheduled-tasks.sqlite'),
      })
      runtime.exec('drop table scheduled_tasks')
      runtime.exec(OLD_TASKS_TABLE_SQL)
      runtime.exec(
        `
          insert into scheduled_tasks (
            id, name, type, created_by, schedule_type, cron_expression,
            interval_seconds, one_time_date_time, next_run_time,
            script_path, agent_prompt, agent_config,
            queue_group, depends_on, continue_on_dependency_failure, priority,
            timeout_seconds, max_retries, enabled, notify_on, created_at, updated_at
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          'task-1',
          'legacy script task',
          'script',
          'user',
          'once',
          null,
          null,
          null,
          1000,
          null,
          null,
          null,
          null,
          null,
          0,
          5,
          300,
          3,
          1,
          '[]',
          900,
          900,
        ],
      )
      runtime.exec(
        `
          insert into task_runs (
            id, task_id, status, scheduled_for, triggered_by, attempt, batch_id
          ) values (?, ?, ?, ?, ?, ?, ?)
        `,
        ['run-1', 'task-1', 'completed', 1000, 'schedule', 1, 'batch-1'],
      )
      runtime.close()

      store.open()
      // The migration widens the CHECK constraint so the new types are accepted...
      const created = store.createTask(
        'task-2',
        makeTaskConfig({ type: 'ragIndex', agentPrompt: null }),
        2000,
      )
      expect(created.type).toBe('ragIndex')
      // ...and legacy tasks and their runs survive the rebuild intact.
      expect(store.getTask('task-1')).toMatchObject({
        name: 'legacy script task',
        type: 'script',
      })
      expect(store.getRun('run-1')).toMatchObject({
        id: 'run-1',
        taskId: 'task-1',
      })
      // The rebuild must leave task_runs's FK pointing at scheduled_tasks:
      // the previous rename-old-first order made SQLite rewrite the FK to
      // reference the dropped table, failing every run insert/update with
      // "no such table".
      store.insertRun(
        makeRunInsert({
          id: 'run-2',
          taskId: 'task-2',
          status: TaskRunStatus.RUNNING,
        }),
      )
      store.updateRun('run-2', {
        status: TaskRunStatus.COMPLETED,
        completedAt: 3000,
      })
      expect(store.getRun('run-2')).toMatchObject({
        id: 'run-2',
        status: TaskRunStatus.COMPLETED,
      })
      store.close()

      // The rebuilt table must carry its indexes (rename-first order left
      // the new table index-less: create index if not exists was skipped
      // while the old table still owned the names).
      const verify = openSqliteRuntime({
        dbPath: path.join(dir, 'scheduled-tasks.sqlite'),
      })
      const indexes = verify.query<{ name: string }>(
        "select name from sqlite_master where type = 'index' and tbl_name = 'scheduled_tasks'",
      )
      expect(indexes.map((r) => r.name)).toEqual(
        expect.arrayContaining([
          'idx_scheduled_tasks_next_run_time',
          'idx_scheduled_tasks_queue_group',
        ]),
      )
      verify.close()
    } finally {
      cleanup(dir)
    }
  })
})

/** The tasks table as it existed before the RAG action types (same columns as today, original two-value type CHECK). */
const OLD_TASKS_TABLE_SQL = `
  create table scheduled_tasks (
    id text primary key,
    name text not null,
    type text not null check (type in ('script', 'agent')),
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
    last_run_status text,
    last_error text
  )
`
