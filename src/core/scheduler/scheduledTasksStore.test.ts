/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

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
    parentRunId: null,
    batchId: 'batch-1',
    conversationId: 'conv-1',
    messagesCount: 3,
    output: null,
    exitCode: null,
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

  it('cascades task_runs deletion when the parent task is deleted', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.insertRun(makeRunInsert({ taskId: 'task-1' }))

      expect(store.getRun('run-1')).not.toBeNull()

      store.deleteTask('task-1')

      expect(store.getRun('run-1')).toBeNull()
      store.close()
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
})
