import { App } from 'obsidian'

import { IndexProgress } from '../../components/chat-view/QueryProgress'
import { ReconcileResult } from '../../database/modules/vector/VectorManager'
import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'
import {
  type AutomaticRetrySchedule,
  getNextAutomaticRetry,
} from '../retry/limitedAutomaticRetry'

import { RAGEngine } from './ragEngine'
import {
  type RagIndexFailureKind,
  describeRagIndexError,
} from './ragIndexErrors'
import type { ReconcileScope } from './reconciler'

type AppWithLocalStorage = App & {
  loadLocalStorage?: (key: string) => string | null | Promise<string | null>
  saveLocalStorage?: (key: string, value: string) => void | Promise<void>
}

export type RagIndexRunStatus =
  | 'idle'
  | 'running'
  | 'retry_scheduled'
  | 'failed'
  | 'completed'

export type RagIndexRunTrigger = 'manual' | 'auto'
export type RagIndexRetryPolicy = 'none' | 'transient'
export type RagIndexRunMode = 'rebuild' | 'sync'

type RagIndexRunOptions = {
  /**
   * `rebuild`: truncate the active model namespace, then reconcile from scratch.
   * `sync`: reconcile against current state without truncation. Idempotent —
   * a crashed sync run resumes naturally on the next call.
   */
  mode: RagIndexRunMode
  scope: ReconcileScope
  trigger: RagIndexRunTrigger
  retryPolicy: RagIndexRetryPolicy
  onProgress?: (progress: IndexProgress) => void
}

export type RagIndexRunSnapshot = {
  phase?: 'vector' | 'lexical'
  runId: string | null
  trigger: RagIndexRunTrigger | null
  retryPolicy: RagIndexRetryPolicy
  mode: RagIndexRunMode | null
  /** Last scope kind for retry restoration (paths are not persisted). */
  scopeKind: 'all' | 'paths' | null
  status: RagIndexRunStatus
  startedAt: number | null
  updatedAt: number | null
  currentFile?: string
  lastCompletedFile?: string
  totalFiles?: number
  completedFiles?: number
  totalChunks?: number
  completedChunks?: number
  waitingForRateLimit?: boolean
  retryCount: number
  retryAt?: number
  failureKind?: RagIndexFailureKind
  failureMessage?: string
  failureHttpStatus?: number
  /**
   * Files that could not be indexed permanently on the last completed run (kept
   * partial results, not retried). Persisted so the settings page can surface a
   * durable "X files couldn't be indexed" notice. Cleared on a clean completion.
   */
  permanentFailedPaths?: string[]
}

type RagIndexServiceDeps = {
  app: App
  getRagEngine: () => Promise<RAGEngine>
  activityRegistry: BackgroundActivityRegistry
  isRagEnabled: () => boolean
  t: (key: string, fallback?: string) => string
  /**
   * Fired after a successful reconcile, regardless of trigger (manual/auto).
   * Lets the host record the index-scope options snapshot the index was built
   * with (and clear any rebuild-required flag). Fire-and-forget: the run is
   * not delayed by the callback.
   */
  onIndexCompleted?: (result: ReconcileResult) => void
}

type RagIndexSubscriber = (snapshot: RagIndexRunSnapshot) => void

const STORAGE_KEY = 'yolo_rag_index_run'
const RETRY_ACTIVITY_ID = 'rag:index'
const INTERRUPTED_RETRY_DELAY_MS = 15 * 1000
const MANUAL_RETRY_SCHEDULE = [
  5 * 60_000,
  15 * 60_000,
  30 * 60_000,
] as const satisfies AutomaticRetrySchedule

const isPromiseLike = <T>(value: T | Promise<T>): value is Promise<T> =>
  typeof value === 'object' &&
  value !== null &&
  'then' in (value as Record<string, unknown>) &&
  typeof (value as { then?: unknown }).then === 'function'

const defaultSnapshot = (): RagIndexRunSnapshot => ({
  runId: null,
  trigger: null,
  retryPolicy: 'none',
  mode: null,
  scopeKind: null,
  status: 'idle',
  startedAt: null,
  updatedAt: null,
  retryCount: 0,
})

const createRunId = (): string =>
  `rag-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

const readLocalStorage = async (
  app: App,
  key: string,
): Promise<string | null> => {
  const appWithLocalStorage = app as AppWithLocalStorage
  if (typeof appWithLocalStorage.loadLocalStorage !== 'function') {
    return null
  }
  const result = appWithLocalStorage.loadLocalStorage(key)
  return isPromiseLike(result) ? await result : result
}

const writeLocalStorage = async (
  app: App,
  key: string,
  value: string,
): Promise<void> => {
  const appWithLocalStorage = app as AppWithLocalStorage
  if (typeof appWithLocalStorage.saveLocalStorage !== 'function') {
    return
  }
  await Promise.resolve(appWithLocalStorage.saveLocalStorage(key, value))
}

export class RagIndexBusyError extends Error {
  constructor() {
    super('RAG index is already running.')
    this.name = 'RagIndexBusyError'
  }
}

/**
 * Cross-window index lock name. Scoped by vault identity so two different
 * vaults never contend; mirrors the scheduler's
 * `yolo-scheduled-tasks-leader:<rootDir>` pattern.
 */
const INDEX_LOCK_PREFIX = 'yolo-rag-index:'

export class RagIndexService {
  private readonly app: App
  private readonly getRagEngine: () => Promise<RAGEngine>
  private readonly activityRegistry: BackgroundActivityRegistry
  private readonly isRagEnabled: () => boolean
  private readonly t: (key: string, fallback?: string) => string
  private readonly onIndexCompleted?: (result: ReconcileResult) => void

  private snapshot: RagIndexRunSnapshot = defaultSnapshot()
  private readonly subscribers = new Set<RagIndexSubscriber>()
  private currentAbortController: AbortController | null = null
  private initPromise: Promise<void> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryOptions: RagIndexRunOptions | null = null
  /** Coalesces per-progress persistSnapshot calls: at most one in-flight write
   * per run, so chunk-level progress callbacks don't hammer localStorage. */
  private progressPersistInFlight = false
  /**
   * Serialization tail for coalesced progress writes. Terminal snapshots await
   * it before writing, so a slow progress write can never land after the
   * completed/failed snapshot and resurrect a stale 'running' state on the
   * next initialize() (which would misreport the finished run as interrupted
   * and schedule a phantom retry).
   */
  private progressPersistTail: Promise<void> = Promise.resolve()

  constructor(deps: RagIndexServiceDeps) {
    this.app = deps.app
    this.getRagEngine = deps.getRagEngine
    this.activityRegistry = deps.activityRegistry
    this.isRagEnabled = deps.isRagEnabled
    this.t = deps.t
    this.onIndexCompleted = deps.onIndexCompleted
  }

  async initialize(): Promise<void> {
    if (!this.initPromise) {
      this.initPromise = (async () => {
        const raw = await readLocalStorage(this.app, STORAGE_KEY)
        if (!raw) {
          return
        }
        try {
          const parsed = JSON.parse(raw) as Partial<RagIndexRunSnapshot>
          this.snapshot = {
            ...defaultSnapshot(),
            ...parsed,
          }
          if (this.snapshot.status === 'running') {
            const shouldRecover =
              this.snapshot.retryPolicy === 'transient' &&
              this.snapshot.mode !== null &&
              this.snapshot.trigger !== null
            this.snapshot = {
              ...this.snapshot,
              status: shouldRecover ? 'retry_scheduled' : 'failed',
              // Interrupted runs always resume as 'sync' so the reconcile loop
              // skips chunks already in the DB instead of truncating. Users who
              // truly want a fresh rebuild trigger it explicitly from the UI.
              mode: shouldRecover ? 'sync' : this.snapshot.mode,
              retryAt: shouldRecover
                ? Date.now() + INTERRUPTED_RETRY_DELAY_MS
                : undefined,
              failureKind: shouldRecover ? 'transient' : 'unknown',
              failureMessage: this.t(
                'settings.rag.previousRunInterrupted',
                '上次索引未正常完成。',
              ),
              updatedAt: Date.now(),
            }
            await this.persistSnapshot()
          }
          this.publishActivity()
          this.emit()
        } catch (error) {
          console.warn('[YOLO] Failed to restore RAG index state', error)
        }
      })()
    }
    await this.initPromise
  }

  subscribe(subscriber: RagIndexSubscriber): () => void {
    this.subscribers.add(subscriber)
    subscriber({ ...this.snapshot })
    return () => {
      this.subscribers.delete(subscriber)
    }
  }

  getSnapshot(): RagIndexRunSnapshot {
    return { ...this.snapshot }
  }

  isRunning(): boolean {
    return this.snapshot.status === 'running'
  }

  cancelActiveRun(): void {
    this.currentAbortController?.abort()
  }

  onOnline(): void {
    const options = this.retryOptions
    if (
      !this.retryTimer ||
      !options ||
      this.snapshot.status !== 'retry_scheduled'
    ) {
      return
    }
    this.clearRetryTimer()
    this.armRetryTimer(options, 0)
  }

  async waitForIdle(): Promise<void> {
    if (!this.currentAbortController) return
    await new Promise<void>((resolve) => {
      const unsubscribe = this.subscribe(() => {
        if (this.currentAbortController) return
        unsubscribe()
        resolve()
      })
      if (!this.currentAbortController) {
        unsubscribe()
        resolve()
      }
    })
  }

  /**
   * Re-issue a previously scheduled retry. Path-scoped runs can't be retried
   * losslessly because we don't persist the path list — they fall back to a
   * full sync, which is correct (sync is idempotent and self-converging).
   */
  restoreRetryScheduledRun(minDelayMs = 0): void {
    if (
      this.snapshot.status !== 'retry_scheduled' ||
      this.snapshot.trigger !== 'manual' ||
      this.snapshot.retryPolicy !== 'transient' ||
      this.snapshot.mode === null
    ) {
      return
    }

    this.scheduleRetry(
      {
        mode: this.snapshot.mode,
        scope: { kind: 'all' },
        trigger: this.snapshot.trigger,
        retryPolicy: this.snapshot.retryPolicy,
      },
      minDelayMs,
    )
  }

  async runIndex(
    options: RagIndexRunOptions,
    attempt: 'new' | 'automatic-retry' = 'new',
  ): Promise<ReconcileResult> {
    await this.initialize()
    if (this.currentAbortController) {
      throw new RagIndexBusyError()
    }
    if (this.hasWebLocks()) {
      // Cross-window single-writer: another Obsidian window may already be
      // indexing this vault (SQLite namespace is shared). Reject fast with the
      // existing busy error — callers already handle RagIndexBusyError.
      const lockName = this.getIndexLockName()
      if (await this.isIndexLockHeld(lockName)) {
        throw new RagIndexBusyError()
      }
      return navigator.locks.request(lockName, { mode: 'exclusive' }, () =>
        this.runIndexLocked(options, attempt),
      )
    }
    // No Web Locks (older runtimes, Jest node env): instance-scoped mutual
    // exclusion via `currentAbortController` is the only guard.
    return this.runIndexLocked(options, attempt)
  }

  /**
   * Runs the index reconcile while holding the caller's exclusive lock (or
   * unguarded when Web Locks are unavailable). Re-checks the instance-scoped
   * guard because a local run can start while lock acquisition is in flight.
   */
  private async runIndexLocked(
    options: RagIndexRunOptions,
    attempt: 'new' | 'automatic-retry',
  ): Promise<ReconcileResult> {
    if (this.currentAbortController) {
      throw new RagIndexBusyError()
    }
    this.clearRetryTimer()

    const runId = createRunId()
    const controller = new AbortController()
    this.currentAbortController = controller

    const startedAt = Date.now()
    this.snapshot = {
      ...this.snapshot,
      runId,
      trigger: options.trigger,
      retryPolicy: options.retryPolicy,
      mode: options.mode,
      scopeKind: options.scope.kind,
      status: 'running',
      startedAt,
      updatedAt: startedAt,
      // A new run must not surface the previous run's progress (e.g. a
      // completed run showing 100% until the first progress callback lands).
      phase: undefined,
      currentFile: undefined,
      lastCompletedFile: undefined,
      totalFiles: undefined,
      completedFiles: undefined,
      totalChunks: undefined,
      completedChunks: undefined,
      waitingForRateLimit: undefined,
      failureKind: undefined,
      failureMessage: undefined,
      failureHttpStatus: undefined,
      retryAt: undefined,
      retryCount: attempt === 'automatic-retry' ? this.snapshot.retryCount : 0,
    }
    await this.persistSnapshot()

    try {
      const ragEngine = await this.getRagEngine()
      const result = await ragEngine.updateVaultIndex(
        {
          scope: options.scope,
          truncate: options.mode === 'rebuild',
          signal: controller.signal,
        },
        (queryProgress) => {
          if (queryProgress.type !== 'indexing') {
            return
          }
          const progress = queryProgress.indexProgress
          this.snapshot = {
            ...this.snapshot,
            updatedAt: Date.now(),
            currentFile: progress.currentFile,
            lastCompletedFile:
              (progress.completedFiles ?? 0) > 0
                ? (progress.currentFile ?? this.snapshot.lastCompletedFile)
                : this.snapshot.lastCompletedFile,
            totalFiles: progress.totalFiles,
            completedFiles: progress.completedFiles,
            totalChunks: progress.totalChunks,
            completedChunks: progress.completedChunks,
            waitingForRateLimit: progress.waitingForRateLimit,
          }
          // Chunk-level progress callbacks fire far more often than a
          // localStorage write is worth; coalesce to one in-flight write.
          if (!this.progressPersistInFlight) {
            this.progressPersistInFlight = true
            this.progressPersistTail = this.progressPersistTail.then(() =>
              this.persistSnapshot().finally(() => {
                this.progressPersistInFlight = false
              }),
            )
          }
          options.onProgress?.(progress)
        },
      )

      this.snapshot = {
        ...this.snapshot,
        status: 'completed',
        updatedAt: Date.now(),
        failureKind: undefined,
        failureMessage: undefined,
        failureHttpStatus: undefined,
        retryAt: undefined,
        retryCount: 0,
        waitingForRateLimit: false,
        // Permanent failures need user intervention → persist so the settings
        // page can surface them durably. Clear on a clean completion. Chunkify
        // failures self-heal on the next reconcile, so they're not persisted.
        permanentFailedPaths:
          result.permanentFailedPaths.length > 0
            ? result.permanentFailedPaths
            : undefined,
      }
      await this.persistTerminalSnapshot()
      // The index content now matches the current scope options: the host
      // records the options snapshot and clears any rebuild-required flag.
      // Fire-and-forget so the run completion is not delayed by a settings
      // write (the callback's failures are caught by the host).
      try {
        this.onIndexCompleted?.(result)
      } catch (error) {
        console.error('[YOLO] onIndexCompleted hook failed', error)
      }
      return result
    } catch (error) {
      const failure = describeRagIndexError(error)
      const failureKind = failure.kind
      const nextRetry =
        failureKind === 'transient' && options.retryPolicy === 'transient'
          ? getNextAutomaticRetry(
              this.snapshot.retryCount,
              MANUAL_RETRY_SCHEDULE,
            )
          : null
      const shouldScheduleRetry = nextRetry !== null
      this.snapshot = {
        ...this.snapshot,
        status:
          failureKind === 'aborted'
            ? 'idle'
            : shouldScheduleRetry
              ? 'retry_scheduled'
              : 'failed',
        updatedAt: Date.now(),
        // A user-initiated cancel is not a failure: clear the stale failure
        // fields so an idle snapshot doesn't keep showing the last error.
        failureKind: failureKind === 'aborted' ? undefined : failureKind,
        failureMessage: failureKind === 'aborted' ? undefined : failure.message,
        failureHttpStatus:
          failureKind === 'aborted' ? undefined : failure.httpStatus,
        waitingForRateLimit: false,
        retryCount: nextRetry?.retryCount ?? this.snapshot.retryCount,
        retryAt: shouldScheduleRetry
          ? Date.now() + nextRetry.delayMs
          : undefined,
      }
      await this.persistTerminalSnapshot()
      if (shouldScheduleRetry && options.trigger === 'manual') {
        this.scheduleRetry(options)
      }
      throw error
    } finally {
      this.currentAbortController = null
      this.publishActivity()
      this.emit()
    }
  }

  async markRetryScheduled(input: {
    mode: RagIndexRunMode
    retryAt: number
    retryCount: number
    failureMessage?: string
  }): Promise<void> {
    await this.initialize()
    this.snapshot = {
      ...this.snapshot,
      mode: input.mode,
      trigger: 'auto',
      retryPolicy: 'transient',
      status: 'retry_scheduled',
      retryAt: input.retryAt,
      updatedAt: Date.now(),
      failureKind: 'transient',
      failureMessage: input.failureMessage,
      retryCount: input.retryCount,
    }
    await this.persistSnapshot()
  }

  async clearRetryScheduled(): Promise<void> {
    await this.initialize()
    if (this.snapshot.status !== 'retry_scheduled') {
      return
    }
    this.clearRetryTimer()
    this.snapshot = {
      ...this.snapshot,
      status: 'idle',
      updatedAt: Date.now(),
      retryAt: undefined,
      failureKind: undefined,
      failureMessage: undefined,
      waitingForRateLimit: false,
    }
    await this.persistSnapshot()
  }

  async resetRetryState(): Promise<void> {
    await this.initialize()
    this.clearRetryTimer()
    this.snapshot = {
      ...this.snapshot,
      status:
        this.snapshot.status === 'retry_scheduled' ||
        this.snapshot.status === 'failed'
          ? 'idle'
          : this.snapshot.status,
      retryPolicy: 'none',
      retryCount: 0,
      retryAt: undefined,
      failureKind: undefined,
      failureMessage: undefined,
      failureHttpStatus: undefined,
      waitingForRateLimit: false,
      updatedAt: Date.now(),
    }
    await this.persistSnapshot()
  }

  refreshActivity(): void {
    this.publishActivity()
  }

  cleanup(): void {
    this.clearRetryTimer()
    this.currentAbortController?.abort()
    this.currentAbortController = null
    this.subscribers.clear()
    this.activityRegistry.remove(RETRY_ACTIVITY_ID)
  }

  private hasWebLocks(): boolean {
    return typeof navigator !== 'undefined' && 'locks' in navigator
  }

  private getIndexLockName(): string {
    const vaultName = this.app.vault?.getName?.()
    return `${INDEX_LOCK_PREFIX}${vaultName || 'default'}`
  }

  private async isIndexLockHeld(lockName: string): Promise<boolean> {
    const locks = navigator.locks
    if (typeof locks.query !== 'function') {
      return false
    }
    const state = await locks.query()
    return (state.held ?? []).some((lock) => lock.name === lockName)
  }

  private async persistSnapshot(): Promise<void> {
    await writeLocalStorage(
      this.app,
      STORAGE_KEY,
      JSON.stringify(this.snapshot),
    )
    this.publishActivity()
    this.emit()
  }

  /**
   * Terminal snapshot write (completed/failed). Serialized behind any
   * in-flight coalesced progress write so the final localStorage value is
   * always the terminal status (see {@link progressPersistTail}).
   */
  private async persistTerminalSnapshot(): Promise<void> {
    await this.progressPersistTail
    await this.persistSnapshot()
  }

  private scheduleRetry(options: RagIndexRunOptions, minDelayMs = 0): void {
    this.clearRetryTimer()
    const delayMs = Math.max(
      (this.snapshot.retryAt ?? Date.now()) - Date.now(),
      minDelayMs,
    )
    this.armRetryTimer(options, delayMs)
  }

  private armRetryTimer(options: RagIndexRunOptions, delayMs: number): void {
    this.retryOptions = options
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.retryOptions = null
      void this.runIndex(options, 'automatic-retry').catch((error: unknown) => {
        console.error('[YOLO] Failed to rerun scheduled RAG index:', error)
      })
    }, delayMs)
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryOptions = null
  }

  private publishActivity(): void {
    if (
      !this.isRagEnabled() ||
      this.snapshot.status === 'idle' ||
      this.snapshot.status === 'completed'
    ) {
      this.activityRegistry.remove(RETRY_ACTIVITY_ID)
      return
    }

    const title = this.buildActivityTitle()
    const detail = this.buildActivityDetail()
    this.activityRegistry.upsert({
      id: RETRY_ACTIVITY_ID,
      kind: 'rag-index',
      title,
      detail,
      status:
        this.snapshot.status === 'retry_scheduled'
          ? 'waiting'
          : this.snapshot.status === 'failed'
            ? 'failed'
            : 'running',
      updatedAt: Date.now(),
      action: { type: 'open-knowledge-settings' },
    })
  }

  private buildActivityTitle(): string {
    if (this.snapshot.status === 'retry_scheduled') {
      return this.t('statusBar.ragAutoUpdateRunning', '知识库等待重试')
    }
    if (this.snapshot.status === 'failed') {
      return this.t('statusBar.ragAutoUpdateFailed', '知识库索引失败')
    }
    if (this.snapshot.mode === 'rebuild') {
      return this.t('notices.rebuildingIndex', '正在重建知识库索引')
    }
    return this.t('statusBar.ragAutoUpdateRunning', '知识库正在后台更新')
  }

  private buildActivityDetail(): string {
    if (this.snapshot.status === 'retry_scheduled') {
      const retryAtLabel = this.snapshot.retryAt
        ? new Date(this.snapshot.retryAt).toLocaleTimeString()
        : this.t('common.retry', '重试')
      return this.snapshot.failureMessage
        ? `${this.snapshot.failureMessage} · ${retryAtLabel}`
        : retryAtLabel
    }
    if (this.snapshot.status === 'failed') {
      return (
        this.snapshot.failureMessage ??
        this.t(
          'statusBar.ragAutoUpdateFailedDetail',
          '最近一次后台同步失败，请稍后重试。',
        )
      )
    }
    if (this.snapshot.waitingForRateLimit) {
      return this.t(
        'settings.rag.waitingRateLimit',
        'Waiting for rate limit to reset...',
      )
    }
    if (this.snapshot.currentFile) {
      return this.snapshot.currentFile
    }
    return this.t(
      'statusBar.ragAutoUpdateRunningDetail',
      '正在增量同步知识库索引。',
    )
  }

  private emit(): void {
    const snapshot = { ...this.snapshot }
    for (const subscriber of this.subscribers) {
      subscriber(snapshot)
    }
  }
}
