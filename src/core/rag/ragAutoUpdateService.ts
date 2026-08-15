import { minimatch } from 'minimatch'
import { TAbstractFile, TFile, TFolder } from 'obsidian'

import {
  getProtectedVaultPathRules,
  isProtectedVaultPath,
} from '../paths/protectedPaths'
import { getYoloBaseDir } from '../paths/yoloPaths'
import { YoloSettings } from '../../settings/schema/setting.types'
import {
  type AutomaticRetrySchedule,
  MAX_AUTOMATIC_RETRIES,
  getNextAutomaticRetry,
} from '../retry/limitedAutomaticRetry'

import { classifyRagIndexError } from './ragIndexErrors'

/**
 * Snapshot of pending vault changes the auto-updater wants reconciled.
 * `kind: 'all'` means the change set is too broad to enumerate (folder
 * rename/delete) and a vault-wide reconcile is required.
 */
export type AutoUpdateRunRequest =
  | { kind: 'all' }
  | { kind: 'paths'; paths: string[] }

type RagAutoUpdateServiceDeps = {
  getSettings: () => YoloSettings
  setSettings: (settings: YoloSettings) => Promise<boolean>
  runIndex: (request: AutoUpdateRunRequest) => Promise<void>
  getRetryCount: () => number
  markRetryScheduled: (input: {
    retryAt: number
    retryCount: number
    failureMessage?: string
  }) => Promise<void>
  clearRetryScheduled: () => Promise<void>
}

export class RagAutoUpdateService {
  private static readonly EDIT_IDLE_WINDOW_MS = 5 * 60 * 1000
  private static readonly WINDOW_BLUR_GRACE_MS = 15 * 1000
  private static readonly SUCCESS_COOLDOWN_MS = 2 * 60 * 1000
  private static readonly RETRY_SCHEDULE = [
    5 * 60_000,
    15 * 60_000,
    30 * 60_000,
  ] as const satisfies AutomaticRetrySchedule

  private readonly getSettings: () => YoloSettings
  private readonly setSettings: (settings: YoloSettings) => Promise<boolean>
  private readonly runIndex: (request: AutoUpdateRunRequest) => Promise<void>
  private readonly getRetryCount: () => number
  private readonly markRetryScheduled: (input: {
    retryAt: number
    retryCount: number
    failureMessage?: string
  }) => Promise<void>
  private readonly clearRetryScheduled: () => Promise<void>

  private autoUpdateTimer: ReturnType<typeof setTimeout> | null = null
  private isAutoUpdating = false
  private pendingDirtyPaths = new Set<string>()
  private hasPendingChangesDuringRun = false
  private hasRecoveredRetry = false
  private requiresFullScan = false
  private lastRelevantEditAt: number | null = null
  private lastRunFinishedAt: number | null = null
  private lastRunError: string | null = null
  /** True while a transient-failure retry timer is pending (for onOnline). */
  private hasPendingTransientRetry = false

  constructor(deps: RagAutoUpdateServiceDeps) {
    this.getSettings = deps.getSettings
    this.setSettings = deps.setSettings
    this.runIndex = deps.runIndex
    this.getRetryCount = deps.getRetryCount
    this.markRetryScheduled = deps.markRetryScheduled
    this.clearRetryScheduled = deps.clearRetryScheduled
  }

  cleanup() {
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer)
      this.autoUpdateTimer = null
    }
    this.pendingDirtyPaths.clear()
    this.hasPendingChangesDuringRun = false
    this.hasRecoveredRetry = false
    this.requiresFullScan = false
    this.hasPendingTransientRetry = false
  }

  restoreRetryScheduled(retryAt?: number, minDelayMs = 0): void {
    const settings = this.getSettings()
    if (!this.isAutoUpdateEnabled(settings)) return

    this.hasRecoveredRetry = true
    // A restored retry is a pending transient retry, so let onOnline() bring it
    // forward when connectivity returns.
    this.hasPendingTransientRetry = true
    const delayMs = Math.max(
      retryAt === undefined ? 0 : retryAt - Date.now(),
      minDelayMs,
    )
    this.scheduleAutoUpdate(delayMs)
  }

  onVaultFileChanged(
    file: TAbstractFile,
    changeType: 'create' | 'modify' | 'delete' | 'rename' = 'modify',
  ) {
    try {
      if (file instanceof TFile) {
        const settings = this.getSettings()
        if (file.extension === 'md') {
          this.markDirty(file.path)
          return
        }
        if (
          file.extension === 'pdf' &&
          (settings.ragOptions.indexPdf ?? true)
        ) {
          this.markDirty(file.path)
        }
        return
      }

      if (
        file instanceof TFolder &&
        (changeType === 'rename' || changeType === 'delete')
      ) {
        this.markDirty(file.path, { requiresFullScan: true })
      }
    } catch {
      // Ignore unexpected file type changes during event handling.
    }
  }

  onVaultPathChanged(path: string, options?: { requiresFullScan?: boolean }) {
    this.markDirty(path, options)
  }

  onWindowBlur() {
    if (this.pendingDirtyPaths.size === 0 || this.isAutoUpdating) {
      return
    }

    const elapsedSinceEdit =
      this.lastRelevantEditAt === null
        ? Number.POSITIVE_INFINITY
        : Date.now() - this.lastRelevantEditAt

    if (elapsedSinceEdit < RagAutoUpdateService.WINDOW_BLUR_GRACE_MS) {
      return
    }

    this.scheduleAutoUpdate(0)
  }

  /**
   * Accelerator (not a gate): when connectivity is restored, bring forward a
   * retry that is currently waiting out its transient-failure backoff. Does
   * nothing for ordinary edit-debounce timers. The SUCCESS_COOLDOWN check in
   * runAutoUpdate still applies, so a retry within 2 min of the failed run is
   * deferred until the cooldown elapses (acceptable).
   */
  onOnline() {
    if (!this.hasPendingTransientRetry || this.isAutoUpdating) {
      return
    }
    this.scheduleAutoUpdate(0)
  }

  private isAutoUpdateEnabled(settings: YoloSettings): boolean {
    if (
      !settings?.ragOptions?.enabled ||
      !settings?.ragOptions?.autoUpdateEnabled
    ) {
      return false
    }
    // Skip auto-update when no valid embedding model is configured so that
    // fresh installations don't immediately surface a confusing error.
    const id = settings.embeddingModelId
    if (!id || !settings.embeddingModels.some((m) => m.id === id)) {
      return false
    }
    return this.isEmbeddingModelAvailable(settings)
  }

  /**
   * The embedding model is usable when it resolves to a provider that carries
   * credentials (API key) or a reachable base URL (local runtimes like
   * Ollama/LM Studio). Without either, an auto-update run would fail on the
   * first embedding call and burn the automatic retry budget for nothing.
   */
  private isEmbeddingModelAvailable(settings: YoloSettings): boolean {
    const id = settings.embeddingModelId
    if (!id) return false
    const model = settings.embeddingModels.find((m) => m.id === id)
    if (!model) return false
    const provider = settings.providers.find(
      (p) => p.id === model.providerId,
    )
    if (!provider) return false
    return Boolean(provider.apiKey?.trim() || provider.baseUrl?.trim())
  }

  private isWithinUpdateInterval(settings: YoloSettings): boolean {
    const intervalHours = settings.ragOptions.autoUpdateIntervalHours ?? 0
    if (intervalHours <= 0) return false
    const lastRunAt = settings.ragOptions.lastAutoUpdateAt ?? 0
    return (
      lastRunAt > 0 &&
      Date.now() - lastRunAt < intervalHours * 60 * 60 * 1000
    )
  }

  private markDirty(path: string, options?: { requiresFullScan?: boolean }) {
    const settings = this.getSettings()
    if (!this.isAutoUpdateEnabled(settings)) return
    if (this.getRetryCount() >= MAX_AUTOMATIC_RETRIES) return
    // Host-managed data (session persistence, memory, projects zone) is never
    // indexable; changes there must not trigger reconciliation at all.
    if (isProtectedVaultPath(path, getProtectedVaultPathRules(settings))) {
      return
    }
    if (
      !options?.requiresFullScan &&
      !this.isPathSelectedByIncludeExclude(path, settings)
    ) {
      return
    }

    this.pendingDirtyPaths.add(path)
    this.lastRelevantEditAt = Date.now()
    this.lastRunError = null

    if (options?.requiresFullScan) {
      this.requiresFullScan = true
    }

    if (this.isAutoUpdating) {
      this.hasPendingChangesDuringRun = true
      return
    }

    if (this.isWithinUpdateInterval(settings)) {
      // Throttle: wait out the remainder of the configured minimum interval
      // between auto-update runs, then reconcile everything accumulated.
      const elapsedMs =
        Date.now() - (settings.ragOptions.lastAutoUpdateAt ?? 0)
      const intervalMs =
        (settings.ragOptions.autoUpdateIntervalHours ?? 0) * 60 * 60 * 1000
      this.scheduleAutoUpdate(intervalMs - elapsedMs)
      return
    }

    this.scheduleAutoUpdate(RagAutoUpdateService.EDIT_IDLE_WINDOW_MS)
  }

  private isPathSelectedByIncludeExclude(
    path: string,
    settings: YoloSettings,
  ): boolean {
    const lower = path.toLowerCase()
    const isMd = lower.endsWith('.md')
    const isPdf =
      lower.endsWith('.pdf') && (settings.ragOptions.indexPdf ?? true)
    if (!isMd && !isPdf) {
      return false
    }
    const { includePatterns = [], excludePatterns = [] } =
      settings?.ragOptions ?? {}
    if (excludePatterns.some((p) => minimatch(path, p))) return false
    // Mirrors the index scope: when the user excluded the YOLO base directory
    // from indexing, changes inside it must not trigger updates either.
    if (settings?.ragOptions?.excludeYoloBaseDir) {
      const baseDir = getYoloBaseDir(settings)
      if (path === baseDir || path.startsWith(`${baseDir}/`)) {
        return false
      }
    }
    if (!includePatterns || includePatterns.length === 0) return true
    return includePatterns.some((p) => minimatch(path, p))
  }

  private scheduleAutoUpdate(delayMs: number) {
    if (this.autoUpdateTimer) {
      clearTimeout(this.autoUpdateTimer)
    }

    this.autoUpdateTimer = setTimeout(() => {
      this.autoUpdateTimer = null
      void this.runAutoUpdate()
    }, delayMs)
  }

  private async runAutoUpdate() {
    if (this.isAutoUpdating) return
    if (
      this.pendingDirtyPaths.size === 0 &&
      !this.requiresFullScan &&
      !this.hasRecoveredRetry
    ) {
      return
    }

    if (
      this.lastRunFinishedAt !== null &&
      Date.now() - this.lastRunFinishedAt <
        RagAutoUpdateService.SUCCESS_COOLDOWN_MS
    ) {
      this.scheduleAutoUpdate(
        RagAutoUpdateService.SUCCESS_COOLDOWN_MS -
          (Date.now() - this.lastRunFinishedAt),
      )
      return
    }

    this.isAutoUpdating = true
    // The run is now consuming any pending transient retry; clear the flag so a
    // later onOnline during an ordinary debounce timer doesn't fast-forward it.
    this.hasPendingTransientRetry = false
    const pendingSnapshot = new Set(this.pendingDirtyPaths)
    const requiresFullScanSnapshot = this.requiresFullScan
    const recoveredRetrySnapshot = this.hasRecoveredRetry
    let hasScheduledTransientRetry = false
    let shouldRescheduleDirtyWork = false

    try {
      this.pendingDirtyPaths.clear()
      this.requiresFullScan = false
      this.hasPendingChangesDuringRun = false
      this.hasRecoveredRetry = false
      await this.clearRetryScheduled()
      const request: AutoUpdateRunRequest =
        requiresFullScanSnapshot || recoveredRetrySnapshot
          ? { kind: 'all' }
          : { kind: 'paths', paths: [...pendingSnapshot] }
      await this.runIndex(request)
      const settings = this.getSettings()
      await this.setSettings({
        ...settings,
        ragOptions: {
          ...settings.ragOptions,
          lastAutoUpdateAt: Date.now(),
        },
      })
      this.lastRunFinishedAt = Date.now()
      this.lastRunError = null
    } catch (e) {
      console.error('Auto update index failed:', e)
      this.lastRunFinishedAt = Date.now()
      this.lastRunError = e instanceof Error ? e.message : String(e)
      for (const path of pendingSnapshot) {
        this.pendingDirtyPaths.add(path)
      }
      this.requiresFullScan = this.requiresFullScan || requiresFullScanSnapshot
      const failureKind = classifyRagIndexError(e)
      // Was this run a vault-wide ('all') reconcile? If so, the retry MUST stay
      // 'all' — degrading to paths-only would drop files that the full scan
      // (incl. transient rollbacks from VectorManager) touched but that aren't
      // in pendingSnapshot, stranding their 0-row state until the next edit.
      const wasAllScope = requiresFullScanSnapshot || recoveredRetrySnapshot

      if (failureKind === 'transient') {
        const nextRetry = this.isAutoUpdateEnabled(this.getSettings())
          ? getNextAutomaticRetry(
              this.getRetryCount(),
              RagAutoUpdateService.RETRY_SCHEDULE,
            )
          : null
        if (!nextRetry) {
          return
        }
        const retryAt = Date.now() + nextRetry.delayMs
        if (wasAllScope) {
          // Keep next run vault-wide. Reuse requiresFullScan when the original
          // 'all' came from a folder rename/delete; otherwise carry the
          // recovered-retry flag forward.
          if (requiresFullScanSnapshot) {
            this.requiresFullScan = true
          } else {
            this.hasRecoveredRetry = true
          }
        } else {
          // 'paths' scope: pendingSnapshot was already restored above.
          this.hasRecoveredRetry = false
        }
        await this.markRetryScheduled({
          retryAt,
          retryCount: nextRetry.retryCount,
          failureMessage: this.lastRunError,
        })
        this.scheduleAutoUpdate(nextRetry.delayMs)
        hasScheduledTransientRetry = true
        this.hasPendingTransientRetry = true
      } else if (failureKind === 'aborted') {
        shouldRescheduleDirtyWork = true
      } else {
        // Permanent / unknown failures are terminal until the user retries.
      }
    } finally {
      this.isAutoUpdating = false
      if (!hasScheduledTransientRetry) {
        this.autoUpdateTimer = null
      }
      if (
        !hasScheduledTransientRetry &&
        (shouldRescheduleDirtyWork || this.hasPendingChangesDuringRun)
      ) {
        this.scheduleAutoUpdate(RagAutoUpdateService.EDIT_IDLE_WINDOW_MS)
      }
    }
  }
}
