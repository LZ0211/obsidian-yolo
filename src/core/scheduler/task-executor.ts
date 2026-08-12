import { Platform } from 'obsidian'

import type { YoloAgentApi } from '../agent/agent-api'

import type {
  ScheduledTaskAgentConfig,
  TaskRunLogEntry,
} from './scheduledTasksStore'
import {
  type ScriptExecutionSettings,
  validateScriptPath,
} from './validateScriptPath'

export type TaskExecutorDeps = {
  getAgentApi: () => YoloAgentApi
  /** Vault filesystem root, used to resolve a task's vault-relative `scriptPath` before spawning a worker. Desktop-only; absent (or returning undefined) means script execution is unavailable. */
  getVaultBasePath?: () => string | undefined
  /** Second line of defense against a bad/disallowed `scriptPath` reaching the worker, in case a caller bypasses the UI/MCP-tool validation at create/update time (e.g. a task edited directly in the store). */
  getScriptExecutionSettings?: () => ScriptExecutionSettings
}

export type AgentExecutionResult = { conversationId: string; result: string }
export type ScriptExecutionResult = { output: string; exitCode: number }

const SCHEDULED_RUN_SYSTEM_MESSAGE = `This is an unattended scheduled task run, not an interactive chat. Execute the requested work without greeting the user or asking follow-up questions. Do not wait for approval: only use permissions explicitly granted to this task. Report only a meaningful result, failure, or required follow-up.`

/** Distinguishes a timeout from any other executor failure so the scheduler can persist run.status as TIMED_OUT instead of FAILED. */
export class TaskTimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskTimeoutError'
  }
}

/** Deterministic script failure (non-zero exit); the scheduler must not retry it. */
export class ScriptExecutionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScriptExecutionError'
  }
}

const TRUNCATE_HEAD_BYTES = 256 * 1024
const TRUNCATE_TAIL_BYTES = 256 * 1024

/** How long to wait for a timed-out run to settle after its abort signal fires. */
const AGENT_ABORT_GRACE_MS = 5000

/** Accumulates worker stdout/stderr chunks with a head+tail cap so a runaway script can't blow up the sqlite run record. */
class CappedOutputCollector {
  private headChunks: Buffer[] = []
  private headBytes = 0
  private tailChunks: Buffer[] = []
  private tailBytes = 0
  private truncated = false
  private totalBytes = 0

  append(chunk: Buffer): void {
    this.totalBytes += chunk.length
    if (this.headBytes < TRUNCATE_HEAD_BYTES) {
      const room = TRUNCATE_HEAD_BYTES - this.headBytes
      const head = chunk.subarray(0, room)
      this.headChunks.push(head)
      this.headBytes += head.length
      chunk = chunk.subarray(head.length)
      if (chunk.length === 0) return
      this.truncated = true
    } else {
      this.truncated = true
    }
    this.tailChunks.push(chunk)
    this.tailBytes += chunk.length
    while (this.tailBytes > TRUNCATE_TAIL_BYTES && this.tailChunks.length > 0) {
      const front = this.tailChunks[0]
      if (this.tailBytes - front.length >= TRUNCATE_TAIL_BYTES) {
        this.tailChunks.shift()
        this.tailBytes -= front.length
      } else {
        const keep = this.tailBytes - TRUNCATE_TAIL_BYTES
        this.tailChunks[0] = front.subarray(keep)
        this.tailBytes -= keep
        break
      }
    }
  }

  toString(): string {
    const head = Buffer.concat(this.headChunks).toString('utf-8')
    if (!this.truncated) return head
    const tail = Buffer.concat(this.tailChunks).toString('utf-8')
    const omittedBytes = this.totalBytes - this.headBytes - this.tailBytes
    const marker = `\n[output truncated, ~${Math.max(omittedBytes, 0)} bytes omitted]\n`
    return `${head}${marker}${tail}`
  }
}

/**
 * Single-task execution. Agent tasks run through `YoloAgentApi.run()`
 * (`src/core/agent/agent-api.ts`) — it already does exactly what a scheduled
 * agent task needs: mint a fresh conversationId, resolve the assistant/tool
 * policy, and run one independent turn to completion without requiring a
 * live chat window or platform adapter. This is a better fit than mirroring
 * `runBotAgentTurn()` (`src/core/bot/agent-runner.ts`), which exists to
 * stream replies back through a chat platform adapter — machinery a
 * scheduled task run doesn't need.
 */
export class TaskExecutor {
  constructor(private readonly deps: TaskExecutorDeps) {}

  /**
   * Runs a vault-relative script file in an isolated `node:worker_threads` Worker.
   * Desktop-only, following the same guard used by `runBash()` (`src/core/agent/bash/index.ts`):
   * check `Platform.isDesktop` before ever touching a Node built-in so the mobile bundle
   * never statically pulls in `node:worker_threads`.
   */
  async executeScript(
    scriptPath: string,
    options?: {
      timeoutMs?: number
      onLog?: (entry: TaskRunLogEntry) => void
      externalAbortSignal?: AbortSignal
    },
  ): Promise<ScriptExecutionResult> {
    if (!Platform.isDesktop) {
      throw new Error('Script task execution is only supported on desktop.')
    }
    const scriptSettings = this.deps.getScriptExecutionSettings?.()
    if (scriptSettings) {
      const pathError = validateScriptPath(scriptPath, scriptSettings)
      if (pathError) throw new Error(pathError.message)
    }
    const vaultBasePath = this.deps.getVaultBasePath?.()
    if (!vaultBasePath) {
      throw new Error('Unable to resolve the vault path for script execution.')
    }
    return this.executeWithTimeout(
      async (abortSignal) => {
        // eslint-disable-next-line import/no-nodejs-modules -- dynamic import inside the Platform.isDesktop guard, so the mobile bundle never pulls in node:worker_threads
        const { Worker } = await import('node:worker_threads')
        // Resolve the final filesystem target before starting the worker. Lexical
        // `..` checks do not protect against a symlink inside the vault pointing
        // outside it.
        // eslint-disable-next-line import/no-nodejs-modules -- dynamic import inside the Platform.isDesktop guard, so the mobile bundle never pulls in node:fs/promises
        const { realpath } = await import('node:fs/promises')
        // eslint-disable-next-line import/no-nodejs-modules -- dynamic import inside the Platform.isDesktop guard, so the mobile bundle never pulls in node:path
        const pathModule = await import('node:path')
        const vaultRoot = await realpath(vaultBasePath)
        const requestedPath = pathModule.resolve(vaultRoot, scriptPath)
        const resolvedScriptPath = await realpath(requestedPath)
        const relativePath = pathModule.relative(vaultRoot, resolvedScriptPath)
        if (
          relativePath === '..' ||
          relativePath.startsWith(`..${pathModule.sep}`) ||
          pathModule.isAbsolute(relativePath)
        ) {
          throw new Error('Script path resolves outside the vault.')
        }
        return new Promise<ScriptExecutionResult>((resolve, reject) => {
          let worker: InstanceType<typeof Worker>
          try {
            worker = new Worker(resolvedScriptPath, {
              stdout: true,
              stderr: true,
            })
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)))
            return
          }

          const collector = new CappedOutputCollector()
          let settled = false
          const onAbort = () => {
            void worker.terminate()
          }
          abortSignal.addEventListener('abort', onAbort)
          const cleanup = () =>
            abortSignal.removeEventListener('abort', onAbort)

          worker.stdout.on('data', (chunk: Buffer) => {
            collector.append(chunk)
            options?.onLog?.({
              timestamp: Date.now(),
              level: 'info',
              message: chunk.toString('utf-8'),
            })
          })
          worker.stderr.on('data', (chunk: Buffer) => {
            collector.append(chunk)
            options?.onLog?.({
              timestamp: Date.now(),
              level: 'error',
              message: chunk.toString('utf-8'),
            })
          })
          worker.on('error', (error) => {
            if (settled) return
            settled = true
            cleanup()
            reject(error)
          })
          worker.on('exit', (exitCode) => {
            if (settled) return
            settled = true
            cleanup()
            resolve({ output: collector.toString(), exitCode })
          })
        })
      },
      options?.timeoutMs,
      options?.externalAbortSignal,
    )
  }

  async executeAgent(
    prompt: string,
    options?: {
      timeoutMs?: number
      agentConfig?: ScheduledTaskAgentConfig | null
      externalAbortSignal?: AbortSignal
    },
  ): Promise<AgentExecutionResult> {
    return this.executeWithTimeout(
      async (abortSignal) => {
        const result = await this.deps.getAgentApi().run({
          // Master's YoloAgentApi has no dedicated request-scoped system-message
          // channel (the backup's `requestScopedSystemMessage`), so the
          // unattended-run instruction is prepended to the task prompt instead.
          // `systemPromptOverride` is deliberately not used: it marks the run as
          // a subagent child run (subagent tool blocking, no memory extraction)
          // and replaces the assistant's system prompt rather than appending.
          prompt: `${SCHEDULED_RUN_SYSTEM_MESSAGE}\n\n${prompt}`,
          assistantId: options?.agentConfig?.assistantId,
          tools: options?.agentConfig?.temporaryApprovedToolNames?.length
            ? {
                allowedToolNames:
                  options.agentConfig.temporaryApprovedToolNames,
              }
            : undefined,
          mode: 'agent',
          // Scheduled runs must not auto-approve tool calls. `yolo: false`
          // resolves to `bypassToolApproval: false` in the chat-mode runtime, so
          // no separate rejectToolApproval flag exists on master's request. A
          // future approval workflow can explicitly resume a run that is waiting
          // for approval.
          yolo: false,
          abortSignal,
        })
        if (result.status === 'error') {
          throw new Error(result.errorMessage ?? 'agent run failed')
        }
        return { conversationId: result.conversationId, result: result.text }
      },
      options?.timeoutMs,
      options?.externalAbortSignal,
    )
  }

  private async executeWithTimeout<T>(
    fn: (abortSignal: AbortSignal) => Promise<T>,
    timeoutMs?: number,
    externalAbortSignal?: AbortSignal,
  ): Promise<T> {
    const abortController = new AbortController()
    const onExternalAbort = (): void => {
      abortController.abort()
    }
    if (externalAbortSignal) {
      if (externalAbortSignal.aborted) {
        abortController.abort()
      } else {
        externalAbortSignal.addEventListener('abort', onExternalAbort, {
          once: true,
        })
      }
    }
    if (!timeoutMs) {
      try {
        return await fn(abortController.signal)
      } finally {
        externalAbortSignal?.removeEventListener('abort', onExternalAbort)
      }
    }

    const executionPromise = fn(abortController.signal)
    // A timed-out run is abandoned by Promise.race; if it rejects late (e.g.
    // the provider surfaces an abort error after the timeout), the abandoned
    // promise would otherwise produce an unhandled rejection. Swallow it.
    executionPromise.catch(() => undefined)

    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        abortController.abort()
        reject(
          new TaskTimeoutError(`task execution timed out after ${timeoutMs}ms`),
        )
        // Grace window: if the run ignores the abort signal entirely, flag it
        // so the operator sees a diagnostic instead of a silent background leak.
        void Promise.race([
          executionPromise.then(
            () => 'settled',
            () => 'settled',
          ),
          new Promise<string>((resolve) => {
            setTimeout(() => resolve('grace-elapsed'), AGENT_ABORT_GRACE_MS)
          }),
        ]).then((result) => {
          if (result === 'grace-elapsed') {
            console.warn(
              '[YOLO] Timed-out agent run did not settle within the abort grace window.',
            )
          }
        })
      }, timeoutMs)
    })

    try {
      return await Promise.race([executionPromise, timeoutPromise])
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      externalAbortSignal?.removeEventListener('abort', onExternalAbort)
    }
  }
}
