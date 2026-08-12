import { decideAfterLlmResult, decideAfterToolResult } from './loop-decision'
import { AgentWorkerInbound, AgentWorkerOutbound } from './types'

type WorkerSubscriber = (message: AgentWorkerOutbound) => void

type WorkerBridge = {
  postMessage: (message: AgentWorkerInbound) => void
  subscribe: (callback: WorkerSubscriber) => () => void
  terminate: () => void
}

type LoopState = {
  runId: string
  iteration: number
  maxIterations: number
  /**
   * Whether the optional single tools-disabled grace request past the budget
   * is enabled for this run. Lives in worker state, not a closure, so the
   * Blob-embedded decision function stays self-contained.
   */
  graceEnabled: boolean
  /** Set once the single grace request has been issued. */
  graceUsed: boolean
  aborted: boolean
  duplicateCallStreak: number
  previousToolSignature: string | null
  maxRepeatedToolCalls: number
}

/**
 * Exact-duplicate-call guard state is embedded in the worker script via
 * `function.toString()`, so this helper must stay self-contained (no closed-over
 * classes or imports). It derives a signature from the normalized short tool
 * name plus recursively key-sorted JSON arguments; null means "no tool executed"
 * and resets the streak.
 */
const normalizeToolSignature = (
  toolName: string | undefined,
  toolArgs: unknown,
): string | null => {
  if (!toolName) return null

  const shortName = toolName.includes('__')
    ? toolName.slice(toolName.indexOf('__') + 2)
    : (toolName.split(/[/:]/).pop() ?? toolName)

  const canonicalize = (input: unknown): unknown => {
    if (input === null || input === undefined) return null
    if (Array.isArray(input)) return input.map(canonicalize)
    if (typeof input === 'object') {
      const record = input as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(record).sort()) {
        out[key] = canonicalize(record[key])
      }
      return out
    }
    return input
  }

  return `${shortName}:${JSON.stringify(canonicalize(toolArgs))}`
}

/**
 * Exported for the parity test suite, which evaluates this string in a `vm`
 * context to drive the real Blob-worker code path. Not part of the public API.
 */
export const WORKER_SCRIPT = `
const createState = (runId, maxIterations, maxRepeatedToolCalls, graceEnabled) => ({
  runId,
  iteration: 0,
  maxIterations: Math.max(1, maxIterations),
  graceEnabled: graceEnabled === true,
  graceUsed: false,
  aborted: false,
  duplicateCallStreak: 0,
  previousToolSignature: null,
  maxRepeatedToolCalls: Math.max(1, maxRepeatedToolCalls ?? 3),
})

let state = null

const emit = (msg) => {
  self.postMessage(msg)
}

const decideAfterLlmResult = ({ hasToolCalls }) => {
  if (hasToolCalls) {
    return { type: 'tool_phase' }
  }
  return { type: 'done', reason: 'completed' }
}

const decideAfterToolResult = ({
  forceStopReason,
  hasPendingTools,
  iteration,
  maxIterations,
  graceEnabled,
  graceUsed,
  repeatedToolCall,
}) => {
  if (forceStopReason) {
    return { type: 'done', reason: forceStopReason }
  }
  if (repeatedToolCall) {
    return { type: 'done', reason: 'repeated_tool_call' }
  }
  if (hasPendingTools) {
    return { type: 'done', reason: 'completed' }
  }
  if (iteration >= maxIterations) {
    if (graceEnabled && !graceUsed) {
      return { type: 'llm_request', nextIteration: iteration + 1, toolsDisabled: true }
    }
    return { type: 'done', reason: 'max_iterations' }
  }
  return { type: 'llm_request', nextIteration: iteration + 1 }
}

const normalizeToolSignature = ${normalizeToolSignature.toString()}

self.onmessage = (event) => {
  const message = event.data
  try {
    switch (message.type) {
      case 'start': {
        state = createState(
          message.runId,
          message.maxIterations,
          message.maxRepeatedToolCalls,
          message.graceEnabled,
        )
        emit({ type: 'llm_request', runId: message.runId, iteration: 1 })
        return
      }
      case 'abort': {
        if (!state || state.runId !== message.runId) return
        state.aborted = true
        emit({ type: 'done', runId: message.runId, reason: 'aborted' })
        return
      }
      case 'stop': {
        if (!state || state.runId !== message.runId) return
        emit({ type: 'done', runId: message.runId, reason: 'completed' })
        return
      }
      case 'llm_result': {
        if (!state || state.runId !== message.runId) return
        if (state.aborted) {
          emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }
        state.iteration += 1
        const decision = decideAfterLlmResult({
          hasToolCalls: message.hasToolCalls,
          hasAssistantOutput: message.hasAssistantOutput,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
        })
        if (decision.type === 'tool_phase') {
          emit({ type: 'tool_phase', runId: message.runId })
          return
        }
        if (decision.type === 'done') {
          emit({ type: 'done', runId: message.runId, reason: decision.reason })
          return
        }
        emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: decision.nextIteration,
        })
        return
      }
      case 'tool_result': {
        if (!state || state.runId !== message.runId) return
        if (state.aborted) {
          emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }
        const signature = normalizeToolSignature(
          message.toolName,
          message.toolArgs,
        )
        if (signature === null) {
          state.duplicateCallStreak = 0
          state.previousToolSignature = null
        } else if (signature === state.previousToolSignature) {
          state.duplicateCallStreak += 1
        } else {
          state.duplicateCallStreak = 1
          state.previousToolSignature = signature
        }
        const decision = decideAfterToolResult({
          forceStopReason: message.forceStopReason,
          hasPendingTools: message.hasPendingTools,
          iteration: state.iteration,
          maxIterations: state.maxIterations,
          graceEnabled: state.graceEnabled,
          graceUsed: state.graceUsed,
          repeatedToolCall:
            state.duplicateCallStreak >= state.maxRepeatedToolCalls,
        })
        if (decision.type === 'done') {
          emit({ type: 'done', runId: message.runId, reason: decision.reason })
          return
        }
        if (decision.toolsDisabled) {
          state.graceUsed = true
        }
        emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: decision.nextIteration,
          ...(decision.toolsDisabled ? { toolsDisabled: true } : {}),
        })
      }
    }
  } catch (error) {
    emit({
      type: 'error',
      runId: message && message.runId ? message.runId : 'unknown',
      error: error instanceof Error ? error.message : String(error),
    })
  }
}
`

/**
 * In-process fallback for environments without a Web Worker. Exported for the
 * parity test suite so the same message sequences drive both this driver and
 * the Blob worker script. Not part of the public host API.
 */
export class AgentLoopWorkerDriver {
  private state: LoopState | null = null
  private subscribers = new Set<WorkerSubscriber>()

  subscribe(callback: WorkerSubscriber): () => void {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  postMessage(message: AgentWorkerInbound): void {
    try {
      this.handleMessage(message)
    } catch (error) {
      this.emit({
        type: 'error',
        runId: 'runId' in message ? message.runId : 'unknown',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  terminate(): void {
    this.subscribers.clear()
    this.state = null
  }

  private handleMessage(message: AgentWorkerInbound): void {
    switch (message.type) {
      case 'start': {
        this.state = {
          runId: message.runId,
          iteration: 0,
          maxIterations: Math.max(1, message.maxIterations),
          graceEnabled: message.graceEnabled === true,
          graceUsed: false,
          aborted: false,
          duplicateCallStreak: 0,
          previousToolSignature: null,
          maxRepeatedToolCalls: Math.max(1, message.maxRepeatedToolCalls ?? 3),
        }
        this.emit({ type: 'llm_request', runId: message.runId, iteration: 1 })
        return
      }
      case 'abort': {
        if (this.state?.runId !== message.runId) return
        this.state.aborted = true
        this.emit({ type: 'done', runId: message.runId, reason: 'aborted' })
        return
      }
      case 'stop': {
        // 与 Blob 脚本行为一致：主线程 loop policy 要求停止时，settle 为
        // completed。缺失该分支会让无 Worker 环境（fallback driver）忽略
        // stop 消息直到 max_iterations 才终止。
        if (this.state?.runId !== message.runId) return
        this.emit({ type: 'done', runId: message.runId, reason: 'completed' })
        return
      }
      case 'llm_result': {
        if (!this.state || this.state.runId !== message.runId) return
        if (this.state.aborted) {
          this.emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }
        this.state.iteration += 1
        const decision = decideAfterLlmResult({
          hasToolCalls: message.hasToolCalls,
          hasAssistantOutput: message.hasAssistantOutput,
          iteration: this.state.iteration,
          maxIterations: this.state.maxIterations,
        })
        if (decision.type === 'tool_phase') {
          this.emit({ type: 'tool_phase', runId: message.runId })
          return
        }
        if (decision.type === 'done') {
          this.emit({
            type: 'done',
            runId: message.runId,
            reason: decision.reason,
          })
          return
        }
        this.emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: decision.nextIteration,
        })
        return
      }
      case 'tool_result': {
        if (!this.state || this.state.runId !== message.runId) return
        if (this.state.aborted) {
          this.emit({ type: 'done', runId: message.runId, reason: 'aborted' })
          return
        }

        const signature = normalizeToolSignature(
          message.toolName,
          message.toolArgs,
        )
        if (signature === null) {
          this.state.duplicateCallStreak = 0
          this.state.previousToolSignature = null
        } else if (signature === this.state.previousToolSignature) {
          this.state.duplicateCallStreak += 1
        } else {
          this.state.duplicateCallStreak = 1
          this.state.previousToolSignature = signature
        }

        const decision = decideAfterToolResult({
          forceStopReason: message.forceStopReason,
          hasPendingTools: message.hasPendingTools,
          iteration: this.state.iteration,
          maxIterations: this.state.maxIterations,
          graceEnabled: this.state.graceEnabled,
          graceUsed: this.state.graceUsed,
          repeatedToolCall:
            this.state.duplicateCallStreak >= this.state.maxRepeatedToolCalls,
        })

        if (decision.type === 'done') {
          this.emit({
            type: 'done',
            runId: message.runId,
            reason: decision.reason,
          })
          return
        }

        if (decision.toolsDisabled) {
          this.state.graceUsed = true
        }

        this.emit({
          type: 'llm_request',
          runId: message.runId,
          iteration: decision.nextIteration,
          ...(decision.toolsDisabled ? { toolsDisabled: true } : {}),
        })
      }
    }
  }

  private emit(message: AgentWorkerOutbound): void {
    this.subscribers.forEach((cb) => {
      cb(message)
    })
  }
}

const createWebWorkerBridge = (): WorkerBridge | null => {
  if (typeof Worker === 'undefined' || typeof Blob === 'undefined') {
    return null
  }

  const blob = new Blob([WORKER_SCRIPT], {
    type: 'application/javascript',
  })
  const url = URL.createObjectURL(blob)

  try {
    const worker = new Worker(url)
    const subscribers = new Set<WorkerSubscriber>()

    worker.onmessage = (event: MessageEvent<AgentWorkerOutbound>) => {
      subscribers.forEach((cb) => {
        cb(event.data)
      })
    }

    return {
      postMessage: (message) => worker.postMessage(message),
      subscribe: (callback) => {
        subscribers.add(callback)
        return () => subscribers.delete(callback)
      },
      terminate: () => {
        subscribers.clear()
        worker.terminate()
        URL.revokeObjectURL(url)
      },
    }
  } catch {
    URL.revokeObjectURL(url)
    return null
  }
}

export const createAgentLoopWorker = (): WorkerBridge => {
  const webWorkerBridge = createWebWorkerBridge()
  if (webWorkerBridge) {
    return webWorkerBridge
  }

  const driver = new AgentLoopWorkerDriver()
  return {
    postMessage: (message) => driver.postMessage(message),
    subscribe: (callback) => driver.subscribe(callback),
    terminate: () => driver.terminate(),
  }
}
