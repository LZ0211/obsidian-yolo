import type { SqliteNativeRuntimeFacade } from '../../database/sqlite/sqliteNativeRuntime'

export const MEMORY_INDEX_SCHEMA_VERSION = 4

export class MemoryIndexUnavailableError extends Error {
  readonly code = 'memory_index_unavailable'

  constructor(message: string, options?: { cause?: unknown }) {
    super(message)
    this.name = 'MemoryIndexUnavailableError'
    if (options && 'cause' in options)
      (this as Error & { cause?: unknown }).cause = options.cause
  }
}

export const buildMemoryIndexSchemaSql = (): readonly string[] => [
  `create table if not exists memory_schema_meta (
    key text primary key,
    value text not null
  );`,
  // v4: `last_reinforced_at` records the last successful reinforcement so
  // recall hits inside the one-hour window only refresh `last_recalled_at`
  // instead of bumping salience again. Existing v3 databases gain the column
  // through the explicit migration, not this DDL (create table if not exists
  // never alters an existing table).
  `create table if not exists memory_index (
    partition_key text not null,
    memory_key text not null unique,
    scope text not null check (scope in ('global', 'assistant')),
    assistant_id text,
    local_id text not null,
    category text not null check (category in ('profile', 'preferences', 'other')),
    sector text not null check (sector in ('episodic', 'semantic', 'procedural', 'emotional', 'reflective')),
    content text not null,
    keywords_json text not null,
    content_hash text not null,
    salience real not null default 0.5 check (salience >= 0 and salience <= 1),
    last_recalled_at integer,
    last_reinforced_at integer,
    created_at integer not null,
    updated_at integer not null,
    source_path text not null,
    source_file_fingerprint text not null,
    entry_fingerprint text not null,
    parser_version text not null,
    primary key (partition_key, local_id),
    check ((scope = 'global' and assistant_id is null) or
           (scope = 'assistant' and assistant_id is not null))
  );`,
  `create index if not exists idx_memory_partition_score
    on memory_index(partition_key, category, salience, updated_at);`,
  `create table if not exists memory_keywords (
    partition_key text not null,
    local_id text not null,
    keyword text not null,
    primary key (partition_key, local_id, keyword),
    foreign key (partition_key, local_id)
      references memory_index(partition_key, local_id) on delete cascade
  );`,
  `create index if not exists idx_memory_keyword_lookup
    on memory_keywords(partition_key, keyword);`,
  `create table if not exists memory_edges (
    partition_key text not null,
    src_local_id text not null,
    dst_local_id text not null,
    weight real not null check (weight >= 0 and weight <= 1),
    created_at integer not null,
    updated_at integer not null,
    primary key (partition_key, src_local_id, dst_local_id),
    check (src_local_id <> dst_local_id),
    foreign key (partition_key, src_local_id)
      references memory_index(partition_key, local_id) on delete cascade,
    foreign key (partition_key, dst_local_id)
      references memory_index(partition_key, local_id) on delete cascade
  );`,
  `create table if not exists memory_reflections (
    partition_key text not null,
    reflection_id text not null,
    content text not null,
    sector text not null check (sector = 'reflective'),
    source_keys_json text not null,
    source_fingerprint text not null,
    prompt_version text not null,
    created_at integer not null,
    updated_at integer not null,
    primary key (partition_key, reflection_id),
    unique (partition_key, source_fingerprint, prompt_version)
  );`,
  `create table if not exists memory_partition_state (
    partition_key text primary key,
    source_path text not null,
    source_file_fingerprint text not null,
    parser_version text not null,
    dirty_reason text,
    last_reconciled_at integer,
    last_reflection_at integer,
    updated_at integer not null
  );`,
  `create table if not exists memory_maintenance_log (
    id integer primary key,
    partition_key text,
    operation text not null,
    status text not null check (status in ('completed', 'failed')),
    source_file_fingerprint text,
    created_at integer not null
  );`,
  // v2: dense embeddings for semantic (vector) recall. One row per indexed
  // entry, keyed by memory_key (``partition::localId``) so the semantic path
  // aligns with the lexical and graph paths in the RRF fusion. The embedding
  // is produced by the RAG embedding model configured for the vault and
  // written during reconcile.
  `create table if not exists memory_embeddings (
    partition_key text not null,
    memory_key text not null,
    local_id integer not null,
    embedding blob not null,
    dimension integer not null,
    updated_at integer not null,
    primary key (partition_key, memory_key)
  );`,
]

const readSchemaVersion = (
  runtime: SqliteNativeRuntimeFacade,
): number | null => {
  const row = runtime.queryOne<{ value: string }>(
    "select value from memory_schema_meta where key = 'schema_version'",
  )
  if (!row) return null
  const version = Number.parseInt(row.value, 10)
  return Number.isInteger(version) ? version : Number.NaN
}

/**
 * v3 migration: drop the dead `hash_band_0..3` and `consolidated` columns
 * from legacy (v1/v2) databases. The `create table if not exists` DDL never
 * alters an existing table, so legacy rows keep those `not null` columns —
 * and the v3 INSERT (which omits them) would violate NOT NULL and freeze
 * every reconcile. `drop index` first: `alter table drop column` refuses a
 * column still covered by an index.
 */
const dropLegacyMemoryIndexColumns = (
  runtime: SqliteNativeRuntimeFacade,
): void => {
  const columns = new Set(
    runtime
      .query<{ name: string }>('pragma table_info(memory_index)')
      .map(({ name }) => name),
  )
  if (columns.has('hash_band_0')) {
    runtime.exec('drop index if exists idx_memory_partition_hash')
    for (const column of [
      'hash_band_0',
      'hash_band_1',
      'hash_band_2',
      'hash_band_3',
    ]) {
      runtime.exec(`alter table memory_index drop column ${column}`)
    }
  }
  if (columns.has('consolidated')) {
    runtime.exec('alter table memory_index drop column consolidated')
  }
}

/**
 * v4 migration: add the nullable `last_reinforced_at` column to v3
 * databases. `alter table add column` has no `if not exists` form, so probe
 * `pragma table_info` first. Legacy rows read NULL (never reinforced),
 * which opens the reinforcement window on the first hit — the same
 * first-hit semantics a fresh v4 database gets from the DDL.
 */
const addLastReinforcedAtColumn = (
  runtime: SqliteNativeRuntimeFacade,
): void => {
  const columns = new Set(
    runtime
      .query<{ name: string }>('pragma table_info(memory_index)')
      .map(({ name }) => name),
  )
  if (!columns.has('last_reinforced_at')) {
    runtime.exec(
      'alter table memory_index add column last_reinforced_at integer',
    )
  }
}

export function initializeMemoryIndexSchema(
  runtime: SqliteNativeRuntimeFacade,
): void {
  try {
    runtime.exec(
      'create table if not exists memory_schema_meta (key text primary key, value text not null);',
    )
    const current = readSchemaVersion(runtime)
    if (current !== null && current > MEMORY_INDEX_SCHEMA_VERSION) {
      throw new MemoryIndexUnavailableError(
        `Unsupported memory index schema version: ${String(current)}`,
      )
    }
    // Older versions migrate forward: every statement is `create table if not
    // exists`, so re-running the full DDL on a v1 database only adds the new
    // v2 tables and leaves existing data intact; the explicit column drops
    // handle the v1/v2 → v3 dead-column removal that DDL re-run cannot, and
    // the explicit column add handles the v3 → v4 reinforcement timestamp.
    runtime.transaction(() => {
      for (const sql of buildMemoryIndexSchemaSql()) runtime.exec(sql)
      if (current !== null && current < MEMORY_INDEX_SCHEMA_VERSION) {
        dropLegacyMemoryIndexColumns(runtime)
        addLastReinforcedAtColumn(runtime)
      }
      runtime.exec(
        `insert into memory_schema_meta (key, value) values ('schema_version', ?)
         on conflict(key) do update set value = excluded.value`,
        [String(MEMORY_INDEX_SCHEMA_VERSION)],
      )
    })
  } catch (error) {
    if (error instanceof MemoryIndexUnavailableError) throw error
    throw new MemoryIndexUnavailableError(
      'Unable to initialize memory index schema',
      { cause: error },
    )
  }
}

export function trimMemoryMaintenanceLog(
  runtime: SqliteNativeRuntimeFacade,
  partitionKey: string,
): void {
  runtime.exec(
    `delete from memory_maintenance_log
     where partition_key = ? and id not in (
       select id from memory_maintenance_log
       where partition_key = ? order by id desc limit 256
     )`,
    [partitionKey, partitionKey],
  )
}
