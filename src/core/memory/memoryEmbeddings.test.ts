import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { openSqliteRuntime } from '../../database/sqlite/sqliteNativeRuntime'
import { initializeMemoryIndexSchema } from './memoryIndexSchema'
import { MemoryEmbeddingStore } from './memoryEmbeddings'

const key = (localId: number) => ({
  partitionKey: 'global',
  memoryKey: `global::${localId}`,
  localId,
})

describe('MemoryEmbeddingStore', () => {
  let dbPath: string
  let runtime: ReturnType<typeof openSqliteRuntime>

  beforeEach(() => {
    dbPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'memory-embeddings-')),
      'index.sqlite',
    )
    runtime = openSqliteRuntime({ dbPath })
    initializeMemoryIndexSchema(runtime)
  })

  afterEach(() => {
    runtime.close()
  })

  it('upserts, replaces, and searches by cosine similarity', () => {
    const store = new MemoryEmbeddingStore(runtime)
    store.upsert(key(1), [1, 0, 0])
    store.upsert(key(2), [0, 1, 0])
    store.upsert(key(3), [1, 1, 0])

    const hits = store.search('global', [1, 0, 0], 3)
    expect(hits[0].localId).toBe(1)
    expect(hits[0].score).toBeCloseTo(1)
    expect(hits[1].localId).toBe(3)

    // Replace entry 1 with a different vector.
    store.upsert(key(1), [0, 1, 0])
    const after = store.search('global', [1, 0, 0], 3)
    expect(after[0].localId).toBe(3)
    // Entries 1 and 2 are both orthogonal to [1,0,0] now — ties may order
    // either way, but neither should outrank the positive hit.
    expect(new Set(after.slice(1).map((h) => h.localId))).toEqual(
      new Set([1, 2]),
    )
  })

  it('filters search hits to the query embedding dimension', () => {
    const store = new MemoryEmbeddingStore(runtime)
    store.upsert(key(1), [1, 0, 0])
    store.upsert(key(2), [0, 1, 0, 0])
    store.upsert(key(3), [0, 0, 1])

    const hits = store.search('global', [1, 0, 0], 3)
    expect(hits.map((h) => h.localId)).toEqual([1, 3])
    // The 4-dimensional row never enters the cosine math (no garbage scores).
    expect(hits.every((h) => h.score >= 0 && h.score <= 1)).toBe(true)
  })

  it('deletes by memory key and clears a partition', () => {
    const store = new MemoryEmbeddingStore(runtime)
    store.upsert(key(1), [1, 0, 0])
    store.upsert(key(2), [0, 1, 0])

    store.delete('global', ['global::1'])
    expect(store.search('global', [1, 0, 0], 3).map((h) => h.localId)).toEqual(
      [2],
    )

    store.clearPartition('global')
    expect(store.search('global', [1, 0, 0], 3)).toEqual([])
  })
})
