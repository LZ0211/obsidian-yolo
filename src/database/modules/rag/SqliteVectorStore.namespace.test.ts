import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { vectorNamespaceId } from './namespaceId'
import { SqliteVectorStore } from './SqliteVectorStore'
import { type VectorFileWrite, type VectorNamespace } from './VectorStore'

const baseNamespace: VectorNamespace = {
  provider: 'openai',
  model: 'text-embedding-3-large',
  dimension: 4,
  distanceMetric: 'cosine',
}

function createTempBaseDir() {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'sqlite-rag-namespace-test-'),
  )
  const baseDir = path.join(rootDir, 'data')
  fs.mkdirSync(baseDir, { recursive: true })
  return { rootDir, baseDir }
}

function vectorFile(
  filePath: string,
  chunks: VectorFileWrite['chunks'],
  contentHash = 'file-hash',
): VectorFileWrite {
  return {
    path: filePath,
    mtime: 1,
    contentHash,
    chunks,
  }
}

function vectorChunk(
  chunkId: string,
  filePath: string,
  embedding: number[],
): VectorFileWrite['chunks'][number] {
  return {
    chunkId,
    path: filePath,
    text: `text-${chunkId}`,
    contentHash: `hash-${chunkId}`,
    embedding,
    location: {},
    metadataJson: { termId: chunkId },
  }
}

describe('SqliteVectorStore namespace lifecycle', () => {
  it('batch reads persisted full vectors with duplicate and missing paths', async () => {
    const { rootDir, baseDir } = createTempBaseDir()
    const store = new SqliteVectorStore({ baseDir })
    await store.open()

    await store.replaceFile(
      baseNamespace,
      vectorFile('term:a', [
        vectorChunk('chunk-a', 'term:a', [1, 0, 0, 0]),
        vectorChunk('chunk-b', 'term:a', [0, 1, 0, 0]),
      ]),
    )

    const files = await store.getStoredFileVectors(baseNamespace, [
      'term:a',
      'term:a',
      'missing',
    ])

    expect(files.get('term:a')).toEqual({
      path: 'term:a',
      contentHash: 'file-hash',
      chunks: [
        expect.objectContaining({
          chunkId: 'chunk-a',
          path: 'term:a',
          contentHash: 'hash-chunk-a',
          embedding: expect.any(Array),
          metadataJson: { termId: 'chunk-a' },
        }),
        expect.objectContaining({ chunkId: 'chunk-b' }),
      ],
    })
    expect(files.has('missing')).toBe(false)

    await expect(
      store.getStoredFileVectors(
        baseNamespace,
        Array.from({ length: 257 }, (_, index) => `term:${index}`),
      ),
    ).rejects.toThrow('256')

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('rejects unsafe namespace IDs and drops only the validated namespace', async () => {
    const { rootDir, baseDir } = createTempBaseDir()
    const store = new SqliteVectorStore({ baseDir })
    const documentNamespace = { ...baseNamespace, corpus: 'documents' }
    const termNamespace = { ...baseNamespace, corpus: 'term-relations-test' }
    await store.open()
    await store.replaceFile(
      documentNamespace,
      vectorFile('document.md', [
        vectorChunk('document', 'document.md', [1, 0, 0, 0]),
      ]),
    )
    await store.replaceFile(
      termNamespace,
      vectorFile('term:a', [vectorChunk('term', 'term:a', [1, 0, 0, 0])]),
    )

    for (const unsafeId of [
      '',
      '.',
      '..',
      '../escape',
      'nested/name',
      '\\absolute',
      '/absolute',
    ]) {
      await expect(store.dropNamespaceById(unsafeId)).rejects.toThrow()
    }

    await store.dropNamespace(termNamespace)
    await store.dropNamespaceById('term-relations-missing')
    expect(await store.listNamespaces()).toEqual([
      vectorNamespaceId(documentNamespace),
    ])
    await expect(store.getStatus(termNamespace)).resolves.toMatchObject({
      rebuildRequired: true,
    })
    expect(await store.getStats(documentNamespace)).toMatchObject({
      fileCount: 1,
      chunkCount: 1,
    })

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('purges only the exact term namespace prefix without requiring open()', async () => {
    const { rootDir, baseDir } = createTempBaseDir()
    const store = new SqliteVectorStore({ baseDir })
    const documentNamespace = { ...baseNamespace, corpus: 'documents' }
    const termNamespace = { ...baseNamespace, corpus: 'term-relations-test' }
    await store.open()
    await store.replaceFile(
      documentNamespace,
      vectorFile('document.md', [
        vectorChunk('document', 'document.md', [1, 0, 0, 0]),
      ]),
    )
    await store.replaceFile(
      termNamespace,
      vectorFile('term:a', [vectorChunk('term', 'term:a', [1, 0, 0, 0])]),
    )
    const orphanId = 'term-relations-orphan'
    fs.mkdirSync(path.join(baseDir, 'rag', orphanId), { recursive: true })
    await store.close()

    const reopened = new SqliteVectorStore({ baseDir })
    await expect(
      reopened.purgeNamespacesByPrefixForPrivacy({
        namespaceIdPrefix: 'term-relations-',
        confirmation: 'wrong',
      }),
    ).rejects.toThrow('PURGE_RELATION_HISTORY')

    await expect(
      reopened.purgeNamespacesByPrefixForPrivacy({
        namespaceIdPrefix: 'term-relations-',
        confirmation: 'PURGE_RELATION_HISTORY',
      }),
    ).resolves.toEqual(
      expect.arrayContaining([vectorNamespaceId(termNamespace), orphanId]),
    )
    expect(
      fs.existsSync(
        path.join(baseDir, 'rag', vectorNamespaceId(documentNamespace)),
      ),
    ).toBe(true)
    expect(fs.existsSync(path.join(baseDir, 'rag', orphanId))).toBe(false)

    fs.rmSync(rootDir, { recursive: true, force: true })
  })
})
