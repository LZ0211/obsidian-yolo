import { vectorNamespaceId } from '../../../rag/namespaceId'
import {
  type StoredVectorFile,
  type VectorBackendStats,
  type VectorBackendStatus,
  type VectorFileReadiness,
  type VectorFileWrite,
  type VectorNamespace,
  type VectorSearchOptions,
  type VectorSearchResult,
  type VectorStore,
  VectorStoreError,
} from '../../../rag/VectorStore'

import {
  getShardedIndexRoot,
  getShardedManifestPath,
  getShardedModelRoot,
} from './shardedPaths'
import { type ShardSqliteOpener, openShardSqliteNode } from './shardedSqlite'

/**
 * Minimal vault-adapter surface the sharded backend needs. Deliberately
 * structural (not the Obsidian `DataAdapter` type) so the store stays
 * testable with an in-memory double; the real `app.vault.adapter` satisfies
 * it. Mirrors the host-agnostic shape of `SqliteEngineVaultAdapter` in
 * `src/core/runtime-components/contracts.ts`.
 */
export type ShardedVaultAdapter = {
  exists(path: string): Promise<boolean>
  read(path: string): Promise<string>
  readBinary(path: string): Promise<ArrayBuffer>
  write(path: string, data: string): Promise<void>
  writeBinary(path: string, data: ArrayBuffer): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
  remove(path: string, options?: { recursive?: boolean }): Promise<void>
  list(path: string): Promise<{ files: string[]; folders: string[] }>
}

export type ShardedVaultApp = {
  vault: { adapter: ShardedVaultAdapter }
}

export type ShardedVectorStoreOptions = {
  baseDir: string
  app: ShardedVaultApp
  openShardSqlite?: ShardSqliteOpener
}

/**
 * Vault-resident sharded vector backend (mobile 分页存储模式). Layout mirrors
 * upstream `feat/sharded-vector-backend`: `<baseDir>/rag-index/v1/manifest.json`
 * plus `models/<ns>/shards/<shardId>/`. Task 1 ships the skeleton (open/close/
 * listNamespaces/dropNamespace/getStatus); write/search/delete/vacuum land in
 * Tasks 2-5 and currently throw.
 */
export class ShardedVectorStore implements VectorStore {
  private readonly baseDir: string
  private readonly app: ShardedVaultApp
  private readonly openShardSqlite: ShardSqliteOpener
  private isOpen = false
  private isClosing = false

  constructor(options: ShardedVectorStoreOptions) {
    this.baseDir = options.baseDir
    this.app = options.app
    this.openShardSqlite = options.openShardSqlite ?? openShardSqliteNode
  }

  private get adapter(): ShardedVaultAdapter {
    return this.app.vault.adapter
  }

  async open(): Promise<void> {
    if (this.isOpen || this.isClosing) return
    this.isClosing = false
    this.isOpen = true
  }

  async close(): Promise<void> {
    this.isClosing = true
    if (!this.isOpen) {
      this.isClosing = false
      return
    }
    this.isOpen = false
    this.isClosing = false
  }

  async listNamespaces(): Promise<string[]> {
    this.assertOpen()
    this.assertNotClosing()
    const modelsRoot = `${getShardedIndexRoot(this.baseDir)}/models`
    if (!(await this.adapter.exists(modelsRoot))) return []
    const listing = await this.adapter.list(modelsRoot)
    return listing.folders.filter((name) => name.length > 0).sort()
  }

  async dropNamespace(namespace: VectorNamespace): Promise<void> {
    await this.dropNamespaceById(vectorNamespaceId(namespace))
  }

  async dropNamespaceById(namespaceId: string): Promise<void> {
    this.assertOpen()
    this.assertNotClosing()
    validateShardedNamespaceId(namespaceId)
    const modelRoot = getShardedModelRoot(this.baseDir, namespaceId)
    if (!(await this.adapter.exists(modelRoot))) return
    await this.adapter.remove(modelRoot, { recursive: true })
  }

  async getStatus(namespace?: VectorNamespace): Promise<VectorBackendStatus> {
    this.assertOpen()
    this.assertNotClosing()
    const storagePath =
      namespace == null
        ? getShardedIndexRoot(this.baseDir)
        : getShardedManifestPath(this.baseDir)
    const manifestExists = await this.adapter.exists(
      getShardedManifestPath(this.baseDir),
    )
    if (!manifestExists) {
      return {
        backend: 'sqlite',
        readiness: 'ready',
        rebuildRequired: true,
        storagePath,
        executionMode: 'plugin-host',
        persistenceMode: 'native-sqlite-file',
        recoveryAction: 'rebuild_index',
      }
    }
    return {
      backend: 'sqlite',
      readiness: 'ready',
      rebuildRequired: false,
      storagePath,
      executionMode: 'plugin-host',
      persistenceMode: 'native-sqlite-file',
      recoveryAction: 'none',
    }
  }

  async replaceFile(
    _namespace: VectorNamespace,
    _file: VectorFileWrite,
  ): Promise<void> {
    throw new Error('not implemented yet')
  }

  async replaceFiles(
    _namespace: VectorNamespace,
    _files: VectorFileWrite[],
  ): Promise<void> {
    throw new Error('not implemented yet')
  }

  async deleteFile(_namespace: VectorNamespace, _path: string): Promise<void> {
    throw new Error('not implemented yet')
  }

  async deleteFiles(
    _namespace: VectorNamespace,
    _paths: string[],
  ): Promise<void> {
    throw new Error('not implemented yet')
  }

  async clearNamespace(_namespace: VectorNamespace): Promise<void> {
    throw new Error('not implemented yet')
  }

  async save(_namespace?: VectorNamespace): Promise<void> {
    throw new Error('not implemented yet')
  }

  async vacuum(_namespace?: VectorNamespace): Promise<void> {
    throw new Error('not implemented yet')
  }

  async getStatusByNamespaceId(
    _namespaceId: string,
  ): Promise<VectorBackendStatus> {
    throw new Error('not implemented yet')
  }

  async search(
    _namespace: VectorNamespace,
    _embedding: number[],
    _options: VectorSearchOptions,
  ): Promise<VectorSearchResult> {
    throw new Error('not implemented yet')
  }

  async searchDetailed(
    _namespace: VectorNamespace,
    _embedding: number[],
    _options: VectorSearchOptions,
  ): Promise<VectorSearchResult> {
    throw new Error('not implemented yet')
  }

  async getStoredFileVectors(
    _namespace: VectorNamespace,
    _paths: readonly string[],
  ): Promise<Map<string, StoredVectorFile>> {
    throw new Error('not implemented yet')
  }

  async getIndexedFiles(
    _namespace: VectorNamespace,
  ): Promise<
    Map<string, { mtime: number; contentHash?: string; updatedAt?: number }>
  > {
    throw new Error('not implemented yet')
  }

  async getFileReadiness(
    _namespace: VectorNamespace,
    _paths: string[],
  ): Promise<Map<string, VectorFileReadiness>> {
    throw new Error('not implemented yet')
  }

  async getQueryEmbedding(
    _namespace: VectorNamespace,
    _queryHash: string,
  ): Promise<number[] | null> {
    throw new Error('not implemented yet')
  }

  async putQueryEmbedding(
    _namespace: VectorNamespace,
    _queryHash: string,
    _embedding: number[],
  ): Promise<void> {
    throw new Error('not implemented yet')
  }

  async getStats(_namespace?: VectorNamespace): Promise<VectorBackendStats> {
    throw new Error('not implemented yet')
  }

  async purgeNamespacesByPrefixForPrivacy(_input: {
    namespaceIdPrefix: string
    confirmation: string
  }): Promise<readonly string[]> {
    throw new Error('not implemented yet')
  }

  private assertOpen(): void {
    if (!this.isOpen) {
      throw new VectorStoreError('not_open', 'sqlite', 'open_backend')
    }
  }

  private assertNotClosing(): void {
    if (this.isClosing) {
      throw new VectorStoreError('closing', 'sqlite', 'retry_close')
    }
  }
}

/**
 * Guards a namespace id before it is interpolated into a model-root path.
 * Pure string checks (no `node:path`) so the module stays free of static
 * `node:*` imports for mobile bundling.
 */
function validateShardedNamespaceId(namespaceId: string): string {
  if (
    typeof namespaceId !== 'string' ||
    namespaceId.length === 0 ||
    namespaceId === '.' ||
    namespaceId === '..' ||
    namespaceId.includes('/') ||
    namespaceId.includes('\\') ||
    namespaceId.includes('\0')
  ) {
    throw new VectorStoreError(
      'malformed_query',
      'sqlite',
      'none',
      `Unsafe namespace ID: ${namespaceId}`,
    )
  }
  return namespaceId
}
