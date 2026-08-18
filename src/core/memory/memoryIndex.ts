import { type App, FileSystemAdapter } from 'obsidian'

import type { SqliteNativeRuntimeFacade } from '../../database/sqlite/sqliteNativeRuntime'
import { sha256Hex } from '../../utils/common/content-hash'
import { logFlightEvent } from '../../utils/debug/flightLog'
import { getAbsoluteYoloMemoryIndexPath } from '../paths/yoloPaths'
import { acquireRuntimeComponent } from '../runtime-components/runtimeComponentAccess'

import {
  COLD_ARCHIVE_MS,
  COLD_ARCHIVE_SALIENCE,
  SALIENCE_DECAY_LAMBDA,
  calcEffectiveSalience,
} from './decay'
import { MemoryEmbeddingStore } from './memoryEmbeddings'
import {
  MAX_GRAPH_CANDIDATES,
  MAX_GRAPH_DEGREE,
  MAX_GRAPH_EXPANSIONS,
  MAX_PARTITION_GRAPH_EDGES,
  MIN_GRAPH_SALIENCE,
  type MemoryGraphEdge,
  type MemoryGraphNode,
  buildBidirectionalGraphEdges,
  buildGraphCandidates,
  scoreGraphExpansion,
} from './memoryGraph'
import {
  MemoryIndexUnavailableError,
  initializeMemoryIndexSchema,
  trimMemoryMaintenanceLog,
} from './memoryIndexSchema'
import type {
  MemorySettingsLike,
  MemorySourceFingerprint,
  MemorySourceSnapshot,
} from './memoryManager'
import { normalizeMemoryText } from './memoryTokenizer'
import type {
  IndexedMemoryEntry,
  MemoryAgentEntry,
  MemoryIndexQuery,
  MemoryPartition,
  MemorySector,
  MemorySourceEntry,
} from './memoryTypes'
import {
  MEMORY_REFLECTION_PROMPT_VERSION,
  type MemoryReflectionSource,
  buildMemoryReflectionIdentity,
  buildMemoryReflectionPrompt,
  parseMemoryReflectionOutput,
  runMemoryReflectionModel,
  selectMemoryReflectionSources,
  shouldRunMemoryReflection,
} from './reflection'
type MemoryPartitionInput = {
  scope: MemoryPartition['scope']
  assistantId?: string | null
}

/**
 * Final line of defense for the serialized operationChain: `reconcilePartition`
 * runs inside `enqueue`, and every later `store.query` awaits the chain — an
 * unbounded injected embedContent would stall the whole memory index and, with
 * it, the main turn's recall. Bound the call here regardless of who injected
 * the embedder; a timeout degrades to "no vector" like any other failure.
 */
const RECONCILE_EMBED_TIMEOUT_MS = 8_000

const boundedEmbed = async (
  embed: ((content: string) => Promise<number[] | null>) | null | undefined,
  content: string,
  timeoutMs: number,
): Promise<number[] | null> => {
  if (!embed) return null
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      embed(content),
      new Promise<null>((resolve) => {
        timeoutId = setTimeout(() => {
          logFlightEvent('memory-index', 'embed-timeout', {
            detail: `${timeoutMs}ms`,
            consoleOutput: 'warn',
          })
          resolve(null)
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

const encodeBase64Url = (value: string): string => {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '')
}

export const buildMemoryPartition = (
  input: MemoryPartitionInput,
): MemoryPartition => {
  if (input.scope === 'global') {
    if (input.assistantId !== undefined && input.assistantId !== null) {
      throw new Error('Global memory partitions cannot include an assistant ID')
    }
    return {
      scope: 'global',
      assistantId: null,
      partitionKey: 'global',
    }
  }

  if (input.scope !== 'assistant') {
    throw new Error('Memory partition scope must be global or assistant')
  }

  if (typeof input.assistantId !== 'string' || !input.assistantId.trim()) {
    throw new Error(
      'Assistant memory partitions require a non-blank assistant ID',
    )
  }

  return {
    scope: 'assistant',
    assistantId: input.assistantId,
    partitionKey: `assistant:${encodeBase64Url(input.assistantId)}`,
  }
}

export const buildMemoryKey = (partitionKey: string, localId: string): string =>
  `${partitionKey}::${localId}`

export type MemoryIndexStore = {
  readonly capability: 'sqlite' | 'unavailable'
  reconcilePartition(input: {
    partition: MemoryPartition
    sourcePath: string
    sourceFileFingerprint: string
    parserVersion: string
    entries: readonly MemorySourceEntry[]
    sectorHints?: Readonly<Record<string, MemorySector | null>>
    signal?: AbortSignal
  }): Promise<void>
  query(input: MemoryIndexQuery): Promise<readonly IndexedMemoryEntry[]>
  isPartitionReady(input: {
    partition: MemoryPartition
    sourceFileFingerprint: string
  }): Promise<boolean>
  reinforce(input: {
    partition: MemoryPartition
    localId: string
    nowMs: number
  }): Promise<void>
  markDirty(input: {
    partition: MemoryPartition
    reason: string
  }): Promise<void>
}

export type MemoryIndexMaintenanceStore = {
  close?(): Promise<void> | void
  forceClose?(): void
  /** Raw sqlite runtime; the recall orchestrator builds the embedding store from it. */
  getRuntime(): Promise<SqliteNativeRuntimeFacade>
  /** Recompute stored salience against elapsed time; keeps `updated_at` stable. */
  applyDecay(input: {
    partition: MemoryPartition
    nowMs: number
  }): Promise<void>
  /** Drop vectors/edges of cold entries so every recall path excludes them. */
  archiveColdEntries(input: { partition: MemoryPartition }): Promise<void>
  rebuildEdges(input: {
    partition: MemoryPartition
    localIds: readonly string[]
  }): Promise<void>
  expandViaEdges(input: {
    partition: MemoryPartition
    seeds: readonly IndexedMemoryEntry[]
    target: MemoryIndexQuery['target']
    maxEntries: number
  }): Promise<readonly IndexedMemoryEntry[]>
  deletePartition(partition: MemoryPartition): Promise<void>
  findPartitionBySourcePath(sourcePath: string): Promise<MemoryPartition | null>
  runReflection(input: {
    partition: MemoryPartition
    nowMs: number
    runModel: (prompt: string, signal: AbortSignal) => Promise<string>
    signal?: AbortSignal
  }): Promise<void>
} & MemoryIndexStore

type MemoryIndexStoreOptions = {
  app: App
  getSettings: () => MemorySettingsLike | undefined
  getSourceSnapshot: (
    partition: MemoryPartition,
  ) => Promise<MemorySourceSnapshot>
  /**
   * Produces the dense embedding for one memory entry during reconcile;
   * null disables the vector path (no memory_embeddings rows are written).
   * Injected by the runtime from the configured embedding model so the
   * semantic recall path has data to search.
   */
  embedContent?: (content: string) => Promise<number[] | null>
  /**
   * Cheap pre-reconcile probe: content hash + parser version WITHOUT parsing
   * the source file. When it matches the stored partition state, the whole
   * reconcile is skipped — the settings flow re-triggers every partition
   * wholesale, and only changed partitions should pay the parse+write cost.
   */
  getSourceFingerprint?: (
    partition: MemoryPartition,
  ) => Promise<MemorySourceFingerprint>
  /** Test seam: shorten the per-embedding bound of the operationChain. */
  embedTimeoutMs?: number
  clock?: () => number
}

type MemoryIndexRow = {
  partition_key: string
  memory_key: string
  scope: MemoryPartition['scope']
  assistant_id: string | null
  local_id: string
  category: MemoryAgentEntry['category']
  sector: MemorySector
  content: string
  keywords_json: string
  content_hash: string
  salience: number
  last_recalled_at: number | null
  created_at: number
  updated_at: number
  source_path: string
  source_file_fingerprint: string
  entry_fingerprint: string
  parser_version: string
  consolidated: number
}

type MemoryEdgeRow = {
  partition_key: string
  src_local_id: string
  dst_local_id: string
  weight: number
  created_at: number
  updated_at: number
}

type MemoryReflectionStateRow = {
  source_file_fingerprint: string
  last_reflection_at: number | null
  dirty_reason: string | null
}

const DEFAULT_MAX_ENTRIES = 8
const DEFAULT_MAX_CHARS = 3000
const MAX_SOURCE_ENTRIES = 20_000
const RECONCILE_HASH_BATCH_SIZE = 500
const MAX_QUERY_KEYWORDS = 64
const MAX_GRAPH_SOURCE_KEYWORDS = 256
const MAX_GRAPH_TRIM_BATCH = 64
const DEFAULT_SECTOR = (
  category: MemoryAgentEntry['category'],
): MemorySector =>
  category === 'profile' || category === 'preferences' ? 'semantic' : 'episodic'

const nowFrom = (clock?: () => number): number =>
  Math.max(0, Math.trunc(clock?.() ?? Date.now()))

const boundedReason = (reason: unknown): string =>
  String(reason instanceof Error ? reason.message : reason).slice(0, 512)

const throwIfMemoryIndexAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return
  const error = new Error('Memory index reconciliation aborted')
  error.name = 'AbortError'
  throw error
}

const rowToEntry = (row: MemoryIndexRow): IndexedMemoryEntry => ({
  id: row.local_id,
  memoryKey: row.memory_key,
  content: row.content,
  keywords: JSON.parse(row.keywords_json) as string[],
  category: row.category,
  scope: row.scope,
  sector: row.sector,
  contentHash: row.content_hash,
  salience: row.salience,
  lastRecalledAt: row.last_recalled_at,
  sourceFingerprint: row.source_file_fingerprint,
})

const rowToGraphEdge = (row: MemoryEdgeRow): MemoryGraphEdge => ({
  partitionKey: row.partition_key,
  srcLocalId: row.src_local_id,
  dstLocalId: row.dst_local_id,
  weight: row.weight,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

const deleteGraphRelation = (
  runtime: SqliteNativeRuntimeFacade,
  partitionKey: string,
  leftLocalId: string,
  rightLocalId: string,
): void => {
  runtime.exec(
    `delete from memory_edges where partition_key = ? and
     ((src_local_id = ? and dst_local_id = ?) or
      (src_local_id = ? and dst_local_id = ?))`,
    [partitionKey, leftLocalId, rightLocalId, rightLocalId, leftLocalId],
  )
}

const trimGraphDegree = (
  runtime: SqliteNativeRuntimeFacade,
  partitionKey: string,
  localId: string,
): void => {
  while (true) {
    const overflow = runtime.query<{ dst_local_id: string }>(
      `select dst_local_id from memory_edges
       where partition_key = ? and src_local_id = ?
       order by weight desc, updated_at desc, created_at desc, dst_local_id asc
       limit ? offset ?`,
      [partitionKey, localId, MAX_GRAPH_TRIM_BATCH, MAX_GRAPH_DEGREE],
    )
    if (overflow.length === 0) return
    for (const edge of overflow) {
      deleteGraphRelation(runtime, partitionKey, localId, edge.dst_local_id)
    }
  }
}

const trimPartitionGraphEdges = (
  runtime: SqliteNativeRuntimeFacade,
  partitionKey: string,
): void => {
  while (true) {
    const count =
      runtime.queryOne<{ count: number }>(
        'select count(*) as count from memory_edges where partition_key = ?',
        [partitionKey],
      )?.count ?? 0
    if (count <= MAX_PARTITION_GRAPH_EDGES) return
    const weakest = runtime.query<{
      src_local_id: string
      dst_local_id: string
    }>(
      `select src_local_id, dst_local_id from memory_edges
       where partition_key = ?
       order by weight asc, updated_at asc, created_at asc, src_local_id asc, dst_local_id asc
       limit ?`,
      [
        partitionKey,
        Math.min(MAX_GRAPH_TRIM_BATCH, count - MAX_PARTITION_GRAPH_EDGES),
      ],
    )
    if (weakest.length === 0) return
    const removed = new Set<string>()
    for (const edge of weakest) {
      const relation = [edge.src_local_id, edge.dst_local_id]
        .sort()
        .join('\u0000')
      if (removed.has(relation)) continue
      removed.add(relation)
      deleteGraphRelation(
        runtime,
        partitionKey,
        edge.src_local_id,
        edge.dst_local_id,
      )
    }
  }
}

const trimPartitionReflections = (
  runtime: SqliteNativeRuntimeFacade,
  partitionKey: string,
): void => {
  runtime.exec(
    `delete from memory_reflections
     where partition_key = ? and reflection_id not in (
       select reflection_id from memory_reflections
       where partition_key = ?
       order by created_at desc, updated_at desc, reflection_id desc limit 64
     )`,
    [partitionKey, partitionKey],
  )
}

class SqliteMemoryIndexStore implements MemoryIndexMaintenanceStore {
  readonly capability = 'sqlite' as const
  private runtime: SqliteNativeRuntimeFacade | null = null
  private runtimePath: string | null = null
  private operationChain: Promise<void> = Promise.resolve()
  private forceClosed = false

  constructor(private readonly options: MemoryIndexStoreOptions) {}

  async initialize(): Promise<void> {
    await this.getRuntime()
  }

  /** Exposed so the recall orchestrator can build the embedding store. */
  public async getRuntime(): Promise<SqliteNativeRuntimeFacade> {
    if (this.forceClosed) {
      throw new MemoryIndexUnavailableError('SQLite memory index is closed')
    }
    const path = getAbsoluteYoloMemoryIndexPath(
      this.options.app,
      this.options.getSettings(),
    )
    if (!path)
      throw new MemoryIndexUnavailableError(
        'SQLite memory index is unavailable',
      )
    if (this.runtime && this.runtimePath === path) return this.runtime
    const previousRuntime = this.runtime
    const runtime = await this.openRuntime(path)
    try {
      initializeMemoryIndexSchema(runtime)
    } catch (error) {
      runtime.close()
      throw error
    }
    previousRuntime?.close()
    this.runtime = runtime
    this.runtimePath = path
    return runtime
  }

  /** node:sqlite on desktop; the sqlite-engine component everywhere else. */
  private async openRuntime(
    absolutePath: string,
  ): Promise<SqliteNativeRuntimeFacade> {
    try {
      const module = await import('../../database/sqlite/sqliteNativeRuntime')
      return module.openSqliteRuntime({ dbPath: absolutePath })
    } catch {
      // No node:sqlite (mobile) or it failed to load: fall back to the
      // sqlite-engine runtime component (sql.js in-memory + vault file).
      // Same pattern as shardedSqlite's toVaultRelativePath: without a
      // FileSystemAdapter (mobile) the path is already vault-relative and
      // passes through unchanged — the wasm opener resolves it against the
      // vault.
      const adapter = this.options.app.vault.adapter
      const relativePath =
        adapter instanceof FileSystemAdapter
          ? absolutePath.startsWith(adapter.getBasePath())
            ? absolutePath
                .slice(adapter.getBasePath().length)
                .replace(/^[\\/]+/, '')
            : absolutePath
          : absolutePath
      try {
        const lease = await acquireRuntimeComponent('sqlite-engine')
        try {
          // The facade is a plain object owned by the caller; the component
          // instance only provides the factory, so releasing the lease here
          // does not invalidate the open database.
          return (await lease.api.openSqliteJsRuntime({
            relativePath,
            adapter,
          })) as unknown as SqliteNativeRuntimeFacade
        } finally {
          lease.release()
        }
      } catch (componentError) {
        throw new MemoryIndexUnavailableError(
          'SQLite memory index is unavailable: sqlite-engine failed',
          { cause: componentError },
        )
      }
    }
  }

  async close(): Promise<void> {
    if (this.forceClosed) return
    await this.operationChain.catch(() => undefined)
    const runtime = this.runtime
    if (runtime) {
      // sql.js keeps the database in memory; flush before dropping it.
      const flushable = runtime as Partial<{ flush(): Promise<void> }>
      await flushable.flush?.()
      runtime.close()
    }
    this.runtime = null
    this.runtimePath = null
  }

  forceClose(): void {
    this.forceClosed = true
    this.runtime?.close()
    this.runtime = null
    this.runtimePath = null
  }

  private enqueue<Result>(operation: () => Promise<Result>): Promise<Result> {
    if (this.forceClosed) {
      return Promise.reject(
        new MemoryIndexUnavailableError('SQLite memory index is closed'),
      )
    }
    const work = this.operationChain.then(() => {
      if (this.forceClosed) {
        throw new MemoryIndexUnavailableError('SQLite memory index is closed')
      }
      return operation()
    })
    this.operationChain = work.then(
      () => undefined,
      () => undefined,
    )
    return work
  }

  async reconcilePartition(input: {
    partition: MemoryPartition
    sourcePath: string
    sourceFileFingerprint: string
    parserVersion: string
    entries: readonly MemorySourceEntry[]
    sectorHints?: Readonly<Record<string, MemorySector | null>>
    signal?: AbortSignal
  }): Promise<void> {
    return this.enqueue(async () => {
      throwIfMemoryIndexAborted(input.signal)
      const runtime = await this.getRuntime()
      // Fingerprint probe: the settings flow reconciles every partition
      // wholesale; when the source file and parser version are unchanged,
      // skip the read-parse-write entirely instead of re-indexing rows that
      // cannot have drifted. Requires existing rows — an empty-but-ready
      // partition (fresh install, or one healed after an old empty-snapshot
      // wipe) must still run the reconcile to (re)build its rows.
      const getSourceFingerprint = this.options.getSourceFingerprint
      if (getSourceFingerprint) {
        const priorFingerprintState = runtime.queryOne<{
          source_file_fingerprint: string
          parser_version: string
        }>(
          'select source_file_fingerprint, parser_version from memory_partition_state where partition_key = ?',
          [input.partition.partitionKey],
        )
        if (priorFingerprintState) {
          const priorRowCount =
            runtime.queryOne<{ count: number }>(
              'select count(*) as count from memory_index where partition_key = ?',
              [input.partition.partitionKey],
            )?.count ?? 0
          if (priorRowCount > 0) {
            const probe = await getSourceFingerprint(input.partition)
            if (
              probe.fingerprint ===
                priorFingerprintState.source_file_fingerprint &&
              probe.parserVersion === priorFingerprintState.parser_version
            ) {
              logFlightEvent('memory-index', 'reconcile-skip', {
                id: input.partition.partitionKey,
                detail: `fingerprint unchanged rows=${priorRowCount}`,
                consoleOutput: 'none',
              })
              return
            }
          }
        }
      }
      let snapshot: MemorySourceSnapshot
      try {
        snapshot = await this.options.getSourceSnapshot(input.partition)
      } catch (error) {
        await this.persistDirty(runtime, input.partition, boundedReason(error))
        throw error
      }
      if (
        !snapshot.valid ||
        snapshot.entries.length > MAX_SOURCE_ENTRIES ||
        snapshot.partition.partitionKey !== input.partition.partitionKey
      ) {
        const reason = !snapshot.valid
          ? 'invalid memory source snapshot'
          : snapshot.entries.length > MAX_SOURCE_ENTRIES
            ? 'memory source entry cap exceeded'
            : 'memory source partition mismatch'
        await this.persistDirty(runtime, input.partition, reason)
        return
      }
      const preparedEntries: Array<{
        entry: MemorySourceEntry
        contentHash: string
      }> = []
      for (
        let start = 0;
        start < snapshot.entries.length;
        start += RECONCILE_HASH_BATCH_SIZE
      ) {
        throwIfMemoryIndexAborted(input.signal)
        const batch = snapshot.entries.slice(
          start,
          start + RECONCILE_HASH_BATCH_SIZE,
        )
        preparedEntries.push(
          ...(await Promise.all(
            batch.map(async (entry) => ({
              entry,
              contentHash: await sha256Hex(entry.content.normalize('NFC')),
            })),
          )),
        )
      }
      // Pre-compute dense embeddings for new/changed entries before the
      // transaction (embedding calls are async network/model work). The same
      // changed set is recomputed inside the transaction from identical
      // inputs; entries whose embedding is unavailable drop any stale vector.
      const changedLocalIds = new Set<string>()
      const priorFingerprintById = new Map(
        runtime
          .query<{
            local_id: string
            entry_fingerprint: string
          }>(
            'select local_id, entry_fingerprint from memory_index where partition_key = ?',
            [input.partition.partitionKey],
          )
          .map(({ local_id, entry_fingerprint }) => [
            local_id,
            entry_fingerprint,
          ]),
      )
      const priorParserVersion = runtime.queryOne<{ parser_version: string }>(
        'select parser_version from memory_partition_state where partition_key = ?',
        [input.partition.partitionKey],
      )?.parser_version
      for (const entry of snapshot.entries) {
        const priorFingerprint = priorFingerprintById.get(entry.localId)
        if (
          !priorFingerprint ||
          priorFingerprint !== entry.entryFingerprint ||
          priorParserVersion !== snapshot.parserVersion
        ) {
          changedLocalIds.add(entry.localId)
        }
      }
      logFlightEvent('memory-index', 'reconcile-diag', {
        id: input.partition.partitionKey,
        detail: `entries=${snapshot.entries.length} priorRows=${priorFingerprintById.size} changed=${changedLocalIds.size} parserMatch=${priorParserVersion === snapshot.parserVersion}`,
        consoleOutput: 'none',
      })
      const embeddingsByLocalId = new Map<string, number[]>()
      const embedContent = this.options.embedContent
      if (embedContent) {
        for (
          let start = 0;
          start < snapshot.entries.length;
          start += RECONCILE_HASH_BATCH_SIZE
        ) {
          throwIfMemoryIndexAborted(input.signal)
          const batch = snapshot.entries.slice(
            start,
            start + RECONCILE_HASH_BATCH_SIZE,
          )
          const embedded = await Promise.all(
            batch.map(async (entry): Promise<[string, number[]] | null> => {
              if (!changedLocalIds.has(entry.localId)) return null
              const embedding = await boundedEmbed(
                embedContent,
                entry.content,
                this.options.embedTimeoutMs ?? RECONCILE_EMBED_TIMEOUT_MS,
              )
              return embedding && embedding.length > 0
                ? [entry.localId, embedding]
                : null
            }),
          )
          for (const result of embedded) {
            if (result) embeddingsByLocalId.set(result[0], result[1])
          }
        }
      }
      try {
        runtime.transaction(() => {
          const timestamp = nowFrom(this.options.clock)
          const priorState = runtime.queryOne<{
            source_file_fingerprint: string
            parser_version: string
          }>(
            'select source_file_fingerprint, parser_version from memory_partition_state where partition_key = ?',
            [input.partition.partitionKey],
          )
          const priorRows = runtime.query<MemoryIndexRow>(
            'select * from memory_index where partition_key = ?',
            [input.partition.partitionKey],
          )
          const incomingEntriesById = new Map(
            snapshot.entries.map((entry) => [entry.localId, entry]),
          )
          const priorRowsById = new Map(
            priorRows.map((row) => [row.local_id, row]),
          )
          const incomingIds = new Set(incomingEntriesById.keys())
          const changedIds = new Set<string>()
          for (const row of priorRows) {
            const incoming = incomingEntriesById.get(row.local_id)
            if (!incoming) changedIds.add(row.local_id)
            else if (
              incoming.entryFingerprint !== row.entry_fingerprint ||
              priorState?.parser_version !== snapshot.parserVersion
            )
              changedIds.add(row.local_id)
          }
          for (const localId of changedIds) {
            runtime.exec(
              'delete from memory_edges where partition_key = ? and (src_local_id = ? or dst_local_id = ?)',
              [input.partition.partitionKey, localId, localId],
            )
          }
          runtime.exec(
            'delete from memory_reflections where partition_key = ? and source_fingerprint <> ?',
            [input.partition.partitionKey, snapshot.sourceFileFingerprint],
          )
          const embeddingStore = new MemoryEmbeddingStore(runtime)
          for (let index = 0; index < preparedEntries.length; index += 1) {
            if (index % 100 === 0) {
              throwIfMemoryIndexAborted(input.signal)
            }
            const prepared = preparedEntries[index]
            const entry = prepared.entry
            const old = priorRowsById.get(entry.localId)
            const contentHash = prepared.contentHash
            const unchanged =
              old?.entry_fingerprint === entry.entryFingerprint &&
              priorState?.parser_version === snapshot.parserVersion
            const memoryKey = buildMemoryKey(
              input.partition.partitionKey,
              entry.localId,
            )
            const hasSectorHint =
              input.sectorHints !== undefined &&
              Object.prototype.hasOwnProperty.call(input.sectorHints, memoryKey)
            const sector = hasSectorHint
              ? (input.sectorHints?.[memoryKey] ??
                old?.sector ??
                DEFAULT_SECTOR(entry.category))
              : ((unchanged ? old?.sector : undefined) ??
                DEFAULT_SECTOR(entry.category))
            const salience = unchanged ? (old?.salience ?? 0.5) : 0.5
            const lastRecalledAt = unchanged
              ? (old?.last_recalled_at ?? null)
              : null
            runtime.exec(
              `insert into memory_index
               (partition_key, memory_key, scope, assistant_id, local_id, category, sector, content, keywords_json,
                content_hash, salience, last_recalled_at,
                created_at, updated_at, source_path, source_file_fingerprint, entry_fingerprint, parser_version)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               on conflict(partition_key, local_id) do update set
                 memory_key = excluded.memory_key,
                 scope = excluded.scope,
                 assistant_id = excluded.assistant_id,
                 category = excluded.category,
                 sector = excluded.sector,
                 content = excluded.content,
                 keywords_json = excluded.keywords_json,
                 content_hash = excluded.content_hash,
                 salience = excluded.salience,
                 last_recalled_at = excluded.last_recalled_at,
                 updated_at = excluded.updated_at,
                 source_path = excluded.source_path,
                 source_file_fingerprint = excluded.source_file_fingerprint,
                 entry_fingerprint = excluded.entry_fingerprint,
                 parser_version = excluded.parser_version`,
              [
                input.partition.partitionKey,
                memoryKey,
                input.partition.scope,
                input.partition.assistantId,
                entry.localId,
                entry.category,
                sector,
                entry.content,
                JSON.stringify(
                  [
                    ...new Set(
                      entry.keywords.map((keyword) => keyword.normalize('NFC')),
                    ),
                  ].sort(),
                ),
                contentHash,
                salience,
                lastRecalledAt,
                old?.created_at ?? timestamp,
                timestamp,
                snapshot.sourcePath,
                snapshot.sourceFileFingerprint,
                entry.entryFingerprint,
                snapshot.parserVersion,
              ],
            )
            runtime.exec(
              'delete from memory_keywords where partition_key = ? and local_id = ?',
              [input.partition.partitionKey, entry.localId],
            )
            for (const keyword of [
              ...new Set(
                entry.keywords
                  .map((item) => normalizeMemoryText(item))
                  .filter(Boolean),
              ),
            ].sort()) {
              runtime.exec(
                'insert into memory_keywords (partition_key, local_id, keyword) values (?, ?, ?)',
                [input.partition.partitionKey, entry.localId, keyword],
              )
            }
            const embedding = embeddingsByLocalId.get(entry.localId)
            if (embedding) {
              embeddingStore.upsert(
                {
                  partitionKey: input.partition.partitionKey,
                  memoryKey,
                  localId: 0,
                },
                embedding,
              )
            } else if (changedLocalIds.has(entry.localId)) {
              // Changed entry with no fresh embedding (model unavailable):
              // drop the stale vector so recall never serves outdated content.
              embeddingStore.delete(input.partition.partitionKey, [memoryKey])
            }
          }
          throwIfMemoryIndexAborted(input.signal)
          const removedLocalIds = priorRows
            .map((row) => row.local_id)
            .filter((id) => !incomingIds.has(id))
          for (const localId of removedLocalIds) {
            runtime.exec(
              'delete from memory_index where partition_key = ? and local_id = ?',
              [input.partition.partitionKey, localId],
            )
            embeddingStore.delete(input.partition.partitionKey, [
              buildMemoryKey(input.partition.partitionKey, localId),
            ])
          }
          runtime.exec(
            `insert into memory_partition_state
             (partition_key, source_path, source_file_fingerprint, parser_version, dirty_reason, last_reconciled_at, updated_at)
             values (?, ?, ?, ?, null, ?, ?)
             on conflict(partition_key) do update set source_path = excluded.source_path,
             source_file_fingerprint = excluded.source_file_fingerprint, parser_version = excluded.parser_version,
             dirty_reason = null, last_reconciled_at = excluded.last_reconciled_at, updated_at = excluded.updated_at`,
            [
              input.partition.partitionKey,
              snapshot.sourcePath,
              snapshot.sourceFileFingerprint,
              snapshot.parserVersion,
              timestamp,
              timestamp,
            ],
          )
          runtime.exec(
            'insert into memory_maintenance_log (partition_key, operation, status, source_file_fingerprint, created_at) values (?, ?, ?, ?, ?)',
            [
              input.partition.partitionKey,
              'reconcile',
              'completed',
              snapshot.sourceFileFingerprint,
              timestamp,
            ],
          )
          trimMemoryMaintenanceLog(runtime, input.partition.partitionKey)
        })
      } catch (error) {
        await this.persistDirty(runtime, input.partition, boundedReason(error))
        throw error
      }
    })
  }

  private async persistDirty(
    runtime: SqliteNativeRuntimeFacade,
    partition: MemoryPartition,
    reason: string,
  ): Promise<void> {
    try {
      const timestamp = nowFrom(this.options.clock)
      runtime.transaction(() => {
        const previous = runtime.queryOne<{
          source_path: string
          source_file_fingerprint: string
          parser_version: string
          last_reconciled_at: number | null
          last_reflection_at: number | null
        }>(
          'select source_path, source_file_fingerprint, parser_version, last_reconciled_at, last_reflection_at from memory_partition_state where partition_key = ?',
          [partition.partitionKey],
        )
        runtime.exec(
          `insert into memory_partition_state
           (partition_key, source_path, source_file_fingerprint, parser_version, dirty_reason,
            last_reconciled_at, last_reflection_at, updated_at)
           values (?, ?, ?, ?, ?, ?, ?, ?)
           on conflict(partition_key) do update set dirty_reason = excluded.dirty_reason, updated_at = excluded.updated_at`,
          [
            partition.partitionKey,
            previous?.source_path ?? '',
            previous?.source_file_fingerprint ?? '',
            previous?.parser_version ?? '',
            boundedReason(reason),
            previous?.last_reconciled_at ?? null,
            previous?.last_reflection_at ?? null,
            timestamp,
          ],
        )
      })
    } catch (error) {
      console.warn('[YOLO][MemoryIndex] failed to persist dirty state', error)
      return
    }
  }

  async query(input: MemoryIndexQuery): Promise<readonly IndexedMemoryEntry[]> {
    if (this.forceClosed) return []
    try {
      await this.operationChain
      const runtime = await this.getRuntime()
      const state = runtime.queryOne<{
        source_file_fingerprint: string
        dirty_reason: string | null
      }>(
        'select source_file_fingerprint, dirty_reason from memory_partition_state where partition_key = ?',
        [input.partition.partitionKey],
      )
      if (
        !state ||
        state.dirty_reason ||
        state.source_file_fingerprint !== input.sourceFileFingerprint
      )
        return []
      const maxEntries = Math.max(
        0,
        Math.min(DEFAULT_MAX_ENTRIES, Math.trunc(input.maxEntries)),
      )
      const maxChars = Math.max(
        0,
        Math.min(DEFAULT_MAX_CHARS, Math.trunc(input.maxChars)),
      )
      const categories =
        input.target.categories?.length > 0
          ? input.target.categories
          : ['profile', 'preferences', 'other']
      const scopes =
        input.target.scopes?.length > 0
          ? input.target.scopes
          : [input.partition.scope]
      const queryKeywords = [
        ...new Set(
          [...input.target.keywords, ...input.target.entities]
            .map((keyword) => normalizeMemoryText(keyword))
            .filter(Boolean),
        ),
      ].slice(0, MAX_QUERY_KEYWORDS)
      const keywordMatchOrder = queryKeywords.length
        ? `(select count(*) from memory_keywords keyword
             where keyword.partition_key = memory_index.partition_key
               and keyword.local_id = memory_index.local_id
               and keyword.keyword in (${queryKeywords.map(() => '?').join(',')}))`
        : '(select 0)'
      const contentMatchOrder = queryKeywords.length
        ? queryKeywords
            .map(
              () =>
                'case when instr(lower(memory_index.content), lower(?)) > 0 then 1 else 0 end',
            )
            .join(' + ')
        : '(select 0)'
      const queryMatchOrder = queryKeywords.length
        ? `(${contentMatchOrder}) + ${keywordMatchOrder}`
        : '(select 0)'
      const memoryKeys = input.memoryKeys?.length
        ? [...new Set(input.memoryKeys)].slice(0, MAX_QUERY_KEYWORDS)
        : []
      const baseWhere = `select * from memory_index where partition_key = ? and source_file_fingerprint = ?
         and category in (${categories.map(() => '?').join(',')}) and scope in (${scopes.map(() => '?').join(',')})
         and not (salience <= ? and (last_recalled_at is null or last_recalled_at < strftime('%s','now')*1000 - ?))`
      const rows = memoryKeys.length
        ? runtime.query<MemoryIndexRow>(
            `${baseWhere}
             and memory_key in (${memoryKeys.map(() => '?').join(',')})
             order by case memory_key ${memoryKeys
               .map((_, index) => `when ? then ${index}`)
               .join(' ')} else ${memoryKeys.length} end limit ?`,
            [
              input.partition.partitionKey,
              input.sourceFileFingerprint,
              ...categories,
              ...scopes,
              COLD_ARCHIVE_SALIENCE,
              COLD_ARCHIVE_MS,
              ...memoryKeys,
              ...memoryKeys,
              maxEntries,
            ],
          )
        : runtime.query<MemoryIndexRow>(
            `${baseWhere}
             order by case category when 'preferences' then 0 when 'profile' then 1 else 2 end,
             ${queryMatchOrder} desc, salience desc, updated_at desc limit ?`,
            [
              input.partition.partitionKey,
              input.sourceFileFingerprint,
              ...categories,
              ...scopes,
              COLD_ARCHIVE_SALIENCE,
              COLD_ARCHIVE_MS,
              ...queryKeywords,
              ...queryKeywords,
              maxEntries,
            ],
          )
      const result: IndexedMemoryEntry[] = []
      let chars = 0
      for (const row of rows) {
        if (chars + row.content.length > maxChars) continue
        result.push(rowToEntry(row))
        chars += row.content.length
      }
      return result
    } catch (error) {
      console.warn('[YOLO][MemoryIndex] query failed', error)
      return []
    }
  }

  async isPartitionReady(input: {
    partition: MemoryPartition
    sourceFileFingerprint: string
  }): Promise<boolean> {
    if (this.forceClosed) return false
    try {
      await this.operationChain
      const runtime = await this.getRuntime()
      const state = runtime.queryOne<{
        source_file_fingerprint: string
        dirty_reason: string | null
      }>(
        'select source_file_fingerprint, dirty_reason from memory_partition_state where partition_key = ?',
        [input.partition.partitionKey],
      )
      return Boolean(
        state &&
          !state.dirty_reason &&
          state.source_file_fingerprint === input.sourceFileFingerprint,
      )
    } catch (error) {
      console.warn(
        '[YOLO][MemoryIndex] partition readiness check failed',
        error,
      )
      return false
    }
  }

  async reinforce(input: {
    partition: MemoryPartition
    localId: string
    nowMs: number
  }): Promise<void> {
    return this.enqueue(async () => {
      const runtime = await this.getRuntime()
      runtime.exec(
        `update memory_index set salience = min(1, salience + 0.05), last_recalled_at = ?, updated_at = ?
         where partition_key = ? and local_id = ?`,
        [input.nowMs, input.nowMs, input.partition.partitionKey, input.localId],
      )
    })
  }

  async applyDecay(input: {
    partition: MemoryPartition
    nowMs: number
  }): Promise<void> {
    return this.enqueue(async () => {
      const runtime = await this.getRuntime()
      const rows = runtime.query<{
        local_id: string
        salience: number
        created_at: number
        last_recalled_at: number | null
      }>(
        'select local_id, salience, created_at, last_recalled_at from memory_index where partition_key = ?',
        [input.partition.partitionKey],
      )
      const decayed = rows.flatMap((row) => {
        const effective = calcEffectiveSalience({
          storedSalience: row.salience,
          createdAtMs: row.created_at,
          lastRecalledAtMs: row.last_recalled_at,
          nowMs: input.nowMs,
          lambda: SALIENCE_DECAY_LAMBDA,
        })
        if (Math.abs(effective - row.salience) <= 1e-6) return []
        return [
          {
            salience: effective,
            partitionKey: input.partition.partitionKey,
            localId: row.local_id,
          },
        ]
      })
      if (decayed.length === 0) return
      runtime.transaction(() => {
        for (const { salience, partitionKey, localId } of decayed) {
          runtime.exec(
            'update memory_index set salience = ? where partition_key = ? and local_id = ?',
            [salience, partitionKey, localId],
          )
        }
      })
    })
  }

  async archiveColdEntries(input: {
    partition: MemoryPartition
  }): Promise<void> {
    return this.enqueue(async () => {
      const runtime = await this.getRuntime()
      const partitionKey = input.partition.partitionKey
      runtime.transaction(() => {
        runtime.exec(
          `delete from memory_embeddings where partition_key = ? and memory_key in (
             select memory_key from memory_index
             where partition_key = ? and salience <= ?
               and (last_recalled_at is null or last_recalled_at < strftime('%s','now')*1000 - ?))`,
          [partitionKey, partitionKey, COLD_ARCHIVE_SALIENCE, COLD_ARCHIVE_MS],
        )
        runtime.exec(
          `delete from memory_edges where partition_key = ? and (
             src_local_id in (
               select local_id from memory_index
               where partition_key = ? and salience <= ?
                 and (last_recalled_at is null or last_recalled_at < strftime('%s','now')*1000 - ?)) or
             dst_local_id in (
               select local_id from memory_index
               where partition_key = ? and salience <= ?
                 and (last_recalled_at is null or last_recalled_at < strftime('%s','now')*1000 - ?)))`,
          [
            partitionKey,
            partitionKey,
            COLD_ARCHIVE_SALIENCE,
            COLD_ARCHIVE_MS,
            partitionKey,
            COLD_ARCHIVE_SALIENCE,
            COLD_ARCHIVE_MS,
          ],
        )
      })
    })
  }

  async markDirty(input: {
    partition: MemoryPartition
    reason: string
  }): Promise<void> {
    return this.enqueue(async () =>
      this.persistDirty(await this.getRuntime(), input.partition, input.reason),
    )
  }

  async rebuildEdges(input: {
    partition: MemoryPartition
    localIds: readonly string[]
  }): Promise<void> {
    return this.enqueue(async () => {
      const runtime = await this.getRuntime()
      const partitionKey = input.partition.partitionKey
      const localIds = [...new Set(input.localIds.filter(Boolean))]
      runtime.transaction(() => {
        runtime.exec(
          `delete from memory_edges where partition_key = ? and
           (not exists (
              select 1 from memory_index source
              where source.partition_key = memory_edges.partition_key
                and source.local_id = memory_edges.src_local_id
            ) or not exists (
              select 1 from memory_index target
              where target.partition_key = memory_edges.partition_key
                and target.local_id = memory_edges.dst_local_id
            ))`,
          [partitionKey],
        )

        for (const localId of localIds) {
          const sourceRow = runtime.queryOne<{
            local_id: string
            salience: number
          }>(
            `select local_id, salience from memory_index
             where partition_key = ? and local_id = ?`,
            [partitionKey, localId],
          )
          if (!sourceRow) {
            runtime.exec(
              'delete from memory_edges where partition_key = ? and (src_local_id = ? or dst_local_id = ?)',
              [partitionKey, localId, localId],
            )
            continue
          }

          const sourceKeywords = runtime
            .query<{ keyword: string }>(
              `select keyword from memory_keywords
               where partition_key = ? and local_id = ?
               order by keyword limit ?`,
              [partitionKey, localId, MAX_GRAPH_SOURCE_KEYWORDS],
            )
            .map(({ keyword }) => keyword)
          const source: MemoryGraphNode = {
            partitionKey,
            localId,
            keywords: sourceKeywords,
            salience: sourceRow.salience,
          }
          let candidateRows: Array<{
            local_id: string
            keywords_json: string
            salience: number
          }> = []
          if (
            source.salience >= MIN_GRAPH_SALIENCE &&
            sourceKeywords.length > 0
          ) {
            candidateRows = runtime.query(
              `select candidate.local_id, candidate.keywords_json, candidate.salience
               from memory_keywords keyword
               join memory_index candidate
                 on candidate.partition_key = keyword.partition_key
                and candidate.local_id = keyword.local_id
               where keyword.partition_key = ?
                 and keyword.keyword in (${sourceKeywords.map(() => '?').join(',')})
                 and candidate.local_id <> ?
                 and candidate.salience >= ?
               group by candidate.local_id
               order by count(*) desc, candidate.salience desc, candidate.local_id asc
               limit ?`,
              [
                partitionKey,
                ...sourceKeywords,
                localId,
                MIN_GRAPH_SALIENCE,
                MAX_GRAPH_CANDIDATES,
              ],
            )
          }
          const candidates = buildGraphCandidates(
            source,
            candidateRows.map((row) => ({
              partitionKey,
              localId: row.local_id,
              keywords: JSON.parse(row.keywords_json) as string[],
              salience: row.salience,
            })),
          )
          const desiredIds = candidates.map(({ localId: id }) => id)
          if (desiredIds.length === 0) {
            runtime.exec(
              'delete from memory_edges where partition_key = ? and (src_local_id = ? or dst_local_id = ?)',
              [partitionKey, localId, localId],
            )
            continue
          }

          runtime.exec(
            `delete from memory_edges where partition_key = ? and
             ((src_local_id = ? and dst_local_id not in (${desiredIds.map(() => '?').join(',')})) or
              (dst_local_id = ? and src_local_id not in (${desiredIds.map(() => '?').join(',')})))`,
            [partitionKey, localId, ...desiredIds, localId, ...desiredIds],
          )
          const existing = runtime
            .query<MemoryEdgeRow>(
              `select * from memory_edges where partition_key = ? and
               ((src_local_id = ? and dst_local_id in (${desiredIds.map(() => '?').join(',')})) or
                (dst_local_id = ? and src_local_id in (${desiredIds.map(() => '?').join(',')})))`,
              [partitionKey, localId, ...desiredIds, localId, ...desiredIds],
            )
            .map(rowToGraphEdge)
          const timestamp = nowFrom(this.options.clock)
          const edges = buildBidirectionalGraphEdges(
            source,
            candidates,
            existing,
            timestamp,
          )
          for (const edge of edges) {
            runtime.exec(
              `insert into memory_edges
               (partition_key, src_local_id, dst_local_id, weight, created_at, updated_at)
               values (?, ?, ?, ?, ?, ?)
               on conflict(partition_key, src_local_id, dst_local_id)
               do update set weight = max(memory_edges.weight, excluded.weight),
                             updated_at = excluded.updated_at`,
              [
                edge.partitionKey,
                edge.srcLocalId,
                edge.dstLocalId,
                edge.weight,
                edge.createdAt,
                edge.updatedAt,
              ],
            )
          }
          for (const touchedId of [localId, ...desiredIds]) {
            trimGraphDegree(runtime, partitionKey, touchedId)
          }
          trimPartitionGraphEdges(runtime, partitionKey)
        }
      })
    })
  }
  async expandViaEdges(input: {
    partition: MemoryPartition
    seeds: readonly IndexedMemoryEntry[]
    target: MemoryIndexQuery['target']
    maxEntries: number
  }): Promise<readonly IndexedMemoryEntry[]> {
    if (this.forceClosed) return input.seeds
    try {
      await this.operationChain
      const runtime = await this.getRuntime()
      const scopes =
        input.target.scopes?.length > 0
          ? input.target.scopes
          : [input.partition.scope]
      if (!scopes.includes(input.partition.scope)) return input.seeds
      const categories =
        input.target.categories?.length > 0
          ? input.target.categories
          : ['profile', 'preferences', 'other']
      const prefix = `${input.partition.partitionKey}::`
      const sourceScores = new Map<string, number>()
      for (const seed of input.seeds) {
        if (
          seed.scope !== input.partition.scope ||
          !seed.memoryKey.startsWith(prefix)
        )
          continue
        sourceScores.set(
          seed.id,
          Math.max(sourceScores.get(seed.id) ?? 0, seed.salience),
        )
      }
      const sourceIds = [...sourceScores.keys()].slice(0, DEFAULT_MAX_ENTRIES)
      if (sourceIds.length === 0) return input.seeds
      const rows = runtime.query<
        MemoryIndexRow & {
          src_local_id: string
          edge_weight: number
        }
      >(
        `select target.*, edge.src_local_id, edge.weight as edge_weight
         from memory_edges edge
         join memory_index target
           on target.partition_key = edge.partition_key
          and target.local_id = edge.dst_local_id
         where edge.partition_key = ?
           and edge.src_local_id in (${sourceIds.map(() => '?').join(',')})
           and target.scope in (${scopes.map(() => '?').join(',')})
           and target.category in (${categories.map(() => '?').join(',')})
           and not (target.salience <= ? and (target.last_recalled_at is null or target.last_recalled_at < strftime('%s','now')*1000 - ?))
         order by edge.weight desc, target.salience desc, target.updated_at desc
         limit ?`,
        [
          input.partition.partitionKey,
          ...sourceIds,
          ...scopes,
          ...categories,
          COLD_ARCHIVE_SALIENCE,
          COLD_ARCHIVE_MS,
          DEFAULT_MAX_ENTRIES * MAX_GRAPH_DEGREE,
        ],
      )
      const seenKeys = new Set(input.seeds.map(({ memoryKey }) => memoryKey))
      const candidates = new Map<
        string,
        { row: MemoryIndexRow; score: number }
      >()
      for (const row of rows) {
        if (seenKeys.has(row.memory_key)) continue
        const score = scoreGraphExpansion(
          sourceScores.get(row.src_local_id) ?? 0,
          row.edge_weight,
        )
        const previous = candidates.get(row.memory_key)
        if (!previous || score > previous.score) {
          candidates.set(row.memory_key, { row, score })
        }
      }
      const maxAdditions = Math.min(
        MAX_GRAPH_EXPANSIONS,
        Math.max(0, Math.trunc(input.maxEntries)),
      )
      const additions = [...candidates.values()]
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score
          if (left.row.category !== right.row.category) {
            if (left.row.category === 'preferences') return -1
            if (right.row.category === 'preferences') return 1
          }
          if (right.row.salience !== left.row.salience)
            return right.row.salience - left.row.salience
          if (right.row.updated_at !== left.row.updated_at)
            return right.row.updated_at - left.row.updated_at
          return left.row.memory_key.localeCompare(right.row.memory_key)
        })
        .slice(0, maxAdditions)
        .map(({ row }) => rowToEntry(row))
      return [...input.seeds, ...additions]
    } catch (error) {
      console.warn('[YOLO][MemoryIndex] graph expansion failed', error)
      return input.seeds
    }
  }
  async deletePartition(partition: MemoryPartition): Promise<void> {
    return this.enqueue(async () => {
      const runtime = await this.getRuntime()
      new MemoryEmbeddingStore(runtime).clearPartition(partition.partitionKey)
      runtime.exec(
        'delete from memory_partition_state where partition_key = ?',
        [partition.partitionKey],
      )
      runtime.exec('delete from memory_index where partition_key = ?', [
        partition.partitionKey,
      ])
      runtime.exec('delete from memory_reflections where partition_key = ?', [
        partition.partitionKey,
      ])
      runtime.exec(
        'delete from memory_maintenance_log where partition_key = ?',
        [partition.partitionKey],
      )
    })
  }
  async findPartitionBySourcePath(
    sourcePath: string,
  ): Promise<MemoryPartition | null> {
    if (this.forceClosed) return null
    try {
      await this.operationChain
      const runtime = await this.getRuntime()
      const state = runtime.queryOne<{ partition_key: string }>(
        `select partition_key from memory_partition_state
         where source_path = ? limit 1`,
        [sourcePath],
      )
      if (!state) return null
      if (state.partition_key === 'global') {
        return buildMemoryPartition({ scope: 'global' })
      }
      const assistant = this.options
        .getSettings()
        ?.assistants?.find(
          ({ id }) =>
            buildMemoryPartition({ scope: 'assistant', assistantId: id })
              .partitionKey === state.partition_key,
        )
      return assistant
        ? buildMemoryPartition({
            scope: 'assistant',
            assistantId: assistant.id,
          })
        : null
    } catch (error) {
      console.warn('[YOLO][MemoryIndex] partition lookup failed', error)
      return null
    }
  }
  async runReflection(input: {
    partition: MemoryPartition
    nowMs: number
    runModel: (prompt: string, signal: AbortSignal) => Promise<string>
    signal?: AbortSignal
  }): Promise<void> {
    let sourceFileFingerprint: string | null = null
    const timestamp = Math.max(0, Math.trunc(input.nowMs))
    try {
      const preparation = await this.enqueue(async () => {
        const readyRuntime = await this.getRuntime()
        const state = readyRuntime.queryOne<MemoryReflectionStateRow>(
          `select source_file_fingerprint, last_reflection_at, dirty_reason
           from memory_partition_state where partition_key = ?`,
          [input.partition.partitionKey],
        )
        if (!state || state.dirty_reason) return null
        sourceFileFingerprint = state.source_file_fingerprint
        const rows = readyRuntime.query<MemoryIndexRow>(
          `select * from memory_index
           where partition_key = ? and source_file_fingerprint = ? and sector <> 'reflective'`,
          [input.partition.partitionKey, sourceFileFingerprint],
        )
        if (
          !shouldRunMemoryReflection({
            partition: input.partition,
            sourceCount: rows.length,
            lastReflectionAt: state.last_reflection_at,
            nowMs: timestamp,
          })
        )
          return null
        const sources = selectMemoryReflectionSources(
          rows.map(
            (row): MemoryReflectionSource => ({
              memoryKey: row.memory_key,
              content: row.content,
              sector: row.sector as MemoryReflectionSource['sector'],
              salience: row.salience,
              updatedAt: row.updated_at,
              entryFingerprint: row.entry_fingerprint,
            }),
          ),
        )
        if (sources.length === 0) return null
        return {
          sourceFileFingerprint: state.source_file_fingerprint,
          sources,
          prompt: buildMemoryReflectionPrompt(sources),
        }
      })
      if (!preparation) return

      const response = await runMemoryReflectionModel(
        input.runModel,
        preparation.prompt,
        undefined,
        input.signal,
      )
      if (input.signal?.aborted)
        throw new Error('Memory reflection model aborted')
      const reflection = parseMemoryReflectionOutput(
        response,
        preparation.sources.map(({ memoryKey }) => memoryKey),
      )
      if (!reflection) throw new Error('Invalid memory reflection output')
      const referencedSources = reflection.sourceKeys.map(
        (sourceKey) =>
          preparation.sources.find(({ memoryKey }) => memoryKey === sourceKey)!,
      )
      const identity = await buildMemoryReflectionIdentity(
        input.partition.partitionKey,
        referencedSources,
      )

      await this.enqueue(async () => {
        const readyRuntime = await this.getRuntime()
        readyRuntime.transaction(() => {
          const currentState = readyRuntime.queryOne<MemoryReflectionStateRow>(
            `select source_file_fingerprint, last_reflection_at, dirty_reason
             from memory_partition_state where partition_key = ?`,
            [input.partition.partitionKey],
          )
          if (
            input.signal?.aborted ||
            !currentState ||
            currentState.dirty_reason ||
            currentState.source_file_fingerprint !==
              preparation.sourceFileFingerprint
          )
            throw new Error('Memory reflection source changed')
          const currentSources = readyRuntime.query<{
            memory_key: string
            entry_fingerprint: string
          }>(
            `select memory_key, entry_fingerprint from memory_index
             where partition_key = ? and memory_key in (${referencedSources.map(() => '?').join(',')})`,
            [
              input.partition.partitionKey,
              ...referencedSources.map(({ memoryKey }) => memoryKey),
            ],
          )
          if (
            referencedSources.some(
              (source) =>
                currentSources.find(
                  ({ memory_key }) => memory_key === source.memoryKey,
                )?.entry_fingerprint !== source.entryFingerprint,
            )
          )
            throw new Error('Memory reflection sources changed')
          readyRuntime.exec(
            `insert into memory_reflections
             (partition_key, reflection_id, content, sector, source_keys_json,
              source_fingerprint, prompt_version, created_at, updated_at)
             values (?, ?, ?, 'reflective', ?, ?, ?, ?, ?)
             on conflict(partition_key, source_fingerprint, prompt_version) do nothing`,
            [
              input.partition.partitionKey,
              identity.reflectionId,
              reflection.content,
              JSON.stringify(reflection.sourceKeys),
              preparation.sourceFileFingerprint,
              MEMORY_REFLECTION_PROMPT_VERSION,
              timestamp,
              timestamp,
            ],
          )
          readyRuntime.exec(
            `update memory_partition_state
             set last_reflection_at = ?, updated_at = ? where partition_key = ?`,
            [timestamp, timestamp, input.partition.partitionKey],
          )
          readyRuntime.exec(
            `insert into memory_maintenance_log
             (partition_key, operation, status, source_file_fingerprint, created_at)
             values (?, 'reflection', 'completed', ?, ?)`,
            [
              input.partition.partitionKey,
              preparation.sourceFileFingerprint,
              timestamp,
            ],
          )
          trimPartitionReflections(readyRuntime, input.partition.partitionKey)
          trimMemoryMaintenanceLog(readyRuntime, input.partition.partitionKey)
        })
      })
    } catch {
      await this.enqueue(async () => {
        const readyRuntime = await this.getRuntime()
        readyRuntime.transaction(() => {
          readyRuntime.exec(
            `insert into memory_maintenance_log
             (partition_key, operation, status, source_file_fingerprint, created_at)
             values (?, 'reflection', 'failed', ?, ?)`,
            [input.partition.partitionKey, sourceFileFingerprint, timestamp],
          )
          trimMemoryMaintenanceLog(readyRuntime, input.partition.partitionKey)
        })
      }).catch(() => undefined)
    }
  }
}

class UnavailableMemoryIndexStore implements MemoryIndexMaintenanceStore {
  readonly capability = 'unavailable' as const
  async getRuntime(): Promise<SqliteNativeRuntimeFacade> {
    throw new MemoryIndexUnavailableError('SQLite memory index is unavailable')
  }
  async reconcilePartition(): Promise<void> {
    return
  }
  async query(): Promise<readonly IndexedMemoryEntry[]> {
    return []
  }
  async isPartitionReady(): Promise<boolean> {
    return false
  }
  async reinforce(): Promise<void> {
    return
  }
  async applyDecay(): Promise<void> {
    return
  }
  async archiveColdEntries(): Promise<void> {
    return
  }
  async markDirty(): Promise<void> {
    return
  }
  async rebuildEdges(): Promise<void> {
    return
  }
  async expandViaEdges(input: {
    partition: MemoryPartition
    seeds: readonly IndexedMemoryEntry[]
    target: MemoryIndexQuery['target']
    maxEntries: number
  }): Promise<readonly IndexedMemoryEntry[]> {
    return input.seeds
  }
  async deletePartition(): Promise<void> {
    return
  }
  async findPartitionBySourcePath(): Promise<MemoryPartition | null> {
    return null
  }
  async runReflection(): Promise<void> {
    return
  }
}

export const createUnavailableMemoryIndexStore =
  (): MemoryIndexMaintenanceStore => new UnavailableMemoryIndexStore()

export async function openMemoryIndexStore(
  options: MemoryIndexStoreOptions,
): Promise<MemoryIndexMaintenanceStore> {
  if (!getAbsoluteYoloMemoryIndexPath(options.app, options.getSettings()))
    return createUnavailableMemoryIndexStore()
  try {
    const store = new SqliteMemoryIndexStore(options)
    await store.initialize()
    return store
  } catch (error) {
    console.warn('[YOLO][MemoryIndex] failed to open SQLite store', error)
    return createUnavailableMemoryIndexStore()
  }
}
