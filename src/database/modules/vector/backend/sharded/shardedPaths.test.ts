import {
  getShardedIndexRoot,
  getShardedManifestPath,
  getShardedModelRoot,
  getShardedShardRoot,
  getShardedStagedManifestPath,
  getShardedTempShardRoot,
} from './shardedPaths'

describe('shardedPaths', () => {
  it('derives the v1 layout under baseDir', () => {
    expect(getShardedIndexRoot('/vault/.yolo')).toBe(
      '/vault/.yolo/rag-index/v1',
    )
    expect(getShardedManifestPath('/vault/.yolo')).toBe(
      '/vault/.yolo/rag-index/v1/manifest.json',
    )
    expect(getShardedStagedManifestPath('/vault/.yolo')).toBe(
      '/vault/.yolo/rag-index/v1/manifest.next.json',
    )
    expect(getShardedModelRoot('/vault/.yolo', 'm1-d256')).toBe(
      '/vault/.yolo/rag-index/v1/models/m1-d256',
    )
    expect(getShardedShardRoot('/vault/.yolo', 'm1-d256', '000001')).toBe(
      '/vault/.yolo/rag-index/v1/models/m1-d256/shards/000001',
    )
    expect(
      getShardedTempShardRoot('/vault/.yolo', 'm1-d256', 'run-1', '000001'),
    ).toContain('.build-run-1-000001')
  })

  it('normalizes trailing slashes and backslashes in baseDir', () => {
    expect(getShardedIndexRoot('/vault/.yolo/')).toBe(
      '/vault/.yolo/rag-index/v1',
    )
    expect(getShardedIndexRoot('C:\\vault\\.yolo')).toBe(
      'C:/vault/.yolo/rag-index/v1',
    )
  })
})
