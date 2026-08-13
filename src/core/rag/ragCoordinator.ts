import { App } from 'obsidian'

import { DatabaseManager } from '../../database/DatabaseManager'
import { YoloSettings } from '../../settings/schema/setting.types'

import { RAGEngine } from './ragEngine'

type RagCoordinatorDeps = {
  app: App
  getSettings: () => YoloSettings
  getDbManager: () => Promise<DatabaseManager>
  t: (key: string, fallback?: string) => string
}

export class RagCoordinator {
  private readonly app: App
  private readonly getSettings: () => YoloSettings
  private readonly getDbManager: () => Promise<DatabaseManager>
  private readonly t: (key: string, fallback?: string) => string

  private ragEngine: RAGEngine | null = null
  private ragEngineInitPromise: Promise<RAGEngine> | null = null
  private closed = false

  constructor(deps: RagCoordinatorDeps) {
    this.app = deps.app
    this.getSettings = deps.getSettings
    this.getDbManager = deps.getDbManager
    this.t = deps.t
  }

  async getRagEngine(): Promise<RAGEngine> {
    if (this.closed) {
      throw new Error('RAG coordinator is stopped')
    }
    if (this.ragEngine) {
      return this.ragEngine
    }

    if (!this.ragEngineInitPromise) {
      this.ragEngineInitPromise = (async () => {
        try {
          const dbManager = await this.getDbManager()
          this.ragEngine = new RAGEngine(
            this.app,
            this.getSettings(),
            dbManager.getVectorManager(),
            this.t,
            dbManager.getRetrievalTraceStore(),
          )
          return this.ragEngine
        } catch (error) {
          this.ragEngineInitPromise = null
          throw error
        }
      })()
    }

    return this.ragEngineInitPromise
  }

  updateSettings(settings: YoloSettings) {
    this.ragEngine?.setSettings(settings)
  }

  cleanup() {
    this.closed = true
    this.ragEngine?.cleanup()
    this.ragEngine = null
    this.ragEngineInitPromise = null
  }
}
