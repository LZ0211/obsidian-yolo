import { BotSentMessageRegistry } from './bot-sent-registry'

describe('BotSentMessageRegistry', () => {
  it('reports a message as not sent-by-bot until registered', () => {
    const registry = new BotSentMessageRegistry()
    expect(registry.isSentByBot('m1')).toBe(false)
  })

  it('register() makes isSentByBot() true and get() returns the entry', () => {
    const registry = new BotSentMessageRegistry()
    registry.register({
      platformMessageId: 'm1',
      sessionKey: 'telegram:private:1',
      sentAt: 123,
    })
    expect(registry.isSentByBot('m1')).toBe(true)
    expect(registry.get('m1')).toEqual({
      platformMessageId: 'm1',
      sessionKey: 'telegram:private:1',
      sentAt: 123,
    })
  })

  it('registerAll() registers every id from a single send', () => {
    const registry = new BotSentMessageRegistry()
    registry.registerAll(['m1', 'm2'], 'telegram:private:1', 100)
    expect(registry.isSentByBot('m1', 100)).toBe(true)
    expect(registry.isSentByBot('m2', 100)).toBe(true)
    expect(registry.get('m2', 100)?.sentAt).toBe(100)
  })

  it('expires entries once past ttlMs', () => {
    const registry = new BotSentMessageRegistry({ capacity: 10, ttlMs: 1000 })
    registry.register(
      { platformMessageId: 'm1', sessionKey: 's', sentAt: 0 },
      0,
    )
    expect(registry.isSentByBot('m1', 500)).toBe(true)
    expect(registry.isSentByBot('m1', 1000)).toBe(false)
  })

  it('evicts the least-recently-registered entry once capacity is exceeded', () => {
    const registry = new BotSentMessageRegistry({ capacity: 2, ttlMs: 100000 })
    registry.register({ platformMessageId: 'a', sessionKey: 's', sentAt: 0 })
    registry.register({ platformMessageId: 'b', sessionKey: 's', sentAt: 0 })
    registry.register({ platformMessageId: 'c', sessionKey: 's', sentAt: 0 })

    expect(registry.isSentByBot('a')).toBe(false)
    expect(registry.isSentByBot('b')).toBe(true)
    expect(registry.isSentByBot('c')).toBe(true)
    expect(registry.size).toBe(2)
  })

  it('clear() removes all entries', () => {
    const registry = new BotSentMessageRegistry()
    registry.register({ platformMessageId: 'a', sessionKey: 's', sentAt: 0 })
    registry.clear()
    expect(registry.isSentByBot('a')).toBe(false)
    expect(registry.size).toBe(0)
  })
})
