import type {
  BotsSettings,
  SessionMapping,
} from '../../settings/schema/setting.types'

import { SessionMapper } from './session-mapper'
import { decodeSessionKey, encodeSessionKey } from './types'

function makeBotsSettings(mappings: SessionMapping[] = []): BotsSettings {
  return {
    enabled: true,
    whitelistEnabled: true,
    groupChatEnabled: false,
    adminUsers: [],
    platforms: [],
    sessionMappings: mappings,
  }
}

function makeMapper(initial: SessionMapping[] = []) {
  let settings = makeBotsSettings(initial)
  const getSettings = jest.fn(() => settings)
  const saveSettings = jest.fn(async (next: BotsSettings) => {
    settings = next
  })
  const mapper = new SessionMapper({ getSettings, saveSettings })
  return { mapper, getSettings, saveSettings, getCurrent: () => settings }
}

function makeMapping(overrides: Partial<SessionMapping> = {}): SessionMapping {
  return {
    sessionKey: 'telegram:private:123',
    platformName: 'telegram',
    chatType: 'private',
    platformChatId: '123',
    conversationId: 'conv-1',
    createdAt: 0,
    lastActiveAt: 0,
    ...overrides,
  }
}

describe('encodeSessionKey / decodeSessionKey round trip', () => {
  it('round trips without a threadId', () => {
    const key = encodeSessionKey('telegram', 'private', '123')
    expect(key).toBe('telegram:private:123')
    expect(decodeSessionKey(key)).toEqual({
      platform: 'telegram',
      chatType: 'private',
      chatId: '123',
      threadId: undefined,
    })
  })

  it('round trips with a threadId', () => {
    const key = encodeSessionKey('telegram', 'group', '456', 'thread-1')
    expect(decodeSessionKey(key)).toEqual({
      platform: 'telegram',
      chatType: 'group',
      chatId: '456',
      threadId: 'thread-1',
    })
  })

  it('escapes ":" inside chatId/threadId so it never collides with delimiters', () => {
    const key = encodeSessionKey(
      'wechat',
      'private',
      'weird:chat:id',
      'weird:thread',
    )
    const decoded = decodeSessionKey(key)
    expect(decoded.chatId).toBe('weird:chat:id')
    expect(decoded.threadId).toBe('weird:thread')
  })

  it('throws on malformed keys', () => {
    expect(() => decodeSessionKey('too:few')).toThrow()
    expect(() => decodeSessionKey('telegram:bogus:123')).toThrow()
  })
})

describe('SessionMapper', () => {
  it('getSessionByKey finds a mapping by sessionKey', () => {
    const mapping = makeMapping()
    const { mapper } = makeMapper([mapping])
    expect(mapper.getSessionByKey('telegram:private:123')).toEqual(mapping)
    expect(mapper.getSessionByKey('missing')).toBeUndefined()
  })

  it('prefers an exact platform instance over an earlier legacy mapping', () => {
    const legacy = makeMapping({ conversationId: 'legacy' })
    const exact = makeMapping({
      platformInstanceId: 'bot-1',
      conversationId: 'exact',
    })
    const { mapper } = makeMapper([legacy, exact])

    expect(
      mapper.getSessionByKey('telegram:private:123', 'bot-1', true),
    ).toEqual(exact)
  })

  it('upsertSession creates a new mapping and persists it', async () => {
    const { mapper, saveSettings, getCurrent } = makeMapper([])
    const mapping = makeMapping()
    await mapper.upsertSession(mapping)
    expect(saveSettings).toHaveBeenCalledTimes(1)
    expect(getCurrent().sessionMappings).toEqual([mapping])
  })

  it('upsertSession replaces an existing mapping for the same sessionKey', async () => {
    const original = makeMapping({ conversationId: 'conv-1' })
    const { mapper, getCurrent } = makeMapper([original])
    const replacement = makeMapping({ conversationId: 'conv-2' })
    await mapper.upsertSession(replacement)
    expect(getCurrent().sessionMappings).toEqual([replacement])
  })

  it('upsertSession replaces only the exact platform instance', async () => {
    const legacy = makeMapping({ conversationId: 'legacy' })
    const exact = makeMapping({
      platformInstanceId: 'bot-1',
      conversationId: 'old-exact',
    })
    const replacement = makeMapping({
      platformInstanceId: 'bot-1',
      conversationId: 'new-exact',
    })
    const { mapper, getCurrent } = makeMapper([legacy, exact])

    await mapper.upsertSession(replacement, true)

    expect(getCurrent().sessionMappings).toEqual([legacy, replacement])
  })

  it('touchActiveSession bumps lastActiveAt and clears archivedAt', async () => {
    const archived = makeMapping({ archivedAt: 100, lastActiveAt: 50 })
    const { mapper, getCurrent } = makeMapper([archived])
    const updated = await mapper.touchActiveSession('telegram:private:123', 999)
    expect(updated?.lastActiveAt).toBe(999)
    expect(updated?.archivedAt).toBeUndefined()
    expect(getCurrent().sessionMappings[0].archivedAt).toBeUndefined()
  })

  it('touchActiveSession updates only the exact platform instance', async () => {
    const legacy = makeMapping({ lastActiveAt: 10, archivedAt: 20 })
    const exact = makeMapping({
      platformInstanceId: 'bot-1',
      conversationId: 'exact',
      lastActiveAt: 30,
      archivedAt: 40,
    })
    const { mapper, getCurrent } = makeMapper([legacy, exact])

    await mapper.touchActiveSession(
      'telegram:private:123',
      'bot-1',
      999,
      true,
    )

    expect(getCurrent().sessionMappings).toEqual([
      legacy,
      { ...exact, lastActiveAt: 999, archivedAt: undefined },
    ])
  })

  it('touchActiveSession no-ops for a disabled session', async () => {
    const disabled = makeMapping({ disabled: true, lastActiveAt: 50 })
    const { mapper, saveSettings } = makeMapper([disabled])
    const result = await mapper.touchActiveSession('telegram:private:123', 999)
    expect(result).toBeUndefined()
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('touchActiveSession no-ops for an unknown sessionKey', async () => {
    const { mapper, saveSettings } = makeMapper([])
    const result = await mapper.touchActiveSession('missing')
    expect(result).toBeUndefined()
    expect(saveSettings).not.toHaveBeenCalled()
  })
})
