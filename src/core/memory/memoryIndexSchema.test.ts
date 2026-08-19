import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { openSqliteRuntime } from '../../database/sqlite/sqliteNativeRuntime'

import {
  MEMORY_INDEX_SCHEMA_VERSION,
  MemoryIndexUnavailableError,
  initializeMemoryIndexSchema,
  trimMemoryMaintenanceLog,
} from './memoryIndexSchema'

describe('memory index schema', () => {
  let root = ''
  let runtime: ReturnType<typeof openSqliteRuntime>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-schema-'))
    runtime = openSqliteRuntime({ dbPath: path.join(root, 'index.sqlite') })
    initializeMemoryIndexSchema(runtime)
  })

  afterEach(() => {
    runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates every version-one table idempotently', () => {
    initializeMemoryIndexSchema(runtime)
    const names = runtime
      .query<{
        name: string
      }>(
        "select name from sqlite_master where type = 'table' and name like 'memory_%'",
      )
      .map((row) => row.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'memory_schema_meta',
        'memory_index',
        'memory_keywords',
        'memory_edges',
        'memory_reflections',
        'memory_partition_state',
        'memory_maintenance_log',
      ]),
    )
    expect(
      runtime.queryOne<{ value: string }>(
        "select value from memory_schema_meta where key = 'schema_version'",
      )?.value,
    ).toBe(String(MEMORY_INDEX_SCHEMA_VERSION))
  })

  it('rejects incompatible versions with a typed unavailable error', () => {
    runtime.exec(
      "update memory_schema_meta set value = '99' where key = 'schema_version'",
    )
    expect(() => initializeMemoryIndexSchema(runtime)).toThrow(
      MemoryIndexUnavailableError,
    )
  })

  it('bounds maintenance log rows per partition', () => {
    for (let index = 0; index < 300; index += 1) {
      runtime.exec(
        'insert into memory_maintenance_log (partition_key, operation, status, created_at) values (?, ?, ?, ?)',
        ['global', 'test', 'completed', index],
      )
    }
    trimMemoryMaintenanceLog(runtime, 'global')
    expect(
      runtime.queryOne<{ count: number }>(
        'select count(*) as count from memory_maintenance_log where partition_key = ?',
        ['global'],
      )?.count,
    ).toBe(256)
  })
})

/**
 * Pre-v4 DDL (before the `last_reinforced_at` column). Kept verbatim so the
 * migration test exercises the exact shape the v3 schema creator produced.
 */
const V3_SCHEMA_SQL: readonly string[] = [
  `create table if not exists memory_schema_meta (
    key text primary key,
    value text not null
  );`,
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

describe('legacy schema migration (v3 → v4 reinforced-at column)', () => {
  it('adds last_reinforced_at to a v3 database, preserves rows, and stays idempotent', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'memory-index-migrate-v4-'),
    )
    const dbPath = path.join(root, 'index.sqlite')
    const legacy = openSqliteRuntime({ dbPath })
    try {
      for (const sql of V3_SCHEMA_SQL) legacy.exec(sql)
      legacy.exec(
        "insert into memory_schema_meta (key, value) values ('schema_version', '3')",
      )
      legacy.exec(
        `insert into memory_index
         (partition_key, memory_key, scope, assistant_id, local_id, category, sector, content, keywords_json,
          content_hash, salience, last_recalled_at,
          created_at, updated_at, source_path, source_file_fingerprint, entry_fingerprint, parser_version)
         values ('global', 'global::Memory_1', 'global', null, 'Memory_1', 'other', 'episodic', 'v3 preserved', '[]',
          'h', 0.6, 12345, 1, 2, 'global.md', 'fp-v1', 'e-v1', 'p')`,
      )
    } finally {
      legacy.close()
    }

    const migrated = openSqliteRuntime({ dbPath })
    try {
      initializeMemoryIndexSchema(migrated)
      const columns = migrated
        .query<{ name: string }>('pragma table_info(memory_index)')
        .map(({ name }) => name)
      expect(columns).toContain('last_reinforced_at')
      expect(
        migrated.queryOne<{ value: string }>(
          "select value from memory_schema_meta where key = 'schema_version'",
        )?.value,
      ).toBe(String(MEMORY_INDEX_SCHEMA_VERSION))
      const row = migrated.queryOne<{
        salience: number
        last_recalled_at: number | null
        last_reinforced_at: number | null
      }>(
        'select salience, last_recalled_at, last_reinforced_at from memory_index where partition_key = ? and local_id = ?',
        ['global', 'Memory_1'],
      )
      expect(row?.salience).toBe(0.6)
      expect(row?.last_recalled_at).toBe(12345)
      expect(row?.last_reinforced_at).toBeNull()

      // Repeated initialization must not rewrite rows or reset the version.
      initializeMemoryIndexSchema(migrated)
      expect(
        migrated.queryOne<{ value: string }>(
          "select value from memory_schema_meta where key = 'schema_version'",
        )?.value,
      ).toBe(String(MEMORY_INDEX_SCHEMA_VERSION))
      const unchanged = migrated.queryOne<{ salience: number }>(
        'select salience from memory_index where partition_key = ? and local_id = ?',
        ['global', 'Memory_1'],
      )
      expect(unchanged?.salience).toBe(0.6)
    } finally {
      migrated.close()
      fs.rmSync(root, { recursive: true, force: true })
    }
  })
})
