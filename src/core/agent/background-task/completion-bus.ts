import { logFlightEvent } from '../../../utils/debug/flightLog'
import type { BashTaskRecord } from '../bash/types'
import type { SubagentTaskCompletionRecord } from '../subagent/types'

/**
 * Cumulative token usage for a child subagent run, summed across every turn
 * of the child's transcript (not just the final turn). Input/output map from
 * each assistant message's `ResponseUsage` (`prompt_tokens` / `completion_tokens`).
 */
export type SubagentCumulativeUsage = {
  inputTokens: number
  outputTokens: number
}

export type BackgroundTaskCompletedEvent =
  | {
      kind: 'subagent'
      taskId: string
      conversationId: string
      usage?: SubagentCumulativeUsage
      record: SubagentTaskCompletionRecord
    }
  | {
      kind: 'terminal_command'
      taskId: string
      conversationId: string
      record: BashTaskRecord
    }

export type BackgroundTaskTerminalWaitingEvent = {
  kind: 'terminal_command_waiting'
  taskId: string
  conversationId: string
  occurredAt: number
  record: BashTaskRecord
}

export type BackgroundTaskEvent =
  | BackgroundTaskCompletedEvent
  | BackgroundTaskTerminalWaitingEvent

type BackgroundTaskSubscriber = (event: BackgroundTaskEvent) => void
type BackgroundTaskCompletedSubscriber = (
  event: BackgroundTaskCompletedEvent,
) => void

class BackgroundTaskCompletionBus {
  private readonly subscribers = new Set<BackgroundTaskSubscriber>()

  subscribe(fn: BackgroundTaskSubscriber): () => void {
    this.subscribers.add(fn)
    return () => {
      this.subscribers.delete(fn)
    }
  }

  subscribeCompleted(fn: BackgroundTaskCompletedSubscriber): () => void {
    return this.subscribe((event) => {
      if (event.kind !== 'terminal_command_waiting') {
        fn(event)
      }
    })
  }

  pushCompleted(event: BackgroundTaskCompletedEvent): void {
    logFlightEvent('background', 'task-completed', {
      id: event.conversationId,
      detail: `kind=${event.kind} taskId=${event.taskId}`,
    })
    for (const fn of this.subscribers) {
      fn(event)
    }
  }

  pushTerminalWaiting(event: BackgroundTaskTerminalWaitingEvent): void {
    for (const fn of this.subscribers) {
      fn(event)
    }
  }
}

export const backgroundTaskCompletionBus = new BackgroundTaskCompletionBus()
