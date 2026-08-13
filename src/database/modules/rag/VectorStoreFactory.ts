import { Platform } from 'obsidian'

import { openShardSqliteWasm } from '../vector/backend/sharded/shardedSqlite'
import {
  type ShardedVaultApp,
  ShardedVectorStore,
} from '../vector/backend/sharded/ShardedVectorStore'

// Type-only on purpose: SqliteVectorStore statically imports node:crypto/fs/
// path, so evaluating the module (even just to load the factory) throws on
// mobile before the Platform.isDesktop dispatch runs. The value is loaded
// lazily via the dynamic import in createVectorStore's desktop branch; this
// type-only import keeps the type-level dependency in the graph.
import type { SqliteVectorStore } from './SqliteVectorStore'
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
  /** Vault surface for the sharded backend (mobile); desktop ignores it. */
  app: ShardedVaultApp
}

export async function createVectorStore(
  options: CreateVectorStoreOptions,
): Promise<VectorStore> {
  if (Platform.isDesktop) {
    // Desktop: native node:sqlite backend, unchanged. Loaded lazily so the
    // mobile bundle never evaluates SqliteVectorStore's node:* imports.
    // Ignores `app`.
    const { SqliteVectorStore: DesktopVectorStore } = await import(
      './SqliteVectorStore'
    )
    const desktopStore: SqliteVectorStore = new DesktopVectorStore({
      baseDir: options.baseDir,
    })
    return desktopStore
  }
  // Mobile: vault-resident sharded backend over the sqlite-engine component
  // (sql.js); shard chunks.sqlite files open through the wasm opener.
  return new ShardedVectorStore({
    baseDir: options.baseDir,
    app: options.app,
    openShardSqlite: openShardSqliteWasm,
  })
}
