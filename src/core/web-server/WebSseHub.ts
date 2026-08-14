export type BufferedRunEvent = {
  sequence: number
  eventType: string
  eventJson: unknown
  createdAtMs: number
}

export type WebSseHubOptions = {
  replayTtlMs?: number
  maxEventsPerRun?: number
  now?: () => number
}

export type WebSseCloseCode =
  | 'token_revoked'
  | 'session_expired'
  | 'agent_unavailable'
  | 'run_closed'

type WebSseSubscriber = {
  onEvent: (event: BufferedRunEvent) => void
  onClose?: (code: WebSseCloseCode) => void
  sessionId?: string
}

const DEFAULT_REPLAY_TTL_MS = 5 * 60_000
const DEFAULT_MAX_EVENTS_PER_RUN = 200

export class WebSseHub {
  private readonly replayTtlMs: number
  private readonly maxEventsPerRun: number
  private readonly now: () => number
  private readonly eventsByRun = new Map<string, BufferedRunEvent[]>()
  private readonly subscribersByRun = new Map<string, Set<WebSseSubscriber>>()

  constructor(options: WebSseHubOptions = {}) {
    this.replayTtlMs = options.replayTtlMs ?? DEFAULT_REPLAY_TTL_MS
    this.maxEventsPerRun = options.maxEventsPerRun ?? DEFAULT_MAX_EVENTS_PER_RUN
    this.now = options.now ?? (() => Date.now())
  }

  publish(runId: string, event: BufferedRunEvent): void {
    const events = this.eventsByRun.get(runId) ?? []
    events.push(event)
    this.eventsByRun.set(runId, this.prune(events))

    for (const subscriber of this.subscribersByRun.get(runId) ?? []) {
      subscriber.onEvent(event)
    }
  }

  getReplayEvents(runId: string, cursorExclusive = 0): BufferedRunEvent[] {
    const events = this.eventsByRun.get(runId) ?? []
    const pruned = this.prune(events)
    this.eventsByRun.set(runId, pruned)
    return pruned.filter((event) => event.sequence > cursorExclusive)
  }

  subscribe(
    runId: string,
    onEvent: (event: BufferedRunEvent) => void,
    options: {
      onClose?: (code: WebSseCloseCode) => void
      sessionId?: string
    } = {},
  ): () => void {
    const subscribers = this.subscribersByRun.get(runId) ?? new Set()
    const subscriber: WebSseSubscriber = {
      onEvent,
      onClose: options.onClose,
      sessionId: options.sessionId,
    }
    subscribers.add(subscriber)
    this.subscribersByRun.set(runId, subscribers)
    return () => {
      subscribers.delete(subscriber)
      if (subscribers.size === 0) {
        this.subscribersByRun.delete(runId)
      }
    }
  }

  clearRun(runId: string): void {
    this.eventsByRun.delete(runId)
    const subscribers = this.subscribersByRun.get(runId)
    this.subscribersByRun.delete(runId)
    for (const subscriber of subscribers ?? []) {
      subscriber.onClose?.('run_closed')
    }
  }

  closeSession(sessionId: string, code: WebSseCloseCode): void {
    for (const [runId, subscribers] of this.subscribersByRun) {
      for (const subscriber of [...subscribers]) {
        if (subscriber.sessionId !== sessionId) {
          continue
        }
        subscribers.delete(subscriber)
        subscriber.onClose?.(code)
      }
      if (subscribers.size === 0) {
        this.subscribersByRun.delete(runId)
      }
    }
  }

  clear(): void {
    for (const subscribers of this.subscribersByRun.values()) {
      for (const subscriber of subscribers) {
        subscriber.onClose?.('agent_unavailable')
      }
    }
    this.eventsByRun.clear()
    this.subscribersByRun.clear()
  }

  private prune(events: BufferedRunEvent[]): BufferedRunEvent[] {
    const minCreatedAt = this.now() - this.replayTtlMs
    return events
      .filter((event) => event.createdAtMs >= minCreatedAt)
      .slice(-this.maxEventsPerRun)
  }
}
