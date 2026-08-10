import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { SqliteVectorStore } from './SqliteVectorStore'
import type { VectorNamespace } from './VectorStore'

const namespace: VectorNamespace = {
  provider: 'openai',
  model: 'text-embedding-3-large',
  dimension: 3,
  distanceMetric: 'cosine',
}

describe('SqliteVectorStore cancellation', () => {
  it('rejects a pre-aborted vector search before touching the namespace', async () => {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sqlite-rag-cancellation-test-'),
    )
    const store = new SqliteVectorStore({ baseDir: path.join(rootDir, 'data') })
    await store.open()
    const controller = new AbortController()
    controller.abort()

    await expect(
      store.search(namespace, [1, 0, 0], {
        topK: 5,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    await store.close()
    fs.rmSync(rootDir, { recursive: true, force: true })
  })
})
