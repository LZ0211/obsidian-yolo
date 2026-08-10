export const SEARCH_MAINTENANCE_COMMAND = {
  UPDATE_CHANGED_SOURCES: 'update_changed_sources',
  FULL_REBUILD: 'full_rebuild',
  CLEAN_STALE_RECORDS: 'clean_stale_records',
} as const

export type SearchMaintenanceCommandKind =
  (typeof SEARCH_MAINTENANCE_COMMAND)[keyof typeof SEARCH_MAINTENANCE_COMMAND]

export type SearchMaintenanceCommand = {
  kind: SearchMaintenanceCommandKind
  operationKey: string
  scope?: { kind: 'all' } | { kind: 'paths'; paths: string[] }
}

export const SEARCH_JOB_STATUS = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
} as const

export const SEARCH_MAINTENANCE_PROGRESS_INTERVAL_MS = 100

export type SearchJobStatus =
  (typeof SEARCH_JOB_STATUS)[keyof typeof SEARCH_JOB_STATUS]

export type SearchJobProjection<Command extends { operationKey: string }> = {
  jobId: string
  command: Command
  status: SearchJobStatus
  startedAt: number | null
  finishedAt: number | null
  progress?: unknown
}

export type SearchJobResult = {
  status: Exclude<SearchJobStatus, 'queued' | 'running'>
  jobId: string
  operationKey: string
  error?: unknown
}

type CommandWithKind = { operationKey: string; kind: string }

export type SearchMaintenanceJobQueueInput<Command extends CommandWithKind> = {
  execute: (
    command: Command,
    signal: AbortSignal,
    onProgress: (progress: unknown) => void,
  ) => Promise<void>
  now?: () => number
  createJobId?: () => string
}

export type SearchMaintenanceJobQueueSnapshot<Command extends CommandWithKind> =
  {
    activeJob: SearchJobProjection<Command> | null
    queuedJobs: readonly SearchJobProjection<Command>[]
  }

type QueueEntry<Command extends CommandWithKind> = {
  projection: SearchJobProjection<Command>
  controller: AbortController
  resolve: (result: SearchJobResult) => void
  promise: Promise<SearchJobResult>
}

export class SearchMaintenanceJobQueue<
  Command extends CommandWithKind = SearchMaintenanceCommand,
> {
  private readonly execute: SearchMaintenanceJobQueueInput<Command>['execute']
  private readonly now: () => number
  private readonly createJobId: () => string
  private readonly listeners = new Set<() => void>()
  private readonly queued: QueueEntry<Command>[] = []
  private readonly byOperationKey = new Map<string, QueueEntry<Command>>()
  private active: QueueEntry<Command> | null = null
  private pumpPromise: Promise<void> | null = null
  private stopped = false

  constructor(input: SearchMaintenanceJobQueueInput<Command>) {
    this.execute = input.execute
    this.now = input.now ?? (() => Date.now())
    let generatedJobSequence = 0
    this.createJobId =
      input.createJobId ??
      (() => `search-job:${this.now()}:${++generatedJobSequence}`)
  }

  enqueue(command: Command): Promise<SearchJobResult> {
    const existing = this.byOperationKey.get(command.operationKey)
    if (existing) return existing.promise
    if (this.stopped) {
      return Promise.resolve({
        status: SEARCH_JOB_STATUS.CANCELLED,
        jobId: this.createJobId(),
        operationKey: command.operationKey,
      })
    }

    let resolve!: (result: SearchJobResult) => void
    const promise = new Promise<SearchJobResult>((nextResolve) => {
      resolve = nextResolve
    })
    const entry: QueueEntry<Command> = {
      projection: {
        jobId: this.createJobId(),
        command,
        status: SEARCH_JOB_STATUS.QUEUED,
        startedAt: null,
        finishedAt: null,
      },
      controller: new AbortController(),
      resolve,
      promise,
    }
    this.queued.push(entry)
    this.byOperationKey.set(command.operationKey, entry)
    this.emit()
    this.startPump()
    return promise
  }

  async cancel(jobId: string): Promise<SearchJobResult> {
    if (this.active?.projection.jobId === jobId) {
      this.active.controller.abort()
      return this.active.promise
    }
    const queuedIndex = this.queued.findIndex(
      (entry) => entry.projection.jobId === jobId,
    )
    if (queuedIndex >= 0) {
      const [entry] = this.queued.splice(queuedIndex, 1)
      if (!entry) throw new Error('queued search job disappeared')
      this.byOperationKey.delete(entry.projection.command.operationKey)
      entry.projection.status = SEARCH_JOB_STATUS.CANCELLED
      entry.projection.finishedAt = this.now()
      entry.resolve(this.resultFor(entry, SEARCH_JOB_STATUS.CANCELLED))
      this.emit()
      return entry.promise
    }
    return {
      status: SEARCH_JOB_STATUS.CANCELLED,
      jobId,
      operationKey: '',
    }
  }

  getSnapshot(): SearchMaintenanceJobQueueSnapshot<Command> {
    return {
      activeJob: this.active?.projection ?? null,
      queuedJobs: this.queued.map((entry) => entry.projection),
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async shutdown(): Promise<void> {
    this.stopped = true
    this.active?.controller.abort()
    for (const entry of [...this.queued]) {
      await this.cancel(entry.projection.jobId)
    }
    await this.pumpPromise?.catch(() => undefined)
  }

  private startPump(): void {
    if (this.pumpPromise || this.stopped) return
    this.pumpPromise = this.pump().finally(() => {
      this.pumpPromise = null
      if (this.queued.length > 0 && !this.stopped) this.startPump()
    })
  }

  private async pump(): Promise<void> {
    while (this.queued.length > 0 && !this.stopped) {
      const entry = this.queued.shift()
      if (!entry) return
      this.active = entry
      entry.projection.status = SEARCH_JOB_STATUS.RUNNING
      entry.projection.startedAt = this.now()
      this.emit()
      let status: SearchJobResult['status'] = SEARCH_JOB_STATUS.COMPLETED
      let error: unknown
      let lastProgressAt = Number.NEGATIVE_INFINITY
      try {
        await this.execute(
          entry.projection.command,
          entry.controller.signal,
          (progress) => {
            const observedAt = this.now()
            if (
              observedAt - lastProgressAt <
              SEARCH_MAINTENANCE_PROGRESS_INTERVAL_MS
            ) {
              return
            }
            lastProgressAt = observedAt
            entry.projection.progress = progress
            this.emit()
          },
        )
        if (entry.controller.signal.aborted)
          status = SEARCH_JOB_STATUS.CANCELLED
      } catch (caught) {
        error = caught
        status = entry.controller.signal.aborted
          ? SEARCH_JOB_STATUS.CANCELLED
          : SEARCH_JOB_STATUS.FAILED
      }
      entry.projection.status = status
      entry.projection.finishedAt = this.now()
      this.byOperationKey.delete(entry.projection.command.operationKey)
      this.active = null
      entry.resolve(this.resultFor(entry, status, error))
      this.emit()
    }
  }

  private resultFor(
    entry: QueueEntry<Command>,
    status: SearchJobResult['status'],
    error?: unknown,
  ): SearchJobResult {
    return {
      status,
      jobId: entry.projection.jobId,
      operationKey: entry.projection.command.operationKey,
      ...(error === undefined ? {} : { error }),
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
