import { QueryEmbeddingCache } from './queryEmbeddingCache'

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
})
