import { Platform } from 'obsidian'

import {
  type ShardedVaultApp,
  ShardedVectorStore,
} from '../vector/backend/sharded/ShardedVectorStore'
import { openShardSqliteWasm } from '../vector/backend/sharded/shardedSqlite'
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
  /** Vault surface for the sharded backend (mobile); desktop ignores it. */
  app: ShardedVaultApp
}

export function createVectorStore(
  options: CreateVectorStoreOptions,
): VectorStore {
  if (Platform.isDesktop) {
    // Desktop: native node:sqlite backend, unchanged. Ignores `app`.
    return new SqliteVectorStore({
      baseDir: options.baseDir,
    })
  }
  // Mobile: vault-resident sharded backend over the sqlite-engine component
  // (sql.js); shard chunks.sqlite files open through the wasm opener.
  return new ShardedVectorStore({
    baseDir: options.baseDir,
    app: options.app,
    openShardSqlite: openShardSqliteWasm,
  })
}
