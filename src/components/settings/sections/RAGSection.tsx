import { App, Notice, Platform } from 'obsidian'
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { RECOMMENDED_MODELS_FOR_EMBEDDING } from '../../../constants'
import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { MAINTENANCE_JOB_KIND } from '../../../core/maintenance/types'
import { getYoloBaseDir } from '../../../core/paths/yoloPaths'
import {
  RagIndexBusyError,
  type RagIndexRunSnapshot,
} from '../../../core/rag/ragIndexService'
import type { VectorBackendStatus } from '../../../database/modules/rag/VectorStore'
import YoloPlugin from '../../../main'
import type { YoloSettings } from '../../../settings/schema/setting.types'
import { findFilesMatchingPatterns } from '../../../utils/glob-utils'
import {
  folderPathsToIncludePatterns,
  includePatternsToFolderPaths,
} from '../../../utils/rag-utils'
import { IndexProgress } from '../../chat-view/QueryProgress'
import { ObsidianButton } from '../../common/ObsidianButton'
import {
  ObsidianDropdown,
  type ObsidianDropdownOptionGroup,
} from '../../common/ObsidianDropdown'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { IndexProgressRing } from '../IndexProgressRing'
import { FolderSelectionList } from '../inputs/FolderSelectionList'
import { ExcludedFilesModal } from '../modals/ExcludedFilesModal'
import { IncludedFilesModal } from '../modals/IncludedFilesModal'

const RAG_UPDATE_ERROR = 'Failed to update RAG settings.'

type RAGSectionProps = {
  app: App
  plugin: YoloPlugin
}

type IndexJob = {
  mode: 'rebuild' | 'sync'
  successNotice?: string
  failureNotice: string
}

type RagSettingsBase = {
  ragOptions: YoloSettings['ragOptions']
  ragBackendSettings: YoloSettings['ragBackendSettings']
}

type RagSettingsPatch<TSettings extends RagSettingsBase = YoloSettings> =
  Partial<Omit<TSettings, 'ragOptions' | 'ragBackendSettings'>> & {
    ragOptions?: Partial<TSettings['ragOptions']>
    ragBackendSettings?: Partial<TSettings['ragBackendSettings']>
  }

export const isRagLogRibbonVisible = (settings: {
  ragOptions: { showRagLogRibbonIcon?: boolean }
}): boolean => settings.ragOptions.showRagLogRibbonIcon !== false

export const mergeRagSettingsPatch = <TSettings extends RagSettingsBase>(
  settings: TSettings,
  patch: RagSettingsPatch<TSettings>,
): TSettings => ({
  ...settings,
  ...patch,
  ragOptions:
    patch.ragOptions == null
      ? settings.ragOptions
      : {
          ...settings.ragOptions,
          ...patch.ragOptions,
        },
  ragBackendSettings:
    patch.ragBackendSettings == null
      ? settings.ragBackendSettings
      : {
          ...settings.ragBackendSettings,
          ...patch.ragBackendSettings,
        },
})

const snapshotToProgress = (
  snapshot: RagIndexRunSnapshot,
): IndexProgress | null => {
  if (
    snapshot.totalFiles === undefined &&
    snapshot.totalChunks === undefined &&
    !snapshot.currentFile
  ) {
    return null
  }

  return {
    phase: snapshot.phase,
    completedChunks: snapshot.completedChunks ?? 0,
    totalChunks: snapshot.totalChunks ?? 0,
    totalFiles: snapshot.totalFiles ?? 0,
    completedFiles: snapshot.completedFiles ?? 0,
    currentFile: snapshot.currentFile,
    waitingForRateLimit: snapshot.waitingForRateLimit,
  }
}

export const getProgressPercent = (progress: IndexProgress | null): number => {
  if (!progress) return 0
  const calculate = (completed: number, total: number): number => {
    if (total <= 0) return 0
    const ratio = Math.max(0, completed) / total
    if (completed < total)
      return Math.min(99.99, Math.floor(ratio * 10_000) / 100)
    return 100
  }
  if ((progress.totalFiles ?? 0) > 0) {
    return calculate(progress.completedFiles ?? 0, progress.totalFiles)
  }
  if ((progress.totalChunks ?? 0) > 0) {
    return calculate(progress.completedChunks, progress.totalChunks)
  }
  return 0
}

export const formatProgressPercent = (percent: number): string =>
  Math.max(0, Math.min(100, percent)).toFixed(2)

/**
 * Ring label for the rebuild-required state. The persisted scope-change flag
 * (`ragBackendSettings.rebuildRequired`) means the configured index scope no
 * longer matches the stored index ("Rebuild required"); a store-derived
 * rebuildRequired without that flag means the index is empty/missing ("Not
 * indexed yet"). Exported for direct unit testing.
 */
export const rebuildRequiredLabel = (
  scopeChangeFlag: boolean,
  t: (key: string, fallback?: string) => string,
): string =>
  scopeChangeFlag
    ? t('settings.rag.rebuildRequired', 'Rebuild required')
    : t('settings.rag.notIndexedYet', 'Not indexed yet')

const getProgressSummary = (
  progress: IndexProgress | null,
  t: (key: string, fallback?: string) => string,
): string | null => {
  if (!progress) return null
  if ((progress.totalFiles ?? 0) > 0) {
    return `${progress.completedFiles ?? 0}/${progress.totalFiles} ${t(
      'settings.rag.filesProgress',
      'files',
    )}`
  }
  if ((progress.totalChunks ?? 0) > 0) {
    return `${progress.completedChunks}/${progress.totalChunks} ${t(
      'settings.rag.chunksProgress',
      'chunks',
    )}`
  }
  return null
}

function RAGCard({
  title,
  description,
  actions,
  children,
}: {
  title: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="yolo-rag-card">
      <div className="yolo-rag-card-header">
        <div className="yolo-rag-card-header-copy">
          <div className="yolo-rag-card-title">{title}</div>
          {description ? (
            <div className="yolo-rag-card-description">{description}</div>
          ) : null}
        </div>
        {actions ? (
          <div className="yolo-rag-card-actions">{actions}</div>
        ) : null}
      </div>
      <div className="yolo-rag-card-body">{children}</div>
    </section>
  )
}

export function RAGSection({ app, plugin }: RAGSectionProps) {
  const FILE_SWITCH_ANIMATION_MS = 120
  const FILE_SWITCH_MIN_INTERVAL_MS = 90
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [indexRunSnapshot, setIndexRunSnapshot] = useState<RagIndexRunSnapshot>(
    () => plugin.getRagIndexSnapshot(),
  )
  const [displayedCurrentFile, setDisplayedCurrentFile] = useState<
    string | null
  >(null)
  const [leavingCurrentFile, setLeavingCurrentFile] = useState<string | null>(
    null,
  )
  const [fileAnimationKey, setFileAnimationKey] = useState(0)
  const [isVacuumingRagBackend, setIsVacuumingRagBackend] = useState(false)
  const [ragBackendStatus, setRagBackendStatus] =
    useState<VectorBackendStatus | null>(null)
  const isRagEnabled = settings.ragOptions.enabled ?? true
  const isIndexPdfEnabled = settings.ragOptions.indexPdf ?? true
  const isRagLogRibbonEnabled = isRagLogRibbonVisible(settings)
  const isIndexing = indexRunSnapshot.status === 'running'
  const progressSource = useMemo(
    () => snapshotToProgress(indexRunSnapshot),
    [indexRunSnapshot],
  )
  const [chunkSizeInput, setChunkSizeInput] = useState(
    String(settings.ragOptions.chunkSize),
  )
  const [chunkOverlapInput, setChunkOverlapInput] = useState(
    String(settings.ragOptions.chunkOverlap ?? 50),
  )
  const [minSimilarityInput, setMinSimilarityInput] = useState(
    String(settings.ragOptions.minSimilarity),
  )
  const [limitInput, setLimitInput] = useState(
    String(settings.ragOptions.limit),
  )
  const [embeddingConcurrencyInput, setEmbeddingConcurrencyInput] = useState(
    String(settings.ragOptions.embeddingConcurrency ?? 10),
  )
  const [autoUpdateIntervalInput, setAutoUpdateIntervalInput] = useState(
    String(settings.ragOptions.autoUpdateIntervalHours ?? 0),
  )
  const [showAdvancedRagSettings, setShowAdvancedRagSettings] = useState(false)
  const [permanentFailuresExpanded, setPermanentFailuresExpanded] =
    useState(false)
  const fileAnimationTimerRef = useRef<number | null>(null)
  const fileSwitchTimerRef = useRef<number | null>(null)
  const pendingCurrentFileRef = useRef<string | null>(null)
  const lastFileSwitchAtRef = useRef(0)
  const settingsRef = useRef(settings)
  const settingsUpdateQueueRef = useRef<Promise<void>>(Promise.resolve())

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    setChunkSizeInput(String(settings.ragOptions.chunkSize))
  }, [settings.ragOptions.chunkSize])

  useEffect(() => {
    setChunkOverlapInput(String(settings.ragOptions.chunkOverlap ?? 50))
  }, [settings.ragOptions.chunkOverlap])

  useEffect(() => {
    setMinSimilarityInput(String(settings.ragOptions.minSimilarity))
  }, [settings.ragOptions.minSimilarity])

  useEffect(() => {
    setLimitInput(String(settings.ragOptions.limit))
  }, [settings.ragOptions.limit])

  useEffect(() => {
    setEmbeddingConcurrencyInput(
      String(settings.ragOptions.embeddingConcurrency ?? 10),
    )
  }, [settings.ragOptions.embeddingConcurrency])

  useEffect(() => {
    setAutoUpdateIntervalInput(
      String(settings.ragOptions.autoUpdateIntervalHours ?? 0),
    )
  }, [settings.ragOptions.autoUpdateIntervalHours])

  const applySettingsUpdate = useCallback(
    (patch: RagSettingsPatch, errorMessage: string = RAG_UPDATE_ERROR) => {
      const runUpdate = async () => {
        const nextSettings = mergeRagSettingsPatch(settingsRef.current, patch)
        const saved = await setSettings(nextSettings)
        if (saved !== false) {
          settingsRef.current = nextSettings
        }
      }

      const queuedUpdate = settingsUpdateQueueRef.current.then(
        runUpdate,
        runUpdate,
      )
      settingsUpdateQueueRef.current = queuedUpdate.then(
        () => undefined,
        () => undefined,
      )

      void queuedUpdate.catch((error: unknown) => {
        console.error('[YOLO] ' + errorMessage, error)
        new Notice(errorMessage)
      })
    },
    [setSettings],
  )

  const refreshRagBackendStatus = useCallback(
    async (): Promise<VectorBackendStatus> => {
    try {
      const result = await plugin.getVectorBackendStatus()
      setRagBackendStatus(result)
      return result
    } catch (error: unknown) {
      console.error('Failed to inspect RAG backend', error)
      const unavailable: VectorBackendStatus = {
        backend: 'sqlite',
        readiness: 'open_failed',
        rebuildRequired: settings.ragBackendSettings.rebuildRequired,
        storagePath: '',
        executionMode: 'unsupported',
        persistenceMode: 'unsupported',
        recoveryAction: 'inspect_runtime_log',
      }
      setRagBackendStatus(unavailable)
      return unavailable
    }
  }, [plugin, settings.ragBackendSettings.rebuildRequired])

  useEffect(() => {
    // Check on first open too: skipping the initial mount left the backend
    // status unknown (null) until some later status change, so a freshly
    // opened RAG section never ran the backend check.
    if (indexRunSnapshot.status === 'running') {
      return
    }
    void refreshRagBackendStatus()
  }, [indexRunSnapshot.status, refreshRagBackendStatus])

  const parseIntegerInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^\d+$/.test(trimmed)) return null
    return parseInt(trimmed, 10)
  }

  const parseFloatInput = (value: string) => {
    const trimmed = value.trim()
    if (trimmed.length === 0) return null
    if (!/^\d*(?:[.,]\d*)?$/.test(trimmed)) return null
    if (
      trimmed === '.' ||
      trimmed === ',' ||
      trimmed.endsWith('.') ||
      trimmed.endsWith(',')
    ) {
      return null
    }
    const normalized = trimmed.includes(',')
      ? trimmed.split(',').join('.')
      : trimmed
    const parsed = Number(normalized)
    return Number.isFinite(parsed) ? parsed : null
  }

  useEffect(() => {
    return plugin.subscribeToRagIndexRuns((snapshot) => {
      setIndexRunSnapshot(snapshot)
    })
  }, [plugin])

  useEffect(() => {
    const applyDisplayedFile = (nextFile: string) => {
      if (fileAnimationTimerRef.current !== null) {
        window.clearTimeout(fileAnimationTimerRef.current)
        fileAnimationTimerRef.current = null
      }

      setLeavingCurrentFile(displayedCurrentFile)
      setDisplayedCurrentFile(nextFile)
      setFileAnimationKey((prev) => prev + 1)
      lastFileSwitchAtRef.current = Date.now()

      if (!displayedCurrentFile) {
        return
      }

      fileAnimationTimerRef.current = window.setTimeout(() => {
        fileAnimationTimerRef.current = null
        setLeavingCurrentFile(null)
      }, FILE_SWITCH_ANIMATION_MS)
    }

    if (!isIndexing) {
      if (fileAnimationTimerRef.current !== null) {
        window.clearTimeout(fileAnimationTimerRef.current)
        fileAnimationTimerRef.current = null
      }
      if (fileSwitchTimerRef.current !== null) {
        window.clearTimeout(fileSwitchTimerRef.current)
        fileSwitchTimerRef.current = null
      }
      pendingCurrentFileRef.current = null
      lastFileSwitchAtRef.current = 0
      setDisplayedCurrentFile(null)
      setLeavingCurrentFile(null)
      return
    }

    const nextFile = progressSource?.currentFile?.trim()
    if (!nextFile) {
      return
    }

    if (nextFile === displayedCurrentFile) {
      return
    }

    const elapsed = Date.now() - lastFileSwitchAtRef.current
    const shouldDelay =
      displayedCurrentFile !== null && elapsed < FILE_SWITCH_MIN_INTERVAL_MS

    if (shouldDelay) {
      pendingCurrentFileRef.current = nextFile
      if (fileSwitchTimerRef.current !== null) {
        return
      }
      fileSwitchTimerRef.current = window.setTimeout(() => {
        fileSwitchTimerRef.current = null
        const pendingFile = pendingCurrentFileRef.current
        pendingCurrentFileRef.current = null
        if (!pendingFile || pendingFile === displayedCurrentFile) {
          return
        }
        applyDisplayedFile(pendingFile)
      }, FILE_SWITCH_MIN_INTERVAL_MS - elapsed)
      return
    }

    pendingCurrentFileRef.current = null
    if (fileSwitchTimerRef.current !== null) {
      window.clearTimeout(fileSwitchTimerRef.current)
      fileSwitchTimerRef.current = null
    }
    applyDisplayedFile(nextFile)
  }, [
    FILE_SWITCH_ANIMATION_MS,
    FILE_SWITCH_MIN_INTERVAL_MS,
    displayedCurrentFile,
    isIndexing,
    progressSource,
  ])

  useEffect(() => {
    return () => {
      if (fileAnimationTimerRef.current !== null) {
        window.clearTimeout(fileAnimationTimerRef.current)
      }
      if (fileSwitchTimerRef.current !== null) {
        window.clearTimeout(fileSwitchTimerRef.current)
      }
    }
  }, [])

  const ringPercent = useMemo(() => {
    if (!isIndexing && indexRunSnapshot.status === 'completed') {
      return 100
    }
    return getProgressPercent(progressSource)
  }, [indexRunSnapshot.status, isIndexing, progressSource])

  const maintenanceStatusLine = useMemo(() => {
    if (isIndexing) {
      if (!progressSource) {
        return t('settings.rag.preparingProgress', 'Preparing index...')
      }
      if (progressSource.waitingForRateLimit) {
        return t(
          'settings.rag.waitingRateLimit',
          'Waiting for rate limit to reset...',
        )
      }
      if (displayedCurrentFile) {
        return displayedCurrentFile
      }
      if (
        (progressSource.totalFiles ?? 0) <= 0 &&
        (progressSource.totalChunks ?? 0) <= 0
      ) {
        return t('settings.rag.preparingProgress', 'Preparing index...')
      }
      return `${formatProgressPercent(ringPercent)}% ${t('settings.rag.indexing', 'Indexing...')}`
    }
    if (ragBackendStatus?.rebuildRequired) {
      // The persisted flag means scope options changed since the last run; a
      // store-derived rebuildRequired means the index is empty/missing.
      return rebuildRequiredLabel(
        settings.ragBackendSettings.rebuildRequired === true,
        t,
      )
    }
    if (indexRunSnapshot.status === 'failed') {
      if (indexRunSnapshot.failureKind === 'aborted') {
        const summary = getProgressSummary(progressSource, t)
        return summary
          ? `${summary} · ${t('settings.rag.indexPaused', 'Paused')}`
          : t('settings.rag.indexPaused', 'Paused')
      }
      const prefix = indexRunSnapshot.failureHttpStatus
        ? `HTTP ${indexRunSnapshot.failureHttpStatus} · `
        : ''
      return (
        prefix +
        (indexRunSnapshot.failureMessage ??
          t('settings.rag.indexIncomplete', 'Last index did not finish'))
      )
    }
    // A completed run wins over the 0% fallback — covers the "deletion-only"
    // sync case where progressSource has totalChunks=0 but the run succeeded.
    if (indexRunSnapshot.status === 'completed') {
      return `100% ${t('settings.rag.indexComplete', 'Index complete')}`
    }
    if (!progressSource) {
      return t('settings.rag.notIndexedYet', 'Not indexed yet')
    }
    if (ringPercent >= 100) {
      return `${formatProgressPercent(ringPercent)}% ${t('settings.rag.indexComplete', 'Index complete')}`
    }
    if (ringPercent > 0) {
      return `${formatProgressPercent(ringPercent)}% ${t(
        'settings.rag.indexIncomplete',
        'Last index did not finish',
      )}`
    }
    return t('settings.rag.notIndexedYet', 'Not indexed yet')
  }, [
    indexRunSnapshot.failureHttpStatus,
    indexRunSnapshot.failureKind,
    indexRunSnapshot.failureMessage,
    indexRunSnapshot.status,
    isIndexing,
    ragBackendStatus?.rebuildRequired,
    settings.ragBackendSettings.rebuildRequired,
    displayedCurrentFile,
    progressSource,
    ringPercent,
    t,
  ])

  const maintenanceStatusKey = useMemo(() => {
    if (isIndexing) {
      if (!progressSource) {
        return 'preparing'
      }
      if (progressSource.waitingForRateLimit) {
        return 'rate-limit'
      }
      if (displayedCurrentFile) {
        return displayedCurrentFile
      }
      return 'indexing'
    }
    if (ragBackendStatus?.rebuildRequired) {
      return 'rebuild-required'
    }
    if (indexRunSnapshot.status === 'failed') {
      return 'failed'
    }
    return `idle-${ringPercent}`
  }, [
    indexRunSnapshot.status,
    isIndexing,
    ragBackendStatus?.rebuildRequired,
    displayedCurrentFile,
    progressSource,
    ringPercent,
  ])

  const isAnimatingCurrentFile = Boolean(isIndexing && displayedCurrentFile)
  const maintenanceStatusPrefix = isAnimatingCurrentFile
    ? `${formatProgressPercent(ringPercent)}%`
    : null

  // Files that completed but could not be indexed permanently. Surfaced as a
  // durable, expandable line under the maintenance status (no modal, no Notice
  // for the background path) until the next clean completion clears the field.
  const permanentFailedPaths = useMemo(
    () =>
      !ragBackendStatus?.rebuildRequired &&
      !isIndexing &&
      indexRunSnapshot.status === 'completed'
        ? (indexRunSnapshot.permanentFailedPaths ?? [])
        : [],
    [
      ragBackendStatus?.rebuildRequired,
      isIndexing,
      indexRunSnapshot.status,
      indexRunSnapshot.permanentFailedPaths,
    ],
  )

  const includeFolders = useMemo(
    () => includePatternsToFolderPaths(settings.ragOptions.includePatterns),
    [settings.ragOptions.includePatterns],
  )

  const yoloBaseDir = useMemo(() => getYoloBaseDir(settings), [settings])

  const excludeFolders = useMemo(() => {
    const userFolders = includePatternsToFolderPaths(
      settings.ragOptions.excludePatterns,
    )
    if (!settings.ragOptions.excludeYoloBaseDir) return userFolders
    if (userFolders.includes(yoloBaseDir)) return userFolders
    return [yoloBaseDir, ...userFolders]
  }, [
    settings.ragOptions.excludePatterns,
    settings.ragOptions.excludeYoloBaseDir,
    yoloBaseDir,
  ])

  // Allow maintenance actions when status is unknown (null) so the user can
  // click a button and trigger a lazy backend check. Only block actions when
  // the backend is known to be not-ready.
  const canRunIndexMaintenance =
    ragBackendStatus === null || ragBackendStatus.readiness === 'ready'
  const canManageEmbeddingDatabase =
    Platform.isDesktop && canRunIndexMaintenance

  const ensureBackendChecked = useCallback(async (): Promise<boolean> => {
    if (ragBackendStatus !== null) return ragBackendStatus.readiness === 'ready'
    const status = await refreshRagBackendStatus()
    return status.readiness === 'ready'
  }, [ragBackendStatus, refreshRagBackendStatus])

  const runRagVacuum = useCallback(() => {
    setIsVacuumingRagBackend(true)
    void (async () => {
      try {
        const result = await plugin
          .getDatabaseMaintenanceController('rag')
          .startJob({
            kind: MAINTENANCE_JOB_KIND.VACUUM,
            operationKey: 'rag:vacuum',
          })
        if (result.status === 'failed') {
          throw result.error instanceof Error
            ? result.error
            : new Error('RAG vacuum failed.')
        }
        if (result.status === 'cancelled') return
        new Notice(t('settings.rag.vacuumComplete', '索引 Vacuum 完成。'))
        await refreshRagBackendStatus()
      } catch (error: unknown) {
        console.error('Failed to vacuum RAG backend', error)
        new Notice(
          error instanceof Error
            ? error.message
            : t('settings.rag.vacuumFailed', '索引 Vacuum 失败。'),
        )
      } finally {
        setIsVacuumingRagBackend(false)
      }
    })()
  }, [plugin, refreshRagBackendStatus, t])

  const runIndexJob = useCallback(
    async ({ mode, successNotice, failureNotice }: IndexJob) => {
      try {
        const kind =
          mode === 'rebuild'
            ? MAINTENANCE_JOB_KIND.FULL_REBUILD
            : MAINTENANCE_JOB_KIND.UPDATE_CHANGED_SOURCES
        const result = await plugin
          .getDatabaseMaintenanceController('rag')
          .startJob({
            kind,
            operationKey: `rag:${kind}`,
            scope: { kind: 'all' },
          })
        if (result.status === 'failed') {
          throw result.error instanceof Error
            ? result.error
            : new Error(failureNotice)
        }
        if (result.status === 'cancelled') {
          new Notice(t('notices.indexCancelled', '索引已取消'))
        } else if (successNotice) {
          new Notice(successNotice)
        }
      } catch (error) {
        if (error instanceof RagIndexBusyError) {
          new Notice(t('statusBar.ragAutoUpdateRunning', '知识库索引正在运行'))
        } else if (
          error instanceof DOMException &&
          error.name === 'AbortError'
        ) {
          new Notice(t('notices.indexCancelled', '索引已取消'))
        } else {
          console.error('Failed to update knowledge base index:', error)
          new Notice(failureNotice)
        }
      }
    },
    [plugin, t],
  )

  const conflictInfo = useMemo(() => {
    const inc = includeFolders
    const exc = excludeFolders
    const isParentOrSame = (parent: string, child: string) => {
      if (parent === '') return true
      if (child === parent) return true
      return child.startsWith(parent + '/')
    }
    const exactConflicts = inc.filter((f) => exc.includes(f))
    const includeUnderExcluded = inc
      .filter((f) => exc.some((e) => isParentOrSame(e, f)))
      .filter((f) => !exactConflicts.includes(f))
    const excludeWithinIncluded = exc
      .filter((e) => inc.some((f) => isParentOrSame(f, e)))
      .filter((e) => !exactConflicts.includes(e))
    return { exactConflicts, includeUnderExcluded, excludeWithinIncluded }
  }, [includeFolders, excludeFolders])

  const embeddingModelOptionGroups = useMemo<
    ObsidianDropdownOptionGroup[]
  >(() => {
    const providerOrder = settings.providers.map((p) => p.id)
    const providerIdsInModels = Array.from(
      new Set(settings.embeddingModels.map((model) => model.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]
    const recommendedBadge =
      t('settings.defaults.recommendedBadge') ?? '(Recommended)'

    return orderedProviderIds
      .map<ObsidianDropdownOptionGroup | null>((providerId) => {
        const groupModels = settings.embeddingModels.filter(
          (model) => model.providerId === providerId,
        )
        if (groupModels.length === 0) return null
        return {
          label: providerId,
          options: groupModels.map((model) => {
            const baseLabel = model.name || model.model || model.id
            const badge = RECOMMENDED_MODELS_FOR_EMBEDDING.includes(model.id)
              ? ` ${recommendedBadge}`
              : ''
            return {
              value: model.id,
              label: `${baseLabel}${badge}`.trim(),
            }
          }),
        }
      })
      .filter((group): group is ObsidianDropdownOptionGroup => group !== null)
  }, [settings.embeddingModels, settings.providers, t])

  const rerankModelOptionGroups = useMemo<ObsidianDropdownOptionGroup[]>(() => {
    const providerOrder = settings.providers.map((p) => p.id)
    const providerIdsInModels = Array.from(
      new Set(settings.rerankModels.map((model) => model.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]

    return orderedProviderIds
      .map<ObsidianDropdownOptionGroup | null>((providerId) => {
        const groupModels = settings.rerankModels.filter(
          (model) => model.providerId === providerId,
        )
        if (groupModels.length === 0) return null
        return {
          label: providerId,
          options: groupModels.map((model) => ({
            value: model.id,
            label: model.name || model.model || model.id,
          })),
        }
      })
      .filter((group): group is ObsidianDropdownOptionGroup => group !== null)
  }, [settings.rerankModels, settings.providers, t])

  return (
    <div className="yolo-settings-section">
      <div className="yolo-settings-header">
        {t('settings.rag.title', '知识库')}
      </div>
      <div className="yolo-settings-desc">
        {t(
          'settings.rag.desc',
          '管理知识库索引，当 Agent 使用「搜索」工具并选择混合 & RAG 模式时，会自动调用 RAG 能力。',
        )}
      </div>
      <div className="yolo-rag-layout">
        <RAGCard title={t('settings.rag.backendCardTitle', 'RAG 后端')}>
          <ObsidianSetting
            name={t('settings.rag.log.openTitle', 'RAG 日志')}
            desc={t('settings.rag.log.openDesc', '查看最近的检索日志。')}
            className="yolo-settings-card"
          >
            <ObsidianButton
              text={t('settings.rag.log.openButton', '打开')}
              onClick={() => plugin.openRagLogModal()}
            />
          </ObsidianSetting>

          {/* The ribbon icon only exists on desktop (syncRagLogRibbonIcon
              gates on Platform.isDesktop); hide the toggle elsewhere instead
              of showing a control that does nothing. */}
          {Platform.isDesktop && (
            <ObsidianSetting
              name={t(
                'settings.rag.log.showRibbonIcon',
                '显示 RAG 日志侧边栏图标',
              )}
              desc={t(
                'settings.rag.log.showRibbonIconDesc',
                '在左侧边栏显示 RAG 日志快捷入口。',
              )}
              className="yolo-settings-card"
            >
              <ObsidianToggle
                value={isRagLogRibbonEnabled}
                onChange={(value) => {
                  applySettingsUpdate({
                    ragOptions: {
                      showRagLogRibbonIcon: value,
                    },
                  })
                }}
              />
            </ObsidianSetting>
          )}
        </RAGCard>

        <RAGCard
          title={t('settings.rag.basicCardTitle', '知识库')}
          description={t(
            'settings.rag.basicCardDesc',
            '控制知识库索引的启用状态、嵌入模型与相关维护操作。',
          )}
        >
          <ObsidianSetting
            name={t('settings.rag.enableRag')}
            desc={t('settings.rag.enableRagDesc')}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={isRagEnabled}
              onChange={(value) => {
                if (value && !settings.embeddingModelId) {
                  new Notice(
                    t(
                      'settings.rag.selectEmbeddingModelFirst',
                      '请先选择嵌入模型，再启用知识库索引。',
                    ),
                  )
                  return
                }
                applySettingsUpdate({
                  ragOptions: {
                    enabled: value,
                  },
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.autoUpdate', '自动更新索引')}
            desc={t(
              'settings.rag.autoUpdateDesc',
              '开启后会在文档发生变化时于后台自动增量更新索引。',
            )}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={settings.ragOptions.autoUpdateEnabled !== false}
              onChange={(value) => {
                applySettingsUpdate({
                  ragOptions: {
                    autoUpdateEnabled: value,
                  },
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.lastIndexedAt', '最近同步')}
            desc={t(
              'settings.rag.lastIndexedAtDesc',
              '最近一次成功完成知识库索引或后台同步的时间。',
            )}
            className="yolo-settings-card"
            nameExtra={
              <span className="yolo-rag-last-sync">
                {(settings.ragOptions.lastAutoUpdateAt ?? 0) > 0
                  ? new Date(
                      settings.ragOptions.lastAutoUpdateAt,
                    ).toLocaleString()
                  : '—'}
              </span>
            }
          />

          <ObsidianSetting
            name={t('settings.rag.indexPdf', '索引 PDF')}
            desc={t(
              'settings.rag.indexPdfDesc',
              '为知识库提取并索引 PDF 文本；首次全库重建可能较慢。大型仓库若不需要可关闭。',
            )}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={isIndexPdfEnabled}
              onChange={(value) => {
                applySettingsUpdate({
                  ragOptions: {
                    indexPdf: value,
                  },
                })
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.rag.embeddingModel')}
            desc={t('settings.rag.embeddingModelDesc')}
            className="yolo-settings-card"
          >
            <ObsidianDropdown
              value={settings.embeddingModelId}
              groupedOptions={embeddingModelOptionGroups}
              onChange={(value) => {
                applySettingsUpdate({ embeddingModelId: value })
              }}
            />
          </ObsidianSetting>

          {rerankModelOptionGroups.length > 0 && (
            <>
              <ObsidianSetting
                name={t('settings.rag.rerankEnabled', '启用重排序')}
                desc={t(
                  'settings.rag.rerankEnabledDesc',
                  '关闭后直接使用向量检索结果，不再调用重排序模型。',
                )}
                className="yolo-settings-card"
              >
                <ObsidianToggle
                  value={settings.ragOptions.rerankEnabled !== false}
                  onChange={(rerankEnabled) =>
                    applySettingsUpdate({ ragOptions: { rerankEnabled } })
                  }
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.rag.rerankModel', 'Rerank model')}
                desc={t(
                  'settings.rag.rerankModelDesc',
                  'Optional. Model for re-ranking search results. Leave empty to skip rerank.',
                )}
                className="yolo-settings-card"
              >
                <ObsidianDropdown
                  value={settings.rerankModelId}
                  groupedOptions={[
                    {
                      label: t('settings.rag.none', 'None'),
                      options: [
                        {
                          value: '',
                          label: t('settings.rag.noRerank', 'No rerank'),
                        },
                      ],
                    },
                    ...rerankModelOptionGroups,
                  ]}
                  onChange={(value) => {
                    applySettingsUpdate({ rerankModelId: value })
                  }}
                />
              </ObsidianSetting>
            </>
          )}

          <ObsidianSetting
            name={t('settings.rag.manageEmbeddingDatabase', '管理嵌入数据库')}
            desc={t(
              'settings.rag.manageEmbeddingDatabaseDesc',
              '查看当前嵌入库的模型统计，并按需删除历史索引数据。',
            )}
            className="yolo-settings-card"
          >
            <ObsidianButton
              text={t('settings.rag.manage', '管理')}
              disabled={!canManageEmbeddingDatabase}
              onClick={() => {
                void import('../modals/SqliteDatabaseExplorerModal').then(
                  ({ SqliteDatabaseExplorerModal }) =>
                    new SqliteDatabaseExplorerModal(app, plugin, 'rag').open(),
                )
              }}
            />
          </ObsidianSetting>

          {!canRunIndexMaintenance &&
            ragBackendStatus !== null &&
            isRagEnabled && (
              <div className="yolo-muted-note">
                {t(
                  'settings.rag.maintenanceUnavailableHint',
                  'RAG 后端尚未就绪。请先处理上方后端状态，再执行索引维护。',
                )}
              </div>
            )}

          {isRagEnabled && (
            <>
              <ObsidianSetting
                name={t('settings.rag.maintenanceActions', '维护操作')}
                nameExtra={
                  <div className="yolo-index-inline-status">
                    <IndexProgressRing percent={ringPercent} />
                    {isAnimatingCurrentFile ? (
                      <span
                        className="yolo-index-current-file"
                        title={`${maintenanceStatusPrefix} ${maintenanceStatusLine}`}
                      >
                        <span className="yolo-index-current-file-prefix">
                          {maintenanceStatusPrefix}
                        </span>
                        <span className="yolo-index-current-file-viewport">
                          {leavingCurrentFile ? (
                            <span className="yolo-index-current-file-text is-leaving">
                              {leavingCurrentFile}
                            </span>
                          ) : null}
                          <span
                            key={fileAnimationKey}
                            className={`yolo-index-current-file-text${leavingCurrentFile ? ' is-entering' : ''}`}
                          >
                            {maintenanceStatusLine}
                          </span>
                        </span>
                      </span>
                    ) : (
                      <span
                        key={maintenanceStatusKey}
                        className="yolo-index-current-file"
                        title={maintenanceStatusLine}
                      >
                        {maintenanceStatusLine}
                      </span>
                    )}
                  </div>
                }
                className="yolo-settings-card yolo-rag-maintenance-setting"
              >
                <div className="yolo-flex-row-gap-8 yolo-rag-maintenance-actions">
                  <ObsidianButton
                    text={t('settings.rag.updateIndex', '更新索引')}
                    disabled={isIndexing || !canRunIndexMaintenance}
                    onClick={() => {
                      void ensureBackendChecked().then((canRun) => {
                        if (!canRun) return
                        return runIndexJob({
                          mode: 'sync',
                          successNotice: t(
                            'notices.continueComplete',
                            '继续索引完成',
                          ),
                          failureNotice: t(
                            'notices.indexUpdateFailed',
                            '更新索引失败',
                          ),
                        })
                      })
                    }}
                  />
                  <ObsidianButton
                    text={t('settings.rag.rebuildIndex', '重建索引')}
                    disabled={isIndexing || !canRunIndexMaintenance}
                    onClick={() => {
                      void ensureBackendChecked().then((canRun) => {
                        if (!canRun) return
                        return runIndexJob({
                          mode: 'rebuild',
                          successNotice: t(
                            'notices.rebuildComplete',
                            '重建索引完成',
                          ),
                          failureNotice: t(
                            'notices.rebuildFailed',
                            '重建索引失败',
                          ),
                        })
                      })
                    }}
                  />
                  <ObsidianButton
                    text={t('settings.rag.vacuumIndex', 'Vacuum 索引')}
                    disabled={
                      isIndexing ||
                      !canRunIndexMaintenance ||
                      isVacuumingRagBackend
                    }
                    onClick={() => {
                      void ensureBackendChecked().then((canRun) => {
                        if (canRun) runRagVacuum()
                      })
                    }}
                  />
                  {isIndexing && (
                    <ObsidianButton
                      text={t('settings.rag.cancelIndex', '暂停')}
                      onClick={() => {
                        void plugin
                          .getDatabaseMaintenanceController('rag')
                          .cancelActiveJob()
                          .then(() => {
                            new Notice(
                              t('notices.indexCancelling', '正在取消索引...'),
                            )
                          })
                      }}
                    />
                  )}
                </div>
              </ObsidianSetting>
              {permanentFailedPaths.length > 0 && (
                <div className="yolo-rag-permanent-failures">
                  <button
                    type="button"
                    className="yolo-rag-permanent-failures-summary"
                    onClick={() =>
                      setPermanentFailuresExpanded((prev) => !prev)
                    }
                    aria-expanded={permanentFailuresExpanded}
                  >
                    <span className="yolo-rag-permanent-failures-text">
                      {t(
                        'settings.rag.partialFailureSummary',
                        '完成 · {{count}} 个文件无法索引',
                      ).replace(
                        '{{count}}',
                        String(permanentFailedPaths.length),
                      )}
                    </span>
                    <span className="yolo-rag-permanent-failures-caret">
                      {permanentFailuresExpanded ? '▾' : '▸'}
                    </span>
                  </button>
                  {permanentFailuresExpanded && (
                    <ul className="yolo-rag-permanent-failures-list">
                      {permanentFailedPaths.map((path) => (
                        <li key={path} title={path}>
                          {path}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </RAGCard>

        {isRagEnabled && (
          <>
            <RAGCard
              title={t('settings.rag.scopeCardTitle', '索引范围')}
              description={t(
                'settings.rag.scopeCardDesc',
                '选择哪些文件夹应参与知识库索引，哪些应被排除。',
              )}
            >
              <div className="yolo-rag-scope-group">
                <ObsidianSetting
                  name={t('settings.rag.includePatterns')}
                  desc={t('settings.rag.includePatternsDesc')}
                  className="yolo-rag-scope-group-setting"
                >
                  <ObsidianButton
                    text={t('settings.rag.testPatterns')}
                    onClick={() => {
                      void (async () => {
                        const patterns = settings.ragOptions.includePatterns
                        const includedFiles = await findFilesMatchingPatterns(
                          patterns,
                          plugin.app.vault,
                        )
                        new IncludedFilesModal(
                          app,
                          includedFiles,
                          patterns,
                        ).open()
                      })().catch((error) => {
                        console.error('Failed to test include patterns', error)
                      })
                    }}
                  />
                </ObsidianSetting>

                <div className="yolo-rag-scope-group-body">
                  <FolderSelectionList
                    app={app}
                    vault={plugin.app.vault}
                    title={t('settings.rag.selectedFolders', '已选择的文件夹')}
                    value={includeFolders}
                    onChange={(folders: string[]) => {
                      const patterns = folderPathsToIncludePatterns(folders)
                      applySettingsUpdate({
                        ragOptions: {
                          includePatterns: patterns,
                        },
                      })
                    }}
                  />
                </div>
              </div>

              <div className="yolo-rag-scope-group">
                <ObsidianSetting
                  name={t('settings.rag.excludePatterns')}
                  desc={t('settings.rag.excludePatternsDesc')}
                  className="yolo-rag-scope-group-setting"
                >
                  <ObsidianButton
                    text={t('settings.rag.testPatterns')}
                    onClick={() => {
                      void (async () => {
                        const basePatterns = settings.ragOptions.excludePatterns
                        const patterns = settings.ragOptions.excludeYoloBaseDir
                          ? [
                              ...basePatterns,
                              ...folderPathsToIncludePatterns([yoloBaseDir]),
                            ]
                          : basePatterns
                        const excludedFiles = await findFilesMatchingPatterns(
                          patterns,
                          plugin.app.vault,
                        )
                        new ExcludedFilesModal(app, excludedFiles).open()
                      })().catch((error) => {
                        console.error('Failed to test exclude patterns', error)
                      })
                    }}
                  />
                </ObsidianSetting>

                <div className="yolo-rag-scope-group-body">
                  <FolderSelectionList
                    app={app}
                    vault={plugin.app.vault}
                    title={t('settings.rag.excludedFolders', '已排除的文件夹')}
                    placeholder={t(
                      'settings.rag.selectExcludeFoldersPlaceholder',
                      '点击此处选择要排除的文件夹（留空则不排除）',
                    )}
                    value={excludeFolders}
                    onChange={(folders: string[]) => {
                      const yoloRemoved =
                        settings.ragOptions.excludeYoloBaseDir &&
                        !folders.includes(yoloBaseDir)
                      const userFolders = settings.ragOptions.excludeYoloBaseDir
                        ? folders.filter((f) => f !== yoloBaseDir)
                        : folders
                      const patterns = folderPathsToIncludePatterns(userFolders)
                      applySettingsUpdate({
                        ragOptions: {
                          excludePatterns: patterns,
                          excludeYoloBaseDir: yoloRemoved
                            ? false
                            : settings.ragOptions.excludeYoloBaseDir,
                        },
                      })
                    }}
                  />
                </div>
              </div>

              {(includeFolders.length === 0 ||
                conflictInfo.exactConflicts.length > 0 ||
                conflictInfo.includeUnderExcluded.length > 0 ||
                conflictInfo.excludeWithinIncluded.length > 0) && (
                <div className="yolo-muted-note">
                  {includeFolders.length === 0 && (
                    <div>
                      {t(
                        'settings.rag.conflictNoteDefaultInclude',
                        '提示：当前未选择包含文件夹，默认包含全部。若设置了排除文件夹，则排除将优先生效。',
                      )}
                    </div>
                  )}
                  {conflictInfo.exactConflicts.length > 0 && (
                    <div>
                      {t(
                        'settings.rag.conflictExact',
                        '以下文件夹同时被包含与排除，最终将被排除：',
                      )}{' '}
                      {conflictInfo.exactConflicts
                        .map((f) => (f === '' ? '/' : f))
                        .join(', ')}
                    </div>
                  )}
                  {conflictInfo.includeUnderExcluded.length > 0 && (
                    <div>
                      {t(
                        'settings.rag.conflictParentExclude',
                        '以下包含的文件夹位于已排除的上级之下，最终将被排除：',
                      )}{' '}
                      {conflictInfo.includeUnderExcluded
                        .map((f) => (f === '' ? '/' : f))
                        .join(', ')}
                    </div>
                  )}
                  {conflictInfo.excludeWithinIncluded.length > 0 && (
                    <div>
                      {t(
                        'settings.rag.conflictChildExclude',
                        '以下排除的子文件夹位于包含文件夹之下（局部排除将生效）：',
                      )}{' '}
                      {conflictInfo.excludeWithinIncluded
                        .map((f) => (f === '' ? '/' : f))
                        .join(', ')}
                    </div>
                  )}
                  <div>
                    {t(
                      'settings.rag.conflictRule',
                      '当包含与排除重叠时，以排除为准。',
                    )}
                  </div>
                </div>
              )}
            </RAGCard>

            <RAGCard title={t('settings.rag.advanced', '高级设置')}>
              <div
                className={`yolo-settings-advanced-toggle yolo-clickable${
                  showAdvancedRagSettings ? ' is-expanded' : ''
                }`}
                onClick={() => setShowAdvancedRagSettings((prev) => !prev)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault()
                    setShowAdvancedRagSettings((prev) => !prev)
                  }
                }}
              >
                <span className="yolo-settings-advanced-toggle-icon">▶</span>
                {t('settings.rag.advanced', '高级设置')}
              </div>

              {showAdvancedRagSettings && (
                <>
                  <ObsidianSetting
                    name={t('settings.rag.chunkSize')}
                    desc={t('settings.rag.chunkSizeDesc')}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={chunkSizeInput}
                      placeholder="1000"
                      onChange={(value) => {
                        setChunkSizeInput(value)
                        const chunkSize = parseIntegerInput(value)
                        if (chunkSize !== null) {
                          applySettingsUpdate({
                            ragOptions: {
                              chunkSize,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const chunkSize = parseIntegerInput(chunkSizeInput)
                        if (chunkSize === null) {
                          setChunkSizeInput(
                            String(settings.ragOptions.chunkSize),
                          )
                        }
                      }}
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t('settings.rag.chunkOverlap', 'Chunk Overlap')}
                    desc={t(
                      'settings.rag.chunkOverlapDesc',
                      '相邻 chunk 之间重叠的字符数。默认 50。',
                    )}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={chunkOverlapInput}
                      placeholder="50"
                      onChange={(value) => {
                        setChunkOverlapInput(value)
                        const chunkOverlap = parseIntegerInput(value)
                        if (chunkOverlap !== null) {
                          applySettingsUpdate({
                            ragOptions: {
                              chunkOverlap,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const chunkOverlap =
                          parseIntegerInput(chunkOverlapInput)
                        if (chunkOverlap === null) {
                          setChunkOverlapInput(
                            String(settings.ragOptions.chunkOverlap ?? 50),
                          )
                        }
                      }}
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t('settings.rag.minSimilarity')}
                    desc={t('settings.rag.minSimilarityDesc')}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={minSimilarityInput}
                      placeholder="0.0"
                      onChange={(value) => {
                        setMinSimilarityInput(value)
                        const minSimilarity = parseFloatInput(value)
                        if (minSimilarity !== null) {
                          applySettingsUpdate({
                            ragOptions: {
                              minSimilarity,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const minSimilarity =
                          parseFloatInput(minSimilarityInput)
                        if (minSimilarity === null) {
                          setMinSimilarityInput(
                            String(settings.ragOptions.minSimilarity),
                          )
                        }
                      }}
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t('settings.rag.limit')}
                    desc={t('settings.rag.limitDesc')}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={limitInput}
                      placeholder="10"
                      onChange={(value) => {
                        setLimitInput(value)
                        const limit = parseIntegerInput(value)
                        if (limit !== null) {
                          applySettingsUpdate({
                            ragOptions: {
                              limit,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const limit = parseIntegerInput(limitInput)
                        if (limit === null) {
                          setLimitInput(String(settings.ragOptions.limit))
                        }
                      }}
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t('settings.rag.embeddingConcurrency')}
                    desc={t('settings.rag.embeddingConcurrencyDesc')}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={embeddingConcurrencyInput}
                      placeholder="10"
                      onChange={(value) => {
                        setEmbeddingConcurrencyInput(value)
                        const parsed = parseIntegerInput(value)
                        if (parsed !== null) {
                          const clamped = Math.max(1, Math.min(24, parsed))
                          applySettingsUpdate({
                            ragOptions: {
                              embeddingConcurrency: clamped,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const parsed = parseIntegerInput(
                          embeddingConcurrencyInput,
                        )
                        if (parsed === null) {
                          setEmbeddingConcurrencyInput(
                            String(
                              settings.ragOptions.embeddingConcurrency ?? 10,
                            ),
                          )
                          return
                        }
                        const clamped = Math.max(1, Math.min(24, parsed))
                        if (clamped !== parsed) {
                          setEmbeddingConcurrencyInput(String(clamped))
                        }
                      }}
                    />
                  </ObsidianSetting>

                  <ObsidianSetting
                    name={t(
                      'settings.rag.autoUpdateInterval',
                      '最小间隔(小时)',
                    )}
                    desc={t(
                      'settings.rag.autoUpdateIntervalDesc',
                      '到达该间隔才会触发自动更新；用于避免频繁重建。',
                    )}
                    className="yolo-settings-card"
                  >
                    <ObsidianTextInput
                      value={autoUpdateIntervalInput}
                      placeholder="24"
                      onChange={(value) => {
                        setAutoUpdateIntervalInput(value)
                        const intervalHours = parseIntegerInput(value)
                        if (intervalHours !== null && intervalHours >= 0) {
                          applySettingsUpdate({
                            ragOptions: {
                              autoUpdateIntervalHours: intervalHours,
                            },
                          })
                        }
                      }}
                      onBlur={() => {
                        const intervalHours = parseIntegerInput(
                          autoUpdateIntervalInput,
                        )
                        if (intervalHours === null || intervalHours < 0) {
                          setAutoUpdateIntervalInput(
                            String(
                              settings.ragOptions.autoUpdateIntervalHours ?? 0,
                            ),
                          )
                        }
                      }}
                    />
                  </ObsidianSetting>
                </>
              )}
            </RAGCard>
          </>
        )}
      </div>
    </div>
  )
}
