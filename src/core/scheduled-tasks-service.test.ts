/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type {
  YoloAgentApi,
  YoloAgentRunRequest,
  YoloAgentRunResult,
} from './agent/agent-api'
import { ScheduledTasksService } from './scheduled-tasks-service'
import {
  type TaskConfig,
  type TaskRunInsert,
  TaskRunStatus,
  createScheduledTasksStore,
} from './scheduler/scheduledTasksStore'
import { TaskEventBus } from './scheduler/task-event-bus'
import { TaskExecutor } from './scheduler/task-executor'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-tasks-service-'))
}

function cleanup(dir: string): void {
  try {
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    })
  } catch {
    // Best-effort: see scheduler.test.ts for why this is swallowed on Windows.
  }
}

function makeTaskConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    name: 'Nightly summary',
    type: 'agent',
    createdBy: 'user',
    scheduleType: 'interval',
    cronExpression: null,
    intervalSeconds: 60,
    oneTimeDateTime: null,
    nextRunTime: null,
    scriptPath: null,
    agentPrompt: 'summarize today',
    agentConfig: null,
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

function makeAgentApi(
  run: (request: YoloAgentRunRequest) => Promise<YoloAgentRunResult>,
): YoloAgentApi {
  return {
    run,
    // eslint-disable-next-line require-yield -- test double never streams, only throws if called
    stream: async function* () {
      throw new Error('not used in these tests')
    },
    abort: () => false,
  }
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/** A run promise the test controls, so it can hold a run in flight across a cleanup(). */
function makeDeferredAgentApi(): {
  agentApi: YoloAgentApi
  resolveRun: (result: YoloAgentRunResult) => void
} {
  let resolve!: (result: YoloAgentRunResult) => void
  const agentApi = makeAgentApi(
    () =>
      new Promise((res) => {
        resolve = res
      }),
  )
  return { agentApi, resolveRun: (result) => resolve(result) }
}

function makeRunInsert(overrides: Partial<TaskRunInsert> = {}): TaskRunInsert {
  return {
    id: 'run-1',
    taskId: 'task-1',
    status: TaskRunStatus.RUNNING,
    result: null,
    error: null,
    scheduledFor: 1000,
    triggeredBy: 'schedule',
    startedAt: 1000,
    completedAt: null,
    durationMs: null,
    attempt: 1,
    batchId: 'batch-1',
    conversationId: null,
    output: null,
    exitCode: null,
    catchUpRunAt: null,
    logs: null,
    ...overrides,
  }
}

describe('ScheduledTasksService', () => {
  it('createTask/listTasks/updateTask/deleteTask round-trip through the store', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'c',
            text: '',
            status: 'completed',
          })),
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })

      const created = await service.createTask(makeTaskConfig({ name: 'A' }))
      let tasks = await service.listTasks()
      expect(tasks).toHaveLength(1)
      expect(tasks[0]?.name).toBe('A')

      await service.updateTask(created.id, { name: 'B' })
      tasks = await service.listTasks()
      expect(tasks[0]?.name).toBe('B')

      await service.deleteTask(created.id)
      expect(await service.listTasks()).toHaveLength(0)

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('toggleTasks applies to every id in the batch', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'c',
            text: '',
            status: 'completed',
          })),
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })

      const a = await service.createTask(makeTaskConfig({ name: 'A' }))
      const b = await service.createTask(makeTaskConfig({ name: 'B' }))

      await service.toggleTasks([a.id, b.id], false)
      const tasks = await service.listTasks()
      expect(tasks.find((task) => task.id === a.id)?.enabled).toBe(false)
      expect(tasks.find((task) => task.id === b.id)?.enabled).toBe(false)

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('listAllRuns spans every task and promoteTaskToFront only touches the queue', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const { agentApi, resolveRun } = makeDeferredAgentApi()
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })
      const a = await service.createTask(makeTaskConfig({ name: 'A' }))
      const b = await service.createTask(makeTaskConfig({ name: 'B' }))
      await service.initialize()

      // Two manual runs behind the maxConcurrent=1 ceiling: the first
      // executes, the second waits in the queue.
      const first = await service.executeTaskNow(a.id)
      expect(first.outcome).toBe('started')
      const second = await service.executeTaskNow(b.id)
      expect(second.outcome).toBe('queued')

      // promoteTaskToFront is TRANSIENT: B jumps to the front of the queue,
      // but the stored priority is untouched (permanent priority lives in the
      // task editor).
      expect(await service.promoteTaskToFront(b.id)).toBe(true)
      const pending = service.getPendingTasks()
      expect(pending.map((i) => i.taskId)).toEqual([b.id])
      expect(pending[0]?.priority).toBe(10)
      expect(store.getTask(b.id)?.priority).toBe(5)
      expect(await service.promoteTaskToFront('missing')).toBe(false)

      const { runs, total } = await service.listAllRuns({
        limit: 10,
        offset: 0,
      })
      expect(total).toBe(1)
      expect(runs[0]?.taskId).toBe(a.id)

      service.shutdown()
      resolveRun({ conversationId: 'c', text: 'done', status: 'completed' })
      await flushPromises()
      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('executeTaskNow runs a task to completion and getTaskRun/listTaskRuns/getTaskStatistics reflect it', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'conv-1',
            text: 'done',
            status: 'completed',
          })),
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })
      const task = await service.createTask(makeTaskConfig())

      const result = await service.executeTaskNow(task.id)
      expect(result.outcome).toBe('started')
      if (result.outcome !== 'started') throw new Error('unreachable')
      await flushPromises()

      const run = await service.getTaskRun(result.runId)
      expect(run.status).toBe(TaskRunStatus.COMPLETED)

      const { runs, total } = await service.listTaskRuns(task.id, {
        limit: 10,
        offset: 0,
      })
      expect(total).toBe(1)
      expect(runs).toHaveLength(1)

      const stats = await service.getTaskStatistics(task.id)
      expect(stats.totalRuns).toBe(1)
      expect(stats.successCount).toBe(1)

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('getTaskRun rejects for a run that does not exist', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'c',
            text: '',
            status: 'completed',
          })),
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })

      await expect(service.getTaskRun('missing')).rejects.toThrow()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('queue control (pause/resume/clear/status) delegates straight through to the scheduler', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'c',
            text: '',
            status: 'completed',
          })),
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })

      expect(service.getQueueStatus().paused).toBe(false)
      service.pauseQueue()
      expect(service.getQueueStatus().paused).toBe(true)
      service.resumeQueue()
      expect(service.getQueueStatus().paused).toBe(false)

      expect(service.getPendingTasks()).toEqual([])
      expect(service.getExecutingTasks()).toEqual([])

      service.clearQueue()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('subscribeToAllTaskEvents/subscribeToTask/subscribeToTaskRun route events from the shared event bus', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'conv-1',
            text: 'done',
            status: 'completed',
          })),
      })
      const eventBus = new TaskEventBus()
      const service = new ScheduledTasksService({ store, eventBus, executor })
      const task = await service.createTask(makeTaskConfig())

      const allEvents: string[] = []
      const taskEvents: string[] = []
      const unsubAll = service.subscribeToAllTaskEvents((e) =>
        allEvents.push(e.type),
      )
      const unsubTask = service.subscribeToTask(task.id, (e) =>
        taskEvents.push(e.type),
      )

      const result = await service.executeTaskNow(task.id)
      if (result.outcome !== 'started') throw new Error('unreachable')

      const runEvents: string[] = []
      const unsubRun = service.subscribeToTaskRun(result.runId, (e) =>
        runEvents.push(e.type),
      )

      await flushPromises()

      expect(allEvents).toEqual(['task_started', 'task_completed'])
      expect(taskEvents).toEqual(['task_started', 'task_completed'])
      expect(runEvents).toEqual(['task_completed'])

      unsubAll()
      unsubTask()
      unsubRun()
      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('cancelTaskRun is a silent no-op for unknown run ids', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'c',
            text: '',
            status: 'completed',
          })),
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })

      await expect(
        service.cancelTaskRun('some-run-id'),
      ).resolves.toBeUndefined()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('initialize() recovers runs orphaned by a previous crash exactly once', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.insertRun(makeRunInsert({ id: 'run-orphaned', taskId: 'task-1' }))
      const listRunningRuns = jest.spyOn(store, 'listRunningRuns')

      const executor = new TaskExecutor({
        getAgentApi: () => {
          throw new Error('not used in this test')
        },
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })

      await service.initialize()

      // Recovery is driven by the scheduler's startup hook and runs before its first due-check.
      expect(listRunningRuns).toHaveBeenCalledTimes(1)

      const run = store.getRun('run-orphaned')
      expect(run?.status).toBe(TaskRunStatus.CANCELLED)
      expect(run?.error).toBeTruthy()

      const task = store.getTask('task-1')
      expect(task?.lastRunStatus).toBe(TaskRunStatus.CANCELLED)
      expect(task?.lastError).toBeTruthy()

      await service.cleanup()
      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('shares one initialization promise across concurrent callers', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.insertRun(makeRunInsert({ id: 'run-orphaned', taskId: 'task-1' }))
      const updateRun = jest.spyOn(store, 'updateRun')
      const executor = new TaskExecutor({
        getAgentApi: () => {
          throw new Error('not used in this test')
        },
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })

      await Promise.all([service.initialize(), service.initialize()])

      expect(updateRun).toHaveBeenCalledTimes(1)
      await service.cleanup()
      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('can initialize again after cleanup', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () => {
          throw new Error('not used in this test')
        },
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })
      const schedulerStart = jest.spyOn(
        (service as unknown as { scheduler: { start: () => void } }).scheduler,
        'start',
      )

      await service.initialize()
      await service.cleanup()
      await service.initialize()

      expect(schedulerStart).toHaveBeenCalledTimes(2)
      await service.cleanup()
      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('cleanup() waits for an in-flight run after stopping the poll loop', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const { agentApi, resolveRun } = makeDeferredAgentApi()
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })
      const task = await service.createTask(makeTaskConfig())
      await service.initialize()

      const result = await service.executeTaskNow(task.id)
      if (result.outcome !== 'started') throw new Error('unreachable')

      // cleanup() must hold until the in-flight run settles — it cannot return
      // while the run could still write to the store after the toggle.
      let settled = false
      void service.cleanup().then(() => {
        settled = true
      })
      await flushPromises()
      expect(settled).toBe(false)

      resolveRun({ conversationId: 'c', text: 'done', status: 'completed' })
      await flushPromises()
      await flushPromises()
      expect(settled).toBe(true)

      const run = store.getRun(result.runId)
      expect(run?.status).toBe(TaskRunStatus.COMPLETED)

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('cleanup() stops queued work before waiting for the active run', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      let resolveFirst!: (result: YoloAgentRunResult) => void
      const run = jest
        .fn<Promise<YoloAgentRunResult>, [YoloAgentRunRequest]>()
        .mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              resolveFirst = resolve
            }),
        )
        .mockResolvedValue({
          conversationId: 'second',
          text: 'done',
          status: 'completed',
        })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor: new TaskExecutor({ getAgentApi: () => makeAgentApi(run) }),
      })
      const a = await service.createTask(makeTaskConfig({ name: 'A' }))
      const b = await service.createTask(makeTaskConfig({ name: 'B' }))
      await service.initialize()

      expect((await service.executeTaskNow(a.id)).outcome).toBe('started')
      expect((await service.executeTaskNow(b.id)).outcome).toBe('queued')

      const cleanupPromise = service.cleanup()
      resolveFirst({
        conversationId: 'first',
        text: 'done',
        status: 'completed',
      })
      await cleanupPromise
      await flushPromises()

      expect(run).toHaveBeenCalledTimes(1)
      expect(service.getPendingTasks()).toHaveLength(0)

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('cleanup() never blocks past the settle cap when a run hangs', async () => {
    jest.useFakeTimers()
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const { agentApi } = makeDeferredAgentApi() // never resolves
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })
      const task = await service.createTask(makeTaskConfig())
      await service.initialize()
      await jest.advanceTimersByTimeAsync(0) // settle the leader poll loop's first check

      const result = await service.executeTaskNow(task.id)
      if (result.outcome !== 'started') throw new Error('unreachable')

      let settled = false
      void service.cleanup().then(() => {
        settled = true
      })
      await jest.advanceTimersByTimeAsync(0)
      expect(settled).toBe(false)

      // The 5s settle cap expires while the run is still in flight; cleanup
      // returns anyway (the run settles on its own later, without touching the
      // store in a way that races the toggle).
      await jest.advanceTimersByTimeAsync(5_100)
      expect(settled).toBe(true)

      store.close()
    } finally {
      jest.useRealTimers()
      cleanup(dir)
    }
  })

  it('createTask rejects a type=script config with a disallowed scriptPath', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'c',
            text: '',
            status: 'completed',
          })),
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
        getScriptExecutionSettings: () => ({
          enableScriptExecution: true,
          allowedScriptDirectories: ['scripts'],
        }),
      })

      await expect(
        service.createTask(
          makeTaskConfig({
            type: 'script',
            scriptPath: 'other/run.js',
            agentPrompt: null,
          }),
        ),
      ).rejects.toThrow('不在允许的目录列表内')
      expect(await service.listTasks()).toHaveLength(0)

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('createTask accepts a type=script config with an allowed scriptPath', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'c',
            text: '',
            status: 'completed',
          })),
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
        getScriptExecutionSettings: () => ({
          enableScriptExecution: true,
          allowedScriptDirectories: ['scripts'],
        }),
      })

      const created = await service.createTask(
        makeTaskConfig({
          type: 'script',
          scriptPath: 'scripts/run.js',
          agentPrompt: null,
        }),
      )
      expect(created.scriptPath).toBe('scripts/run.js')

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('updateTask re-validates scriptPath only when the patch includes it', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => ({
            conversationId: 'c',
            text: '',
            status: 'completed',
          })),
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
        getScriptExecutionSettings: () => ({
          enableScriptExecution: true,
          allowedScriptDirectories: ['scripts'],
        }),
      })
      const task = await service.createTask(
        makeTaskConfig({
          type: 'script',
          scriptPath: 'scripts/run.js',
          agentPrompt: null,
        }),
      )

      await service.updateTask(task.id, { name: 'renamed' })
      expect(store.getTask(task.id)?.name).toBe('renamed')

      await expect(
        service.updateTask(task.id, { scriptPath: 'other/run.js' }),
      ).rejects.toThrow('不在允许的目录列表内')

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('initialize() does not touch runs that already reached a terminal status', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.insertRun(
        makeRunInsert({
          id: 'run-completed',
          taskId: 'task-1',
          status: TaskRunStatus.COMPLETED,
          completedAt: 1100,
        }),
      )

      const executor = new TaskExecutor({
        getAgentApi: () => {
          throw new Error('not used in this test')
        },
      })
      const service = new ScheduledTasksService({
        store,
        eventBus: new TaskEventBus(),
        executor,
      })

      await service.initialize()

      const run = store.getRun('run-completed')
      expect(run?.status).toBe(TaskRunStatus.COMPLETED)

      await service.cleanup()
      store.close()
    } finally {
      cleanup(dir)
    }
  })
})
