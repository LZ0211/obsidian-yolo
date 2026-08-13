import { FileSystemAdapter } from 'obsidian'

import { acquireRuntimeComponent } from '../../../../../core/runtime-components/runtimeComponentAccess'
import { VectorStoreError } from '../../../rag/VectorStore'

import {
  type SqliteNativeRuntimeFacade,
  openSqliteRuntime,
} from '../../../../sqlite/sqliteNativeRuntime'

/**
 * Minimal vault surface the wasm opener needs: the vault adapter for sql.js
 * file IO, plus (on desktop) `FileSystemAdapter` to recover the vault root so
 * an absolute `dbPath` can be relativized. Structurally satisfied by the real
 * Obsidian `App` and by `ShardedVectorStore`'s `ShardedVaultApp`. Kept local
 * (instead of importing `ShardedVaultApp`) so `shardedSqlite.ts` stays the
 * opener-contract owner with no import back into `ShardedVectorStore.ts`.
 */
export type ShardSqliteOpenerApp = {
  vault: {
    adapter: {
      exists(path: string): Promise<boolean>
      readBinary(path: string): Promise<ArrayBuffer>
      writeBinary(path: string, data: ArrayBuffer): Promise<void>
      rename(oldPath: string, newPath: string): Promise<void>
    }
  }
}

export type ShardSqliteOpenerContext = {
  app: ShardSqliteOpenerApp
}

/**
 * Opens a shard's `chunks.sqlite`. Async: the mobile (`sqlite-engine`
 * component) path must acquire the runtime component and load sql.js before
 * the facade exists; the desktop node:sqlite path resolves immediately.
 *
 * `context` is optional because the desktop opener never needs it (direct
 * calls in tests pass only `dbPath`); `openShardSqliteWasm` requires it and
 * the sharded store always supplies it.
 */
export type ShardSqliteOpener = (
  dbPath: string,
  context?: ShardSqliteOpenerContext,
) => Promise<SqliteNativeRuntimeFacade>

export async function openShardSqliteNode(
  dbPath: string,
  _context?: ShardSqliteOpenerContext,
): Promise<SqliteNativeRuntimeFacade> {
  return openSqliteRuntime({ dbPath })
}

const toVaultRelativePath = (
  dbPath: string,
  adapter: ShardSqliteOpenerApp['vault']['adapter'],
): string => {
  const basePath =
    adapter instanceof FileSystemAdapter ? adapter.getBasePath() : null
  return basePath && dbPath.startsWith(basePath)
    ? dbPath.slice(basePath.length).replace(/^[\\/]+/, '')
    : dbPath
}

/**
 * 移动端：sqlite-engine 组件的 sql.js；dbPath 映射为 vault 相对路径。
 *
 * Follows the memoryIndex.ts pattern: `acquireRuntimeComponent('sqlite-engine')`
 * → `lease.api.openSqliteJsRuntime({ relativePath, adapter })`. The returned
 * facade is a plain object owned by the caller, so releasing the lease right
 * after opening does not invalidate the open database. The engine's facade has
 * an extra async `flush()` that `SqliteNativeRuntimeFacade` lacks — cast
 * structurally like memoryIndex does; `ShardedVectorStore` only uses
 * exec/query/transaction/close, and the engine's `close()` snapshots dirty
 * data to the vault file itself, so the missing `flush()` is never needed.
 */
export async function openShardSqliteWasm(
  dbPath: string,
  context: ShardSqliteOpenerContext,
): Promise<SqliteNativeRuntimeFacade> {
  const { app } = context
  const adapter = app.vault.adapter
  let lease
  try {
    lease = await acquireRuntimeComponent('sqlite-engine')
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    throw new VectorStoreError(
      'mobile_sqlite_unavailable',
      'sqlite',
      'none',
      `sqlite-engine runtime component is unavailable: ${cause}`,
    )
  }
  try {
    return (await lease.api.openSqliteJsRuntime({
      relativePath: toVaultRelativePath(dbPath, adapter),
      adapter,
    })) as unknown as SqliteNativeRuntimeFacade
  } finally {
    lease.release()
  }
}
