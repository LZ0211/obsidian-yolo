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

export class WebAgentRunBridge {
  private readonly now: () => number
  private readonly abortControllersByRun = new Map<string, AbortController>()
  private readonly abortRunCallbacksByRun = new Map<string, () => boolean>()

  constructor(private readonly options: WebAgentRunBridgeOptions) {
    this.now = options.now ?? (() => Date.now())
  }

  start(input: StartWebAgentRunInput): Promise<void> {
    const startedAtMs = input.startedAtMs ?? this.now()
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

    return this.consumeRun(input, abortController).finally(() => {
      this.abortControllersByRun.delete(input.runId)
      this.abortRunCallbacksByRun.delete(input.runId)
    })
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
          sequence += 1
          this.options.eventStore.insertEvent({
            runId: input.runId,
            sequence,
            eventType: event.type,
            eventJson: event,
            createdAtMs: this.now(),
          })
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
      this.options.eventStore.updateRunStatus(
        input.runId,
        finalStatus,
        this.now(),
      )
      // Run 已终态：主动关闭该 run 的 SSE 流，让客户端 consumeRunStream
      // 收到 done 后走 refreshAgentState 拉全量状态兜底。否则事件交付依赖
      // 首条连接上的实时推送竞态（浏览器可能只收到首块），回复会丢。
      this.options.sseHub.clearRun(input.runId)
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
