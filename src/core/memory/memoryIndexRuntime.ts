import type { App, EventRef, TAbstractFile, Vault } from 'obsidian'

import { getEmbeddingModelClient } from '../rag/embedding'

import {
  type MemoryIndexMaintenanceStore,
  type MemoryIndexStore,
  buildMemoryPartition,
  createUnavailableMemoryIndexStore,
  openMemoryIndexStore,
} from './memoryIndex'
import { MemoryIndexMaintenanceQueue } from './memoryIndexMaintenanceQueue'
import {
  type MemorySettingsLike,
  loadMemorySourceSnapshot,
  loadMemorySourceSnapshotAtPath,
  resolveMemoryFilePaths,
  resolveMemoryPartitionByPath,
} from './memoryManager'
import type { MemoryPartition, MemorySector } from './memoryTypes'

type MemoryIndexSettings = MemorySettingsLike & {
  advancedMemoryIndexEnabled?: boolean
  memoryReflectionEnabled?: boolean
  /** RAG embedding model id; reconciles write memory_embeddings with it. */
  embeddingModelId?: string
}

export type MemoryIndexRuntimeHandle = {
  getStore(): Promise<MemoryIndexStore>
  onSourceCommitted(input: {
    partition: MemoryPartition
    sourcePath: string
    sectorHints?: Readonly<Record<string, MemorySector | null>>
  }): void
  onAssistantRemoved?(assistantId: string): void
  setReflectionModelRunner?(
    runner: (prompt: string, signal: AbortSignal) => Promise<string>,
  ): void
}

type VaultWithOptionalEvents = Vault & {
  on?: Vault['on']
  offref?: (eventRef: EventRef) => void
}

export type MemoryRenameResolution = Readonly<{
  reconcilePartition: MemoryPartition | null
  cleanupPartition: MemoryPartition | null
}>

const getOptionalVault = (app: App): VaultWithOptionalEvents | undefined =>
  (app as Partial<App>).vault as VaultWithOptionalEvents | undefined

export type MemorySettingsReconcilePlan = {
  removedAssistantIds: readonly string[]
  reconciles: ReadonlyArray<{
    partition: MemoryPartition
    sourcePath: string
  }>
}

/**
 * What a settings change means for the memory index (backup main.ts
 * settings-listener behavior, extracted so main.ts wiring is a thin shell):
 * - assistants that disappeared must have their partitions dropped;
 * - while the advanced index is enabled, every memory partition (global plus
 *   each assistant) is re-reconciled so renames/duplicate-index shifts are
 *   picked up;
 * - disabling the advanced index yields no reconciles (main.ts then closes
 *   the runtime).
 */
export const planMemorySettingsReconcile = ({
  previousAssistantIds,
  settings,
}: {
  previousAssistantIds: readonly string[]
  settings: MemorySettingsLike
}): MemorySettingsReconcilePlan => {
  const removedAssistantIds = previousAssistantIds.filter(
    (assistantId) =>
      !settings.assistants?.some((assistant) => assistant.id === assistantId),
  )
  if (!settings.advancedMemoryIndexEnabled) {
    return { removedAssistantIds, reconciles: [] }
  }
  const paths = new Set<string>()
  for (const assistantId of [
    undefined,
    ...(settings.assistants?.map((assistant) => assistant.id) ?? []),
  ]) {
    const memoryPaths = resolveMemoryFilePaths({ settings, assistantId })
    paths.add(memoryPaths.global)
    if (memoryPaths.assistant) paths.add(memoryPaths.assistant)
  }
  const reconciles = [...paths].flatMap((sourcePath) => {
    const partition = resolveMemoryPartitionByPath({
      settings,
      path: sourcePath,
    })
    return partition ? [{ partition, sourcePath }] : []
  })
  return { removedAssistantIds, reconciles }
}

export const resolveMemoryRename = ({
  settings,
  newPath,
  oldPath,
  indexedPartition,
}: {
  settings: MemorySettingsLike | undefined
  newPath: string
  oldPath: string
  indexedPartition: MemoryPartition | null
}): MemoryRenameResolution => {
  const reconcilePartition = resolveMemoryPartitionByPath({
    settings,
    path: newPath,
  })
  if (reconcilePartition) {
    return {
      reconcilePartition,
      cleanupPartition:
        indexedPartition &&
        indexedPartition.partitionKey !== reconcilePartition.partitionKey
          ? indexedPartition
          : null,
    }
  }
  return {
    reconcilePartition: null,
    cleanupPartition:
      indexedPartition ??
      resolveMemoryPartitionByPath({ settings, path: oldPath }),
  }
}

export class MemoryIndexRuntime {
  private storePromise: Promise<MemoryIndexMaintenanceStore> | null = null
  private queue: MemoryIndexMaintenanceQueue | null = null
  private readonly eventRefs: EventRef[] = []
  private readonly debounceTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >()
  private readonly sourcePathOverrides = new Map<string, string>()
  private readonly renameCleanups = new Map<string, MemoryPartition>()
  private closed = false
  private settingsGetter: () => MemoryIndexSettings | undefined
  private reflectionModelRunner:
    | ((prompt: string, signal: AbortSignal) => Promise<string>)
    | null = null

  constructor(
    private readonly app: App,
    getSettings: () => MemoryIndexSettings | undefined,
  ) {
    this.settingsGetter = getSettings
    this.registerVaultListeners()
  }

  updateSettingsGetter(
    getSettings: () => MemoryIndexSettings | undefined,
  ): void {
    this.settingsGetter = getSettings
    this.sourcePathOverrides.clear()
  }

  setReflectionModelRunner(
    runner: (prompt: string, signal: AbortSignal) => Promise<string>,
  ): void {
    this.reflectionModelRunner = runner
  }

  async getStore(): Promise<MemoryIndexMaintenanceStore> {
    if (
      this.closed ||
      this.settingsGetter()?.advancedMemoryIndexEnabled !== true
    ) {
      await this.closeStoreAndQueue()
      return createUnavailableMemoryIndexStore()
    }
    if (!this.storePromise) {
      this.storePromise = openMemoryIndexStore({
        app: this.app,
        getSettings: () => this.settingsGetter(),
        getSourceSnapshot: (partition) => this.getSourceSnapshot(partition),
        embedContent: (content) => this.embedContent(content),
      })
    }
    const pendingStore = this.storePromise
    const store = await pendingStore
    if (
      this.closed ||
      this.settingsGetter()?.advancedMemoryIndexEnabled !== true
    ) {
      return createUnavailableMemoryIndexStore()
    }
    return store
  }

  onSourceCommitted(input: {
    partition: MemoryPartition
    sourcePath: string
    sectorHints?: Readonly<Record<string, MemorySector | null>>
  }): void {
    if (
      this.closed ||
      this.settingsGetter()?.advancedMemoryIndexEnabled !== true
    )
      return
    void this.enqueueReconcile(input)
  }

  onAssistantRemoved(assistantId: string): void {
    if (
      this.closed ||
      this.settingsGetter()?.advancedMemoryIndexEnabled !== true
    )
      return
    const partition = buildMemoryPartition({
      scope: 'assistant',
      assistantId,
    })
    this.sourcePathOverrides.delete(partition.partitionKey)
    this.renameCleanups.delete(partition.partitionKey)
    this.queue?.cancelPartition(partition.partitionKey)
    void this.deletePartition(partition)
  }

  private async deletePartition(partition: MemoryPartition): Promise<void> {
    const store = await this.getStore()
    if (store.capability !== 'sqlite' || this.closed) return
    await store.deletePartition(partition)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const timer of this.debounceTimers.values()) clearTimeout(timer)
    this.debounceTimers.clear()
    const vault = getOptionalVault(this.app)
    for (const eventRef of this.eventRefs) vault?.offref?.(eventRef)
    this.eventRefs.length = 0
    await this.closeStoreAndQueue()
  }

  private async enqueueReconcile(input: {
    partition: MemoryPartition
    sourcePath: string
    sectorHints?: Readonly<Record<string, MemorySector | null>>
  }): Promise<void> {
    this.sourcePathOverrides.set(input.partition.partitionKey, input.sourcePath)
    const store = await this.getStore()
    if (store.capability !== 'sqlite' || this.closed) return
    if (!this.queue) {
      this.queue = new MemoryIndexMaintenanceQueue({
        store,
        getSourceSnapshot: (partition) => this.getSourceSnapshot(partition),
        isReflectionEnabled: () =>
          this.settingsGetter()?.memoryReflectionEnabled === true &&
          this.reflectionModelRunner !== null,
        runReflectionModel: (prompt, signal) => {
          const runner = this.reflectionModelRunner
          return runner
            ? runner(prompt, signal)
            : Promise.reject(new Error('Memory reflection model unavailable'))
        },
        onReconciled: async ({ partition }) => {
          const cleanupPartition = this.renameCleanups.get(
            partition.partitionKey,
          )
          if (!cleanupPartition) return
          this.renameCleanups.delete(partition.partitionKey)
          if (cleanupPartition.partitionKey !== partition.partitionKey) {
            await store.deletePartition(cleanupPartition)
          }
        },
      })
    }
    this.queue.enqueueReconcile(input)
  }

  /**
   * Embed one memory entry with the vault's configured RAG embedding model.
   * Resolves the model per call so settings changes apply without restart.
   * Returns null when no model is configured or the call fails — the vector
   * path then stays empty (lexical/graph recall continue to work).
   */
  private async embedContent(content: string): Promise<number[] | null> {
    const settings = this.settingsGetter()
    const embeddingModelId = settings?.embeddingModelId?.trim()
    if (!embeddingModelId) return null
    try {
      const client = getEmbeddingModelClient({
        settings: settings as never,
        embeddingModelId,
      })
      return await client.getEmbedding(content)
    } catch (error) {
      console.warn(
        '[YOLO][Memory] embedding unavailable during reconcile',
        error,
      )
      return null
    }
  }

  private async getSourceSnapshot(
    partition: MemoryPartition,
  ): Promise<Awaited<ReturnType<typeof loadMemorySourceSnapshot>>> {
    const sourcePath = this.sourcePathOverrides.get(partition.partitionKey)
    if (sourcePath) {
      return await loadMemorySourceSnapshotAtPath({
        app: this.app,
        partition,
        sourcePath,
      })
    }
    return await loadMemorySourceSnapshot({
      app: this.app,
      settings: this.settingsGetter(),
      scope: partition.scope,
      assistantId: partition.assistantId ?? undefined,
    })
  }

  private async closeStoreAndQueue(): Promise<void> {
    const queue = this.queue
    this.queue = null
    const queueTimedOut = await queue?.shutdown()
    const store = await this.storePromise
    this.storePromise = null
    if (
      queueTimedOut &&
      store &&
      'forceClose' in store &&
      typeof store.forceClose === 'function'
    ) {
      store.forceClose()
      return
    }
    if (store && 'close' in store && typeof store.close === 'function') {
      await store.close()
    }
  }

  private registerVaultListeners(): void {
    const vault = getOptionalVault(this.app)
    if (!vault || typeof vault.on !== 'function') return
    const register = (eventRef: EventRef): void => {
      this.eventRefs.push(eventRef)
    }
    register(vault.on('create', (file) => this.schedulePath(file.path)))
    register(vault.on('modify', (file) => this.schedulePath(file.path)))
    register(vault.on('delete', (file) => this.schedulePath(file.path)))
    register(
      vault.on('rename', (file, oldPath) => this.scheduleRename(file, oldPath)),
    )
  }

  private schedulePath(path: string): void {
    const partition = resolveMemoryPartitionByPath({
      settings: this.settingsGetter(),
      path,
    })
    if (!partition) return
    this.debounce(`path:${partition.partitionKey}`, () => {
      this.onSourceCommitted({ partition, sourcePath: path })
    })
  }

  private scheduleRename(file: TAbstractFile, oldPath: string): void {
    this.debounce(`rename:${oldPath}`, () => {
      void this.handleRename(file.path, oldPath)
    })
  }

  private async handleRename(path: string, oldPath: string): Promise<void> {
    const store = await this.getStore()
    const indexedPartition = await store.findPartitionBySourcePath(oldPath)
    const resolution = resolveMemoryRename({
      settings: this.settingsGetter(),
      newPath: path,
      oldPath,
      indexedPartition,
    })
    if (!resolution.reconcilePartition) {
      if (resolution.cleanupPartition) {
        this.sourcePathOverrides.delete(
          resolution.cleanupPartition.partitionKey,
        )
        await store.deletePartition(resolution.cleanupPartition)
      }
      return
    }
    if (resolution.cleanupPartition) {
      this.renameCleanups.set(
        resolution.reconcilePartition.partitionKey,
        resolution.cleanupPartition,
      )
    }
    this.onSourceCommitted({
      partition: resolution.reconcilePartition,
      sourcePath: path,
    })
  }

  private debounce(key: string, callback: () => void): void {
    const previous = this.debounceTimers.get(key)
    if (previous) clearTimeout(previous)
    const timer = setTimeout(() => {
      this.debounceTimers.delete(key)
      callback()
    }, 100)
    this.debounceTimers.set(key, timer)
  }
}

const runtimes = new WeakMap<App, MemoryIndexRuntime>()

export function getMemoryIndexRuntime(
  app: App,
  getSettings: () => MemoryIndexSettings | undefined,
): MemoryIndexRuntime {
  const existing = runtimes.get(app)
  if (existing) {
    return existing
  }
  const runtime = new MemoryIndexRuntime(app, getSettings)
  runtimes.set(app, runtime)
  return runtime
}

export function getMemoryIndexRuntimeHandle(
  app: App,
  getSettings: () => MemoryIndexSettings | undefined,
): MemoryIndexRuntimeHandle {
  const runtime = getMemoryIndexRuntime(app, getSettings)
  return {
    getStore: () => runtime.getStore(),
    onSourceCommitted: (input) => runtime.onSourceCommitted(input),
    onAssistantRemoved: (assistantId) =>
      runtime.onAssistantRemoved(assistantId),
    setReflectionModelRunner: (runner) =>
      runtime.setReflectionModelRunner(runner),
  }
}

export async function getMemoryIndexStore(
  app: App,
  getSettings: () => MemoryIndexSettings | undefined,
): Promise<MemoryIndexStore> {
  return await getMemoryIndexRuntime(app, getSettings).getStore()
}

export async function closeMemoryIndexRuntime(app: App): Promise<void> {
  const runtime = runtimes.get(app)
  if (!runtime) return
  await runtime.close()
  if (runtimes.get(app) === runtime) {
    runtimes.delete(app)
  }
}
