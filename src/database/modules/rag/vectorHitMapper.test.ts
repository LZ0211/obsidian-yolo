import {
  type SqliteVectorHitRow,
  mapSqliteRowToVectorHit,
} from './vectorHitMapper'
import { VectorStoreError } from './VectorStore'

function makeRow(
  overrides: Partial<SqliteVectorHitRow> = {},
): SqliteVectorHitRow {
  return {
    id: 'row-1',
    chunk_id: 'chunk-1',
    path: 'docs/example.md',
    excerpt: 'Example excerpt',
    score: 0.75,
    source: 'vector',
    line_start: 10,
    line_end: 12,
    block_id: 'block-1',
    heading_path_json: JSON.stringify(['Section', 'Subsection']),
    page: 3,
    metadata_json: JSON.stringify({ title: 'Example title', tag: 'note' }),
    ...overrides,
  }
}

describe('mapSqliteRowToVectorHit', () => {
  test('throws database_corrupt when heading_path_json is invalid JSON', () => {
    expect(() =>
      mapSqliteRowToVectorHit(
        makeRow({
          heading_path_json: '{"broken"',
        }),
      ),
    ).toThrow(VectorStoreError)

    try {
      mapSqliteRowToVectorHit(
        makeRow({
          heading_path_json: '{"broken"',
        }),
      )
    } catch (error) {
      expect(error).toBeInstanceOf(VectorStoreError)
      expect((error as VectorStoreError).code).toBe('database_corrupt')
    }
  })

  test('throws database_corrupt when metadata_json is invalid JSON', () => {
    expect(() =>
      mapSqliteRowToVectorHit(
        makeRow({
          metadata_json: '{"broken"',
        }),
      ),
    ).toThrow(VectorStoreError)

    try {
      mapSqliteRowToVectorHit(
        makeRow({
          metadata_json: '{"broken"',
        }),
      )
    } catch (error) {
      expect(error).toBeInstanceOf(VectorStoreError)
      expect((error as VectorStoreError).code).toBe('database_corrupt')
    }
  })

  test('throws database_corrupt when metadata_json is not a JSON object', () => {
    expect(() =>
      mapSqliteRowToVectorHit(
        makeRow({
          metadata_json: JSON.stringify(['not', 'an', 'object']),
        }),
      ),
    ).toThrow(VectorStoreError)

    try {
      mapSqliteRowToVectorHit(
        makeRow({
          metadata_json: JSON.stringify(['not', 'an', 'object']),
        }),
      )
    } catch (error) {
      expect(error).toBeInstanceOf(VectorStoreError)
      expect((error as VectorStoreError).code).toBe('database_corrupt')
    }
  })

  test('maps a valid lexical row', () => {
    const hit = mapSqliteRowToVectorHit(
      makeRow({
        source: 'lexical',
        block_id: '',
        heading_path_json: undefined,
        metadata_json: JSON.stringify({
          title: 'Lexical title',
          section: 'intro',
        }),
        page: null,
      }),
    )

    expect(hit).toEqual({
      id: 'row-1',
      chunkId: 'chunk-1',
      path: 'docs/example.md',
      title: 'Lexical title',
      excerpt: 'Example excerpt',
      score: 0.75,
      source: 'lexical',
      location: {
        lineStart: 10,
        lineEnd: 12,
        blockId: undefined,
        headingPath: undefined,
        page: undefined,
      },
      metadataJson: {
        title: 'Lexical title',
        section: 'intro',
      },
    })
  })
})
