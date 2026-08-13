import { App, FileSystemAdapter, normalizePath } from 'obsidian'

import { getYoloBaseDir } from '../core/paths/yoloPaths'

import type { RetrievalTraceStore } from './modules/rag/retrievalTraceStore'
import type { VectorStore } from './modules/rag/VectorStore'
import { createVectorStore } from './modules/rag/VectorStoreFactory'
import { VectorManager } from './modules/vector/VectorManager'

type VectorManagerSettings = {
  embeddingModels?: Array<{
    providerId: string
    id: string
    model: string
    dimension: number
    name?: string
    nativeDimension?: number
  }>
  ragBackendSettings?: {
    rebuildRequired?: boolean
  }
}

export class DatabaseManager {
  private app: App
  private vectorStore: VectorStore | null = null
  private retrievalTraceStore: RetrievalTraceStore | null = null
  private static managers = new WeakMap<
    DatabaseManager,
    { vectorManager?: VectorManager }
  >()

  constructor(app: App) {
    this.app = app
  }

  static async create(
    app: App,
    settings?: {
      yolo?: {
        baseDir?: string
      }
    } | null,
    pluginDir?: string,
  ): Promise<DatabaseManager> {
    const dbManager = new DatabaseManager(app)
    const normalizedPluginDir =
      pluginDir && pluginDir.trim().length > 0
        ? normalizePath(pluginDir)
        : undefined
    const adapter = app.vault.adapter
    const vaultBasePath =
      adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null

    // Desktop: absolute base dir under the vault root (byte-identical to the
    // pre-Task-7 behavior). Mobile: vault-relative — the sharded backend's
    // file layout lives inside the vault and its sql.js opener maps shard
    // paths through vault-relative paths (memoryIndex.ts pattern); without a
    // FileSystemAdapter there is no absolute vault path to derive.
    const baseDir = vaultBasePath
      ? normalizePath(`${vaultBasePath}/${getYoloBaseDir(settings)}`)
      : getYoloBaseDir(settings)

    // The node:sqlite RetrievalTraceStore needs an absolute filesystem path
    // and statically imports node:* — mobile must neither construct it (it
    // would throw) nor evaluate the module (mobile bundle). Loaded lazily in
    // the desktop-only branch, mirroring VectorStoreFactory's desktop store.
    if (vaultBasePath) {
      const { RetrievalTraceStore: DesktopRetrievalTraceStore } = await import(
        './modules/rag/retrievalTraceStore'
      )
      dbManager.retrievalTraceStore = new DesktopRetrievalTraceStore({
        baseDir,
      })
      await dbManager.retrievalTraceStore.open()
    }

    if (normalizedPluginDir && baseDir) {
      dbManager.vectorStore = await createVectorStore({
        baseDir,
        pluginDir: normalizedPluginDir,
        settings: settings ?? {},
        app,
      })
      await dbManager.vectorStore.open()
    }

    DatabaseManager.managers.set(dbManager, {
      vectorManager: new VectorManager(app, {
        vectorStore: dbManager.vectorStore,
        settings: DatabaseManager.toVectorManagerSettings(settings),
      }),
    })

    console.debug('YOLO database initialized.', dbManager)
    return dbManager
  }

  async save(): Promise<void> {
    await this.vectorStore?.save?.()
  }

  async quiesceAndCleanup(): Promise<void> {
    await this.vectorStore?.close?.()
    this.vectorStore = null
    await this.retrievalTraceStore?.close?.()
    this.retrievalTraceStore = null
  }

  getVectorManager(): VectorManager {
    const managers = DatabaseManager.managers.get(this) ?? {}
    if (!managers.vectorManager) {
      managers.vectorManager = new VectorManager(this.app, {
        vectorStore: this.vectorStore,
      })
      DatabaseManager.managers.set(this, managers)
    }
    return managers.vectorManager
  }

  getVectorStore(): VectorStore | null {
    return this.vectorStore
  }

  getRetrievalTraceStore(): RetrievalTraceStore | null {
    return this.retrievalTraceStore
  }

  async cleanup() {
    try {
      await this.vectorStore?.close()
    } catch (error) {
      console.warn(
        '[YOLO] Failed to close sqlite VectorStore during cleanup.',
        error,
      )
    }
    try {
      await this.retrievalTraceStore?.close()
    } catch (error) {
      console.warn(
        '[YOLO] Failed to close RetrievalTraceStore during cleanup.',
        error,
      )
    }
    this.vectorStore = null
    this.retrievalTraceStore = null
    DatabaseManager.managers.delete(this)
  }

  private static toVectorManagerSettings(
    settings?:
      | {
          embeddingModels?: VectorManagerSettings extends {
            embeddingModels?: infer T
          }
            ? T
            : never
          ragBackendSettings?: VectorManagerSettings extends {
            ragBackendSettings?: infer T
          }
            ? T
            : never
        }
      | {
          yolo?: {
            baseDir?: string
          }
        }
      | null,
  ): VectorManagerSettings | null {
    if (
      settings &&
      ('embeddingModels' in settings || 'ragBackendSettings' in settings)
    ) {
      return {
        embeddingModels: settings.embeddingModels,
        ragBackendSettings: settings.ragBackendSettings,
      }
    }
    return null
  }
}
