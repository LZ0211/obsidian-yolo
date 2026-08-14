import type { AgentRunTerminalStatus } from '../../types/agentRun'
import type { YoloAgentEvent } from '../agent/agent-api'
import type { AgentEventStore } from '../agent/agentEventStore'
import type { AgentConversationState } from '../agent/service'

import type { WebSseHub } from './WebSseHub'

export type StartWebAgentRunInput = {
  runId: string
  conversationId: string
  workspaceId: string | null
  agentInstanceId: string | null
  startedAtMs?: number
  execute: (input: {
    abortSignal: AbortSignal
    onEvent: (event: WebAgentRunEvent) => void
  }) => Promise<void>
  abort: () => boolean
}

export type WebAgentRunEvent =
  | YoloAgentEvent
  | (AgentConversationState & { type: 'state' })

export type WebAgentRunBridgeOptions = {
  eventStore: AgentEventStore
  sseHub: WebSseHub
  now?: () => number
}

/** 终态 run 记录保留 TTL（E6-F5）：超过后随下一次 start 惰性清理。 */
const RUN_RECORD_RETENTION_TTL_MS = 24 * 60 * 60 * 1000
const BRIDGE_DISPOSE_TIMEOUT_MS = 5_000

export class WebAgentRunBridge {
  private readonly now: () => number
  private readonly abortControllersByRun = new Map<string, AbortController>()
  private readonly abortRunCallbacksByRun = new Map<string, () => boolean>()
  private readonly activeRuns = new Map<string, Promise<void>>()
  private disposed = false

  constructor(private readonly options: WebAgentRunBridgeOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  start(input: StartWebAgentRunInput): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new Error('web agent run bridge is disposed'))
    }
    const startedAtMs = input.startedAtMs ?? this.now()
    // E6-F5：新 run 到来时顺带清理过期终态记录（events 级联删除）。
    this.options.eventStore.sweepExpiredRuns(
      startedAtMs,
      RUN_RECORD_RETENTION_TTL_MS,
    )
    this.options.eventStore.createRun({
      runId: input.runId,
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      agentInstanceId: input.agentInstanceId,
      status: 'running',
      startedAtMs,
    })

    const abortController = new AbortController()
    this.abortControllersByRun.set(input.runId, abortController)
    this.abortRunCallbacksByRun.set(input.runId, input.abort)

    const completion = this.consumeRun(input, abortController).finally(() => {
      this.abortControllersByRun.delete(input.runId)
      this.abortRunCallbacksByRun.delete(input.runId)
      this.activeRuns.delete(input.runId)
    })
    this.activeRuns.set(input.runId, completion)
    return completion
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.waitForActiveRuns()
      return
    }
    this.disposed = true
    for (const runId of this.activeRuns.keys()) {
      this.abort(runId)
    }
    await this.waitForActiveRuns()
  }

  abort(runId: string): { found: boolean; status: AgentRunTerminalStatus } {
    const run = this.options.eventStore.getRun(runId)
    if (run == null) {
      return { found: false, status: 'aborted' }
    }

    this.abortControllersByRun.get(runId)?.abort()
    this.abortRunCallbacksByRun.get(runId)?.()
    if (run.status === 'running') {
      this.options.eventStore.updateRunStatus(runId, 'aborted', this.now())
      return { found: true, status: 'aborted' }
    }
    return { found: true, status: run.status }
  }

  private async consumeRun(
    input: StartWebAgentRunInput,
    abortController: AbortController,
  ): Promise<void> {
    let sequence = 0
    let finalStatus: AgentRunTerminalStatus = 'completed'

    try {
      await input.execute({
        abortSignal: abortController.signal,
        onEvent: (event) => {
          if (this.disposed || abortController.signal.aborted) return
          sequence += 1
          if (!this.options.eventStore.isOpen) return
          try {
            this.options.eventStore.insertEvent({
              runId: input.runId,
              sequence,
              eventType: event.type,
              eventJson: event,
              createdAtMs: this.now(),
            })
          } catch (error) {
            if (this.options.eventStore.isOpen) throw error
            return
          }
          this.options.sseHub.publish(input.runId, {
            sequence,
            eventType: event.type,
            eventJson: event,
            createdAtMs: this.now(),
          })
          const status = getTerminalStatus(event)
          if (
            status === 'aborted' ||
            status === 'error' ||
            status === 'completed'
          ) {
            finalStatus = status
          }
        },
      })
    } catch (error) {
      finalStatus = abortController.signal.aborted ? 'aborted' : 'error'
      if (this.disposed || !this.options.eventStore.isOpen) return
      sequence += 1
      const message = error instanceof Error ? error.message : String(error)
      const event = {
        type: 'state' as const,
        conversationId: input.conversationId,
        status: 'error' as const,
        messages: [],
        compaction: [],
        pendingCompactionAnchorMessageId: null,
        errorMessage: message,
      }
      this.options.eventStore.insertEvent({
        runId: input.runId,
        sequence,
        eventType: 'state',
        eventJson: event,
        createdAtMs: this.now(),
      })
      this.options.sseHub.publish(input.runId, {
        sequence,
        eventType: 'state',
        eventJson: event,
        createdAtMs: this.now(),
      })
    } finally {
      this.persistTerminalStatus(input.runId, finalStatus)
      // Run 已终态：主动关闭该 run 的 SSE 流，让客户端 consumeRunStream
      // 收到 done 后走 refreshAgentState 拉全量状态兜底。否则事件交付依赖
      // 首条连接上的实时推送竞态（浏览器可能只收到首块），回复会丢。
      if (!this.disposed) this.options.sseHub.clearRun(input.runId)
    }
  }

  private persistTerminalStatus(
    runId: string,
    status: AgentRunTerminalStatus,
  ): void {
    if (this.disposed || !this.options.eventStore.isOpen) return
    try {
      const run = this.options.eventStore.getRun(runId)
      if (run?.status === 'running') {
        this.options.eventStore.updateRunStatus(runId, status, this.now())
      }
    } catch (error) {
      if (this.options.eventStore.isOpen) {
        console.error('[YOLO] Failed to persist web agent run status:', error)
      }
    }
  }

  private async waitForActiveRuns(): Promise<void> {
    const activeRuns = Promise.allSettled([...this.activeRuns.values()])
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        activeRuns,
        new Promise<void>((resolve) => {
          timeout = setTimeout(resolve, BRIDGE_DISPOSE_TIMEOUT_MS)
          ;(timeout as unknown as { unref?: () => void }).unref?.()
        }),
      ])
    } finally {
      if (timeout != null) clearTimeout(timeout)
    }
  }
}

function getTerminalStatus(
  event: WebAgentRunEvent,
): AgentRunTerminalStatus | null {
  if (event.type === 'state') {
    return event.status === 'completed' ||
      event.status === 'aborted' ||
      event.status === 'error'
      ? event.status
      : null
  }
  if (event.type === 'completed') return 'completed'
  if (event.type === 'error') return 'error'
  return null
}
