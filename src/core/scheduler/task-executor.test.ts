/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { Platform } from 'obsidian'

import type {
  YoloAgentApi,
  YoloAgentRunRequest,
  YoloAgentRunResult,
} from '../agent/agent-api'

import { TaskExecutor } from './task-executor'

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'task-executor-'))
}

function cleanup(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  })
}

function writeScript(dir: string, name: string, source: string): string {
  fs.writeFileSync(path.join(dir, name), source, 'utf-8')
  return name
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

describe('TaskExecutor.executeAgent', () => {
  it('prepends the scheduled-run instruction to the agent prompt', async () => {
    let capturedPrompt: string | undefined
    const agentApi = makeAgentApi(async (request) => {
      capturedPrompt = request.prompt
      return { conversationId: 'conv-1', text: 'ok', status: 'completed' }
    })
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })

    await executor.executeAgent('prompt')

    expect(capturedPrompt).toContain('scheduled task')
    expect(capturedPrompt).toContain('Do not wait for approval')
    expect(capturedPrompt).toContain('meaningful result')
    expect(capturedPrompt).toContain('prompt')
  })

  it('resolves with the conversationId and text on a completed run', async () => {
    let capturedPrompt: string | undefined
    const agentApi = makeAgentApi(async (request) => {
      capturedPrompt = request.prompt
      return {
        conversationId: 'conv-1',
        text: `handled: ${request.prompt}`,
        status: 'completed',
      }
    })
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })

    const result = await executor.executeAgent('summarize today')

    expect(result).toEqual({
      conversationId: 'conv-1',
      result: `handled: ${capturedPrompt}`,
    })
  })

  it('passes agentConfig.assistantId through to the run request', async () => {
    let capturedAssistantId: string | undefined
    const agentApi = makeAgentApi(async (request) => {
      capturedAssistantId = request.assistantId
      return { conversationId: 'conv-1', text: 'ok', status: 'completed' }
    })
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })

    await executor.executeAgent('prompt', {
      agentConfig: { assistantId: 'assistant-1' },
    })

    expect(capturedAssistantId).toBe('assistant-1')
  })

  it('does not auto-approve tool calls for scheduled runs', async () => {
    let capturedYolo: boolean | undefined
    const agentApi = makeAgentApi(async (request) => {
      capturedYolo = request.yolo
      return { conversationId: 'conv-1', text: 'ok', status: 'completed' }
    })
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })

    await executor.executeAgent('prompt')

    expect(capturedYolo).toBe(false)
  })

  it('passes temporary task tool approvals without changing assistant settings', async () => {
    let capturedTools: string[] | undefined
    const agentApi = makeAgentApi(async (request) => {
      capturedTools = request.tools?.allowedToolNames
      return { conversationId: 'conv-1', text: 'ok', status: 'completed' }
    })
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })

    await executor.executeAgent('prompt', {
      agentConfig: {
        assistantId: 'assistant-1',
        temporaryApprovedToolNames: ['yolo_local__read_file'],
      },
    })

    expect(capturedTools).toEqual(['yolo_local__read_file'])
  })

  it('throws when the run result status is error', async () => {
    const agentApi = makeAgentApi(async () => ({
      conversationId: 'conv-1',
      text: '',
      status: 'error',
      errorMessage: 'model unavailable',
    }))
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })

    await expect(executor.executeAgent('prompt')).rejects.toThrow(
      'model unavailable',
    )
  })

  it('rejects with a timeout error and aborts the run when timeoutMs elapses', async () => {
    jest.useFakeTimers()
    let observedSignal: AbortSignal | undefined
    const agentApi = makeAgentApi(
      (request) =>
        new Promise((_, reject) => {
          observedSignal = request.abortSignal
          request.abortSignal?.addEventListener('abort', () =>
            reject(new Error('aborted')),
          )
        }),
    )
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })

    const promise = executor.executeAgent('prompt', { timeoutMs: 1000 })
    const expectation = expect(promise).rejects.toThrow('timed out')
    await jest.advanceTimersByTimeAsync(1000)
    await expectation

    expect(observedSignal?.aborted).toBe(true)
    jest.useRealTimers()
  })

  it('logs a grace-window diagnostic when a timed-out run ignores the abort signal', async () => {
    jest.useFakeTimers()
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const agentApi = makeAgentApi(
      // Never settles: ignores the abort signal entirely.
      () => new Promise(() => {}),
    )
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })

    const promise = executor.executeAgent('prompt', { timeoutMs: 1000 })
    const expectation = expect(promise).rejects.toThrow('timed out')
    await jest.advanceTimersByTimeAsync(1000)
    await expectation

    await jest.advanceTimersByTimeAsync(5000)

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('grace window'),
    )
    warnSpy.mockRestore()
    jest.useRealTimers()
  })
})

describe('TaskExecutor.executeScript', () => {
  const agentApi = makeAgentApi(async () => {
    throw new Error('not used in these tests')
  })
  let dir: string

  beforeEach(() => {
    dir = makeTempDir()
  })

  afterEach(() => {
    cleanup(dir)
  })

  it('runs a script in a worker thread and captures stdout', async () => {
    const scriptPath = writeScript(
      dir,
      'echo.js',
      "console.log('hello from worker')",
    )
    const executor = new TaskExecutor({
      getAgentApi: () => agentApi,
      getVaultBasePath: () => dir,
    })

    const result = await executor.executeScript(scriptPath)

    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('hello from worker')
  })

  it('captures a non-zero exit code', async () => {
    const scriptPath = writeScript(dir, 'exit.js', 'process.exit(2)')
    const executor = new TaskExecutor({
      getAgentApi: () => agentApi,
      getVaultBasePath: () => dir,
    })

    const result = await executor.executeScript(scriptPath)

    expect(result.exitCode).toBe(2)
  })

  it('rejects with a timeout error and terminates a hanging script', async () => {
    const scriptPath = writeScript(
      dir,
      'hang.js',
      'setInterval(() => {}, 1000)',
    )
    const executor = new TaskExecutor({
      getAgentApi: () => agentApi,
      getVaultBasePath: () => dir,
    })

    await expect(
      executor.executeScript(scriptPath, { timeoutMs: 200 }),
    ).rejects.toThrow('timed out')
  })

  it('throws when the platform is not desktop', async () => {
    Platform.isDesktop = false
    try {
      const executor = new TaskExecutor({
        getAgentApi: () => agentApi,
        getVaultBasePath: () => dir,
      })
      await expect(executor.executeScript('unused.js')).rejects.toThrow(
        'only supported on desktop',
      )
    } finally {
      Platform.isDesktop = true
    }
  })

  it('throws when no vault base path is available', async () => {
    const executor = new TaskExecutor({ getAgentApi: () => agentApi })
    await expect(executor.executeScript('unused.js')).rejects.toThrow(
      'Unable to resolve the vault path',
    )
  })

  it('invokes onLog with an entry per stdout/stderr chunk', async () => {
    const scriptPath = writeScript(
      dir,
      'log.js',
      "console.log('stdout line'); console.error('stderr line')",
    )
    const executor = new TaskExecutor({
      getAgentApi: () => agentApi,
      getVaultBasePath: () => dir,
    })
    const entries: { level: string; message: string }[] = []

    await executor.executeScript(scriptPath, {
      onLog: (entry) => entries.push(entry),
    })

    expect(
      entries.some(
        (e) => e.level === 'info' && e.message.includes('stdout line'),
      ),
    ).toBe(true)
    expect(
      entries.some(
        (e) => e.level === 'error' && e.message.includes('stderr line'),
      ),
    ).toBe(true)
  })
})

describe('TaskExecutor RAG actions', () => {
  type RagIndexServiceLike = {
    runIndex: jest.Mock
    cancelActiveRun: jest.Mock
  }

  const makeRagIndexService = (
    overrides: Partial<RagIndexServiceLike> = {},
  ): RagIndexServiceLike => ({
    runIndex: jest.fn().mockResolvedValue({
      permanentFailedPaths: [],
      chunkifyFailedPaths: [],
    }),
    cancelActiveRun: jest.fn(),
    ...overrides,
  })

  const makeExecutorWithRag = (service: RagIndexServiceLike): TaskExecutor =>
    new TaskExecutor({
      getAgentApi: () =>
        makeAgentApi(async () => {
          throw new Error('not used in RAG action tests')
        }),
      getRagIndexService: () => service,
    })

  it('executes a ragIndex action through RagIndexService as a manual vault-wide sync', async () => {
    const service = makeRagIndexService()
    const executor = makeExecutorWithRag(service)

    const result = await executor.executeRagIndex()

    expect(service.runIndex).toHaveBeenCalledTimes(1)
    expect(service.runIndex).toHaveBeenCalledWith({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })
    expect(result.exitCode).toBe(0)
    expect(result.output).toContain('completed')
  })

  it('executes a ragAutoUpdate action as an auto-triggered vault-wide sync', async () => {
    const service = makeRagIndexService()
    const executor = makeExecutorWithRag(service)

    const result = await executor.executeRagAutoUpdate()

    expect(service.runIndex).toHaveBeenCalledWith(
      expect.objectContaining({ trigger: 'auto' }),
    )
    expect(result.exitCode).toBe(0)
  })

  it('surfaces a ragIndex failure as a run failure carrying the underlying message', async () => {
    const service = makeRagIndexService({
      runIndex: jest
        .fn()
        .mockRejectedValue(new Error('embedding provider unavailable')),
    })
    const executor = makeExecutorWithRag(service)

    await expect(executor.executeRagIndex()).rejects.toThrow(
      'embedding provider unavailable',
    )
  })

  it('aborts the active index run when the scheduled run is cancelled', async () => {
    const cancelActiveRun = jest.fn()
    const runIndex = jest.fn(
      () =>
        new Promise((_, reject) => {
          cancelActiveRun.mockImplementationOnce(() =>
            reject(new Error('index aborted')),
          )
        }),
    )
    const executor = makeExecutorWithRag({ runIndex, cancelActiveRun })
    const controller = new AbortController()

    const promise = executor.executeRagIndex({
      externalAbortSignal: controller.signal,
    })
    await Promise.resolve()
    controller.abort()

    await expect(promise).rejects.toThrow('index aborted')
    expect(cancelActiveRun).toHaveBeenCalled()
  })

  it('does not start an index run when the scheduled run was already cancelled', async () => {
    const service = makeRagIndexService()
    const executor = makeExecutorWithRag(service)
    const controller = new AbortController()
    controller.abort()

    await expect(
      executor.executeRagIndex({ externalAbortSignal: controller.signal }),
    ).rejects.toThrow('cancelled before it started')
    expect(service.runIndex).not.toHaveBeenCalled()
  })

  it('rejects with a timeout error when the index run exceeds timeoutMs', async () => {
    jest.useFakeTimers()
    const service = makeRagIndexService({
      runIndex: jest.fn(() => new Promise(() => {})),
    })
    const executor = makeExecutorWithRag(service)

    const promise = executor.executeRagIndex({ timeoutMs: 1000 })
    const expectation = expect(promise).rejects.toThrow('timed out')
    await jest.advanceTimersByTimeAsync(1000)
    await expectation

    // The index run itself is owned by RagIndexService and is left to finish
    // in the background; the executor only bounds the queue slot.
    expect(service.runIndex).toHaveBeenCalledTimes(1)
    jest.useRealTimers()
  })

  it('rejects when no RAG index service is available', async () => {
    const executor = new TaskExecutor({
      getAgentApi: () =>
        makeAgentApi(async () => {
          throw new Error('not used in RAG action tests')
        }),
    })

    await expect(executor.executeRagIndex()).rejects.toThrow(
      'RAG index service is not available',
    )
  })
})
