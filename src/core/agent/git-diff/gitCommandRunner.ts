import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { win32 as windowsPath } from 'node:path'

import { spawn as crossSpawn } from 'cross-spawn'

export type GitCommandRequest = {
  binary?: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  stdin?: string
  timeoutMs: number
  maxOutputBytes: number
}

export type GitCommandResult = {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  outputExceeded: boolean
}

export type GitCommandRunner = (
  request: GitCommandRequest,
) => Promise<GitCommandResult>

type RunState = 'starting' | 'running' | 'terminating' | 'closed'
type TerminationReason = 'timeout' | 'output'

const MAX_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const VALIDATION_ERROR_MAX_BYTES = 1_024
const FINALIZATION_WATCHDOG_MS = 2_000
const configuredWindowsRoot = process.env.SystemRoot ?? process.env.WINDIR
const windowsRoot =
  configuredWindowsRoot && windowsPath.isAbsolute(configuredWindowsRoot)
    ? configuredWindowsRoot
    : 'C:\\Windows'
const WINDOWS_TASKKILL_PATH = windowsPath.join(
  windowsRoot,
  'System32',
  'taskkill.exe',
)
const spawnFn = process.platform === 'win32' ? crossSpawn : spawn

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const isSafeProcessId = (pid: number | undefined): pid is number =>
  Number.isSafeInteger(pid) && pid !== undefined && pid > 0

const isSpawnFailure = (error: Error): boolean => {
  const code = (error as NodeJS.ErrnoException).code
  return code === 'EACCES' || code === 'ENOENT' || code === 'ENOEXEC'
}

const trimDecodedTextToBytes = (text: string, maxBytes: number): string => {
  let remainingBytes = Buffer.byteLength(text) - maxBytes
  if (remainingBytes <= 0) return text

  let end = text.length
  while (remainingBytes > 0 && end > 0) {
    let start = end - 1
    const trailingCodeUnit = text.charCodeAt(start)
    if (trailingCodeUnit >= 0xdc00 && trailingCodeUnit <= 0xdfff && start > 0) {
      start -= 1
    }
    remainingBytes -= Buffer.byteLength(text.slice(start, end))
    end = start
  }
  return text.slice(0, end)
}

const decodeCompleteUtf8 = (buffer: Buffer): string => {
  const earliestCandidate = Math.max(0, buffer.length - 3)
  for (let end = buffer.length; end >= earliestCandidate; end -= 1) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(
        buffer.subarray(0, end),
      )
    } catch {
      continue
    }
  }

  return trimDecodedTextToBytes(
    new TextDecoder('utf-8').decode(buffer),
    buffer.length,
  )
}

const boundedErrorResult = (
  message: string,
  maxBytes: number,
): GitCommandResult => {
  const messageBuffer = Buffer.from(message, 'utf8')
  const retainedBuffer = Buffer.from(messageBuffer.subarray(0, maxBytes))
  return {
    code: null,
    stdout: '',
    stderr: decodeCompleteUtf8(retainedBuffer),
    timedOut: false,
    outputExceeded: messageBuffer.length > maxBytes,
  }
}

const validateRequest = (request: GitCommandRequest): string | null => {
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs <= 0 ||
    request.timeoutMs > MAX_TIMEOUT_MS
  ) {
    return `timeoutMs must be an integer between 1 and ${MAX_TIMEOUT_MS}`
  }
  if (
    !Number.isSafeInteger(request.maxOutputBytes) ||
    request.maxOutputBytes <= 0 ||
    request.maxOutputBytes > MAX_OUTPUT_BYTES
  ) {
    return `maxOutputBytes must be an integer between 1 and ${MAX_OUTPUT_BYTES}`
  }
  return null
}

export const runGitCommand: GitCommandRunner = (request) => {
  const validationError = validateRequest(request)
  if (validationError) {
    return Promise.resolve(
      boundedErrorResult(validationError, VALIDATION_ERROR_MAX_BYTES),
    )
  }

  return new Promise((resolve) => {
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    let retainedOutputBytes = 0
    let timedOut = false
    let outputExceeded = false
    let hadRuntimeError = false
    let hasSpawned = false
    let childHasClosed = false
    let childCloseCode: number | null = null
    let treeTerminationSettled = false
    let state: RunState = 'starting'
    let commandTimeout: ReturnType<typeof setTimeout> | null = null
    let finalizationWatchdog: ReturnType<typeof setTimeout> | null = null
    let child: ChildProcessWithoutNullStreams

    const buildResult = (code: number | null): GitCommandResult => ({
      code: hadRuntimeError ? null : code,
      stdout: decodeCompleteUtf8(Buffer.concat(stdoutChunks)),
      stderr: decodeCompleteUtf8(Buffer.concat(stderrChunks)),
      timedOut,
      outputExceeded,
    })

    try {
      child = spawnFn(request.binary ?? 'git', request.args, {
        cwd: request.cwd,
        detached: process.platform !== 'win32',
        env: request.env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve(boundedErrorResult(errorMessage(error), request.maxOutputBytes))
      return
    }

    const clearTimers = () => {
      if (commandTimeout) {
        clearTimeout(commandTimeout)
        commandTimeout = null
      }
      if (finalizationWatchdog) {
        clearTimeout(finalizationWatchdog)
        finalizationWatchdog = null
      }
    }

    const forceKillDirectChild = () => {
      if (state === 'closed') return
      try {
        const killResult = child.kill('SIGKILL')
        if (
          killResult &&
          typeof (killResult as unknown as { catch?: unknown }).catch ===
            'function'
        ) {
          void Promise.resolve(killResult).catch(() => undefined)
        }
      } catch {
        return
      }
    }

    const forceKillTree = (onSettled: () => void) => {
      const pid = child.pid
      if (!isSafeProcessId(pid)) {
        onSettled()
        return
      }

      if (process.platform !== 'win32') {
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          forceKillDirectChild()
        }
        onSettled()
        return
      }

      let fallbackRequested = false
      let settled = false
      const settle = () => {
        if (settled) return
        settled = true
        onSettled()
      }
      const fallback = () => {
        if (state === 'closed') {
          settle()
          return
        }
        if (!fallbackRequested) {
          fallbackRequested = true
          forceKillDirectChild()
        }
        settle()
      }

      try {
        const taskkill = spawn(
          WINDOWS_TASKKILL_PATH,
          ['/PID', String(pid), '/T', '/F'],
          {
            shell: false,
            stdio: 'ignore',
            windowsHide: true,
          },
        )
        taskkill.once('error', fallback)
        taskkill.once('close', (code) => {
          if (state === 'closed') {
            settle()
            return
          }
          if (code === 0) {
            settle()
          } else {
            fallback()
          }
        })
        taskkill.unref()
      } catch {
        fallback()
      }
    }

    const retainChunk = (chunks: Buffer[], chunk: Buffer | string): boolean => {
      if (state === 'closed' || outputExceeded) return false

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      const remainingBytes = request.maxOutputBytes - retainedOutputBytes
      const retainedBytes = Math.min(buffer.length, remainingBytes)
      if (retainedBytes > 0) {
        chunks.push(Buffer.from(buffer.subarray(0, retainedBytes)))
        retainedOutputBytes += retainedBytes
      }
      if (retainedBytes === buffer.length) return false

      outputExceeded = true
      return true
    }

    const cleanup = (watchdogExpired: boolean) => {
      clearTimers()
      child.stdout.removeListener('data', handleStdout)
      child.stderr.removeListener('data', handleStderr)
      child.stdin.removeListener('error', handleStdinError)
      child.removeListener('spawn', handleSpawn)
      child.removeListener('error', handleError)
      child.removeListener('close', handleClose)
      if (watchdogExpired) {
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
      }
    }

    const finish = (code: number | null, watchdogExpired = false): void => {
      if (state === 'closed') return
      state = 'closed'
      cleanup(watchdogExpired)
      resolve(buildResult(code))
    }

    const requestTermination = (reason?: TerminationReason): void => {
      if (reason === 'timeout') timedOut = true
      if (reason === 'output') outputExceeded = true
      if (state === 'closed' || state === 'terminating') return

      state = 'terminating'
      if (commandTimeout) {
        clearTimeout(commandTimeout)
        commandTimeout = null
      }
      finalizationWatchdog = setTimeout(
        () => finish(null, true),
        FINALIZATION_WATCHDOG_MS,
      )
      forceKillTree(() => {
        if (state !== 'terminating') return
        treeTerminationSettled = true
        if (childHasClosed) finish(childCloseCode)
      })
    }

    function handleStdout(chunk: Buffer): void {
      if (retainChunk(stdoutChunks, chunk)) requestTermination('output')
    }

    function handleStderr(chunk: Buffer): void {
      if (retainChunk(stderrChunks, chunk)) requestTermination('output')
    }

    function handleStdinError(): void {}

    function handleSpawn(): void {
      hasSpawned = true
      if (state === 'starting') state = 'running'
    }

    function handleError(error: Error): void {
      hadRuntimeError = true
      if (!hasSpawned || isSpawnFailure(error)) {
        retainChunk(stderrChunks, errorMessage(error))
        if (!hasSpawned || child.pid === undefined) finish(null)
        return
      }

      if (retainChunk(stderrChunks, errorMessage(error))) {
        requestTermination('output')
      } else {
        requestTermination()
      }
    }

    function handleClose(code: number | null): void {
      childHasClosed = true
      childCloseCode = code
      if (state === 'terminating' && !treeTerminationSettled) return
      finish(code)
    }

    child.stdout.on('data', handleStdout)
    child.stderr.on('data', handleStderr)
    child.stdin.on('error', handleStdinError)
    child.once('spawn', handleSpawn)
    child.on('error', handleError)
    child.once('close', handleClose)

    commandTimeout = setTimeout(
      () => requestTermination('timeout'),
      request.timeoutMs,
    )
    commandTimeout.unref?.()

    try {
      child.stdin.end(request.stdin)
    } catch {
      return
    }
  })
}
