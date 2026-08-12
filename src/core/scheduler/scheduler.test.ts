/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Overrides the root __mocks__/obsidian.ts (which doesn't export Notice/getLanguage) so the V1-c
// notification tests below can assert on calls. Also re-declares Platform/normalizePath (used by
// task-executor.ts's executeScript()) to match the root mock, since this override replaces the
// whole 'obsidian' module for every file this test imports, not just scheduler.ts.
jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  getLanguage: jest.fn(() => 'en'),
  Platform: { isDesktop: true, isMobile: false },
  normalizePath: jest.fn((path: string) => path),
}))

import { Notice } from 'obsidian'

import type {
  YoloAgentApi,
  YoloAgentRunRequest,
  YoloAgentRunResult,
} from '../agent/agent-api'

import {
  type TaskConfig,
  TaskRunStatus,
  createScheduledTasksStore,
} from './scheduledTasksStore'
import { ScheduledTaskScheduler } from './scheduler'
import { type TaskEvent, TaskEventBus } from './task-event-bus'
import { TaskExecutor } from './task-executor'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scheduler-'))
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
    // Best-effort: on Windows, WAL/SHM files from node:sqlite can stay briefly locked after
    // close() in async tests; leaking an OS temp dir here is harmless, unlike failing the test.
  }
}

function writeScript(dir: string, name: string, source: string): string {
  fs.writeFileSync(path.join(dir, name), source, 'utf-8')
  return name
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

/**
 * A run promise the test controls, so it can assert mid-flight state before letting the task
 * finish. `resolveRun` is a stable wrapper (not the destructured resolver itself) because the
 * resolver is only assigned once `agentApi.run()` is actually invoked, which happens after this
 * factory returns — a plain destructured reference would capture `undefined`.
 */
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

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve))
}

/**
 * Regression for the leader-hook error path: if `onLeaderAcquired` throws (e.g.
 * recoverOrphanedRuns -> store.listRunningRuns rejects), the poll loop must still install its
 * interval and pick up due tasks, and the lock-request / poll-loop promise must NOT produce an
 * unhandled rejection — otherwise this window silently stops polling and another window takes over
 * and re-runs the same due tasks. `navigatorValue` selects the Web Locks vs fallback path.
 */
async function assertPollingContinuesWhenLeaderHookThrows(
  navigatorValue: unknown,
): Promise<void> {
  const dir = makeTempDir()
  const originalNavigator = globalThis.navigator
  const unhandledRejections: unknown[] = []
  const onUnhandledRejection = (reason: unknown): void => {
    unhandledRejections.push(reason)
  }
  process.on('unhandledRejection', onUnhandledRejection)
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: navigatorValue,
      configurable: true,
    })

    const store = createScheduledTasksStore(dir)
    const executor = new TaskExecutor({
      getAgentApi: () =>
        makeAgentApi(async () => ({
          conversationId: 'conv-1',
          text: 'done',
          status: 'completed',
        })),
    })
    const hook = jest.fn(async () => {
      throw new Error('orphan recovery failed') // stand-in for store.listRunningRuns() throwing
    })
    const scheduler = new ScheduledTaskScheduler({
      store,
      executor,
      eventBus: new TaskEventBus(),
      onLeaderAcquired: hook,
    })

    const now = Date.now()
    store.createTask(
      'interval-task',
      makeTaskConfig({
        scheduleType: 'interval',
        intervalSeconds: 60,
        nextRunTime: now - 1000,
      }),
      now - 2000,
    )

    scheduler.start()
    await flushPromises()
    await flushPromises() // lets the enqueued run settle (agentApi resolves immediately)

    // Polling continued despite the hook throwing: the due task was picked up and its next run
    // time recomputed, exactly as if the hook had succeeded.
    expect(hook).toHaveBeenCalledTimes(1)
    expect(store.getTask('interval-task')?.nextRunTime).toBeGreaterThan(now)

    // The hook error was contained: nothing escaped to the process as an unhandled rejection.
    expect(unhandledRejections).toHaveLength(0)

    scheduler.stop()
    await flushPromises()
    store.close()
  } finally {
    process.removeListener('unhandledRejection', onUnhandledRejection)
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
    })
    cleanup(dir)
  }
}

/** Real `node:worker_threads` execution isn't controlled by fake timers/microtask flushes like the mocked agentApi paths above, so script-task tests poll for a terminal run status instead of a single `flushPromises()` tick. */
async function waitForTerminalRun(
  getRun: () => { status: TaskRunStatus } | null,
  timeoutMs = 5000,
): Promise<void> {
  const terminal = new Set([
    TaskRunStatus.COMPLETED,
    TaskRunStatus.FAILED,
    TaskRunStatus.TIMED_OUT,
    TaskRunStatus.CANCELLED,
  ])
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const run = getRun()
    if (run && terminal.has(run.status)) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out waiting for run to reach a terminal status')
}

describe('ScheduledTaskScheduler', () => {
  it('executeTaskNow runs a task to completion, persisting run+task state and emitting events', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const eventBus = new TaskEventBus()
      const { agentApi, resolveRun } = makeDeferredAgentApi()
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus,
      })
      store.createTask('task-1', makeTaskConfig(), 1000)

      const events: TaskEvent[] = []
      eventBus.subscribeAll((e) => events.push(e))

      const result = scheduler.executeTaskNow('task-1')
      expect(result.outcome).toBe('started')
      if (result.outcome !== 'started') throw new Error('unreachable')

      expect(store.getRun(result.runId)?.status).toBe(TaskRunStatus.RUNNING)
      expect(events).toEqual([
        { type: 'task_started', taskId: 'task-1', runId: result.runId },
      ])

      resolveRun({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      })
      await flushPromises()

      const run = store.getRun(result.runId)
      expect(run?.status).toBe(TaskRunStatus.COMPLETED)
      expect(run?.result).toBe('done')
      expect(run?.conversationId).toBe('conv-1')

      const updatedTask = store.getTask('task-1')
      expect(updatedTask?.lastRunStatus).toBe(TaskRunStatus.COMPLETED)
      expect(updatedTask?.lastError).toBeNull()
      expect(events.map((e) => e.type)).toEqual([
        'task_started',
        'task_completed',
      ])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('executeTaskNow persists a failed run and lastError when the agent run errors', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const eventBus = new TaskEventBus()
      const agentApi = makeAgentApi(async () => ({
        conversationId: 'conv-1',
        text: '',
        status: 'error',
        errorMessage: 'model unavailable',
      }))
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus,
      })
      store.createTask('task-1', makeTaskConfig(), 1000)

      const events: TaskEvent[] = []
      eventBus.subscribeAll((e) => events.push(e))

      const result = scheduler.executeTaskNow('task-1')
      if (result.outcome !== 'started') throw new Error('unreachable')
      await flushPromises()

      const run = store.getRun(result.runId)
      expect(run?.status).toBe(TaskRunStatus.FAILED)
      expect(run?.error).toBe('model unavailable')

      const updatedTask = store.getTask('task-1')
      expect(updatedTask?.lastRunStatus).toBe(TaskRunStatus.FAILED)
      expect(updatedTask?.lastError).toBe('model unavailable')
      expect(events.map((e) => e.type)).toEqual(['task_started', 'task_failed'])

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('executeTaskNow persists a timed-out run as TIMED_OUT (not FAILED) and emits task_timed_out', async () => {
    const dir = makeTempDir()
    try {
      jest.useFakeTimers()
      const store = createScheduledTasksStore(dir)
      const eventBus = new TaskEventBus()
      const agentApi = makeAgentApi(
        (request) =>
          new Promise((_, reject) => {
            request.abortSignal?.addEventListener('abort', () =>
              reject(new Error('aborted')),
            )
          }),
      )
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus,
      })
      store.createTask('task-1', makeTaskConfig({ timeoutSeconds: 1 }), 1000)

      const events: TaskEvent[] = []
      eventBus.subscribeAll((e) => events.push(e))

      const result = scheduler.executeTaskNow('task-1')
      if (result.outcome !== 'started') throw new Error('unreachable')

      await jest.advanceTimersByTimeAsync(1000)

      const run = store.getRun(result.runId)
      expect(run?.status).toBe(TaskRunStatus.TIMED_OUT)
      expect(run?.error).toContain('timed out')

      const updatedTask = store.getTask('task-1')
      expect(updatedTask?.lastRunStatus).toBe(TaskRunStatus.TIMED_OUT)
      expect(events.map((e) => e.type)).toEqual([
        'task_started',
        'task_timed_out',
      ])

      store.close()
      jest.useRealTimers()
    } finally {
      cleanup(dir)
    }
  })

  it('cancelTaskRun aborts a running task, marks it CANCELLED, and ignores unknown ids', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const eventBus = new TaskEventBus()
      const agentApi = makeAgentApi(
        (request) =>
          new Promise((_, reject) => {
            request.abortSignal?.addEventListener('abort', () =>
              reject(new Error('cancelled')),
            )
          }),
      )
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus,
      })
      store.createTask('task-1', makeTaskConfig({ timeoutSeconds: 30 }), 1000)

      const events: TaskEvent[] = []
      eventBus.subscribeAll((e) => events.push(e))

      const result = scheduler.executeTaskNow('task-1')
      if (result.outcome !== 'started') throw new Error('unreachable')
      await flushPromises()

      scheduler.cancelTaskRun(result.runId)
      await flushPromises()

      const run = store.getRun(result.runId)
      expect(run?.status).toBe(TaskRunStatus.CANCELLED)
      expect(events.map((e) => e.type)).toEqual([
        'task_started',
        'task_cancelled',
      ])

      // Unknown run ids are silent no-ops.
      expect(() => scheduler.cancelTaskRun('unknown-run')).not.toThrow()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('executeTaskNow rejects for a task that does not exist', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () => makeDeferredAgentApi().agentApi,
      })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })

      expect(scheduler.executeTaskNow('missing')).toEqual({
        outcome: 'rejected',
        reason: 'task_not_found',
      })

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('executeTaskNow rejects a disabled task', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () => makeDeferredAgentApi().agentApi,
      })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })
      store.createTask('task-1', makeTaskConfig({ enabled: false }), 1000)

      expect(scheduler.executeTaskNow('task-1')).toEqual({
        outcome: 'rejected',
        reason: 'task_disabled',
      })

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('executeTaskNow rejects a second manual trigger while the first is still running', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const { agentApi, resolveRun } = makeDeferredAgentApi()
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })
      store.createTask('task-1', makeTaskConfig(), 1000)

      const first = scheduler.executeTaskNow('task-1')
      expect(first.outcome).toBe('started')

      expect(scheduler.executeTaskNow('task-1')).toEqual({
        outcome: 'rejected',
        reason: 'already_queued',
      })

      // Settle the in-flight run before closing the store, so no pending promise resumes after teardown.
      resolveRun({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      })
      await flushPromises()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('removes a deleted task from the pending queue instead of leaving a stuck execution slot', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const { agentApi, resolveRun } = makeDeferredAgentApi()
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor: new TaskExecutor({ getAgentApi: () => agentApi }),
        eventBus: new TaskEventBus(),
        queuePolicy: { maxConcurrent: 1, defaultMode: 'concurrent' },
      })
      store.createTask('task-1', makeTaskConfig(), 1000)
      store.createTask('task-2', makeTaskConfig({ name: 'Queued' }), 1000)

      const first = scheduler.executeTaskNow('task-1')
      expect(first.outcome).toBe('started')
      expect(scheduler.executeTaskNow('task-2').outcome).toBe('queued')

      scheduler.deleteTask('task-2')
      resolveRun({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      })
      await flushPromises()

      expect(scheduler.getPendingTasks()).toHaveLength(0)
      expect(scheduler.getExecutingTasks()).toHaveLength(0)
      expect(store.getTask('task-2')).toBeNull()
      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('does not write to the store when shutdown closes it before an in-flight run settles', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const { agentApi, resolveRun } = makeDeferredAgentApi()
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor: new TaskExecutor({ getAgentApi: () => agentApi }),
        eventBus: new TaskEventBus(),
      })
      store.createTask('task-1', makeTaskConfig(), 1000)

      const result = scheduler.executeTaskNow('task-1')
      expect(result.outcome).toBe('started')
      scheduler.shutdown()
      store.close()

      resolveRun({
        conversationId: 'conv-1',
        text: 'late',
        status: 'completed',
      })
      await flushPromises()
    } finally {
      cleanup(dir)
    }
  })

  it('createTask rejects a self-referencing dependsOn cycle', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () => makeDeferredAgentApi().agentApi,
      })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })

      const task = scheduler.createTask(makeTaskConfig({ name: 'A' }))
      expect(() =>
        scheduler.updateTask(task.id, { dependsOn: [task.id] }),
      ).toThrow()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('updateTask recomputes nextRunTime when a schedule field changes, but leaves it untouched otherwise', () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () => makeDeferredAgentApi().agentApi,
      })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })

      const task = scheduler.createTask(
        makeTaskConfig({ scheduleType: 'interval', intervalSeconds: 60 }),
      )
      const originalNextRunTime = task.nextRunTime

      scheduler.updateTask(task.id, { name: 'Renamed' })
      expect(scheduler.getTask(task.id)?.nextRunTime).toBe(originalNextRunTime)

      scheduler.updateTask(task.id, { intervalSeconds: 3600 })
      const afterIntervalChange = scheduler.getTask(task.id)?.nextRunTime
      expect(afterIntervalChange).not.toBeNull()
      expect(afterIntervalChange as number).toBeGreaterThan(
        originalNextRunTime ?? 0,
      )

      const cronExpression = '0 9 * * *'
      scheduler.updateTask(task.id, {
        scheduleType: 'cron',
        cronExpression,
        intervalSeconds: null,
      })
      const updated = scheduler.getTask(task.id)
      expect(updated?.scheduleType).toBe('cron')
      expect(updated?.nextRunTime).not.toBeNull()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('start() enqueues due tasks, disabling one-time tasks and recomputing nextRunTime for recurring ones', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      // Both due tasks share maxConcurrent=1, so the second is dequeued and run only once the
      // first completes; resolving immediately (rather than deferred) lets both settle within
      // the same flush instead of leaving a second in-flight run (and its timeout timer) dangling.
      const agentApi = makeAgentApi(async () => ({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      }))
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })

      const now = Date.now()
      store.createTask(
        'once-task',
        makeTaskConfig({
          scheduleType: 'once',
          intervalSeconds: null,
          oneTimeDateTime: now - 1000,
          nextRunTime: now - 1000,
        }),
        now - 2000,
      )
      store.createTask(
        'interval-task',
        makeTaskConfig({
          scheduleType: 'interval',
          intervalSeconds: 60,
          nextRunTime: now - 1000,
        }),
        now - 2000,
      )

      scheduler.start()
      await flushPromises() // lets the (possibly Web-Locks-gated) leader poll loop actually acquire the lock and run its first check before stop() below
      scheduler.stop()

      const onceTask = store.getTask('once-task')
      expect(onceTask?.enabled).toBe(false)
      expect(onceTask?.nextRunTime).toBeNull()

      const intervalTask = store.getTask('interval-task')
      expect(intervalTask?.nextRunTime).toBeGreaterThan(now)

      await flushPromises()
      await flushPromises() // second flush: lets the cascaded (once first completes) interval-task run also settle

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('does not double-enqueue a task that is still executing from a previous due-check', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const { agentApi, resolveRun } = makeDeferredAgentApi() // stays "executing" across both checks until resolved below
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })

      const now = Date.now()
      store.createTask(
        'interval-task',
        makeTaskConfig({
          scheduleType: 'interval',
          intervalSeconds: 60,
          nextRunTime: now - 1000,
        }),
        now - 2000,
      )

      scheduler.start()
      await flushPromises() // lets the leader poll loop's first check actually run before stop()
      scheduler.stop()
      scheduler.start() // re-triggers checkAndEnqueueScheduledTasks while the task is still executing
      await flushPromises()
      scheduler.stop()

      expect(
        scheduler
          .getExecutingTasks()
          .filter((r) => r.taskId === 'interval-task'),
      ).toHaveLength(1)

      resolveRun({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      })
      await flushPromises()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('caps agent runs per tick to the configured budget, deferring isolated tasks', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const resolvers: Array<(result: YoloAgentRunResult) => void> = []
      const agentApi = makeAgentApi(
        () =>
          new Promise<YoloAgentRunResult>((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
        queuePolicy: { maxConcurrent: 4, defaultMode: 'concurrent' },
        getMaxAgentRunsPerTick: () => 1,
      })

      const now = Date.now()
      for (let index = 0; index < 3; index += 1) {
        store.createTask(
          `agent-${index}`,
          makeTaskConfig({
            name: `Agent ${index}`,
            scheduleType: 'interval',
            intervalSeconds: 60,
            nextRunTime: now - 1000,
          }),
          now - 2000,
        )
      }
      // First tick: only one agent run starts (budget 1); the other two keep
      // their due nextRunTime so the next tick picks them up.
      scheduler.start()
      await flushPromises()
      scheduler.stop()

      expect(scheduler.getExecutingTasks()).toHaveLength(1)
      const updatedAfterFirstTick = [0, 1, 2].filter(
        (index) => store.getTask(`agent-${index}`)?.nextRunTime !== now - 1000,
      )
      expect(updatedAfterFirstTick).toHaveLength(1)

      // Next tick picks up one more isolated agent task.
      scheduler.start()
      await flushPromises()
      scheduler.stop()
      expect(scheduler.getExecutingTasks()).toHaveLength(2)

      for (const resolve of resolvers) {
        resolve({ conversationId: 'conv-1', text: 'done', status: 'completed' })
      }
      await flushPromises()
      await flushPromises()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('does not split a dependency chain across ticks when the budget is exceeded', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const resolvers: Array<(result: YoloAgentRunResult) => void> = []
      const agentApi = makeAgentApi(
        () =>
          new Promise<YoloAgentRunResult>((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
        queuePolicy: { maxConcurrent: 4, defaultMode: 'concurrent' },
        getMaxAgentRunsPerTick: () => 1,
      })

      const now = Date.now()
      store.createTask(
        'parent-agent',
        makeTaskConfig({
          name: 'Parent',
          scheduleType: 'interval',
          intervalSeconds: 60,
          nextRunTime: now - 1000,
        }),
        now - 2000,
      )
      store.createTask(
        'child-agent',
        makeTaskConfig({
          name: 'Child',
          scheduleType: 'interval',
          intervalSeconds: 60,
          nextRunTime: now - 1000,
          dependsOn: ['parent-agent'],
        }),
        now - 2000,
      )

      // Both tasks must enqueue in the same tick: parent is depended on and
      // child has dependencies, so neither qualifies for isolated deferral.
      scheduler.start()
      await flushPromises()
      scheduler.stop()

      expect(scheduler.getExecutingTasks().map((run) => run.taskId)).toEqual([
        'parent-agent',
      ])
      expect(scheduler.getPendingTasks().map((item) => item.taskId)).toEqual([
        'child-agent',
      ])

      // Completing the parent unblocks the child within the same batch.
      resolvers[0]?.({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      })
      await flushPromises()
      await flushPromises()
      expect(scheduler.getExecutingTasks().map((run) => run.taskId)).toEqual([
        'child-agent',
      ])
      resolvers[1]?.({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      })
      await flushPromises()
      await flushPromises()

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('two schedulers sharing the same vault only let the leader-lock holder poll — no double-execution', async () => {
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const agentApi = makeAgentApi(async () => ({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      }))
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const eventBus = new TaskEventBus() // shared across both schedulers purely so the test can observe a single combined event stream
      const schedulerA = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus,
      })
      const schedulerB = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus,
      })

      const now = Date.now()
      store.createTask(
        'interval-task',
        makeTaskConfig({
          scheduleType: 'interval',
          intervalSeconds: 60,
          nextRunTime: now - 1000,
        }),
        now - 2000,
      )

      const events: TaskEvent[] = []
      eventBus.subscribeAll((e) => events.push(e))

      // Simulates opening a second Obsidian window against the same vault while the first is
      // already running: both call start(), but only the one that wins the exclusive lock may
      // actually poll and enqueue — otherwise the due task would be picked up and executed twice.
      schedulerA.start()
      schedulerB.start()
      await flushPromises()
      await flushPromises()

      expect(events.filter((e) => e.type === 'task_started')).toHaveLength(1)

      schedulerA.stop()
      schedulerB.stop()
      await flushPromises() // lets the non-leader's now-stale lock grant (if any) settle as a no-op instead of leaking a pending promise

      store.close()
    } finally {
      cleanup(dir)
    }
  })

  it('falls back to polling directly (no leader election) when navigator.locks is unavailable', async () => {
    const dir = makeTempDir()
    const originalNavigator = globalThis.navigator
    try {
      // Simulates an environment without the Web Locks API (older runtimes) — the scheduler
      // must still run its poll loop unguarded rather than hanging forever waiting on a lock.
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
      })

      const store = createScheduledTasksStore(dir)
      const agentApi = makeAgentApi(async () => ({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      }))
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })

      const now = Date.now()
      store.createTask(
        'interval-task',
        makeTaskConfig({
          scheduleType: 'interval',
          intervalSeconds: 60,
          nextRunTime: now - 1000,
        }),
        now - 2000,
      )

      // No navigator.locks — the scheduler must still run its first check rather than hang on a
      // lock grant that will never come. The poll loop is now async (it awaits onLeaderAcquired),
      // so the first check happens on a microtask: flush before stop() both lets it run and lets
      // stop() clear the interval it installs.
      scheduler.start()
      await flushPromises()
      scheduler.stop()

      const task = store.getTask('interval-task')
      expect(task?.nextRunTime).toBeGreaterThan(now)

      await flushPromises()
      store.close()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
      cleanup(dir)
    }
  })

  it('runs onLeaderAcquired exactly once per leader acquisition, before the first check', async () => {
    const dir = makeTempDir()
    const originalNavigator = globalThis.navigator
    const store = createScheduledTasksStore(dir)
    const { agentApi, resolveRun } = makeDeferredAgentApi() // stays RUNNING until the finally block
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })
    const executingAtHook: number[] = []
    const scheduler = new ScheduledTaskScheduler({
      store,
      executor,
      eventBus: new TaskEventBus(),
      onLeaderAcquired: async () => {
        // Ordering contract: the hook fires before the first checkAndEnqueueScheduledTasks, so a
        // due task must not have been picked up yet at the moment recovery runs.
        executingAtHook.push(scheduler.getExecutingTasks().length)
      },
    })
    try {
      // Fall back to the no-Web-Locks path so leadership is granted synchronously inside start(),
      // making the hook's ordering relative to the first due-check deterministic.
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
      })

      store.createTask(
        'interval-task',
        makeTaskConfig({
          scheduleType: 'interval',
          intervalSeconds: 60,
          nextRunTime: Date.now() - 1000,
        }),
        Date.now() - 2000,
      )

      scheduler.start()
      await flushPromises()

      // Exactly once on this acquisition, and it ran before the first check enqueued the due task.
      expect(executingAtHook).toEqual([0])
      expect(scheduler.getExecutingTasks()).toHaveLength(1)

      // Re-acquiring leadership (stop -> start) fires the one-shot again — once per acquisition.
      scheduler.stop()
      scheduler.start()
      await flushPromises()
      expect(executingAtHook).toHaveLength(2)
    } finally {
      // Always settle the in-flight run, stop the poll loop, and close the store — even if an
      // assertion above failed (otherwise the deferred run + interval would leave Jest hanging).
      resolveRun({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      })
      await flushPromises()
      scheduler.stop()
      store.close()
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
      cleanup(dir)
    }
  })

  it('continues polling when the leader hook throws — no unhandled rejection on either lock path', async () => {
    // Web Locks path: navigator.locks.request()'s returned promise must resolve, not reject, even
    // though the hook (e.g. recoverOrphanedRuns) throws inside its callback.
    await assertPollingContinuesWhenLeaderHookThrows({
      locks: {
        request: (
          _name: string,
          _opts: unknown,
          callback: () => Promise<void>,
        ) => Promise.resolve().then(callback),
      },
    })
    // Fallback path (no navigator.locks): void runLeaderPollLoop() must not reject either.
    await assertPollingContinuesWhenLeaderHookThrows({})
  })

  it('does not install an interval or run a check when stop() lands while the leader hook is still pending', async () => {
    const dir = makeTempDir()
    const originalNavigator = globalThis.navigator
    try {
      // Fall back to the synchronous leadership path so the pending-hook window is deterministic.
      Object.defineProperty(globalThis, 'navigator', {
        value: {},
        configurable: true,
      })

      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        // Never invoked: without a check, no task is ever enqueued or run.
        getAgentApi: () => makeDeferredAgentApi().agentApi,
      })

      let resolveHook!: () => void
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
        onLeaderAcquired: () =>
          new Promise<void>((resolve) => {
            resolveHook = resolve
          }),
      })

      const now = Date.now()
      store.createTask(
        'interval-task',
        makeTaskConfig({
          scheduleType: 'interval',
          intervalSeconds: 60,
          nextRunTime: now - 1000,
        }),
        now - 2000,
      )

      scheduler.start()
      await flushPromises() // the hook is now in flight and unresolved
      scheduler.stop() // stop() runs while the hook is still pending
      resolveHook() // the hook settles only after stop()
      await flushPromises()

      // The post-await `stopped` recheck must prevent both the first check and the interval from
      // ever being installed — the due task is left untouched and nothing polls afterwards.
      const internals = scheduler as unknown as {
        checkInterval?: ReturnType<typeof setInterval>
      }
      expect(internals.checkInterval).toBeUndefined()
      expect(store.getTask('interval-task')?.nextRunTime).toBe(now - 1000)
      expect(scheduler.getExecutingTasks()).toHaveLength(0)

      store.close()
    } finally {
      Object.defineProperty(globalThis, 'navigator', {
        value: originalNavigator,
        configurable: true,
      })
      cleanup(dir)
    }
  })

  it('catches up missed cron runs after restart (skip-missed), but not during the quiet window', async () => {
    jest.useFakeTimers()
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const agentApi = makeAgentApi(async () => ({
        conversationId: 'conv-1',
        text: 'done',
        status: 'completed',
      }))
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })

      // Every-30-min cron task whose process was closed between its last fire
      // (T-90min) and a restart at T: the T-60min and T-30min triggers both came
      // and went while the process wasn't polling. nextRunTime still points at
      // the first missed trigger point.
      const now = Date.now()
      const lastRunAt = now - 90 * 60_000
      const missedTrigger = now - 60 * 60_000
      store.createTask(
        'cron-task',
        makeTaskConfig({
          scheduleType: 'cron',
          cronExpression: '*/30 * * * *',
          intervalSeconds: null,
          nextRunTime: missedTrigger,
        }),
        lastRunAt,
      )
      store.updateTask('cron-task', { lastRunAt }, lastRunAt + 1000)

      scheduler.start()
      await jest.advanceTimersByTimeAsync(0) // settle the leader poll loop's first check

      // Quiet window (30s after start): the missed trigger must NOT storm the
      // startup — nothing is enqueued and nextRunTime stays pinned to the
      // missed trigger point until the catch-up pass is allowed to run.
      expect(scheduler.getExecutingTasks()).toHaveLength(0)
      expect(store.getTask('cron-task')?.nextRunTime).toBe(missedTrigger)

      // Once the quiet window elapses, the catch-up pass runs the missed
      // trigger exactly once (skip-missed — no replay of both missed triggers)
      // and recomputes nextRunTime from the restart moment.
      await jest.advanceTimersByTimeAsync(31_000)
      await jest.advanceTimersByTimeAsync(0) // let the caught-up run settle

      const runs = store.listRunsByTask('cron-task').runs
      expect(runs).toHaveLength(1)
      expect(runs[0]?.scheduledFor).toBe(missedTrigger)
      expect(runs[0]?.catchUpRunAt).not.toBeNull()
      expect(store.getTask('cron-task')?.nextRunTime).toBeGreaterThan(now)

      scheduler.stop()
      store.close()
    } finally {
      jest.useRealTimers()
      cleanup(dir)
    }
  })

  it("resolves a missed task's dependency that is due in the same tick (catch-up and due share one batch)", async () => {
    jest.useFakeTimers()
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const resolvers: Array<(result: YoloAgentRunResult) => void> = []
      const agentApi = makeAgentApi(
        () =>
          new Promise<YoloAgentRunResult>((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const events: TaskEvent[] = []
      const eventBus = new TaskEventBus()
      eventBus.subscribeAll((e) => events.push(e))
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus,
      })

      // Review scenario: B (every 1 min) becomes due within 60s of restart
      // (nextRunTime 29s out → due batch at the t=30s tick), while A (every 2
      // min, depends on B) missed its trigger by 90s (→ catch-up batch, same
      // tick). Before the fix the two passes made separate batches and A was
      // fast-failed as "dependency not in this batch" — the same-batch
      // guarantee the due-check alone used to provide.
      const now = Date.now()
      store.createTask(
        'task-b',
        makeTaskConfig({
          name: 'B',
          scheduleType: 'interval',
          cronExpression: null,
          intervalSeconds: 60,
          nextRunTime: now + 29_000,
        }),
        now - 120_000,
      )
      store.updateTask('task-b', { lastRunAt: now - 90_000 }, now - 90_000)
      store.createTask(
        'task-a',
        makeTaskConfig({
          name: 'A',
          scheduleType: 'interval',
          cronExpression: null,
          intervalSeconds: 120,
          nextRunTime: now - 90_000,
          dependsOn: ['task-b'],
        }),
        now - 180_000,
      )
      store.updateTask('task-a', { lastRunAt: now - 180_000 }, now - 180_000)

      scheduler.start()
      await jest.advanceTimersByTimeAsync(0) // quiet window: first check enqueues nothing
      await jest.advanceTimersByTimeAsync(31_000) // catch-up + due passes of this tick

      // A waits on B inside the shared batch instead of fast-failing; B runs first.
      expect(scheduler.getPendingTasks().map((item) => item.taskId)).toEqual([
        'task-a',
      ])
      expect(scheduler.getExecutingTasks().map((run) => run.taskId)).toEqual([
        'task-b',
      ])

      // B completes → A is unblocked within the same batch and runs to completion.
      resolvers[0]?.({
        conversationId: 'conv-b',
        text: 'b',
        status: 'completed',
      })
      await jest.advanceTimersByTimeAsync(0)
      expect(scheduler.getExecutingTasks().map((run) => run.taskId)).toEqual([
        'task-a',
      ])
      resolvers[1]?.({
        conversationId: 'conv-a',
        text: 'a',
        status: 'completed',
      })
      await jest.advanceTimersByTimeAsync(0)

      const runs = store.listRunsByTask('task-a').runs
      expect(runs).toHaveLength(1)
      expect(runs[0]?.status).toBe(TaskRunStatus.COMPLETED)
      // No dependency fast-fail anywhere in the round.
      expect(events.some((e) => e.type === 'task_failed')).toBe(false)
      // A's catch-up audit stays intact: one make-up run, schedule resumed from now.
      expect(runs[0]?.catchUpRunAt).not.toBeNull()
      expect(store.getTask('task-a')?.nextRunTime).toBeGreaterThan(now)

      scheduler.stop()
      store.close()
    } finally {
      jest.useRealTimers()
      cleanup(dir)
    }
  })

  it('defers a missed task whose dependency already ran at restart, until both land in one batch', async () => {
    jest.useFakeTimers()
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const resolvers: Array<(result: YoloAgentRunResult) => void> = []
      const agentApi = makeAgentApi(
        () =>
          new Promise<YoloAgentRunResult>((resolve) => {
            resolvers.push(resolve)
          }),
      )
      const executor = new TaskExecutor({ getAgentApi: () => agentApi })
      const events: TaskEvent[] = []
      const eventBus = new TaskEventBus()
      eventBus.subscribeAll((e) => events.push(e))
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus,
      })

      // Same chain, but B is due AT restart (overdue 20s): the quiet window
      // makes B run in the t=0 tick while A's catch-up only becomes eligible
      // at t=30s — two different ticks. A must be deferred (not enqueued to
      // fast-fail) until B's next fire joins the same round at t=60s.
      const now = Date.now()
      store.createTask(
        'task-b',
        makeTaskConfig({
          name: 'B',
          scheduleType: 'interval',
          cronExpression: null,
          intervalSeconds: 60,
          nextRunTime: now - 20_000,
        }),
        now - 120_000,
      )
      store.updateTask('task-b', { lastRunAt: now - 90_000 }, now - 90_000)
      store.createTask(
        'task-a',
        makeTaskConfig({
          name: 'A',
          scheduleType: 'interval',
          cronExpression: null,
          intervalSeconds: 120,
          nextRunTime: now - 90_000,
          dependsOn: ['task-b'],
        }),
        now - 180_000,
      )
      store.updateTask('task-a', { lastRunAt: now - 180_000 }, now - 180_000)

      scheduler.start()
      await jest.advanceTimersByTimeAsync(0) // t=0 tick: B (due) runs, A gated by the quiet window

      // t=30s tick: A is eligible for catch-up but B is not in this round —
      // deferring A instead of enqueueing it to fast-fail against B's absence.
      await jest.advanceTimersByTimeAsync(31_000)
      expect(scheduler.getPendingTasks().map((item) => item.taskId)).toEqual([])
      expect(store.listRunsByTask('task-a').runs).toHaveLength(0)

      // B's t=0 run settles (a normal short run), then t=60s tick: B's next
      // fire and A's catch-up land in the SAME batch — A waits for B, then runs.
      resolvers[0]?.({
        conversationId: 'conv-b',
        text: 'b',
        status: 'completed',
      })
      await jest.advanceTimersByTimeAsync(30_000)
      expect(scheduler.getPendingTasks().map((item) => item.taskId)).toEqual([
        'task-a',
      ])
      expect(scheduler.getExecutingTasks().map((run) => run.taskId)).toEqual([
        'task-b',
      ])

      resolvers[1]?.({
        conversationId: 'conv-b',
        text: 'b',
        status: 'completed',
      })
      await jest.advanceTimersByTimeAsync(0)
      expect(scheduler.getExecutingTasks().map((run) => run.taskId)).toEqual([
        'task-a',
      ])
      resolvers[2]?.({
        conversationId: 'conv-a',
        text: 'a',
        status: 'completed',
      })
      await jest.advanceTimersByTimeAsync(0)

      const aRuns = store.listRunsByTask('task-a').runs
      expect(aRuns).toHaveLength(1)
      expect(aRuns[0]?.status).toBe(TaskRunStatus.COMPLETED)
      expect(aRuns[0]?.catchUpRunAt).not.toBeNull()
      // B fired twice — its restart fire (t=0) and its regular next fire (t=60s).
      expect(store.listRunsByTask('task-b').runs).toHaveLength(2)
      expect(events.some((e) => e.type === 'task_failed')).toBe(false)

      scheduler.stop()
      store.close()
    } finally {
      jest.useRealTimers()
      cleanup(dir)
    }
  })

  it('does not catch up tasks with scheduleType once that already ran', async () => {
    jest.useFakeTimers()
    const dir = makeTempDir()
    try {
      const store = createScheduledTasksStore(dir)
      const executor = new TaskExecutor({
        getAgentApi: () => makeDeferredAgentApi().agentApi,
      })
      const scheduler = new ScheduledTaskScheduler({
        store,
        executor,
        eventBus: new TaskEventBus(),
      })

      const now = Date.now()
      const firedAt = now - 60 * 60_000
      // A once task that already ran: disabled, nextRunTime cleared, lastRunAt
      // set — exactly the shape the due-check leaves behind after firing it.
      store.createTask(
        'once-task',
        makeTaskConfig({
          scheduleType: 'once',
          intervalSeconds: null,
          oneTimeDateTime: firedAt,
          nextRunTime: null,
          enabled: false,
        }),
        firedAt,
      )
      store.updateTask('once-task', { lastRunAt: firedAt }, firedAt)

      scheduler.start()
      await jest.advanceTimersByTimeAsync(31_000) // past the quiet window
      await jest.advanceTimersByTimeAsync(0)

      // Once schedules are never caught up, and a consumed one must not be
      // revived by the restart — no run is created and the task stays disabled.
      expect(store.listRunsByTask('once-task').runs).toHaveLength(0)
      expect(scheduler.getExecutingTasks()).toHaveLength(0)
      expect(store.getTask('once-task')).toMatchObject({
        enabled: false,
        nextRunTime: null,
        lastRunAt: firedAt,
      })

      scheduler.stop()
      store.close()
    } finally {
      jest.useRealTimers()
      cleanup(dir)
    }
  })

  describe('notifyOn -> Notice', () => {
    beforeEach(() => {
      ;(Notice as jest.Mock).mockClear()
    })

    it('shows a Notice on failure when notifyOn includes "failure", and not on success', async () => {
      const dir = makeTempDir()
      try {
        const store = createScheduledTasksStore(dir)
        const agentApi = makeAgentApi(async () => ({
          conversationId: 'conv-1',
          text: '',
          status: 'error',
          errorMessage: 'model unavailable',
        }))
        const executor = new TaskExecutor({ getAgentApi: () => agentApi })
        const scheduler = new ScheduledTaskScheduler({
          store,
          executor,
          eventBus: new TaskEventBus(),
        })
        store.createTask(
          'task-1',
          makeTaskConfig({ notifyOn: ['failure'] }),
          1000,
        )

        const result = scheduler.executeTaskNow('task-1')
        if (result.outcome !== 'started') throw new Error('unreachable')
        await flushPromises()

        expect(Notice).toHaveBeenCalledTimes(1)

        store.close()
      } finally {
        cleanup(dir)
      }
    })

    it('shows a Notice on success when notifyOn includes "success"', async () => {
      const dir = makeTempDir()
      try {
        const store = createScheduledTasksStore(dir)
        const { agentApi, resolveRun } = makeDeferredAgentApi()
        const executor = new TaskExecutor({ getAgentApi: () => agentApi })
        const scheduler = new ScheduledTaskScheduler({
          store,
          executor,
          eventBus: new TaskEventBus(),
        })
        store.createTask(
          'task-1',
          makeTaskConfig({ notifyOn: ['success'] }),
          1000,
        )

        const result = scheduler.executeTaskNow('task-1')
        if (result.outcome !== 'started') throw new Error('unreachable')
        resolveRun({
          conversationId: 'conv-1',
          text: 'done',
          status: 'completed',
        })
        await flushPromises()

        expect(Notice).toHaveBeenCalledTimes(1)

        store.close()
      } finally {
        cleanup(dir)
      }
    })

    it('does not show a Notice when notifyOn is empty, regardless of outcome', async () => {
      const dir = makeTempDir()
      try {
        const store = createScheduledTasksStore(dir)
        const agentApi = makeAgentApi(async () => ({
          conversationId: 'conv-1',
          text: '',
          status: 'error',
          errorMessage: 'model unavailable',
        }))
        const executor = new TaskExecutor({ getAgentApi: () => agentApi })
        const scheduler = new ScheduledTaskScheduler({
          store,
          executor,
          eventBus: new TaskEventBus(),
        })
        store.createTask('task-1', makeTaskConfig({ notifyOn: [] }), 1000)

        const result = scheduler.executeTaskNow('task-1')
        if (result.outcome !== 'started') throw new Error('unreachable')
        await flushPromises()

        expect(Notice).not.toHaveBeenCalled()

        store.close()
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('script task logs', () => {
    it('persists accumulated stdout/stderr log entries on the completed run', async () => {
      const dir = makeTempDir()
      try {
        const scriptPath = writeScript(
          dir,
          'log.js',
          "console.log('stdout line'); console.error('stderr line')",
        )
        const store = createScheduledTasksStore(dir)
        const agentApi = makeAgentApi(async () => {
          throw new Error('not used in this test')
        })
        const executor = new TaskExecutor({
          getAgentApi: () => agentApi,
          getVaultBasePath: () => dir,
        })
        const scheduler = new ScheduledTaskScheduler({
          store,
          executor,
          eventBus: new TaskEventBus(),
        })
        store.createTask(
          'task-1',
          makeTaskConfig({ type: 'script', scriptPath, agentPrompt: null }),
          1000,
        )

        const result = scheduler.executeTaskNow('task-1')
        if (result.outcome !== 'started') throw new Error('unreachable')
        await waitForTerminalRun(() => store.getRun(result.runId))

        const run = store.getRun(result.runId)
        expect(run?.status).toBe(TaskRunStatus.COMPLETED)
        expect(run?.logs).not.toBeNull()
        expect(
          run?.logs?.some(
            (l) => l.level === 'info' && l.message.includes('stdout line'),
          ),
        ).toBe(true)
        expect(
          run?.logs?.some(
            (l) => l.level === 'error' && l.message.includes('stderr line'),
          ),
        ).toBe(true)

        store.close()
      } finally {
        cleanup(dir)
      }
    })

    it('records a non-zero script exit as FAILED without retrying', async () => {
      const dir = makeTempDir()
      try {
        const scriptPath = writeScript(dir, 'fail.js', 'process.exit(3)')
        const store = createScheduledTasksStore(dir)
        const executor = new TaskExecutor({
          getAgentApi: () =>
            makeAgentApi(async () => {
              throw new Error('not used in this test')
            }),
          getVaultBasePath: () => dir,
        })
        const scheduler = new ScheduledTaskScheduler({
          store,
          executor,
          eventBus: new TaskEventBus(),
        })
        store.createTask(
          'task-1',
          makeTaskConfig({
            type: 'script',
            scriptPath,
            agentPrompt: null,
            maxRetries: 3,
          }),
          1000,
        )

        const result = scheduler.executeTaskNow('task-1')
        if (result.outcome !== 'started') throw new Error('unreachable')
        await waitForTerminalRun(() => store.getRun(result.runId))

        const run = store.getRun(result.runId)
        expect(run?.status).toBe(TaskRunStatus.FAILED)
        expect(run?.exitCode).toBe(3)
        expect(run?.error).toContain('code 3')

        const task = store.getTask('task-1')
        expect(task?.lastRunStatus).toBe(TaskRunStatus.FAILED)

        // Deterministic script failure must not be retried.
        expect(store.listRunsByTask('task-1').runs).toHaveLength(1)
        store.close()
      } finally {
        cleanup(dir)
      }
    })
  })

  describe('RAG action task dispatch', () => {
    const makeRagExecutor = (runIndex: jest.Mock): TaskExecutor =>
      new TaskExecutor({
        getAgentApi: () =>
          makeAgentApi(async () => {
            throw new Error('not used in RAG dispatch tests')
          }),
        getRagIndexService: () => ({
          runIndex,
          cancelActiveRun: jest.fn(),
        }),
      })

    it('runs a ragIndex task through the executor and records output and exitCode', async () => {
      const dir = makeTempDir()
      try {
        const store = createScheduledTasksStore(dir)
        const runIndex = jest.fn().mockResolvedValue({
          permanentFailedPaths: [],
          chunkifyFailedPaths: [],
        })
        const scheduler = new ScheduledTaskScheduler({
          store,
          executor: makeRagExecutor(runIndex),
          eventBus: new TaskEventBus(),
        })
        store.createTask(
          'task-1',
          makeTaskConfig({ type: 'ragIndex', agentPrompt: null }),
          1000,
        )

        const result = scheduler.executeTaskNow('task-1')
        if (result.outcome !== 'started') throw new Error('unreachable')
        await waitForTerminalRun(() => store.getRun(result.runId))

        const run = store.getRun(result.runId)
        expect(run?.status).toBe(TaskRunStatus.COMPLETED)
        expect(run?.exitCode).toBe(0)
        expect(run?.output).toContain('completed')
        expect(runIndex).toHaveBeenCalledTimes(1)

        store.close()
      } finally {
        cleanup(dir)
      }
    })

    it('marks a failing ragAutoUpdate task run as FAILED with the underlying message', async () => {
      const dir = makeTempDir()
      try {
        const store = createScheduledTasksStore(dir)
        const runIndex = jest
          .fn()
          .mockRejectedValue(new Error('embedding provider unavailable'))
        const scheduler = new ScheduledTaskScheduler({
          store,
          executor: makeRagExecutor(runIndex),
          eventBus: new TaskEventBus(),
        })
        store.createTask(
          'task-1',
          makeTaskConfig({ type: 'ragAutoUpdate', agentPrompt: null }),
          1000,
        )

        const result = scheduler.executeTaskNow('task-1')
        if (result.outcome !== 'started') throw new Error('unreachable')
        await waitForTerminalRun(() => store.getRun(result.runId))

        const run = store.getRun(result.runId)
        expect(run?.status).toBe(TaskRunStatus.FAILED)
        expect(run?.error).toContain('embedding provider unavailable')

        store.close()
      } finally {
        cleanup(dir)
      }
    })
  })
})
