import { UserNotificationPolicy } from '../notifications/UserNotificationPolicy'
import {
  SearchMaintenanceJobQueue,
  type SearchMaintenanceJobQueueSnapshot,
} from '../search/SearchMaintenanceJobQueue'
import {
  type StateIncidentFactory,
  createIncidentFactory,
} from '../state/stateIncident'

import {
  type DatabaseMaintenanceBackend,
  MAINTENANCE_CONTROLLER_STATUS,
  type MaintenanceJobCommand,
  type MaintenancePageRequest,
  type MaintenanceQueryRequest,
  type MaintenanceRequestResult,
  type MaintenanceSnapshot,
} from './types'

type ControllerInput = {
  backend: DatabaseMaintenanceBackend
  notificationPolicy?: Pick<UserNotificationPolicy, 'handle'>
  incidentFactory?: StateIncidentFactory
  now?: () => number
}

const isAbort = (signal: AbortSignal, error: unknown): boolean =>
  signal.aborted ||
  (error instanceof DOMException && error.name === 'AbortError')

export class DatabaseMaintenanceController {
  private readonly backend: DatabaseMaintenanceBackend
  private readonly notificationPolicy: Pick<UserNotificationPolicy, 'handle'>
  private readonly incidentFactory: StateIncidentFactory
  private readonly now: () => number
  private readonly listeners = new Set<() => void>()
  private readonly views = new Set<string>()
  private readonly jobs: SearchMaintenanceJobQueue<MaintenanceJobCommand>
  private readAbortController: AbortController | null = null
  private readGeneration = 0
  private summaryHeadSequence: number | null = null
  private readonly rowCountCache = new Map<
    string,
    { headSequence: number; rowCount: number }
  >()
  private snapshot: MaintenanceSnapshot = {
    status: MAINTENANCE_CONTROLLER_STATUS.IDLE,
    summary: null,
    activeJob: null,
    page: null,
    query: null,
    error: null,
  }
  private stopped = false

  constructor(input: ControllerInput) {
    this.backend = input.backend
    this.notificationPolicy =
      input.notificationPolicy ?? new UserNotificationPolicy()
    this.incidentFactory =
      input.incidentFactory ??
      createIncidentFactory({
        ids: () => `maintenance:incident:${Date.now()}:${Math.random()}`,
      })
    this.now = input.now ?? (() => Date.now())
    this.jobs = new SearchMaintenanceJobQueue<MaintenanceJobCommand>({
      now: this.now,
      execute: (command, signal, onProgress) =>
        this.backend.runJob(command, signal, (progress) => {
          onProgress(progress)
          this.setSnapshot({
            status: MAINTENANCE_CONTROLLER_STATUS.RUNNING,
            activeJob: this.jobs.getSnapshot().activeJob,
          })
        }),
    })
    this.jobs.subscribe(() => {
      const queueSnapshot = this.jobs.getSnapshot()
      const active = queueSnapshot.activeJob
      this.setSnapshot({
        activeJob: active,
        status: active
          ? MAINTENANCE_CONTROLLER_STATUS.RUNNING
          : this.snapshot.status === MAINTENANCE_CONTROLLER_STATUS.RUNNING
            ? MAINTENANCE_CONTROLLER_STATUS.IDLE
            : this.snapshot.status,
      })
    })
  }

  attachView(viewId: string): () => void {
    if (this.stopped) return () => undefined
    this.views.add(viewId)
    let detached = false
    return () => {
      if (detached) return
      detached = true
      this.views.delete(viewId)
      if (this.views.size === 0) this.cancelViewReads()
    }
  }

  async loadSummary(): Promise<
    MaintenanceRequestResult<NonNullable<MaintenanceSnapshot['summary']>>
  > {
    const request = this.startRead()
    const generation = this.readGeneration
    try {
      const headSequence = await this.backend.getHeadSequence(request.signal)
      if (this.summaryHeadSequence === headSequence && this.snapshot.summary) {
        return { status: 'fulfilled', value: this.snapshot.summary }
      }
      this.setSnapshot({ status: MAINTENANCE_CONTROLLER_STATUS.LOADING })
      const summary = await this.backend.getSummary(request.signal)
      if (!this.isCurrentRead(generation, request.signal))
        return { status: 'cancelled' }
      this.summaryHeadSequence = headSequence
      this.setSnapshot({
        status: MAINTENANCE_CONTROLLER_STATUS.IDLE,
        summary,
        error: null,
      })
      return { status: 'fulfilled', value: summary }
    } catch (error) {
      return this.handleReadFailure(
        generation,
        request.signal,
        'summary_read_failed',
        error,
      )
    }
  }

  async loadPage(
    pageRequest: MaintenancePageRequest,
  ): Promise<MaintenanceRequestResult<MaintenanceSnapshot['page']>> {
    const request = this.startRead()
    const generation = this.readGeneration
    try {
      const page = await this.backend.loadPage(
        {
          cursor: pageRequest.cursor,
          limit: Math.max(1, Math.min(200, Math.floor(pageRequest.limit))),
          table: pageRequest.table,
          columns: pageRequest.columns,
        },
        request.signal,
      )
      if (!this.isCurrentRead(generation, request.signal))
        return { status: 'cancelled' }
      this.setSnapshot({
        status: MAINTENANCE_CONTROLLER_STATUS.IDLE,
        page,
        error: null,
      })
      return { status: 'fulfilled', value: page }
    } catch (error) {
      return this.handleReadFailure(
        generation,
        request.signal,
        'page_read_failed',
        error,
      )
    }
  }

  async loadTableRowCount(
    table: string,
  ): Promise<MaintenanceRequestResult<number>> {
    const request = this.startRead()
    const generation = this.readGeneration
    try {
      const headSequence = await this.backend.getHeadSequence(request.signal)
      const cached = this.rowCountCache.get(table)
      if (cached?.headSequence === headSequence) {
        return { status: 'fulfilled', value: cached.rowCount }
      }
      if (!this.backend.getRowCount) {
        const summary = await this.backend.getSummary(request.signal)
        if (!this.isCurrentRead(generation, request.signal))
          return { status: 'cancelled' }
        this.rowCountCache.set(table, {
          headSequence,
          rowCount: summary.rowCount,
        })
        return { status: 'fulfilled', value: summary.rowCount }
      }
      const rowCount = await this.backend.getRowCount(table, request.signal)
      if (!this.isCurrentRead(generation, request.signal))
        return { status: 'cancelled' }
      this.rowCountCache.set(table, { headSequence, rowCount })
      return { status: 'fulfilled', value: rowCount }
    } catch (error) {
      return this.handleReadFailure(
        generation,
        request.signal,
        'row_count_failed',
        error,
      )
    }
  }

  async runReadOnlyQuery(
    queryRequest: MaintenanceQueryRequest,
  ): Promise<MaintenanceRequestResult<MaintenanceSnapshot['query']>> {
    const request = this.startRead()
    const generation = this.readGeneration
    try {
      const query = await this.backend.runQuery(queryRequest, request.signal)
      if (!this.isCurrentRead(generation, request.signal))
        return { status: 'cancelled' }
      this.setSnapshot({
        status: MAINTENANCE_CONTROLLER_STATUS.IDLE,
        query,
        error: null,
      })
      return { status: 'fulfilled', value: query }
    } catch (error) {
      return this.handleReadFailure(
        generation,
        request.signal,
        'query_failed',
        error,
      )
    }
  }

  startJob(command: MaintenanceJobCommand) {
    if (this.stopped) {
      return Promise.resolve({
        status: 'cancelled' as const,
        jobId: '',
        operationKey: command.operationKey,
      })
    }
    this.setSnapshot({
      status: MAINTENANCE_CONTROLLER_STATUS.RUNNING,
      error: null,
    })
    return this.jobs.enqueue(command).then((result) => {
      if (result.status === 'failed') {
        const incident = this.createIncident(
          'maintenance_job_failed',
          result.error,
        )
        this.setSnapshot({
          status: MAINTENANCE_CONTROLLER_STATUS.FAILED,
          error: incident,
        })
        this.notificationPolicy.handle(incident)
      } else if (this.jobs.getSnapshot().activeJob == null) {
        this.setSnapshot({ status: MAINTENANCE_CONTROLLER_STATUS.IDLE })
      }
      return result
    })
  }

  async cancelActiveJob() {
    const active = this.jobs.getSnapshot().activeJob
    if (!active) {
      return { status: 'cancelled' as const, jobId: '', operationKey: '' }
    }
    this.setSnapshot({ status: MAINTENANCE_CONTROLLER_STATUS.CANCELLING })
    return this.jobs.cancel(active.jobId)
  }

  getSnapshot(): MaintenanceSnapshot {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.cancelViewReads()
    await this.jobs.shutdown()
    await this.backend.close?.()
    this.listeners.clear()
  }

  private startRead(): { signal: AbortSignal } {
    this.readAbortController?.abort()
    const controller = new AbortController()
    this.readAbortController = controller
    this.readGeneration += 1
    return { signal: controller.signal }
  }

  private cancelViewReads(): void {
    this.readGeneration += 1
    this.readAbortController?.abort()
    this.readAbortController = null
  }

  private isCurrentRead(generation: number, signal: AbortSignal): boolean {
    return (
      !this.stopped && generation === this.readGeneration && !signal.aborted
    )
  }

  private handleReadFailure<T>(
    generation: number,
    signal: AbortSignal,
    code: string,
    error: unknown,
  ): MaintenanceRequestResult<T> {
    if (!this.isCurrentRead(generation, signal) || isAbort(signal, error)) {
      return { status: 'cancelled' }
    }
    const incident = this.createIncident(code, error)
    this.setSnapshot({
      status: MAINTENANCE_CONTROLLER_STATUS.FAILED,
      error: incident,
    })
    this.notificationPolicy.handle(incident)
    return { status: 'failed', incident }
  }

  private createIncident(code: string, cause: unknown) {
    return this.incidentFactory.fromFailure({
      domain: 'maintenance',
      code,
      severity: 'action_required',
      retryable: true,
      cause,
    })
  }

  private setSnapshot(update: Partial<MaintenanceSnapshot>): void {
    if (this.stopped) return
    this.snapshot = { ...this.snapshot, ...update }
    for (const listener of this.listeners) listener()
  }
}
