import type { VectorNamespace } from './VectorStore'

// Keep user_version = 3 for backward compatibility with already-created
// on-disk sqlite RAG databases from earlier iterations of this backend.
export const SQLITE_SCHEMA_VERSION = 3
export const SQLITE_COARSE_DIMENSION = 256

export function validateNamespaceForSqlite(
  namespace: VectorNamespace,
): VectorNamespace {
  if (namespace.distanceMetric !== 'cosine') {
    throw new Error(
      `sqlite backend only supports cosine distance, received ${namespace.distanceMetric}`,
    )
  }

  if (
    !Number.isInteger(namespace.dimension) ||
    namespace.dimension <= 0 ||
    !Number.isFinite(namespace.dimension)
  ) {
    throw new Error(
      `sqlite backend requires a positive integer dimension, received ${namespace.dimension}`,
    )
  }

  return namespace
}

export function buildCreateSchemaSql(
  namespace: VectorNamespace,
  namespaceId: string,
): string[] {
  const validatedNamespace = validateNamespaceForSqlite(namespace)
  const dimension = validatedNamespace.dimension
  const escapedNamespaceId = quoteSqlString(namespaceId)

  return [
    `
create table if not exists rag_namespaces (
  id text primary key,
  provider text not null,
  model text not null,
  dimension integer not null,
  distance_metric text not null,
  embedding_encoding text,
  tokenizer text,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
);
insert into rag_namespaces (
  id,
  provider,
  model,
  dimension,
  distance_metric,
  embedding_encoding,
  tokenizer
) values (
  ${escapedNamespaceId},
  ${quoteSqlString(validatedNamespace.provider)},
  ${quoteSqlString(validatedNamespace.model)},
  ${dimension},
  ${quoteSqlString(validatedNamespace.distanceMetric)},
  ${quoteSqlString(validatedNamespace.embeddingEncoding ?? null)},
  ${quoteSqlString(validatedNamespace.tokenizer ?? null)}
)
on conflict(id) do update set
  provider = excluded.provider,
  model = excluded.model,
  dimension = excluded.dimension,
  distance_metric = excluded.distance_metric,
  embedding_encoding = excluded.embedding_encoding,
  tokenizer = excluded.tokenizer,
  updated_at = unixepoch();
    `.trim(),
    `
create table if not exists rag_files (
  id text primary key,
  namespace_id text not null references rag_namespaces(id) on delete cascade,
  path text not null,
  mtime integer not null,
  content_hash text,
  created_at integer not null default (unixepoch()),
  updated_at integer not null default (unixepoch())
, unique(namespace_id, path)
);
create index if not exists rag_files_namespace_path_idx
  on rag_files(namespace_id, path);
    `.trim(),
    `
create table if not exists rag_chunks (
  id text primary key,
  file_id text not null references rag_files(id) on delete cascade,
  chunk_id text not null,
  path text not null,
  text text not null,
  content_hash text not null,
  line_start integer,
  line_end integer,
  block_id text,
  heading_path_json text,
  page integer,
  metadata_json text not null,
  created_at integer not null default (unixepoch()),
  unique(file_id, chunk_id)
);
create index if not exists rag_chunks_file_id_idx on rag_chunks(file_id);
    `.trim(),
    `
create table if not exists rag_embeddings (
  rowid integer primary key,
  embedding blob not null
);
    `.trim(),
    `
create table if not exists rag_coarse_embeddings (
  rowid integer primary key,
  embedding blob not null,
  chunk_id text not null,
  file_id text not null
);
create index if not exists rag_coarse_embeddings_file_id_idx
  on rag_coarse_embeddings(file_id);
    `.trim(),
    `
create table if not exists metadata_key_embeddings (
  key text not null,
  embedding_model_id text not null,
  dimension integer not null,
  embedding_json text not null,
  updated_at integer not null default (unixepoch()),
  primary key (key, embedding_model_id, dimension)
);
    `.trim(),
    `
create table if not exists query_embedding_cache (
  model_id text not null,
  query_hash text not null,
  dimension integer not null,
  embedding blob not null,
  created_at_ms integer not null,
  last_accessed_at_ms integer not null,
  primary key (model_id, query_hash)
);
create index if not exists query_embedding_cache_lru_idx
  on query_embedding_cache(last_accessed_at_ms);
    `.trim(),
  ]
}

export function buildSchemaMigrationSql(
  fromVersion: number,
  namespace: VectorNamespace,
  namespaceId: string,
): string[] {
  if (fromVersion < 0 || fromVersion > SQLITE_SCHEMA_VERSION) {
    throw new Error(`Unsupported sqlite schema version ${fromVersion}`)
  }

  if (fromVersion === SQLITE_SCHEMA_VERSION) {
    return buildCreateSchemaSql(namespace, namespaceId)
  }

  if (fromVersion === 1) {
    return [`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`]
  }

  if (fromVersion === 2) {
    return [`PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`]
  }

  if (fromVersion !== 0) {
    throw new Error(
      `No sqlite migration path from schema version ${fromVersion}`,
    )
  }

  return [
    ...buildCreateSchemaSql(namespace, namespaceId),
    `PRAGMA user_version = ${SQLITE_SCHEMA_VERSION}`,
  ]
}

export function buildClearNamespaceSql(): string[] {
  return [
    `
delete from rag_coarse_embeddings
where rowid in (
  select rc.rowid
  from rag_chunks rc
  inner join rag_files rf on rf.id = rc.file_id
  where rf.namespace_id = ?
)
    `.trim(),
    `
delete from rag_embeddings
where rowid in (
  select rc.rowid
  from rag_chunks rc
  inner join rag_files rf on rf.id = rc.file_id
  where rf.namespace_id = ?
)
    `.trim(),
    `
delete from rag_chunks
where file_id in (
  select id from rag_files where namespace_id = ?
)
    `.trim(),
    'delete from rag_files where namespace_id = ?',
  ]
}

export function buildUserVersionCheckSql(): string {
  return 'PRAGMA user_version'
}

function quoteSqlString(value: string | null): string {
  if (value === null) {
    return 'null'
  }

  return `'${value.replace(/'/g, "''")}'`
}
