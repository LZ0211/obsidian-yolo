import { parseShardedManifest } from './shardedManifest'

describe('shardedManifest', () => {
  it('parses a valid manifest', () => {
    const m = parseShardedManifest({
      schemaVersion: 1,
      formatVersion: 1,
      activeModel: 'm1',
      updatedAt: 1,
      shards: [
        {
          id: '000001',
          relativePath: 'models/m1/shards/000001',
          state: 'ready',
          dimension: 256,
          vectorCount: 100,
          checksums: {
            chunksSqlite: 'a',
            vectorsF32: 'b',
            indexBin: 'c',
            tombstonesBin: 'd',
            shardMeta: 'e',
          },
        },
      ],
    })
    expect(m.shards[0]?.state).toBe('ready')
    expect(m.shards[0]?.relativePath).toBe('models/m1/shards/000001')
  })

  it('accepts a building shard', () => {
    const m = parseShardedManifest({
      schemaVersion: 1,
      formatVersion: 1,
      activeModel: 'm1',
      updatedAt: 1,
      shards: [
        {
          id: '000002',
          relativePath: 'models/m1/shards/000002',
          state: 'building',
          dimension: 256,
          vectorCount: 0,
          checksums: {
            chunksSqlite: 'a',
            vectorsF32: 'b',
            indexBin: 'c',
            tombstonesBin: 'd',
            shardMeta: 'e',
          },
        },
      ],
    })
    expect(m.shards[0]?.state).toBe('building')
  })

  it('rejects a shard missing checksums', () => {
    expect(() =>
      parseShardedManifest({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: 'm1',
        updatedAt: 1,
        shards: [
          {
            id: '1',
            relativePath: 'x',
            state: 'ready',
            dimension: 256,
            vectorCount: 0,
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects a manifest with an unknown shard state', () => {
    expect(() =>
      parseShardedManifest({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: 'm1',
        updatedAt: 1,
        shards: [
          {
            id: '1',
            relativePath: 'x',
            state: 'wat',
            dimension: 256,
            vectorCount: 0,
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects a manifest with a non-positive shard dimension', () => {
    expect(() =>
      parseShardedManifest({
        schemaVersion: 1,
        formatVersion: 1,
        activeModel: 'm1',
        updatedAt: 1,
        shards: [
          {
            id: '1',
            relativePath: 'x',
            state: 'ready',
            dimension: 0,
            vectorCount: 0,
            checksums: {
              chunksSqlite: 'a',
              vectorsF32: 'b',
              indexBin: 'c',
              tombstonesBin: 'd',
              shardMeta: 'e',
            },
          },
        ],
      }),
    ).toThrow()
  })

  it('rejects non-object input', () => {
    expect(() => parseShardedManifest(null)).toThrow()
    expect(() => parseShardedManifest('manifest')).toThrow()
  })
})
