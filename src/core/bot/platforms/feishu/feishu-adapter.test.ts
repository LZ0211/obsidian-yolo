import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'

import { Platform, requestUrl } from 'obsidian'
import type { App, RequestUrlParam } from 'obsidian'

import type { BotPlatformFeishuConfig } from '../../../../settings/schema/setting.types'
import type { PlatformMessageEvent } from '../../types'

import { FeishuAdapter } from './feishu-adapter'
import { decodeFrame, encodeFrame } from './frame-codec'

// Relies on the global `__mocks__/obsidian.ts` mock (exports `requestUrl`/
// `Platform`/`FileSystemAdapter`/`App` together), same approach as
// `dingtalk-adapter.test.ts` — plus a custom global `WebSocket` that speaks
// real encoded binary frames (via `frame-codec.ts`) so tests exercise the
// real decode path rather than a JSON shortcut.
const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

function makeApp(): App {
  return { vault: { adapter: {} } } as unknown as App
}

function makeConfig(
  overrides: Partial<BotPlatformFeishuConfig> = {},
): BotPlatformFeishuConfig {
  return {
    id: 'fs-1',
    name: 'My Feishu Bot',
    enabled: true,
    platformType: 'feishu',
    allowedUsers: [],
    allowedGroups: [],
    whitelistEnabled: true,
    appId: 'app-1',
    appSecret: 'secret-1',
    ...overrides,
  }
}

function asRequestUrlParam(request: string | RequestUrlParam): RequestUrlParam {
  if (typeof request === 'string') {
    throw new Error('expected a RequestUrlParam object, got a bare URL string')
  }
  return request
}

function bodyAsString(param: RequestUrlParam): string {
  if (typeof param.body !== 'string') {
    throw new Error('expected a string request body')
  }
  return param.body
}

const DEFAULT_WS_URL =
  'wss://open.feishu.cn/ws/abc?device_id=dev-1&service_id=42'

type RouteHandler = (param: RequestUrlParam) => unknown

/** Routes `requestUrl` calls by URL substring so tests don't depend on call
 * order. Always includes the handshake + bot-identity + token routes so
 * `startAdapter()` keeps working when a test layers on more routes
 * afterwards (identity resolution needs a tenant token + bot/v3/info). */
function mockRoutes(routes: Record<string, RouteHandler>): void {
  const allRoutes: Record<string, RouteHandler> = {
    'callback/ws/endpoint': () => ({
      json: {
        code: 0,
        msg: 'ok',
        data: {
          URL: DEFAULT_WS_URL,
          ClientConfig: {
            PingInterval: 120,
            ReconnectCount: 5,
            ReconnectInterval: 5,
            ReconnectNonce: 10,
          },
        },
      },
    }),
    tenant_access_token: () => ({
      json: {
        code: 0,
        msg: 'ok',
        tenant_access_token: 'tok-1',
        expire: 7200,
      },
    }),
    'bot/v3/info': () => ({
      json: {
        code: 0,
        msg: 'ok',
        data: { open_id: 'ou_bot_1', app_name: 'Yolo Bot' },
      },
    }),
    ...routes,
  }
  mockedRequestUrl.mockImplementation(((request: string | RequestUrlParam) => {
    const param = asRequestUrlParam(request)
    const match = Object.entries(allRoutes).find(([key]) =>
      param.url.includes(key),
    )
    if (!match) {
      return Promise.reject(
        new Error(`Unhandled requestUrl call: ${param.url}`),
      )
    }
    return Promise.resolve(match[1](param))
  }) as unknown as typeof requestUrl)
}

function waitForNextMessage(
  adapter: FeishuAdapter,
): Promise<PlatformMessageEvent> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onMessage((event) => {
      unsubscribe()
      resolve(event)
    })
  })
}

function waitForNextError(adapter: FeishuAdapter): Promise<Error> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onError((error) => {
      unsubscribe()
      resolve(error)
    })
  })
}

type MockMessageEvent = { data: ArrayBuffer }

class MockWebSocket {
  static instances: MockWebSocket[] = []
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readonly sent: Uint8Array[] = []
  binaryType = ''
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

  send(data: Uint8Array): void {
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

/** Starts the adapter and opens its (mocked) WebSocket, mirroring what a real
 * successful handshake + connect looks like. */
async function startAdapter(
  configOverrides: Partial<BotPlatformFeishuConfig> = {},
): Promise<{ adapter: FeishuAdapter; ws: MockWebSocket }> {
  const adapter = new FeishuAdapter(makeApp())
  liveAdapters.push(adapter)
  await adapter.start(makeConfig(configOverrides))
  const ws = latestSocket()
  ws.onopen?.()
  return { adapter, ws }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

function buildDataFrame(
  headers: Record<string, string>,
  payload: Uint8Array,
  overrides: { seqId?: number; logId?: number; service?: number } = {},
): Uint8Array {
  return encodeFrame({
    seqId: overrides.seqId ?? 1,
    logId: overrides.logId ?? 1,
    service: overrides.service ?? 42,
    method: 1,
    headers: Object.entries(headers).map(([key, value]) => ({ key, value })),
    payload,
  })
}

function makeMessageReceiveEnvelope(
  messageOverrides: Partial<Record<string, unknown>> = {},
  senderOverrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schema: '2.0',
    header: {
      event_id: 'evt-1',
      token: 'tok',
      create_time: '1700000000000',
      event_type: 'im.message.receive_v1',
    },
    event: {
      sender: {
        sender_id: { open_id: 'ou_sender_1' },
        sender_type: 'user',
        ...senderOverrides,
      },
      message: {
        message_id: 'om_msg_1',
        create_time: '1700000000000',
        chat_id: 'oc_chat_1',
        chat_type: 'p2p',
        message_type: 'text',
        content: JSON.stringify({ text: 'hello there' }),
        ...messageOverrides,
      },
    },
  }
}

function sendEventFrame(
  ws: MockWebSocket,
  envelope: unknown,
  frameOverrides: {
    seqId?: number
    logId?: number
    service?: number
    messageId?: string
  } = {},
): void {
  const payload = new TextEncoder().encode(JSON.stringify(envelope))
  const frame = buildDataFrame(
    {
      type: 'event',
      message_id: frameOverrides.messageId ?? 'msg-frame-1',
      sum: '1',
      seq: '0',
      trace_id: 'trace-1',
    },
    payload,
    frameOverrides,
  )
  ws.onmessage?.({ data: toArrayBuffer(frame) })
}

let originalWebSocket: typeof WebSocket | undefined

/** Adapters started during this file — stopped in `afterEach` so their
 * stable-connection/ping/reconnect timers (real timers, up to 300s) never
 * keep jest's worker alive and force it to exit. */
const liveAdapters: FeishuAdapter[] = []

beforeEach(() => {
  mockedRequestUrl.mockReset()
  mockRoutes({})
  MockWebSocket.instances = []
  originalWebSocket = (global as { WebSocket?: typeof WebSocket }).WebSocket
  ;(global as { WebSocket: unknown }).WebSocket = MockWebSocket
  Platform.isMobile = false
})

afterEach(async () => {
  await Promise.allSettled(liveAdapters.map((adapter) => adapter.stop()))
  liveAdapters.length = 0
  ;(global as { WebSocket: unknown }).WebSocket = originalWebSocket
  jest.useRealTimers()
})

describe('FeishuAdapter — capabilities', () => {
  it('declares text/image/file support without streaming', () => {
    const adapter = new FeishuAdapter(makeApp())
    expect(adapter.capabilities).toEqual({
      markdownMode: 'none',
      supportsImage: true,
      supportsFile: true,
      supportsStreaming: false,
      maxMessageLength: 10_000,
      maxImageSize: 10 * 1024 * 1024,
      maxFileSize: 30 * 1024 * 1024,
    })
  })
})

describe('FeishuAdapter — start()', () => {
  it('throws a desktop-only error on mobile without making any request', async () => {
    Platform.isMobile = true
    const adapter = new FeishuAdapter(makeApp())
    await expect(adapter.start(makeConfig())).rejects.toThrow(/desktop-only/)
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('opens the connection with the expected handshake request shape and connects directly to the returned URL', async () => {
    const { ws } = await startAdapter()

    expect(mockedRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://open.feishu.cn/callback/ws/endpoint',
        method: 'POST',
        headers: expect.objectContaining({ locale: 'zh' }),
      }),
    )
    const call = asRequestUrlParam(mockedRequestUrl.mock.calls[0][0])
    expect(JSON.parse(bodyAsString(call))).toEqual({
      AppID: 'app-1',
      AppSecret: 'secret-1',
    })
    expect(ws.url).toBe(DEFAULT_WS_URL)
  })

  it('degrades and schedules a reconnect when the handshake request fails, without throwing', async () => {
    mockedRequestUrl.mockRejectedValue(new Error('network down'))
    jest.useFakeTimers()

    const adapter = new FeishuAdapter(makeApp())
    const errorPromise = waitForNextError(adapter)
    await adapter.start(makeConfig())

    expect(adapter.health()).toBe('degraded')
    await expect(errorPromise).resolves.toThrow(/network down/)
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('degrades when the handshake response has a non-zero code', async () => {
    mockRoutes({
      'callback/ws/endpoint': () => ({
        json: { code: 99991663, msg: 'invalid app secret' },
      }),
    })
    jest.useFakeTimers()
    const adapter = new FeishuAdapter(makeApp())
    const errorPromise = waitForNextError(adapter)
    await adapter.start(makeConfig())

    expect(adapter.health()).toBe('degraded')
    await expect(errorPromise).resolves.toThrow(/invalid app secret/)
  })

  it('does not resurrect the connection when stop() lands while the handshake is in flight', async () => {
    let releaseHandshake!: () => void
    const handshakeGate = new Promise<void>((resolve) => {
      releaseHandshake = resolve
    })
    mockRoutes({
      'callback/ws/endpoint': () =>
        handshakeGate.then(() => ({
          json: {
            code: 0,
            msg: 'ok',
            data: { URL: DEFAULT_WS_URL, ClientConfig: { PingInterval: 120 } },
          },
        })),
    })

    const adapter = new FeishuAdapter(makeApp())
    liveAdapters.push(adapter)
    const startPromise = adapter.start(makeConfig())

    // Disable lands while the handshake request is still pending.
    await adapter.stop()
    releaseHandshake()
    await startPromise

    expect(adapter.health()).toBe('stopped')
    expect(MockWebSocket.instances).toHaveLength(0)
  })
})

describe('FeishuAdapter — WS frame handling', () => {
  it('treats a control frame (server pong) as a no-op', async () => {
    const { adapter, ws } = await startAdapter()
    const pongFrame = encodeFrame({
      seqId: 0,
      logId: 0,
      service: 42,
      method: 0,
      headers: [{ key: 'type', value: 'pong' }],
      payload: new TextEncoder().encode(JSON.stringify({ PingInterval: 120 })),
    })

    ws.onmessage?.({ data: toArrayBuffer(pongFrame) })

    expect(ws.sent).toHaveLength(0)
    expect(adapter.health()).toBe('running')
  })

  it('sends a client-initiated ping control frame on the configured interval', async () => {
    jest.useFakeTimers()
    const { ws } = await startAdapter()

    await jest.advanceTimersByTimeAsync(120_000)

    expect(ws.sent).toHaveLength(1)
    const frame = decodeFrame(ws.sent[0])
    expect(frame.method).toBe(0)
    expect(frame.headers).toEqual([{ key: 'type', value: 'ping' }])
  })

  it('acks a data frame immediately with code 200 and dispatches a parsed message event', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)

    sendEventFrame(ws, makeMessageReceiveEnvelope())

    expect(ws.sent).toHaveLength(1)
    const ackFrame = decodeFrame(ws.sent[0])
    expect(ackFrame.method).toBe(1)
    expect(
      ackFrame.headers.some(
        (h) => h.key === 'message_id' && h.value === 'msg-frame-1',
      ),
    ).toBe(true)
    expect(ackFrame.headers.some((h) => h.key === 'biz_rt')).toBe(true)
    expect(JSON.parse(new TextDecoder().decode(ackFrame.payload))).toEqual({
      code: 200,
    })

    const event = await messagePromise
    expect(event).toMatchObject({
      platformName: 'feishu',
      messageId: 'om_msg_1',
      sessionKey: 'feishu:private:oc_chat_1',
      chatType: 'private',
      senderId: 'ou_sender_1',
      senderName: 'ou_sender_1',
      isFromBot: false,
    })
    expect(event.message.components).toEqual([
      { type: 'text', text: 'hello there' },
    ])
    expect(event.message.plainText).toBe('hello there')
  })

  it('sets mentionedBotId for a group message that @s the bot (open_id match)', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)

    sendEventFrame(
      ws,
      makeMessageReceiveEnvelope({
        chat_type: 'group',
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_sender_1' }, name: 'Alice' },
          { key: '@_user_2', id: { open_id: 'ou_bot_1' }, name: 'Yolo Bot' },
        ],
      }),
    )

    const event = await messagePromise
    expect(event.chatType).toBe('group')
    expect(event.mentionedBotId).toBe('ou_bot_1')
  })

  it('falls back to matching the bot by mention name when the open_id differs', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)

    sendEventFrame(
      ws,
      makeMessageReceiveEnvelope({
        chat_type: 'group',
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_other' }, name: 'Yolo Bot' },
        ],
      }),
    )

    const event = await messagePromise
    expect(event.mentionedBotId).toBe('Yolo Bot')
  })

  it('leaves mentionedBotId unset for a group message that @s someone else', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)

    sendEventFrame(
      ws,
      makeMessageReceiveEnvelope({
        chat_type: 'group',
        mentions: [
          { key: '@_user_1', id: { open_id: 'ou_sender_1' }, name: 'Alice' },
        ],
      }),
    )

    const event = await messagePromise
    expect(event.mentionedBotId).toBeUndefined()
  })

  it('leaves mentionedBotId unset for private-chat messages', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)

    sendEventFrame(ws, makeMessageReceiveEnvelope())

    const event = await messagePromise
    expect(event.chatType).toBe('private')
    expect(event.mentionedBotId).toBeUndefined()
  })

  it('reassembles a message split across multiple physical frames sharing the same message_id', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)
    const envelope = makeMessageReceiveEnvelope()
    const fullBytes = new TextEncoder().encode(JSON.stringify(envelope))
    const mid = Math.ceil(fullBytes.length / 2)
    const chunk0 = fullBytes.slice(0, mid)
    const chunk1 = fullBytes.slice(mid)

    ws.onmessage?.({
      data: toArrayBuffer(
        buildDataFrame(
          {
            type: 'event',
            message_id: 'chunked-msg-1',
            sum: '2',
            seq: '0',
          },
          chunk0,
        ),
      ),
    })
    expect(ws.sent).toHaveLength(0)

    ws.onmessage?.({
      data: toArrayBuffer(
        buildDataFrame(
          {
            type: 'event',
            message_id: 'chunked-msg-1',
            sum: '2',
            seq: '1',
          },
          chunk1,
        ),
      ),
    })

    const event = await messagePromise
    expect(event.message.plainText).toBe('hello there')
    expect(ws.sent).toHaveLength(1)
  })

  it('acks with code 500 and emits an error when the reassembled payload is not valid JSON', async () => {
    const { adapter, ws } = await startAdapter()
    const errorPromise = waitForNextError(adapter)

    ws.onmessage?.({
      data: toArrayBuffer(
        buildDataFrame(
          { type: 'event', message_id: 'bad-json-1', sum: '1', seq: '0' },
          new TextEncoder().encode('not json'),
        ),
      ),
    })

    await errorPromise
    const ackFrame = decodeFrame(ws.sent[0])
    expect(JSON.parse(new TextDecoder().decode(ackFrame.payload))).toEqual({
      code: 500,
    })
  })

  it('ignores non-message event types without crashing', async () => {
    const { ws } = await startAdapter()
    sendEventFrame(ws, {
      header: { event_id: 'evt-x', event_type: 'im.chat.updated_v1' },
      event: {},
    })
    expect(ws.sent).toHaveLength(1) // still acked
  })

  it('emits an error and does not crash on a data frame missing message_id', async () => {
    const { adapter, ws } = await startAdapter()
    const errorPromise = waitForNextError(adapter)
    const frame = encodeFrame({
      seqId: 1,
      logId: 1,
      service: 42,
      method: 1,
      headers: [{ key: 'type', value: 'event' }],
      payload: new TextEncoder().encode('{}'),
    })

    ws.onmessage?.({ data: toArrayBuffer(frame) })

    await expect(errorPromise).resolves.toThrow(/message_id/)
  })
})

describe('FeishuAdapter — reconnect backoff', () => {
  it('schedules reconnects with exponential backoff capped at 300s, and resets after a stable connection', async () => {
    jest.useFakeTimers()
    const { ws: firstWs } = await startAdapter()

    firstWs.onclose?.()
    expect(MockWebSocket.instances).toHaveLength(1)
    await jest.advanceTimersByTimeAsync(10_000)
    expect(MockWebSocket.instances).toHaveLength(2)

    const secondWs = latestSocket()
    secondWs.onclose?.()
    await jest.advanceTimersByTimeAsync(20_000)
    expect(MockWebSocket.instances).toHaveLength(3)

    const thirdWs = latestSocket()
    thirdWs.onopen?.()
    await jest.advanceTimersByTimeAsync(300_000) // stable-connection window resets the counter

    thirdWs.onclose?.()
    await jest.advanceTimersByTimeAsync(10_000) // back to the base delay, not 40s
    expect(MockWebSocket.instances).toHaveLength(4)
  })

  it('does not schedule a reconnect after an intentional stop()', async () => {
    jest.useFakeTimers()
    const { adapter, ws } = await startAdapter()

    await adapter.stop()
    expect(adapter.health()).toBe('stopped')
    ws.onclose?.()
    await jest.advanceTimersByTimeAsync(300_000)
    expect(MockWebSocket.instances).toHaveLength(1)
  })
})

describe('FeishuAdapter — sendMessage()', () => {
  it('throws when there is no cached session binding for the sessionKey', async () => {
    const { adapter } = await startAdapter()
    await expect(
      adapter.sendMessage('feishu:private:unknown', { text: 'hi' }),
    ).rejects.toThrow(/session binding/)
  })

  async function receiveMessage(
    adapter: FeishuAdapter,
    ws: MockWebSocket,
    messageOverrides: Partial<Record<string, unknown>> = {},
  ): Promise<PlatformMessageEvent> {
    const messagePromise = waitForNextMessage(adapter)
    sendEventFrame(ws, makeMessageReceiveEnvelope(messageOverrides), {
      messageId: 'seed-frame',
    })
    return messagePromise
  }

  it('sends a text reply via the reply-to-message REST endpoint', async () => {
    mockRoutes({
      tenant_access_token: () => ({
        json: {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tok-1',
          expire: 7200,
        },
      }),
      reply: () => ({
        json: { code: 0, msg: 'ok', data: { message_id: 'om_reply_1' } },
      }),
    })
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws)

    const refs = await adapter.sendMessage(event.sessionKey, { text: 'reply!' })

    const sendCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('/messages/om_msg_1/reply'),
    )
    expect(sendCall).toBeDefined()
    const param = asRequestUrlParam(sendCall![0])
    expect(param.headers).toMatchObject({ Authorization: 'Bearer tok-1' })
    expect(JSON.parse(bodyAsString(param))).toEqual({
      msg_type: 'text',
      content: JSON.stringify({ text: 'reply!' }),
      reply_in_thread: false,
    })
    expect(refs).toHaveLength(1)
    expect(refs[0].platformMessageId).toBe('om_reply_1')
    expect(refs[0].sessionKey).toBe(event.sessionKey)
  })

  it('B4: splits a long text reply at the 10000 cap', async () => {
    mockRoutes({
      tenant_access_token: () => ({
        json: {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tok-1',
          expire: 7200,
        },
      }),
      reply: () => ({
        json: { code: 0, msg: 'ok', data: { message_id: 'om_reply_chunk' } },
      }),
    })
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws)

    const longText = 'y'.repeat(25_000)
    const refs = await adapter.sendMessage(event.sessionKey, { text: longText })

    const replyCalls = mockedRequestUrl.mock.calls.filter((c) =>
      asRequestUrlParam(c[0]).url.includes('/messages/om_msg_1/reply'),
    )
    // RED on the old behavior: one oversized call instead of three chunks.
    expect(replyCalls).toHaveLength(3)
    const chunks = replyCalls.map((c) => {
      const body = JSON.parse(bodyAsString(asRequestUrlParam(c[0]))) as {
        content: string
      }
      return (JSON.parse(body.content) as { text: string }).text
    })
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(10_000)
    }
    expect(chunks.join('')).toBe(longText)
    expect(refs).toHaveLength(3)
  })

  it('uploads and replies with an image', async () => {
    mockRoutes({
      tenant_access_token: () => ({
        json: {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tok-1',
          expire: 7200,
        },
      }),
      'img.example.com/pic.jpg': () => ({ arrayBuffer: new ArrayBuffer(4) }),
      'im/v1/images': () => ({
        json: { code: 0, msg: 'ok', data: { image_key: 'img_key_up_1' } },
      }),
      reply: () => ({
        json: { code: 0, msg: 'ok', data: { message_id: 'om_reply_2' } },
      }),
    })
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws)

    await adapter.sendMessage(event.sessionKey, {
      images: [
        {
          source: 'url',
          url: 'https://img.example.com/pic.jpg',
          mimeType: 'image/jpeg',
        },
      ],
    })

    const uploadCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('im/v1/images'),
    )
    expect(uploadCall).toBeDefined()
    const uploadParam = asRequestUrlParam(uploadCall![0])
    expect(uploadParam.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(uploadParam.body).toBeInstanceOf(ArrayBuffer)

    const sendCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('/reply'),
    )
    expect(sendCall).toBeDefined()
    expect(JSON.parse(bodyAsString(asRequestUrlParam(sendCall![0])))).toEqual({
      msg_type: 'image',
      content: JSON.stringify({ image_key: 'img_key_up_1' }),
      reply_in_thread: false,
    })
  })

  it('uploads and replies with a file', async () => {
    mockRoutes({
      tenant_access_token: () => ({
        json: {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tok-1',
          expire: 7200,
        },
      }),
      'files.example.com/report.pdf': () => ({
        arrayBuffer: new TextEncoder().encode('file-bytes').buffer,
      }),
      'im/v1/files': () => ({
        json: { code: 0, msg: 'ok', data: { file_key: 'file_key_up_1' } },
      }),
      reply: () => ({
        json: { code: 0, msg: 'ok', data: { message_id: 'om_reply_3' } },
      }),
    })
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws)

    await adapter.sendMessage(event.sessionKey, {
      files: [
        {
          source: 'url',
          url: 'https://files.example.com/report.pdf',
          mimeType: 'application/pdf',
          name: 'report.pdf',
        },
      ],
    })

    const uploadCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('im/v1/files'),
    )
    expect(uploadCall).toBeDefined()

    const sendCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('/reply'),
    )
    expect(sendCall).toBeDefined()
    expect(JSON.parse(bodyAsString(asRequestUrlParam(sendCall![0])))).toEqual({
      msg_type: 'file',
      content: JSON.stringify({ file_key: 'file_key_up_1' }),
      reply_in_thread: false,
    })
  })

  it('throws when sendMessage is called with no text/images/files content', async () => {
    mockRoutes({
      tenant_access_token: () => ({
        json: {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tok-1',
          expire: 7200,
        },
      }),
    })
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws)

    await expect(adapter.sendMessage(event.sessionKey, {})).rejects.toThrow(
      /no text\/images\/files/,
    )
  })
})

describe('FeishuAdapter — sendStreamingMessage()', () => {
  it('throws because capabilities.supportsStreaming is false', async () => {
    const { adapter } = await startAdapter()
    expect(() =>
      adapter.sendStreamingMessage('feishu:private:oc_chat_1'),
    ).toThrow(/[Ss]treaming/)
  })
})

describe('FeishuAdapter — downloadFile()', () => {
  it('downloads bytes to a real temp file using the message_id cached at receive time', async () => {
    mockRoutes({
      tenant_access_token: () => ({
        json: {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tok-1',
          expire: 7200,
        },
      }),
      'resources/img_key_1': () => ({
        arrayBuffer: new TextEncoder().encode('file-bytes').buffer,
      }),
    })
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)
    sendEventFrame(
      ws,
      makeMessageReceiveEnvelope({
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_key_1' }),
      }),
    )
    const event = await messagePromise
    const component = event.message.components.find((c) => c.type === 'image')
    if (!component) throw new Error('expected an image component')

    const result = await adapter.downloadFile(component)

    expect(result.size).toBe('file-bytes'.length)
    expect(result.tempPath.startsWith(os.tmpdir())).toBe(true)
    const written = await fsPromises.readFile(result.tempPath, 'utf8')
    expect(written).toBe('file-bytes')

    const downloadCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('resources/img_key_1'),
    )
    expect(downloadCall).toBeDefined()
    expect(asRequestUrlParam(downloadCall![0]).url).toContain('type=image')
  })

  it('throws a clear error when the component has no fileId', async () => {
    const { adapter } = await startAdapter()
    await expect(
      adapter.downloadFile({ type: 'text', text: 'no file here' }),
    ).rejects.toThrow(/fileId/)
  })

  it('throws a clear error when the fileId has no cached source message', async () => {
    const { adapter } = await startAdapter()
    await expect(
      adapter.downloadFile({ type: 'image', fileId: 'never-seen-key' }),
    ).rejects.toThrow(/no source message/i)
  })
})

describe('FeishuAdapter — access token caching', () => {
  it('caches the tenant access token across multiple sendMessage calls', async () => {
    mockRoutes({
      tenant_access_token: () => ({
        json: {
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tok-1',
          expire: 7200,
        },
      }),
      reply: () => ({
        json: { code: 0, msg: 'ok', data: { message_id: 'om_reply_x' } },
      }),
    })
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)
    sendEventFrame(ws, makeMessageReceiveEnvelope())
    const event = await messagePromise

    await adapter.sendMessage(event.sessionKey, { text: 'first' })
    await adapter.sendMessage(event.sessionKey, { text: 'second' })

    const tokenCalls = mockedRequestUrl.mock.calls.filter((c) =>
      asRequestUrlParam(c[0]).url.includes('tenant_access_token'),
    )
    expect(tokenCalls).toHaveLength(1)
  })

  it('throws a clear error when the tenant token response has a non-zero code', async () => {
    mockRoutes({
      tenant_access_token: () => ({
        json: { code: 99991663, msg: 'invalid app secret' },
      }),
    })
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)
    sendEventFrame(ws, makeMessageReceiveEnvelope())
    const event = await messagePromise

    await expect(
      adapter.sendMessage(event.sessionKey, { text: 'hi' }),
    ).rejects.toThrow(/invalid app secret/)
  })
})

describe('FeishuAdapter — onMessage/onError bookkeeping', () => {
  it('subscribes and unsubscribes message handlers', () => {
    const adapter = new FeishuAdapter(makeApp())
    const handler = jest.fn()
    const unsubscribe = adapter.onMessage(handler)
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
  })

  it('subscribes and unsubscribes error handlers', () => {
    const adapter = new FeishuAdapter(makeApp())
    const handler = jest.fn()
    const unsubscribe = adapter.onError(handler)
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
  })
})
