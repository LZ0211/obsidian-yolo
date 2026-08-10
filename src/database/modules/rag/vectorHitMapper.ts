import { type VectorHit, VectorStoreError } from './VectorStore'

export type SqliteVectorHitRow = {
  id: string
  chunk_id: string
  path: string
  excerpt: string
  score: number
  source: 'vector' | 'lexical'
  line_start: number | null
  line_end: number | null
  block_id: string | null
  heading_path_json: string | null | undefined
  page: number | null
  metadata_json: string
}

export type MappedVectorHit = Omit<VectorHit, 'source'> & {
  source: 'vector' | 'lexical'
}

function corruptStoreError(message: string): VectorStoreError {
  return new VectorStoreError(
    'database_corrupt',
    'sqlite',
    'rebuild_index',
    message,
  )
}

function parseMetadataJson(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch (error) {
    throw corruptStoreError(
      error instanceof Error
        ? `metadata_json is not valid JSON: ${error.message}`
        : 'metadata_json is not valid JSON',
    )
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw corruptStoreError('metadata_json must contain a JSON object')
  }

  return parsed as Record<string, unknown>
}

function parseHeadingPathJson(
  value: string | null | undefined,
): string[] | undefined {
  if (value == null) {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch (error) {
    throw corruptStoreError(
      error instanceof Error
        ? `heading_path_json is not valid JSON: ${error.message}`
        : 'heading_path_json is not valid JSON',
    )
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some((item) => typeof item !== 'string')
  ) {
    throw corruptStoreError(
      'heading_path_json must contain a JSON string array',
    )
  }

  return parsed
}

export function mapSqliteRowToVectorHit(
  row: SqliteVectorHitRow,
): MappedVectorHit {
  const metadataJson = parseMetadataJson(row.metadata_json)

  return {
    id: row.id,
    chunkId: row.chunk_id,
    path: row.path,
    title:
      typeof metadataJson.title === 'string' ? metadataJson.title : undefined,
    excerpt: row.excerpt,
    score: row.score,
    source: row.source,
    location: {
      lineStart: row.line_start ?? undefined,
      lineEnd: row.line_end ?? undefined,
      blockId:
        row.block_id == null || row.block_id.length === 0
          ? undefined
          : row.block_id,
      headingPath: parseHeadingPathJson(row.heading_path_json),
      page: row.page ?? undefined,
    },
    metadataJson,
  }
}
