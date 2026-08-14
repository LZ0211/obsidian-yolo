import {
  QueryEmbeddingCache,
  queryEmbeddingCacheKey,
} from './queryEmbeddingCache'

describe('QueryEmbeddingCache', () => {
  it('writes an embedding and enforces the LRU entry limit', () => {
    const exec = jest.fn()
    const cache = new QueryEmbeddingCache({
      queryOne: jest.fn(() => null),
      exec,
    })
    cache.set('model', 'query', [0.1, 0.2])
    expect(exec).toHaveBeenCalledTimes(2)
  })

  it('includes the configured dimension in the query key', () => {
    expect(queryEmbeddingCacheKey('model', 'query', 3)).not.toBe(
      queryEmbeddingCacheKey('model', 'query', 4),
    )
  })
})
