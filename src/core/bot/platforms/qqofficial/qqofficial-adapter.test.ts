import { Platform, requestUrl } from 'obsidian'
import type { RequestUrlParam } from 'obsidian'

import type { BotPlatformQqOfficialConfig } from '../../../../settings/schema/setting.types'
import { encodeSessionKey } from '../../types'
import type { PlatformMessageEvent } from '../../types'

import { QQOfficialAdapter } from './qqofficial-adapter'

// Same global `__mocks__/obsidian.ts` approach as the feishu/dingtalk
// suites (mock `requestUrl`/`Platform` + a global `WebSocket`), so the
// reconnect and dispatch paths are exercised with real frame flow.
const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

function makeConfig(
  overrides: Partial<BotPlatformQqOfficialConfig> = {},
): BotPlatformQqOfficialConfig {
  return {
    id: 'qq-1',
    name: 'My QQ Bot',
    enabled: true,
    platformType: 'qq_official',
    whitelistEnabled: true,
    allowedUsers: [],
    allowedGroups: [],
    appId: 'app-1',
    appSecret: 'secret-1',
    enableC2c: true,
    enableGroup: true,
    enableGuild: true,
    ...overrides,
  }
}

const DEFAULT_GATEWAY_URL = 'wss://api.sgroup.qq.com/websocket'

type MockMessageEvent = { data: string }

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readonly sent: string[] = []
  readyState = MockWebSocket.OPEN
  closeCode: number | undefined
  onopen: (() => void) | null = null
  onmessage: ((event: MockMessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: ((event: unknown) => void) | null = null

  constructor(url: string) {
    this.url = url
    MockWebSocket.instances.push(this)
  }

  send(data: string): void {
    this.sent.push(data)
  }

  close(code?: number): void {
    this.closeCode = code
    this.onclose?.()
  }
}

function latestSocket(): MockWebSocket {
  const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  if (!ws) throw new Error('no MockWebSocket instance was created')
  return ws
}

/** Starts the adapter (gateway URL fetch + WS) and completes the hello
 * handshake, mirroring a real connect. */
async function startAdapter(
  configOverrides: Partial<BotPlatformQqOfficialConfig> = {},
): Promise<{ adapter: QQOfficialAdapter; ws: MockWebSocket }> {
  const adapter = new QQOfficialAdapter()
  liveAdapters.push(adapter)
  await adapter.start(makeConfig(configOverrides))
  const ws = latestSocket()
  ws.onmessage?.({
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 40_000 } }),
  })
  return { adapter, ws }
}

function sendHello(ws: MockWebSocket): void {
  ws.onmessage?.({
    data: JSON.stringify({ op: 10, d: { heartbeat_interval: 40_000 } }),
  })
}

function sendDispatch(
  ws: MockWebSocket,
  type: string,
  data: Record<string, unknown>,
): void {
  ws.onmessage?.({
    data: JSON.stringify({ op: 0, s: 1, t: type, d: data }),
  })
}

let originalWebSocket: typeof WebSocket | undefined

/** Adapters started during this file — stopped in `afterEach` so their
 * reconnect/stable/heartbeat timers never keep jest's worker alive. */
const liveAdapters: QQOfficialAdapter[] = []

beforeEach(() => {
  mockedRequestUrl.mockReset()
  mockedRequestUrl.mockImplementation((async (
    _request: string | { url: string },
  ) => {
    const url = typeof _request === 'string' ? _request : _request.url
    if (url.includes('/gateway/bot')) {
      return { json: { url: DEFAULT_GATEWAY_URL } }
    }
    return Promise.reject(new Error(`Unhandled requestUrl call: ${url}`))
  }) as unknown as typeof requestUrl)
  MockWebSocket.instances = []
  originalWebSocket = (global as { WebSocket?: typeof WebSocket }).WebSocket
  ;(global as { WebSocket: unknown }).WebSocket = MockWebSocket
  Platform.isMobile = false
  jest.useRealTimers()
})

afterEach(async () => {
  await Promise.allSettled(liveAdapters.map((adapter) => adapter.stop()))
  liveAdapters.length = 0
  ;(global as { WebSocket: unknown }).WebSocket = originalWebSocket
  jest.useRealTimers()
})

describe('QQOfficialAdapter listener cleanup', () => {
  it('does not remove the last listener when an unsubscribe is called twice', () => {
    const adapter = new QQOfficialAdapter()
    const first = jest.fn()
    const second = jest.fn()
    const unsubscribeFirst = adapter.onMessage(first)
    adapter.onMessage(second)

    unsubscribeFirst()
    unsubscribeFirst()

    expect(
      (adapter as unknown as { messageHandlers: unknown[] }).messageHandlers,
    ).toHaveLength(1)
  })

  it('keeps error listeners intact after repeated cleanup', () => {
    const adapter = new QQOfficialAdapter()
    const first = jest.fn()
    const second = jest.fn()
    const unsubscribeFirst = adapter.onError(first)
    adapter.onError(second)

    unsubscribeFirst()
    unsubscribeFirst()

    expect(
      (adapter as unknown as { errorHandlers: unknown[] }).errorHandlers,
    ).toHaveLength(1)
  })
})

describe('QQOfficialAdapter — start()', () => {
  it('throws a desktop-only error on mobile without making any request', async () => {
    Platform.isMobile = true
    const adapter = new QQOfficialAdapter()
    await expect(adapter.start(makeConfig())).rejects.toThrow(/desktop-only/)
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('fetches the gateway URL and opens a socket, reporting running after the hello', async () => {
    const { adapter, ws } = await startAdapter()

    expect(mockedRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.sgroup.qq.com/gateway/bot',
      }),
    )
    expect(ws.url).toBe(DEFAULT_GATEWAY_URL)
    expect(adapter.health()).toBe('running')
  })
})

describe('QQOfficialAdapter — reconnect', () => {
  it('reconnects with exponential backoff after an unexpected close, reset after a stable window', async () => {
    jest.useFakeTimers()
    const { ws: firstWs } = await startAdapter()

    firstWs.onclose?.()
    expect(MockWebSocket.instances).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(10_000)
    expect(MockWebSocket.instances).toHaveLength(2)

    const secondWs = latestSocket()
    sendHello(secondWs)
    secondWs.onclose?.()
    await jest.advanceTimersByTimeAsync(10_000)
    expect(MockWebSocket.instances).toHaveLength(2)
    await jest.advanceTimersByTimeAsync(10_000)
    expect(MockWebSocket.instances).toHaveLength(3)

    const thirdWs = latestSocket()
    sendHello(thirdWs)
    await jest.advanceTimersByTimeAsync(300_000) // stable window resets the counter

    thirdWs.onclose?.()
    await jest.advanceTimersByTimeAsync(10_000) // back to base delay, not 40s
    expect(MockWebSocket.instances).toHaveLength(4)
  })

  it('does not reconnect after an intentional stop()', async () => {
    jest.useFakeTimers()
    const { adapter, ws } = await startAdapter()

    await adapter.stop()
    expect(adapter.health()).toBe('stopped')
    ws.onclose?.()
    await jest.advanceTimersByTimeAsync(300_000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})

describe('QQOfficialAdapter — malformed gateway frames', () => {
  it('reports malformed JSON without throwing from the WebSocket callback', async () => {
    const { adapter, ws } = await startAdapter()
    const errorPromise = new Promise<Error>((resolve) => {
      const unsubscribe = adapter.onError((error) => {
        unsubscribe()
        resolve(error)
      })
    })

    expect(() => ws.onmessage?.({ data: '{not-json' })).not.toThrow()
    await expect(errorPromise).resolves.toThrow(/JSON|unexpected/i)
  })
})

describe('QQOfficialAdapter — B1 intents', () => {
  function intentsFromHello(ws: MockWebSocket): number {
    const hello = ws.sent
      .map((message) => JSON.parse(message) as { op: number; d?: unknown })
      .find((payload) => payload.op === 2)
    return (hello?.d as { intents?: number } | undefined)?.intents ?? -1
  }

  it('subscribes GUILD_MESSAGES | DIRECT_MESSAGE | GROUP_AND_C2C_EVENT when every channel is enabled', async () => {
    const { ws } = await startAdapter()
    // fix-round-1: official bit table — GUILD_MESSAGES=1<<9 (channel @),
    // DIRECT_MESSAGE=1<<12 (channel DM), GROUP_AND_C2C_EVENT=1<<25.
    expect(intentsFromHello(ws)).toBe((1 << 9) | (1 << 12) | (1 << 25))
  })

  it('enableGuild=false drops the guild intents (1<<9 GUILD_MESSAGES / 1<<12 DIRECT_MESSAGE)', async () => {
    const { ws } = await startAdapter({ enableGuild: false })
    expect(intentsFromHello(ws)).toBe(1 << 25)
  })

  it('C2C and group switches are independent at dispatch time (GROUP_AND_C2C_EVENT is one intent bit)', async () => {
    const { adapter, ws } = await startAdapter({
      enableC2c: false,
      enableGroup: true,
      enableGuild: false,
    })
    const received: PlatformMessageEvent[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    sendDispatch(ws, 'C2C_MESSAGE_CREATE', {
      author: { user_openid: 'u1' },
      content: 'c2c should be dropped',
      id: 'msg-c2c',
    })
    sendDispatch(ws, 'GROUP_AT_MESSAGE_CREATE', {
      group_openid: 'g1',
      content: '<@!BOT_OPENID> group should pass',
      id: 'msg-group',
      author: { member_openid: 'm1', user_nick: 'Alice' },
    })
    sendDispatch(ws, 'AT_MESSAGE_CREATE', {
      channel_id: 'ch-1',
      content: '<@!BOT_OPENID> guild should be dropped',
      id: 'msg-guild',
      author: { user_openid: 'u2' },
    })
    sendDispatch(ws, 'DIRECT_MESSAGE_CREATE', {
      guild_id: 'guild-1',
      content: 'guild dm should be dropped',
      id: 'msg-dm',
      author: { user_openid: 'u3' },
    })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      chatType: 'group',
      mentionedBotId: 'qq_official',
    })
  })

  it('drops every dispatch when all channels are disabled', async () => {
    const { adapter, ws } = await startAdapter({
      enableC2c: false,
      enableGroup: false,
      enableGuild: false,
    })
    const received: PlatformMessageEvent[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    sendDispatch(ws, 'C2C_MESSAGE_CREATE', {
      author: { user_openid: 'u1' },
      content: 'hi',
      id: 'msg-1',
    })
    sendDispatch(ws, 'GROUP_AT_MESSAGE_CREATE', {
      group_openid: 'g1',
      content: '<@!BOT_OPENID> hi',
      id: 'msg-2',
      author: { member_openid: 'm1' },
    })

    expect(received).toHaveLength(0)
  })
})

describe('QQOfficialAdapter — B2 stop during start', () => {
  it('does not open a socket when stop() lands while the gateway fetch is in flight', async () => {
    let releaseGateway!: (value: unknown) => void
    const gateway = new Promise((resolve) => {
      releaseGateway = resolve
    })
    mockedRequestUrl.mockImplementation(
      (() => gateway) as unknown as typeof requestUrl,
    )

    const adapter = new QQOfficialAdapter()
    liveAdapters.push(adapter)
    const starting = adapter.start(makeConfig())
    await Promise.resolve() // let the gateway await begin
    await adapter.stop()
    releaseGateway({ json: { url: DEFAULT_GATEWAY_URL } })
    await starting

    // RED on the old behavior: start() opened the connection anyway.
    expect(MockWebSocket.instances).toHaveLength(0)
    expect(adapter.health()).toBe('stopped')
  })
})

describe('QQOfficialAdapter — sendMessage', () => {
  function mockSendRoutes(): {
    bodies: Array<{ content: string; msg_seq?: number }>
  } {
    const bodies: Array<{ content: string; msg_seq?: number }> = []
    mockedRequestUrl.mockImplementation((async (
      request: string | RequestUrlParam,
    ) => {
      const url = typeof request === 'string' ? request : request.url
      if (url.includes('/gateway/bot')) {
        return { json: { url: DEFAULT_GATEWAY_URL } }
      }
      if (url.includes('/v2/')) {
        const body =
          typeof request === 'string' ? '' : String(request.body ?? '')
        bodies.push(JSON.parse(body) as { content: string; msg_seq?: number })
        return { json: { id: 'msg-ok' } }
      }
      return Promise.reject(new Error(`Unhandled requestUrl call: ${url}`))
    }) as unknown as typeof requestUrl)
    return { bodies }
  }

  it('B4: splits a long reply into multiple chunked sends at the 2000 cap', async () => {
    const { bodies } = mockSendRoutes()
    const { adapter } = await startAdapter()
    const longText = 'a'.repeat(4500)

    const refs = await adapter.sendMessage(
      encodeSessionKey('qq_official', 'private', 'u1'),
      { text: longText },
    )

    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      expect(body.content.length).toBeLessThanOrEqual(2000)
    }
    expect(bodies.map((body) => body.content).join('')).toBe(longText)
    expect(refs).toHaveLength(3)
  })

  it('B5: msg_seq increases monotonically instead of being random', async () => {
    // A fixed random source makes the old implementation emit the same
    // msg_seq twice — the monotonic assertion fails (RED).
    const randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5)
    try {
      const { bodies } = mockSendRoutes()
      const { adapter } = await startAdapter()
      const sessionKey = encodeSessionKey('qq_official', 'private', 'u1')

      await adapter.sendMessage(sessionKey, { text: 'first' })
      await adapter.sendMessage(sessionKey, { text: 'second' })

      expect(bodies.map((body) => body.msg_seq)).toEqual([1, 2])
    } finally {
      randomSpy.mockRestore()
    }
  })
})

describe('QQOfficialAdapter — group mention wake signal', () => {
  it('sets mentionedBotId for a group at-message with a specific mention tag', async () => {
    const { adapter, ws } = await startAdapter()
    const received: PlatformMessageEvent[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    sendDispatch(ws, 'GROUP_AT_MESSAGE_CREATE', {
      group_openid: 'g1',
      content: '<@!BOT_OPENID> hello',
      id: 'msg-1',
      author: { member_openid: 'm1', user_nick: 'Alice' },
    })

    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({
      chatType: 'group',
      mentionedBotId: 'qq_official',
      senderId: 'm1',
    })
    expect(received[0].message.plainText).toBe('hello')
  })

  it('does not wake on a group at-message that only @everyone', async () => {
    const { adapter, ws } = await startAdapter()
    const received: PlatformMessageEvent[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    sendDispatch(ws, 'GROUP_AT_MESSAGE_CREATE', {
      group_openid: 'g1',
      content: '<@everyone> look at this',
      id: 'msg-2',
      author: { member_openid: 'm1', user_nick: 'Alice' },
    })

    expect(received).toHaveLength(1)
    expect(received[0].chatType).toBe('group')
    expect(received[0].mentionedBotId).toBeUndefined()
  })

  it('wakes when @everyone is accompanied by a specific bot mention', async () => {
    const { adapter, ws } = await startAdapter()
    const received: PlatformMessageEvent[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    sendDispatch(ws, 'GROUP_AT_MESSAGE_CREATE', {
      group_openid: 'g1',
      content: '<@everyone> <@!BOT_OPENID> please respond',
      id: 'msg-2b',
      author: { member_openid: 'm1', user_nick: 'Alice' },
    })

    expect(received).toHaveLength(1)
    expect(received[0].mentionedBotId).toBe('qq_official')
  })

  it('treats a guild private message as private without a mention wake signal', async () => {
    const { adapter, ws } = await startAdapter()
    const received: PlatformMessageEvent[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    sendDispatch(ws, 'DIRECT_MESSAGE_CREATE', {
      guild_id: 'guild-1',
      content: 'hello in dm',
      id: 'msg-3',
      author: { user_openid: 'u9', username: 'Bob' },
    })

    expect(received).toHaveLength(1)
    expect(received[0].chatType).toBe('private')
    expect(received[0].mentionedBotId).toBeUndefined()
  })
})
