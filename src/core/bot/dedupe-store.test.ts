import { DedupeStore, buildDedupeKey } from './dedupe-store'

describe('buildDedupeKey', () => {
  it('joins platform/sessionKey/threadId/messageId with colons', () => {
    expect(
      buildDedupeKey({
        platformName: 'telegram',
        sessionKey: 'telegram:private:123',
        threadId: 't1',
        messageId: 'm1',
      }),
    ).toBe('telegram:telegram:private:123:t1:m1')
  })

  it('defaults threadId to an empty segment when absent', () => {
    expect(
      buildDedupeKey({
        platformName: 'telegram',
        sessionKey: 'telegram:private:123',
        messageId: 'm1',
      }),
    ).toBe('telegram:telegram:private:123::m1')
  })
})

describe('DedupeStore', () => {
  it('reports a key as unseen until markSeen is called', () => {
    const store = new DedupeStore()
    expect(store.hasSeen('k1')).toBe(false)
    store.markSeen('k1')
    expect(store.hasSeen('k1')).toBe(true)
  })

  it('treats different keys independently', () => {
    const store = new DedupeStore()
    store.markSeen('k1')
    expect(store.hasSeen('k2')).toBe(false)
  })

  it('expires entries once past ttlMs', () => {
    const store = new DedupeStore({ capacity: 10, ttlMs: 1000 })
    store.markSeen('k1', 0)
    expect(store.hasSeen('k1', 500)).toBe(true)
    expect(store.hasSeen('k1', 1000)).toBe(false)
  })

  it('evicts the least-recently-seen key once capacity is exceeded', () => {
    const store = new DedupeStore({ capacity: 2, ttlMs: 100000 })
    store.markSeen('a')
    store.markSeen('b')
    store.markSeen('c') // should evict 'a'

    expect(store.hasSeen('a')).toBe(false)
    expect(store.hasSeen('b')).toBe(true)
    expect(store.hasSeen('c')).toBe(true)
    expect(store.size).toBe(2)
  })

  it('clear() removes all entries', () => {
    const store = new DedupeStore()
    store.markSeen('a')
    store.markSeen('b')
    store.clear()
    expect(store.hasSeen('a')).toBe(false)
    expect(store.size).toBe(0)
  })
})
