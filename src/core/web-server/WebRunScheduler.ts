export type WebScheduledRunStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'aborted'
  | 'error'

export type WebScheduledRun = {
  runId: string
  conversationId: string
  status: WebScheduledRunStatus
  queuedAtMs: number
  startedAtMs: number | null
  finishedAtMs: number | null
}

export type WebRunSchedulerInput = {
  runId: string
  conversationId: string
  execute: () => Promise<void>
  abort?: () => void
}

export type WebRunSchedulerOptions = {
  maxConcurrent: number
  now?: () => number
}

type ScheduledEntry = WebScheduledRun & WebRunSchedulerInput

export class WebRunScheduler {
  private readonly now: () => number
  private readonly entries = new Map<string, ScheduledEntry>()
  private readonly queuedRunIds: string[] = []
  private readonly activeConversationIds = new Set<string>()
  private maxConcurrent: number
  private activeCount = 0

  constructor(private readonly options: WebRunSchedulerOptions) {
    this.assertMaxConcurrent(options.maxConcurrent)
    this.maxConcurrent = options.maxConcurrent
    this.now = options.now ?? (() => Date.now())
  }

  setMaxConcurrent(maxConcurrent: number): void {
    this.assertMaxConcurrent(maxConcurrent)
    this.maxConcurrent = maxConcurrent
    this.processQueue()
  }

  enqueue(input: WebRunSchedulerInput): WebScheduledRun {
    if (this.entries.has(input.runId)) {
      throw new Error(`Run already exists: ${input.runId}`)
    }

    const entry: ScheduledEntry = {
      ...input,
      status: 'queued',
      queuedAtMs: this.now(),
      startedAtMs: null,
      finishedAtMs: null,
    }
    this.entries.set(entry.runId, entry)
    this.queuedRunIds.push(entry.runId)
    this.processQueue()
    return this.toRun(entry)
  }

  abort(runId: string): { found: boolean; status: WebScheduledRunStatus } {
    const entry = this.entries.get(runId)
    if (!entry) {
      return { found: false, status: 'aborted' }
    }
    if (entry.status === 'queued') {
      entry.status = 'aborted'
      entry.finishedAtMs = this.now()
      this.removeQueuedRun(runId)
      return { found: true, status: 'aborted' }
    }
    if (entry.status === 'running') {
      entry.status = 'aborted'
      entry.abort?.()
      return { found: true, status: 'aborted' }
    }
    return { found: true, status: entry.status }
  }

  getRun(runId: string): WebScheduledRun | null {
    const entry = this.entries.get(runId)
    return entry ? this.toRun(entry) : null
  }

  getActiveCount(): number {
    return this.activeCount
  }

  getQueuePosition(runId: string): number | null {
    const index = this.queuedRunIds.indexOf(runId)
    return index < 0 ? null : index + 1
  }

  private processQueue(): void {
    while (this.activeCount < this.maxConcurrent) {
      const next = this.dequeueNextRunnable()
      if (!next) return
      this.start(next)
    }
  }

  private dequeueNextRunnable(): ScheduledEntry | null {
    for (let index = 0; index < this.queuedRunIds.length; index += 1) {
      const runId = this.queuedRunIds[index]
      const entry = this.entries.get(runId)
      if (!entry || entry.status !== 'queued') {
        this.queuedRunIds.splice(index, 1)
        index -= 1
        continue
      }
      if (this.activeConversationIds.has(entry.conversationId)) continue
      this.queuedRunIds.splice(index, 1)
      return entry
    }
    return null
  }

  private start(entry: ScheduledEntry): void {
    entry.status = 'running'
    entry.startedAtMs = this.now()
    this.activeCount += 1
    this.activeConversationIds.add(entry.conversationId)

    void entry.execute().then(
      () => this.finish(entry, 'completed'),
      () => this.finish(entry, 'error'),
    )
  }

  private finish(
    entry: ScheduledEntry,
    terminalStatus: Extract<WebScheduledRunStatus, 'completed' | 'error'>,
  ): void {
    if (entry.status !== 'aborted') {
      entry.status = terminalStatus
    }
    entry.finishedAtMs = this.now()
    this.activeCount -= 1
    this.activeConversationIds.delete(entry.conversationId)
    this.processQueue()
  }

  private removeQueuedRun(runId: string): void {
    const index = this.queuedRunIds.indexOf(runId)
    if (index >= 0) this.queuedRunIds.splice(index, 1)
  }

  private toRun(entry: ScheduledEntry): WebScheduledRun {
    return {
      runId: entry.runId,
      conversationId: entry.conversationId,
      status: entry.status,
      queuedAtMs: entry.queuedAtMs,
      startedAtMs: entry.startedAtMs,
      finishedAtMs: entry.finishedAtMs,
    }
  }

  private assertMaxConcurrent(maxConcurrent: number): void {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error('maxConcurrent must be a positive integer')
    }
  }
}
