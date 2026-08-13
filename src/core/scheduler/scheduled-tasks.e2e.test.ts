/* eslint-disable import/no-nodejs-modules -- e2e 冒烟测试运行在 Node 环境，直接使用 node 内置模块装配临时 vault/脚本 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// Overrides the root __mocks__/obsidian.ts (which doesn't export Notice) so the
// scheduler's notification path can be spied on, and pins Platform to desktop
// so node:worker_threads script execution is enabled. Same shape as
// scheduler.test.ts.
jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  getLanguage: jest.fn(() => 'en'),
  Platform: { isDesktop: true, isMobile: false },
  normalizePath: jest.fn((p: string) => p),
}))

import type { YoloAgentApi } from '../agent/agent-api'
import { ScheduledTasksService } from '../scheduled-tasks-service'

import {
  type ScheduledTasksStore,
  type TaskConfig,
  TaskRunStatus,
  createScheduledTasksStore,
} from './scheduledTasksStore'
import { type TaskEvent, TaskEventBus } from './task-event-bus'
import { TaskExecutor, type TaskExecutorDeps } from './task-executor'

/**
 * End-to-end smoke over the REAL assembly the plugin ships:
 * ScheduledTasksService facade + ScheduledTaskScheduler (with its real
 * TaskQueue) + ScheduledTasksStore on a real SQLite file in a temp dir +
 * TaskExecutor running REAL node:worker_threads scripts. RAG action targets
 * are mocked (per the task-8 brief: "RAG mock 或真实但无索引文件").
 *
 * Timing strategy:
 *  - The scheduler poll tick (30s) is exercised with jest fake timers
 *    (doNotFake: ['setImmediate']) so the tick fires instantly while real
 *    worker I/O still settles on the real event loop.
 *  - Manual-trigger paths run on real timers (sub-second).
 */

type SmokeAssembly = {
  service: ScheduledTasksService
  store: ScheduledTasksStore
  eventBus: TaskEventBus
  dir: string
}

const TERMINAL_STATUSES = new Set<TaskRunStatus>([
  TaskRunStatus.COMPLETED,
  TaskRunStatus.FAILED,
  TaskRunStatus.TIMED_OUT,
  TaskRunStatus.CANCELLED,
])

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'scheduled-tasks-e2e-'))
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
    // Best-effort: on Windows, WAL/SHM files from node:sqlite can stay briefly
    // locked after close() in async tests; leaking an OS temp dir here is
    // harmless, unlike failing the test.
  }
}

function writeScript(dir: string, name: string, source: string): string {
  fs.writeFileSync(path.join(dir, name), source, 'utf-8')
  return name
}

function makeTaskConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
  return {
    name: 'E2E smoke task',
    type: 'agent',
    createdBy: 'user',
    scheduleType: 'once',
    cronExpression: null,
    intervalSeconds: null,
    oneTimeDateTime: null,
    nextRunTime: null,
    scriptPath: null,
    agentPrompt: null,
    agentConfig: null,
    queueGroup: null,
    dependsOn: null,
    continueOnDependencyFailure: false,
    priority: 5,
    timeoutSeconds: 30,
    maxRetries: 0,
    enabled: true,
    notifyOn: [],
    ...overrides,
  }
}

function makeUnusedAgentApi(): YoloAgentApi {
  return {
    run: async () => {
      throw new Error('agent execution is not part of the e2e smoke')
    },
    // eslint-disable-next-line require-yield -- test double never streams
    stream: async function* () {
      throw new Error('not used in the e2e smoke')
    },
    abort: () => false,
  }
}

/** Real assembly: service facade + real store (SQLite file) + real executor. */
function makeService(
  dir: string,
  executorDeps: Partial<TaskExecutorDeps> = {},
): SmokeAssembly {
  const store = createScheduledTasksStore(dir)
  const eventBus = new TaskEventBus()
  const executor = new TaskExecutor({
    getAgentApi: () => makeUnusedAgentApi(),
    getVaultBasePath: () => dir,
    ...executorDeps,
  })
  const service = new ScheduledTasksService({ store, eventBus, executor })
  return { service, store, eventBus, dir }
}

/**
 * Real node:worker_threads execution isn't controlled by fake timers or
 * microtask flushes (same note as scheduler.test.ts's waitForTerminalRun), so
 * the smoke polls for a terminal run status. Under fake timers setImmediate
 * must stay real (doNotFake: ['setImmediate']) for this to turn the event
 * loop; the bound is an iteration count instead of a Date-based deadline
 * because Date.now() is faked there.
 */
async function pollUntil(
  predicate: () => boolean,
  label: string,
  maxIterations = 5000,
): Promise<void> {
  for (let i = 0; i < maxIterations; i += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`timed out waiting for: ${label}`)
}

describe('scheduled-tasks e2e smoke (real assembly)', () => {
  it('runs an interval script task on the scheduler poll tick and persists the run', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const dir = makeTempDir()
    let service: ScheduledTasksService | undefined
    let store: ScheduledTasksStore | undefined
    try {
      const scriptPath = writeScript(
        dir,
        'echo-tick.js',
        "console.log('scheduled tick from e2e smoke')",
      )
      const assembly = makeService(dir)
      service = assembly.service
      store = assembly.store
      const events: TaskEvent[] = []
      assembly.eventBus.subscribeAll((e) => events.push(e))

      const t0 = Date.now()
      const task = await service.createTask(
        makeTaskConfig({
          name: 'tick-echo',
          type: 'script',
          scriptPath,
          agentPrompt: null,
          scheduleType: 'interval',
          intervalSeconds: 30,
        }),
      )
      expect(task.nextRunTime).toBe(t0 + 30_000)

      await service.initialize()
      await jest.advanceTimersByTimeAsync(0) // settle the leader poll loop's first check

      // Fake time jumps past the interval: the 30s tick fires and enqueues the task.
      await jest.advanceTimersByTimeAsync(31_000)

      await pollUntil(
        () => events.some((e) => e.type === 'task_started'),
        'task_started event',
      )
      const started = events.find(
        (e): e is Extract<TaskEvent, { type: 'task_started' }> =>
          e.type === 'task_started',
      )
      if (!started) throw new Error('unreachable')
      await pollUntil(() => {
        const run = store?.getRun(started.runId)
        return run != null && TERMINAL_STATUSES.has(run.status)
      }, 'scheduled run to reach a terminal status')

      const run = store?.getRun(started.runId)
      expect(run?.status).toBe(TaskRunStatus.COMPLETED)
      expect(run?.triggeredBy).toBe('schedule')
      expect(run?.exitCode).toBe(0)
      expect(run?.output).toContain('scheduled tick from e2e smoke')
      expect(
        run?.logs?.some(
          (l) =>
            l.level === 'info' &&
            l.message.includes('scheduled tick from e2e smoke'),
        ),
      ).toBe(true)

      // The schedule advanced past the fired trigger and the run is persisted
      // on the real SQLite file.
      const taskAfter = store?.getTask(task.id)
      expect(taskAfter?.nextRunTime).toBe(t0 + 60_000)
      expect(taskAfter?.lastRunStatus).toBe(TaskRunStatus.COMPLETED)
      expect(taskAfter?.lastError).toBeNull()
      expect(fs.existsSync(path.join(dir, 'scheduled-tasks.sqlite'))).toBe(true)
      expect(events.some((e) => e.type === 'task_completed')).toBe(true)
    } finally {
      service?.shutdown()
      store?.close()
      jest.useRealTimers()
      cleanup(dir)
    }
  })

  it('manual "run now" executes a script task end-to-end with output and events', async () => {
    const dir = makeTempDir()
    let service: ScheduledTasksService | undefined
    let store: ScheduledTasksStore | undefined
    try {
      const scriptPath = writeScript(
        dir,
        'manual-echo.js',
        "console.log('manual run output'); console.error('manual stderr')",
      )
      const assembly = makeService(dir)
      service = assembly.service
      store = assembly.store
      const events: TaskEvent[] = []
      assembly.eventBus.subscribeAll((e) => events.push(e))

      const task = await service.createTask(
        makeTaskConfig({
          name: 'manual-echo',
          type: 'script',
          scriptPath,
          agentPrompt: null,
        }),
      )
      await service.initialize()

      const result = await service.executeTaskNow(task.id)
      expect(result.outcome).toBe('started')
      if (result.outcome !== 'started') throw new Error('unreachable')

      await pollUntil(() => {
        const run = store?.getRun(result.runId)
        return run != null && TERMINAL_STATUSES.has(run.status)
      }, 'manual run to reach a terminal status')

      const run = store?.getRun(result.runId)
      expect(run?.status).toBe(TaskRunStatus.COMPLETED)
      expect(run?.triggeredBy).toBe('manual')
      expect(run?.exitCode).toBe(0)
      expect(run?.output).toContain('manual run output')
      expect(
        run?.logs?.some(
          (l) => l.level === 'error' && l.message.includes('manual stderr'),
        ),
      ).toBe(true)

      expect(store?.getTask(task.id)?.lastRunStatus).toBe(
        TaskRunStatus.COMPLETED,
      )
      expect(events.map((e) => e.type)).toEqual([
        'task_started',
        'task_completed',
      ])
      expect(service.getQueueStatus().completed).toBeGreaterThan(0)
    } finally {
      service?.shutdown()
      store?.close()
      cleanup(dir)
    }
  })

  it('records a deterministic script failure (exit 1) as FAILED without retrying', async () => {
    const dir = makeTempDir()
    let service: ScheduledTasksService | undefined
    let store: ScheduledTasksStore | undefined
    try {
      const scriptPath = writeScript(dir, 'exit1.js', 'process.exit(1)')
      const assembly = makeService(dir)
      service = assembly.service
      store = assembly.store
      const events: TaskEvent[] = []
      assembly.eventBus.subscribeAll((e) => events.push(e))

      // maxRetries 3 proves that even a task WITH retry budget never retries a
      // deterministic script failure (retrying repeats the same mistake).
      const task = await service.createTask(
        makeTaskConfig({
          name: 'exit-1',
          type: 'script',
          scriptPath,
          agentPrompt: null,
          maxRetries: 3,
        }),
      )
      await service.initialize()

      const result = await service.executeTaskNow(task.id)
      expect(result.outcome).toBe('started')
      if (result.outcome !== 'started') throw new Error('unreachable')

      await pollUntil(() => {
        const run = store?.getRun(result.runId)
        return run != null && TERMINAL_STATUSES.has(run.status)
      }, 'exit-1 run to settle')

      const run = store?.getRun(result.runId)
      expect(run?.status).toBe(TaskRunStatus.FAILED)
      expect(run?.exitCode).toBe(1)
      expect(run?.error).toContain('code 1')

      expect(store?.getTask(task.id)?.lastRunStatus).toBe(TaskRunStatus.FAILED)
      expect(store?.getTask(task.id)?.lastError).toContain('code 1')

      // Exactly one run row; no retry_scheduled event.
      expect(store?.listRunsByTask(task.id).runs).toHaveLength(1)
      expect(events.some((e) => e.type === 'retry_scheduled')).toBe(false)
    } finally {
      service?.shutdown()
      store?.close()
      cleanup(dir)
    }
  })

  it('retries a transient script failure with exponential backoff and drains it on the poll tick', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const dir = makeTempDir()
    let service: ScheduledTasksService | undefined
    let store: ScheduledTasksStore | undefined
    try {
      // An uncaught worker exception surfaces as a plain Error (not a
      // ScriptExecutionError), which the scheduler treats as transient and
      // therefore retryable — unlike a deterministic non-zero exit.
      const scriptPath = writeScript(
        dir,
        'throw.js',
        "throw new Error('boom from e2e worker')",
      )
      const assembly = makeService(dir)
      service = assembly.service
      store = assembly.store
      const events: TaskEvent[] = []
      assembly.eventBus.subscribeAll((e) => events.push(e))

      // maxRetries 2 = attempt 1 + one retry (attempt 2), then the task is
      // given up — exactly one retry_scheduled is expected (queue semantics:
      // attempt < maxRetries decides whether a retry is scheduled).
      const t0 = Date.now()
      const task = await service.createTask(
        makeTaskConfig({
          name: 'flaky',
          type: 'script',
          scriptPath,
          agentPrompt: null,
          maxRetries: 2,
        }),
      )
      await service.initialize()
      await jest.advanceTimersByTimeAsync(0)

      const result = await service.executeTaskNow(task.id)
      expect(result.outcome).toBe('started')
      if (result.outcome !== 'started') throw new Error('unreachable')
      const runId1 = result.runId

      // Attempt 1 fails -> the retry is announced with exponential backoff
      // (2^1 s) and waits in the queue rather than starting immediately.
      await pollUntil(
        () => store?.getRun(runId1)?.status === TaskRunStatus.FAILED,
        'attempt 1 to fail',
      )
      expect(events).toContainEqual({
        type: 'retry_scheduled',
        taskId: task.id,
        runId: runId1,
        attempt: 2,
        nextAttemptAtMs: t0 + 2_000,
      })
      expect(service.getExecutingTasks()).toHaveLength(0)
      expect(service.getPendingTasks()).toHaveLength(1)
      expect(service.getPendingTasks()[0]?.scheduleTime).toBe(t0 + 2_000)

      // The next poll tick drains the due retry (attempt 2); it fails again and
      // maxRetries (2) is exhausted — no further retry is scheduled.
      await jest.advanceTimersByTimeAsync(30_000)
      await pollUntil(() => {
        const runs = store?.listRunsByTask(task.id).runs ?? []
        return (
          runs.length === 2 &&
          runs.every((r) => TERMINAL_STATUSES.has(r.status))
        )
      }, 'attempt 2 to settle')

      const runs = [...(store?.listRunsByTask(task.id).runs ?? [])].sort(
        (a, b) => a.attempt - b.attempt,
      )
      expect(runs.map((r) => r.attempt)).toEqual([1, 2])
      expect(runs.map((r) => r.status)).toEqual([
        TaskRunStatus.FAILED,
        TaskRunStatus.FAILED,
      ])
      expect(runs.map((r) => r.triggeredBy)).toEqual(['manual', 'retry'])
      expect(runs[1]?.scheduledFor).toBe(t0 + 2_000)
      expect(events.filter((e) => e.type === 'retry_scheduled')).toHaveLength(1)

      expect(store?.getTask(task.id)?.lastRunStatus).toBe(TaskRunStatus.FAILED)
      expect(store?.getTask(task.id)?.lastError).toContain('boom')
    } finally {
      service?.shutdown()
      store?.close()
      jest.useRealTimers()
      cleanup(dir)
    }
  })

  it('dispatches ragIndex / ragAutoUpdate action tasks to the RAG index service', async () => {
    const dir = makeTempDir()
    let service: ScheduledTasksService | undefined
    let store: ScheduledTasksStore | undefined
    try {
      const runIndex = jest.fn().mockResolvedValue({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
      const assembly = makeService(dir, {
        getRagIndexService: () => ({
          runIndex,
          cancelActiveRun: jest.fn(),
        }),
      })
      service = assembly.service
      store = assembly.store

      const ragTask = await service.createTask(
        makeTaskConfig({
          name: 'rag-index',
          type: 'ragIndex',
          agentPrompt: null,
        }),
      )
      const autoTask = await service.createTask(
        makeTaskConfig({
          name: 'rag-auto',
          type: 'ragAutoUpdate',
          agentPrompt: null,
        }),
      )
      await service.initialize()

      // The default queue policy is sequential (maxConcurrent 1), so the two
      // manual triggers are executed one at a time; wait for the first run to
      // settle before triggering the second to keep the dispatch order
      // deterministic.
      const manual = await service.executeTaskNow(ragTask.id)
      expect(manual.outcome).toBe('started')
      if (manual.outcome !== 'started') throw new Error('unreachable')
      await pollUntil(() => {
        const run = store?.getRun(manual.runId)
        return run != null && TERMINAL_STATUSES.has(run.status)
      }, 'ragIndex run to settle')

      const auto = await service.executeTaskNow(autoTask.id)
      expect(auto.outcome).toBe('started')
      if (auto.outcome !== 'started') throw new Error('unreachable')
      await pollUntil(() => {
        const run = store?.getRun(auto.runId)
        return run != null && TERMINAL_STATUSES.has(run.status)
      }, 'ragAutoUpdate run to settle')

      const manualRun = store?.getRun(manual.runId)
      const autoRun = store?.getRun(auto.runId)
      expect(manualRun?.status).toBe(TaskRunStatus.COMPLETED)
      expect(manualRun?.exitCode).toBe(0)
      expect(manualRun?.output).toContain('RAG index sync completed')
      expect(autoRun?.status).toBe(TaskRunStatus.COMPLETED)

      // Action dispatch correctness: the scheduler routed the manual task to
      // executeRagIndex (trigger 'manual') and the auto task to
      // executeRagAutoUpdate (trigger 'auto').
      expect(runIndex).toHaveBeenCalledTimes(2)
      expect(runIndex.mock.calls[0]?.[0]).toMatchObject({
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'none',
      })
      expect(runIndex.mock.calls[1]?.[0]).toMatchObject({ trigger: 'auto' })
    } finally {
      service?.shutdown()
      store?.close()
      cleanup(dir)
    }
  })
})
