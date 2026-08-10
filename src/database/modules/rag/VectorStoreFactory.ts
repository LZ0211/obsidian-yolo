import { SqliteVectorStore } from './SqliteVectorStore'
import { type VectorStore } from './VectorStore'

type VectorBackendSettingsLike = {
  productionBackend?: 'sqlite'
  rebuildRequired?: boolean
}

type VectorStoreFactorySettingsLike = {
  ragBackend?: 'sqlite'
  ragBackendSettings?: VectorBackendSettingsLike
  yolo?: {
    baseDir?: string
  }
}

type CreateVectorStoreOptions = {
  baseDir: string
  pluginDir: string
  settings: VectorStoreFactorySettingsLike
  expectedTargetRuntime?: string
}

export function createVectorStore(
  options: CreateVectorStoreOptions,
): VectorStore {
  return new SqliteVectorStore({
    baseDir: options.baseDir,
  })
}
