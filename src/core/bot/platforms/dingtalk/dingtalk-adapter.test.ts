import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'

import { Platform, requestUrl } from 'obsidian'
import type { App, RequestUrlParam } from 'obsidian'

import type { BotPlatformDingtalkConfig } from '../../../../settings/schema/setting.types'
import type { PlatformMessageEvent } from '../../types'

import { DingTalkAdapter } from './dingtalk-adapter'

// Relies on the global `__mocks__/obsidian.ts` mock (exports `requestUrl`/
// `Platform`/`FileSystemAdapter`/`App` together) rather than overriding the
// whole module — this suite needs all of them plus a custom global
// `WebSocket`, matching `platform-adapter-factory.test.ts`'s approach.
const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

function makeApp(): App {
  return { vault: { adapter: {} } } as unknown as App
}

function makeConfig(
  overrides: Partial<BotPlatformDingtalkConfig> = {},
): BotPlatformDingtalkConfig {
  return {
    id: 'dt-1',
    name: 'My DingTalk Bot',
    enabled: true,
    platformType: 'dingtalk',
    allowedUsers: [],
    allowedGroups: [],
    whitelistEnabled: true,
    robotCode: 'robot-1',
    clientId: 'client-1',
    clientSecret: 'secret-1',
    streamMode: true,
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

const DEFAULT_ENDPOINT = 'wss://long-conn.dingtalk.com:8443/ignoredPath'
const DEFAULT_TICKET = 'ticket-abc'

type RouteHandler = (param: RequestUrlParam) => unknown

/** Routes `requestUrl` calls by URL substring so tests don't depend on call
 * order. Always includes the connection-open route so `startAdapter()` keeps
 * working when a test layers on more routes afterwards. */
function mockRoutes(routes: Record<string, RouteHandler>): void {
  const allRoutes: Record<string, RouteHandler> = {
    'gateway/connections/open': () => ({
      json: { endpoint: DEFAULT_ENDPOINT, ticket: DEFAULT_TICKET },
    }),
    'webhook.dingtalk.com': () => ({ json: { errcode: 0 } }),
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
  adapter: DingTalkAdapter,
): Promise<PlatformMessageEvent> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onMessage((event) => {
      unsubscribe()
      resolve(event)
    })
  })
}

function waitForNextError(adapter: DingTalkAdapter): Promise<Error> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onError((error) => {
      unsubscribe()
      resolve(error)
    })
  })
}

type MockMessageEvent = {
  data: string
}

class MockWebSocket {
  static instances: MockWebSocket[] = []

  readonly url: string
  readonly sent: string[] = []
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

/** Starts the adapter and opens its (mocked) WebSocket, mirroring what a real
 * successful handshake + connect looks like. */
async function startAdapter(
  configOverrides: Partial<BotPlatformDingtalkConfig> = {},
): Promise<{ adapter: DingTalkAdapter; ws: MockWebSocket }> {
  const adapter = new DingTalkAdapter(makeApp())
  liveAdapters.push(adapter)
  await adapter.start(makeConfig(configOverrides))
  const ws = latestSocket()
  ws.onopen?.()
  return { adapter, ws }
}

function sendFrame(
  ws: MockWebSocket,
  frame: {
    type: 'SYSTEM' | 'EVENT' | 'CALLBACK'
    headers: { topic?: string; messageId: string }
    data: string
  },
): void {
  ws.onmessage?.({ data: JSON.stringify(frame) })
}

function makeChatbotMessage(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    conversationId: 'conv-1',
    conversationType: '1',
    senderId: 'sender-1',
    senderStaffId: 'staff-1',
    senderNick: 'Alice',
    msgId: 'msg-1',
    createAt: 1_700_000_000_000,
    msgtype: 'text',
    text: { content: 'hello there' },
    sessionWebhook: 'https://webhook.dingtalk.com/reply/abc',
    sessionWebhookExpiredTime: Date.now() + 10 * 60_000,
    ...overrides,
  }
}

let originalWebSocket: typeof WebSocket | undefined

/** Adapters started during this file — stopped in `afterEach` so their
 * stable-connection/reconnect timers (real timers, up to 300s) never keep
 * jest's worker alive and force it to exit. */
const liveAdapters: DingTalkAdapter[] = []

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

describe('DingTalkAdapter — capabilities', () => {
  it('declares text/image/file support without streaming', () => {
    const adapter = new DingTalkAdapter(makeApp())
    expect(adapter.capabilities).toEqual({
      markdownMode: 'none',
      supportsImage: true,
      supportsFile: true,
      supportsStreaming: false,
      maxMessageLength: 20_000,
      maxImageSize: 20 * 1024 * 1024,
      maxFileSize: 100 * 1024 * 1024,
    })
  })
})

describe('DingTalkAdapter — start()', () => {
  it('throws a desktop-only error on mobile without making any request', async () => {
    Platform.isMobile = true
    const adapter = new DingTalkAdapter(makeApp())
    await expect(adapter.start(makeConfig())).rejects.toThrow(/desktop-only/)
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('throws a clear error when streamMode is false', async () => {
    const adapter = new DingTalkAdapter(makeApp())
    await expect(
      adapter.start(makeConfig({ streamMode: false })),
    ).rejects.toThrow(/Stream Mode/)
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('opens the connection with the expected request shape and builds the WS URL from endpoint host only', async () => {
    const { ws } = await startAdapter()

    expect(mockedRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.dingtalk.com/v1.0/gateway/connections/open',
        method: 'POST',
      }),
    )
    const call = asRequestUrlParam(mockedRequestUrl.mock.calls[0][0])
    expect(JSON.parse(bodyAsString(call))).toEqual({
      clientId: 'client-1',
      clientSecret: 'secret-1',
      ua: 'yolo-obsidian',
      subscriptions: [{ type: 'CALLBACK', topic: '/v1.0/im/bot/messages/get' }],
      localIp: '127.0.0.1',
    })

    expect(ws.url).toBe(
      'wss://long-conn.dingtalk.com:8443/connect?ticket=ticket-abc',
    )
  })

  it('degrades and schedules a reconnect when the connection-open request fails, without throwing', async () => {
    mockedRequestUrl.mockRejectedValue(new Error('network down'))
    jest.useFakeTimers()

    const adapter = new DingTalkAdapter(makeApp())
    const errorPromise = waitForNextError(adapter)
    await adapter.start(makeConfig())

    expect(adapter.health()).toBe('degraded')
    await expect(errorPromise).resolves.toThrow(/network down/)
    expect(MockWebSocket.instances).toHaveLength(0)
  })

  it('B2: does not open a socket when stop() lands during the connection-open handshake', async () => {
    let releaseHandshake!: (value: unknown) => void
    const handshake = new Promise((resolve) => {
      releaseHandshake = resolve
    })
    mockedRequestUrl.mockImplementation(
      (() => handshake) as unknown as typeof requestUrl,
    )

    const adapter = new DingTalkAdapter(makeApp())
    liveAdapters.push(adapter)
    const starting = adapter.start(makeConfig())
    await Promise.resolve() // let the handshake await begin
    await adapter.stop()
    releaseHandshake({
      json: { endpoint: DEFAULT_ENDPOINT, ticket: DEFAULT_TICKET },
    })
    await starting

    // RED on the old behavior: connect() created the socket anyway.
    expect(MockWebSocket.instances).toHaveLength(0)
    expect(adapter.health()).toBe('stopped')
  })
})

describe('DingTalkAdapter — WS frame handling', () => {
  it('echoes ping data back unchanged in a 200/OK ack', async () => {
    const { adapter, ws } = await startAdapter()
    expect(adapter.health()).toBe('running')

    sendFrame(ws, {
      type: 'SYSTEM',
      headers: { topic: 'ping', messageId: 'ping-1' },
      data: 'ping-payload',
    })

    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0])).toMatchObject({
      code: 200,
      message: 'OK',
      headers: { messageId: 'ping-1' },
      data: 'ping-payload',
    })
  })

  it('emits a non-fatal error on a disconnect system frame without crashing', async () => {
    const { adapter, ws } = await startAdapter()
    const errorPromise = waitForNextError(adapter)

    sendFrame(ws, {
      type: 'SYSTEM',
      headers: { topic: 'disconnect', messageId: 'sys-1' },
      data: 'server is closing',
    })

    await expect(errorPromise).resolves.toThrow(/disconnect/)
  })

  it('acks a CALLBACK frame immediately with an empty JSON body and dispatches a parsed message event', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)
    const message = makeChatbotMessage()

    sendFrame(ws, {
      type: 'CALLBACK',
      headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'cb-1' },
      data: JSON.stringify(message),
    })

    expect(JSON.parse(ws.sent[0])).toMatchObject({
      code: 200,
      message: 'OK',
      headers: { messageId: 'cb-1' },
      data: '{}',
    })

    const event = await messagePromise
    expect(event).toMatchObject({
      platformName: 'dingtalk',
      messageId: 'msg-1',
      sessionKey: 'dingtalk:private:conv-1',
      chatType: 'private',
      senderId: 'staff-1',
      senderName: 'Alice',
      isFromBot: false,
    })
    expect(event.message.components).toEqual([
      { type: 'text', text: 'hello there' },
    ])
    expect(event.message.plainText).toBe('hello there')
  })

  it('acks an EVENT frame generically', async () => {
    const { ws } = await startAdapter()

    sendFrame(ws, {
      type: 'EVENT',
      headers: { messageId: 'evt-1' },
      data: '{}',
    })

    expect(JSON.parse(ws.sent[0])).toMatchObject({
      headers: { messageId: 'evt-1' },
    })
  })

  it('sets mentionedBotId for a group message that @s the robot (isInAtList)', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)

    sendFrame(ws, {
      type: 'CALLBACK',
      headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'cb-g1' },
      data: JSON.stringify(
        makeChatbotMessage({ conversationType: '2', isInAtList: true }),
      ),
    })

    const event = await messagePromise
    expect(event.chatType).toBe('group')
    expect(event.mentionedBotId).toBe('dingtalk')
  })

  it('keeps mentionedBotId unset for a group message that explicitly did not @ the robot', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)

    sendFrame(ws, {
      type: 'CALLBACK',
      headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'cb-g2' },
      data: JSON.stringify(
        makeChatbotMessage({ conversationType: '2', isInAtList: false }),
      ),
    })

    const event = await messagePromise
    expect(event.chatType).toBe('group')
    expect(event.mentionedBotId).toBeUndefined()
  })

  it('keeps mentionedBotId unset for private-chat messages', async () => {
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)

    sendFrame(ws, {
      type: 'CALLBACK',
      headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'cb-p1' },
      data: JSON.stringify(makeChatbotMessage({ isInAtList: true })),
    })

    const event = await messagePromise
    expect(event.chatType).toBe('private')
    expect(event.mentionedBotId).toBeUndefined()
  })
})

describe('DingTalkAdapter — reconnect backoff', () => {
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

describe('DingTalkAdapter — sendMessage()', () => {
  it('throws when there is no cached session binding for the sessionKey', async () => {
    const { adapter } = await startAdapter()
    await expect(
      adapter.sendMessage('dingtalk:private:unknown', { text: 'hi' }),
    ).rejects.toThrow(/session binding/)
  })

  async function receiveMessage(
    adapter: DingTalkAdapter,
    ws: MockWebSocket,
    overrides: Partial<Record<string, unknown>> = {},
  ): Promise<PlatformMessageEvent> {
    const messagePromise = waitForNextMessage(adapter)
    sendFrame(ws, {
      type: 'CALLBACK',
      headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'cb-seed' },
      data: JSON.stringify(makeChatbotMessage(overrides)),
    })
    return messagePromise
  }

  it('sends plain text via the cached sessionWebhook when it is still valid', async () => {
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws)

    const refs = await adapter.sendMessage(event.sessionKey, { text: 'reply!' })

    expect(mockedRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://webhook.dingtalk.com/reply/abc',
        method: 'POST',
      }),
    )
    const call = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('webhook.dingtalk.com'),
    )
    expect(call).toBeDefined()
    expect(JSON.parse(bodyAsString(asRequestUrlParam(call![0])))).toEqual({
      msgtype: 'text',
      text: { content: 'reply!' },
    })
    expect(refs).toHaveLength(1)
    expect(refs[0].sessionKey).toBe(event.sessionKey)
  })

  it('B4: splits a long text reply at the 20000 cap when sending via webhook', async () => {
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws)

    const longText = 'z'.repeat(45_000)
    const refs = await adapter.sendMessage(event.sessionKey, { text: longText })

    const webhookCalls = mockedRequestUrl.mock.calls.filter((c) =>
      asRequestUrlParam(c[0]).url.includes('webhook.dingtalk.com'),
    )
    // RED on the old behavior: one oversized call instead of three chunks.
    expect(webhookCalls).toHaveLength(3)
    const chunks = webhookCalls.map((c) => {
      const body = JSON.parse(bodyAsString(asRequestUrlParam(c[0]))) as {
        text: { content: string }
      }
      return body.text.content
    })
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20_000)
    }
    expect(chunks.join('')).toBe(longText)
    expect(refs).toHaveLength(3)
  })

  it('falls back to the REST private-send API once the sessionWebhook has expired', async () => {
    mockRoutes({
      'oauth2/accessToken': () => ({
        json: { accessToken: 'tok-1', expireIn: 7200 },
      }),
      'oToMessages/batchSend': () => ({ json: {} }),
    })
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws, {
      sessionWebhookExpiredTime: Date.now() - 1000,
    })

    await adapter.sendMessage(event.sessionKey, { text: 'late reply' })

    const sendCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('oToMessages/batchSend'),
    )
    expect(sendCall).toBeDefined()
    const param = asRequestUrlParam(sendCall![0])
    expect(param.headers).toMatchObject({
      'x-acs-dingtalk-access-token': 'tok-1',
    })
    expect(JSON.parse(bodyAsString(param))).toEqual({
      robotCode: 'robot-1',
      userIds: ['staff-1'],
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: 'late reply' }),
    })
  })

  it('sends to the group REST API when the binding is a group chat', async () => {
    mockRoutes({
      'oauth2/accessToken': () => ({
        json: { accessToken: 'tok-1', expireIn: 7200 },
      }),
      'groupMessages/send': () => ({ json: {} }),
    })
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws, {
      conversationType: '2',
      conversationId: 'group-conv-1',
      sessionWebhookExpiredTime: Date.now() - 1000,
    })

    await adapter.sendMessage(event.sessionKey, { text: 'group reply' })

    const sendCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('groupMessages/send'),
    )
    expect(sendCall).toBeDefined()
    expect(JSON.parse(bodyAsString(asRequestUrlParam(sendCall![0])))).toEqual({
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: 'group reply' }),
      openConversationId: 'group-conv-1',
      robotCode: 'robot-1',
    })
  })

  it('forces the REST path and uploads media when the reply includes an image, even with a valid webhook', async () => {
    mockRoutes({
      'oauth2/accessToken': () => ({
        json: { accessToken: 'tok-1', expireIn: 7200 },
      }),
      'img.example.com/pic.jpg': () => ({ arrayBuffer: new ArrayBuffer(4) }),
      'media/upload': () => ({ json: { errcode: 0, media_id: 'media-123' } }),
      'oToMessages/batchSend': () => ({ json: {} }),
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

    const webhookCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('webhook.dingtalk.com'),
    )
    expect(webhookCall).toBeUndefined()

    const uploadCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('media/upload'),
    )
    expect(uploadCall).toBeDefined()
    const uploadParam = asRequestUrlParam(uploadCall![0])
    expect(uploadParam.contentType).toMatch(/^multipart\/form-data; boundary=/)
    expect(uploadParam.body).toBeInstanceOf(ArrayBuffer)

    const sendCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('oToMessages/batchSend'),
    )
    expect(sendCall).toBeDefined()
    expect(JSON.parse(bodyAsString(asRequestUrlParam(sendCall![0])))).toEqual({
      robotCode: 'robot-1',
      userIds: ['staff-1'],
      msgKey: 'sampleImageMsg',
      msgParam: JSON.stringify({ photoURL: 'media-123' }),
    })
  })

  it('rejects an oversized base64 file before uploading it', async () => {
    mockRoutes({
      'oauth2/accessToken': () => ({
        json: { accessToken: 'tok-1', expireIn: 7200 },
      }),
    })
    const { adapter, ws } = await startAdapter()
    const event = await receiveMessage(adapter, ws)

    await expect(
      adapter.sendMessage(event.sessionKey, {
        files: [
          {
            source: 'base64',
            dataBase64: Buffer.alloc(100 * 1024 * 1024 + 1).toString('base64'),
            mimeType: 'application/pdf',
            name: 'large.pdf',
          },
        ],
      }),
    ).rejects.toThrow(/exceeds.*file.*limit/i)

    expect(
      mockedRequestUrl.mock.calls.some((c) =>
        asRequestUrlParam(c[0]).url.includes('media/upload'),
      ),
    ).toBe(false)
  })
})

describe('DingTalkAdapter — sendStreamingMessage()', () => {
  it('throws because capabilities.supportsStreaming is false', async () => {
    const { adapter } = await startAdapter()
    expect(() =>
      adapter.sendStreamingMessage('dingtalk:private:conv-1'),
    ).toThrow(/[Ss]treaming/)
  })
})

describe('DingTalkAdapter — downloadFile()', () => {
  it('downloads bytes to a real temp file and reports its size', async () => {
    mockRoutes({
      'oauth2/accessToken': () => ({
        json: { accessToken: 'tok-1', expireIn: 7200 },
      }),
      'messageFiles/download': () => ({
        json: { downloadUrl: 'https://files.example.com/report.pdf' },
      }),
      'files.example.com/report.pdf': () => ({
        arrayBuffer: new TextEncoder().encode('file-bytes').buffer,
      }),
    })
    const { adapter } = await startAdapter()

    const result = await adapter.downloadFile({
      type: 'file',
      fileId: 'download-code-1',
      mimeType: 'application/pdf',
      name: 'report.pdf',
    })

    expect(result.fileName).toBe('report.pdf')
    expect(result.mimeType).toBe('application/pdf')
    expect(result.size).toBe('file-bytes'.length)
    expect(result.tempPath.startsWith(os.tmpdir())).toBe(true)

    const written = await fsPromises.readFile(result.tempPath, 'utf8')
    expect(written).toBe('file-bytes')
  })

  it('throws a clear error when the component has no downloadCode', async () => {
    const { adapter } = await startAdapter()
    await expect(
      adapter.downloadFile({ type: 'text', text: 'no file here' }),
    ).rejects.toThrow(/downloadCode/)
  })
})

describe('DingTalkAdapter — access token caching', () => {
  it('caches the token from the flat {accessToken, expireIn} response shape', async () => {
    mockRoutes({
      'oauth2/accessToken': () => ({
        json: { accessToken: 'flat-tok', expireIn: 7200 },
      }),
      'oToMessages/batchSend': () => ({ json: {} }),
    })
    const { adapter, ws } = await startAdapter()
    const event = await (async () => {
      const messagePromise = waitForNextMessage(adapter)
      sendFrame(ws, {
        type: 'CALLBACK',
        headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'cb-x' },
        data: JSON.stringify(
          makeChatbotMessage({ sessionWebhookExpiredTime: Date.now() - 1 }),
        ),
      })
      return messagePromise
    })()

    await adapter.sendMessage(event.sessionKey, { text: 'first' })
    await adapter.sendMessage(event.sessionKey, { text: 'second' })

    const tokenCalls = mockedRequestUrl.mock.calls.filter((c) =>
      asRequestUrlParam(c[0]).url.includes('oauth2/accessToken'),
    )
    expect(tokenCalls).toHaveLength(1)
  })

  it('falls back to the nested {data: {accessToken, expireIn}} response shape', async () => {
    mockRoutes({
      'oauth2/accessToken': () => ({
        json: { data: { accessToken: 'nested-tok', expireIn: 7200 } },
      }),
      'oToMessages/batchSend': () => ({ json: {} }),
    })
    const { adapter, ws } = await startAdapter()
    const messagePromise = waitForNextMessage(adapter)
    sendFrame(ws, {
      type: 'CALLBACK',
      headers: { topic: '/v1.0/im/bot/messages/get', messageId: 'cb-y' },
      data: JSON.stringify(
        makeChatbotMessage({ sessionWebhookExpiredTime: Date.now() - 1 }),
      ),
    })
    const event = await messagePromise

    await adapter.sendMessage(event.sessionKey, { text: 'reply' })

    const sendCall = mockedRequestUrl.mock.calls.find((c) =>
      asRequestUrlParam(c[0]).url.includes('oToMessages/batchSend'),
    )
    expect(sendCall).toBeDefined()
    expect(asRequestUrlParam(sendCall![0]).headers).toMatchObject({
      'x-acs-dingtalk-access-token': 'nested-tok',
    })
  })
})

describe('DingTalkAdapter — onMessage/onError bookkeeping', () => {
  it('subscribes and unsubscribes message handlers', () => {
    const adapter = new DingTalkAdapter(makeApp())
    const handler = jest.fn()
    const unsubscribe = adapter.onMessage(handler)
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
  })

  it('subscribes and unsubscribes error handlers', () => {
    const adapter = new DingTalkAdapter(makeApp())
    const handler = jest.fn()
    const unsubscribe = adapter.onError(handler)
    expect(typeof unsubscribe).toBe('function')
    unsubscribe()
  })
})
