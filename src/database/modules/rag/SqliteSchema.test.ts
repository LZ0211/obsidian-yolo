import {
  SQLITE_COARSE_DIMENSION,
  SQLITE_SCHEMA_VERSION,
  buildClearNamespaceSql,
  buildCreateSchemaSql,
  buildSchemaMigrationSql,
  buildUserVersionCheckSql,
  validateNamespaceForSqlite,
} from './SqliteSchema'
import type { VectorNamespace } from './VectorStore'

const namespace: VectorNamespace = {
  provider: 'openai',
  model: 'text-embedding-3-large',
  dimension: 1536,
  distanceMetric: 'cosine',
}

describe('SqliteSchema', () => {
  it('builds schema DDL for vector rag tables', () => {
    const statements = buildCreateSchemaSql(namespace, 'ns-123')
    const joined = statements.join('\n')

    expect(statements.length).toBeGreaterThanOrEqual(6)
    expect(statements[0]).toContain('create table if not exists rag_namespaces')
    expect(statements[1]).toContain('create table if not exists rag_files')
    expect(statements[2]).toContain('create table if not exists rag_chunks')
    expect(statements[3]).toContain('create table if not exists rag_embeddings')
    expect(statements[4]).toContain(
      'create table if not exists rag_coarse_embeddings',
    )
    expect(statements[5]).toContain(
      'create table if not exists metadata_key_embeddings',
    )
    expect(statements[6]).toContain(
      'create table if not exists query_embedding_cache',
    )
    expect(joined).not.toContain('rag_chunks_fts')
    expect(joined).not.toContain('rag_fts_state')
    expect(joined).not.toContain('chunk_metadata_kv')
  })

  it('keeps create-schema DDL separate from PRAGMA user_version writes', () => {
    const statements = buildCreateSchemaSql(namespace, 'ns-123')

    expect(statements.join('\n')).not.toContain('PRAGMA user_version')
  })

  it('keeps the comma before unique(namespace_id, path) in rag_files DDL', () => {
    const statements = buildCreateSchemaSql(namespace, 'ns-123')

    expect(statements[1]).toContain(', unique(namespace_id, path)')
  })

  it('keeps coarse embeddings as ordinary SQLite BLOB rows', () => {
    const statements = buildCreateSchemaSql(namespace, 'ns-123')

    expect(SQLITE_COARSE_DIMENSION).toBe(256)
    expect(statements[4]).toContain('embedding blob not null')
    expect(statements[4]).toContain('chunk_id text not null')
    expect(statements[4]).toContain('file_id text not null')
    expect(statements[4]).not.toContain('vec0')
  })

  it('rejects invalid dimensions', () => {
    expect(() =>
      validateNamespaceForSqlite({ ...namespace, dimension: 0 }),
    ).toThrow(/dimension/i)
    expect(() =>
      validateNamespaceForSqlite({ ...namespace, dimension: 1.5 }),
    ).toThrow(/dimension/i)
    expect(() =>
      validateNamespaceForSqlite({ ...namespace, dimension: Number.NaN }),
    ).toThrow(/dimension/i)
  })

  it('rejects distance metrics other than cosine', () => {
    expect(() =>
      validateNamespaceForSqlite({
        ...namespace,
        distanceMetric: 'l2' as VectorNamespace['distanceMetric'],
      }),
    ).toThrow(/cosine/i)
  })

  it('builds clearNamespace SQL that deletes vectors, chunks, and files but keeps the namespace row', () => {
    const statements = buildClearNamespaceSql()

    expect(statements).toHaveLength(4)
    expect(statements[0]).toContain('delete from rag_coarse_embeddings')
    expect(statements[1]).toContain('delete from rag_embeddings')
    expect(statements[2]).toContain('delete from rag_chunks')
    expect(statements[3]).toContain('delete from rag_files')
    expect(statements.join('\n')).not.toContain('delete from rag_namespaces')
  })

  it('builds the user_version check SQL', () => {
    expect(buildUserVersionCheckSql()).toBe('PRAGMA user_version')
  })

  it('builds a v0 to current migration that writes user_version last', () => {
    const statements = buildSchemaMigrationSql(0, namespace, 'ns-123')

    expect(statements).toHaveLength(8)
    expect(statements[0]).toContain('create table if not exists rag_namespaces')
    expect(statements[4]).toContain(
      'create table if not exists rag_coarse_embeddings',
    )
    expect(statements[5]).toContain(
      'create table if not exists metadata_key_embeddings',
    )
    expect(statements[6]).toContain(
      'create table if not exists query_embedding_cache',
    )
    expect(statements.at(-1)).toBe(
      `PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`,
    )
  })

  it('builds migration from schema version 1 to current', () => {
    const statements = buildSchemaMigrationSql(1, namespace, 'ns-123')
    const joined = statements.join('\n')

    expect(joined).not.toContain('rag_chunks_fts')
    expect(joined).not.toContain('rag_fts_state')
    expect(statements.at(-1)).toBe('PRAGMA user_version = 3')
  })

  it('keeps current-version setup idempotent without rewriting user_version', () => {
    const statements = buildSchemaMigrationSql(
      SQLITE_SCHEMA_VERSION,
      namespace,
      'ns-123',
    )

    expect(statements.length).toBeGreaterThanOrEqual(5)
    expect(statements[0]).toContain('create table if not exists rag_namespaces')
    expect(statements.join('\n')).not.toContain('PRAGMA user_version')
  })

  it('rejects unknown historical schema versions', () => {
    expect(() => buildSchemaMigrationSql(-1, namespace, 'ns-123')).toThrow(
      /schema version/i,
    )
  })

  it('upgrades schema version to 3 without metadata or FTS objects', () => {
    const statements = buildSchemaMigrationSql(0, namespace, 'ns-123')
    const joined = statements.join('\n')

    expect(SQLITE_SCHEMA_VERSION).toBe(3)
    expect(joined).not.toContain('metadata_extraction_version')
    expect(joined).not.toContain('metadata_index_state')
    expect(joined).not.toContain('chunk_metadata_kv')
    expect(joined).not.toContain('rag_chunks_fts')
    expect(statements.at(-1)).toBe('PRAGMA user_version = 3')
  })

  it('keeps v2 migration minimal', () => {
    const statements = buildSchemaMigrationSql(2, namespace, 'ns-123')
    const joined = statements.join('\n').toLowerCase()

    expect(joined).not.toContain('chunk_metadata_kv')
    expect(joined).not.toContain('rag_chunks_fts')
    expect(statements.at(-1)).toBe('PRAGMA user_version = 3')
  })
})
