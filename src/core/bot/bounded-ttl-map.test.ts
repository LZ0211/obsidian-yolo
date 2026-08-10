import { BoundedTtlMap } from './bounded-ttl-map'

describe('BoundedTtlMap', () => {
  it('stores and retrieves values', () => {
    const map = new BoundedTtlMap<string, number>({ capacity: 10, ttlMs: 1000 })
    map.set('a', 1)
    expect(map.get('a')).toBe(1)
    expect(map.has('a')).toBe(true)
    expect(map.size).toBe(1)
  })

  it('returns undefined for missing keys', () => {
    const map = new BoundedTtlMap<string, number>({ capacity: 10, ttlMs: 1000 })
    expect(map.get('missing')).toBeUndefined()
    expect(map.has('missing')).toBe(false)
  })

  it('evicts the least-recently-used entry once capacity is exceeded', () => {
    const map = new BoundedTtlMap<string, number>({
      capacity: 2,
      ttlMs: 100000,
    })
    map.set('a', 1)
    map.set('b', 2)
    map.set('c', 3) // should evict 'a' (oldest)

    expect(map.has('a')).toBe(false)
    expect(map.get('b')).toBe(2)
    expect(map.get('c')).toBe(3)
    expect(map.size).toBe(2)
  })

  it('treats get() as a recency refresh so LRU order updates on read', () => {
    const map = new BoundedTtlMap<string, number>({
      capacity: 2,
      ttlMs: 100000,
    })
    map.set('a', 1)
    map.set('b', 2)
    // Touch 'a' so it becomes most-recently-used; 'b' is now the LRU victim.
    map.get('a')
    map.set('c', 3)

    expect(map.has('b')).toBe(false)
    expect(map.get('a')).toBe(1)
    expect(map.get('c')).toBe(3)
  })

  it('re-inserting an existing key updates its value without evicting anything', () => {
    const map = new BoundedTtlMap<string, number>({
      capacity: 2,
      ttlMs: 100000,
    })
    map.set('a', 1)
    map.set('b', 2)
    map.set('a', 10)

    expect(map.size).toBe(2)
    expect(map.get('a')).toBe(10)
    expect(map.get('b')).toBe(2)
  })

  it('expires entries lazily once past their TTL', () => {
    const map = new BoundedTtlMap<string, number>({ capacity: 10, ttlMs: 1000 })
    map.set('a', 1, 0)

    expect(map.get('a', 500)).toBe(1)
    expect(map.has('a', 999)).toBe(true)
    expect(map.get('a', 1000)).toBeUndefined() // exactly at expiry boundary
  })

  it('does not count an expired entry towards capacity once it is read', () => {
    const map = new BoundedTtlMap<string, number>({ capacity: 1, ttlMs: 1000 })
    map.set('a', 1, 0)
    // 'a' has now expired; reading it removes it and frees capacity.
    expect(map.get('a', 2000)).toBeUndefined()
    map.set('b', 2, 2000)
    expect(map.get('b', 2000)).toBe(2)
    expect(map.size).toBe(1)
  })

  it('delete() and clear() remove entries', () => {
    const map = new BoundedTtlMap<string, number>({ capacity: 10, ttlMs: 1000 })
    map.set('a', 1)
    map.set('b', 2)
    expect(map.delete('a')).toBe(true)
    expect(map.has('a')).toBe(false)
    map.clear()
    expect(map.size).toBe(0)
  })

  it('rejects non-positive capacity or ttlMs', () => {
    expect(() => new BoundedTtlMap({ capacity: 0, ttlMs: 1000 })).toThrow()
    expect(() => new BoundedTtlMap({ capacity: 10, ttlMs: 0 })).toThrow()
  })
})
