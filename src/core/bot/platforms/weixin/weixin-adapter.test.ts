jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
}))

import { createCipheriv } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'

import { requestUrl } from 'obsidian'
import type { RequestUrlParam, RequestUrlResponsePromise } from 'obsidian'

import type { BotPlatformWeixinConfig } from '../../../../settings/schema/setting.types'
import type { PlatformMessageEvent } from '../../types'

import { WeixinOCAdapter } from './weixin-adapter'

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

function makeConfig(
  overrides: Partial<BotPlatformWeixinConfig> = {},
): BotPlatformWeixinConfig {
  return {
    id: 'wx-1',
    name: 'My WeChat Bot',
    enabled: true,
    platformType: 'weixin_oc',
    botToken: undefined,
    baseUrl: 'https://ilinkai.weixin.qq.com',
    botId: undefined,
    loginTime: undefined,
    allowedUsers: [],
    allowedGroups: [],
    whitelistEnabled: true,
    pollTimeoutMs: 40_000,
    ...overrides,
  }
}

/** Never resolves — used to freeze the poll loop on its current iteration so
 * a test can safely call `adapter.stop()` (which aborts the pending request
 * via its `AbortSignal` listener) without waiting on any real timer. */
function hangForever(): RequestUrlResponsePromise {
  return new Promise(() => {}) as unknown as RequestUrlResponsePromise
}

/** `mockedRequestUrl.mock.calls` is typed against `requestUrl`'s
 * `string | RequestUrlParam` parameter — every call in this suite passes the
 * object form, so this narrows that away instead of repeating the guard at
 * each call site. */
function asRequestUrlParam(request: string | RequestUrlParam): RequestUrlParam {
  if (typeof request === 'string') {
    throw new Error('expected a RequestUrlParam object, got a bare URL string')
  }
  return request
}

/** `body` is typed `string | ArrayBuffer | undefined` — the adapter only
 * ever sends JSON string bodies, so this asserts that instead of calling
 * `String()` on a value that could legitimately be an ArrayBuffer. */
function bodyAsString(param: RequestUrlParam): string {
  if (typeof param.body !== 'string') {
    throw new Error('expected a string request body')
  }
  return param.body
}

function bodyAsArrayBuffer(param: RequestUrlParam): ArrayBuffer {
  if (!(param.body instanceof ArrayBuffer)) {
    throw new Error('expected an ArrayBuffer request body')
  }
  return param.body
}

function bytesAsArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
}

function encryptAesEcb(plaintext: Uint8Array, key: Buffer): Buffer {
  const cipher = createCipheriv('aes-128-ecb', key, null)
  cipher.setAutoPadding(true)
  return Buffer.concat([cipher.update(plaintext), cipher.final()])
}

function mockStartWithHangingPoll(): void {
  mockedRequestUrl.mockImplementation(((request) => {
    const param = asRequestUrlParam(request)
    if (param.url.includes('/ilink/bot/msg/notifystart')) {
      return Promise.resolve({ json: { ret: 0 } }) as never
    }
    return hangForever()
  }) as typeof requestUrl)
}

function mockStartWithFirstPoll(response: { json: unknown }): void {
  let pollCount = 0
  mockedRequestUrl.mockImplementation(((request) => {
    const param = asRequestUrlParam(request)
    if (param.url.includes('/ilink/bot/msg/notifystart')) {
      return Promise.resolve({ json: { ret: 0 } }) as never
    }
    if (pollCount === 0) {
      pollCount += 1
      return Promise.resolve(response) as never
    }
    return hangForever()
  }) as typeof requestUrl)
}

function waitForNextMessage(
  adapter: WeixinOCAdapter,
): Promise<PlatformMessageEvent> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onMessage((event) => {
      unsubscribe()
      resolve(event)
    })
  })
}

function waitForNextError(adapter: WeixinOCAdapter): Promise<Error> {
  return new Promise((resolve) => {
    const unsubscribe = adapter.onError((error) => {
      unsubscribe()
      resolve(error)
    })
  })
}

beforeEach(() => {
  mockedRequestUrl.mockReset()
})

describe('WeixinOCAdapter — capabilities', () => {
  it('declares image and file support with conservative media limits', () => {
    const adapter = new WeixinOCAdapter()
    expect(adapter.capabilities.supportsImage).toBe(true)
    expect(adapter.capabilities.supportsFile).toBe(true)
    expect(adapter.capabilities.supportsStreaming).toBe(false)
    expect(adapter.capabilities.maxImageSize).toBe(20 * 1024 * 1024)
    expect(adapter.capabilities.maxFileSize).toBe(50 * 1024 * 1024)
  })
})

describe('WeixinOCAdapter — start()', () => {
  it('stays in a needs-login state without throwing when no botToken is configured', async () => {
    const adapter = new WeixinOCAdapter()
    await expect(
      adapter.start(makeConfig({ botToken: undefined })),
    ).resolves.toBeUndefined()
    expect(adapter.health()).toBe('stopped')
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('notifies iLink that the bot is starting before polling for messages', async () => {
    mockStartWithHangingPoll()

    const adapter = new WeixinOCAdapter()

    await adapter.start(makeConfig({ botToken: 'saved-token' }))

    try {
      const notifyCall = mockedRequestUrl.mock.calls.find(([request]) =>
        asRequestUrlParam(request).url.includes('/ilink/bot/msg/notifystart'),
      )
      expect(notifyCall).toBeDefined()
      expect(asRequestUrlParam(notifyCall![0])).toEqual(
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: 'Bearer saved-token',
          }),
          body: expect.stringContaining('channel_version'),
        }),
      )
    } finally {
      await adapter.stop()
    }
  })

  it('starts the long-poll loop when a botToken is already configured', async () => {
    mockStartWithHangingPoll()
    const adapter = new WeixinOCAdapter()

    await adapter.start(makeConfig({ botToken: 'saved-token' }))
    expect(adapter.health()).toBe('running')
    expect(mockedRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({ url: expect.stringContaining('getupdates') }),
    )

    await adapter.stop()
    expect(adapter.health()).toBe('stopped')
  })

  it('emits a diagnostic error when the getupdates request fails', async () => {
    let pollCount = 0
    mockedRequestUrl.mockImplementation(((request) => {
      const param = asRequestUrlParam(request)
      if (param.url.includes('/ilink/bot/msg/notifystart')) {
        return Promise.resolve({ json: { ret: 0 } }) as never
      }
      if (pollCount === 0) {
        pollCount += 1
        return Promise.reject(new Error('network down')) as never
      }
      return hangForever()
    }) as typeof requestUrl)

    const adapter = new WeixinOCAdapter()
    const errorPromise = waitForNextError(adapter)
    await adapter.start(makeConfig({ botToken: 'saved-token' }))

    try {
      const error = await Promise.race([
        errorPromise,
        new Promise<Error>((_, reject) => {
          setTimeout(() => reject(new Error('diagnostic timeout')), 100)
        }),
      ])
      expect(error.message).toBe('network down')
      expect(adapter.health()).toBe('degraded')
    } finally {
      await adapter.stop()
    }
  })

})

describe('WeixinOCAdapter — QR login', () => {
  it('requests a QR login key with the legacy GET protocol', async () => {
    mockedRequestUrl.mockResolvedValueOnce({
      json: { qrcode: 'key-abc', interval: 3000 },
    } as never)

    const adapter = new WeixinOCAdapter()
    const result = await adapter.requestQRCode()

    expect(result).toEqual({ qrcode: 'key-abc', interval: 3000 })
    expect(mockedRequestUrl).toHaveBeenCalledWith({
      url: 'https://ilinkai.weixin.qq.com/ilink/bot/get_bot_qrcode?bot_type=3',
      method: 'GET',
      throw: false,
    })
  })

  it('preserves the QR image content when the service provides it', async () => {
    mockedRequestUrl.mockResolvedValueOnce({
      json: {
        qrcode: 'key-abc',
        qrcode_img_content: 'https://liteapp.weixin.qq.com/q/example',
        interval: 3000,
      },
    } as never)

    const adapter = new WeixinOCAdapter()

    await expect(adapter.requestQRCode()).resolves.toEqual({
      qrcode: 'key-abc',
      qrcodeUrl: 'https://liteapp.weixin.qq.com/q/example',
      interval: 3000,
    })
  })

  it.each([
    ['pending', { status: 'pending' }],
    ['scanned', { status: 'scanned' }],
    ['expired', { status: 'expired' }],
  ] as const)('pollQRStatus() reports a %s status', async (expected, body) => {
    mockedRequestUrl.mockResolvedValueOnce({ json: body } as never)
    const adapter = new WeixinOCAdapter()

    const result = await adapter.pollQRStatus('key-abc')
    expect(result.status).toBe(expected)
  })

  it('pollQRStatus() returns the confirmed credentials for the caller to persist', async () => {
    mockedRequestUrl.mockResolvedValueOnce({
      json: {
        status: 'confirmed',
        bot_token: 'fresh-token',
        baseurl: 'https://ilinkai.weixin.qq.com',
        bot_id: 'bot-42',
      },
    } as never)
    const adapter = new WeixinOCAdapter()

    const result = await adapter.pollQRStatus('key-abc')
    expect(result).toEqual({
      status: 'confirmed',
      botToken: 'fresh-token',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      botId: 'bot-42',
    })
  })

  it('treats an unrecognized status string as pending rather than throwing', async () => {
    mockedRequestUrl.mockResolvedValueOnce({
      json: { status: 'something-unexpected' },
    } as never)
    const adapter = new WeixinOCAdapter()

    const result = await adapter.pollQRStatus('key-abc')
    expect(result.status).toBe('pending')
  })
})

describe('WeixinOCAdapter — session expiry (errcode -14)', () => {
  it('clears the token, stops the loop, and emits an error for the UI to prompt re-login', async () => {
    mockStartWithFirstPoll({
      json: { ret: 1, errcode: -14, errmsg: 'session expired' },
    })

    const adapter = new WeixinOCAdapter()
    const errorPromise = waitForNextError(adapter)
    await adapter.start(makeConfig({ botToken: 'stale-token' }))

    const error = await errorPromise
    expect(error.message).toMatch(/session expired/i)
    expect(adapter.health()).toBe('stopped')

    // Token was cleared — sending now fails with the "not logged in" error,
    // not just a missing-context-token error.
    await expect(
      adapter.sendMessage('weixin_oc:private:alice', { text: 'hi' }),
    ).rejects.toThrow(/not logged in/)
  })

  it('backs off and retries (without clearing the token) on other protocol errors', async () => {
    mockStartWithFirstPoll({
      json: { ret: 1, errcode: -1, errmsg: 'transient failure' },
    })

    const adapter = new WeixinOCAdapter()
    const errorPromise = waitForNextError(adapter)
    await adapter.start(makeConfig({ botToken: 'still-valid-token' }))

    const error = await errorPromise
    expect(error.message).toMatch(/transient failure/)
    // Degraded, not stopped — this is a retryable error, unlike -14.
    expect(adapter.health()).toBe('degraded')

    await adapter.stop()
  })
})

describe('WeixinOCAdapter — inbound media downloads', () => {
  it('downloads and decrypts an encrypted file using a base64 ASCII-hex key', async () => {
    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const encrypted = encryptAesEcb(Buffer.from('wechat-file'), key)
    mockStartWithFirstPoll({
      json: {
        ret: 0,
        msgs: [
          {
            message_id: 'm-file-download',
            from_user_id: 'alice',
            item_list: [
              {
                type: 4,
                file_item: {
                  media: {
                    encrypt_query_param: 'file-query',
                    aes_key: Buffer.from(key.toString('hex'), 'utf8').toString(
                      'base64',
                    ),
                  },
                  file_name: 'report.pdf',
                  len: '11',
                },
              },
            ],
          },
        ],
      },
    })

    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))
    const event = await messagePromise
    const component = event.message.components.find(
      (candidate) => candidate.type === 'file',
    )
    expect(component).toBeDefined()

    mockedRequestUrl.mockReset()
    mockedRequestUrl.mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: bytesAsArrayBuffer(encrypted),
    } as never)

    const result = await adapter.downloadFile(component!)
    expect(result).toMatchObject({
      fileName: 'report.pdf',
      mimeType: 'application/pdf',
      size: Buffer.byteLength('wechat-file'),
    })
    expect(await readFile(result.tempPath)).toEqual(Buffer.from('wechat-file'))
    expect(mockedRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=file-query',
        method: 'GET',
        throw: false,
      }),
    )

    await rm(result.tempPath, { force: true })
    await adapter.stop()
  })

  it('downloads and decrypts an image using the direct hex image_item.aeskey', async () => {
    const key = Buffer.from('fedcba98765432100123456789abcdef', 'hex')
    const encrypted = encryptAesEcb(Buffer.from('wechat-image'), key)
    mockStartWithFirstPoll({
      json: {
        ret: 0,
        msgs: [
          {
            message_id: 'm-image-download',
            from_user_id: 'alice',
            item_list: [
              {
                type: 2,
                image_item: {
                  aeskey: key.toString('hex'),
                  media: { encrypt_query_param: 'image-query' },
                  mid_size: encrypted.byteLength,
                },
              },
            ],
          },
        ],
      },
    })

    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))
    const event = await messagePromise
    const component = event.message.components.find(
      (candidate) => candidate.type === 'image',
    )
    expect(component).toBeDefined()

    mockedRequestUrl.mockReset()
    mockedRequestUrl.mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: bytesAsArrayBuffer(encrypted),
    } as never)

    const result = await adapter.downloadFile(component!)
    expect(result.fileName).toMatch(/\.(?:jpg|jpeg|png)$/i)
    expect(result.mimeType).toBe('image/jpeg')
    expect(await readFile(result.tempPath)).toEqual(Buffer.from('wechat-image'))
    expect(mockedRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=image-query',
      }),
    )

    await rm(result.tempPath, { force: true })
    await adapter.stop()
  })

  it('accepts a base64-encoded raw 16-byte AES key', async () => {
    const key = Buffer.from('1234567890abcdef')
    const encrypted = encryptAesEcb(Buffer.from('raw-key-file'), key)
    mockStartWithFirstPoll({
      json: {
        ret: 0,
        msgs: [
          {
            message_id: 'm-raw-key',
            from_user_id: 'alice',
            item_list: [
              {
                type: 4,
                file_item: {
                  media: {
                    encrypt_query_param: 'raw-key-query',
                    aes_key: key.toString('base64'),
                  },
                  file_name: 'raw.bin',
                },
              },
            ],
          },
        ],
      },
    })

    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))
    const event = await messagePromise
    const component = event.message.components.find(
      (candidate) => candidate.type === 'file',
    )
    mockedRequestUrl.mockReset()
    mockedRequestUrl.mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: bytesAsArrayBuffer(encrypted),
    } as never)

    const result = await adapter.downloadFile(component!)
    expect(await readFile(result.tempPath)).toEqual(Buffer.from('raw-key-file'))

    await rm(result.tempPath, { force: true })
    await adapter.stop()
  })

  it('rejects missing keys, HTTP failures, and oversized encrypted responses', async () => {
    const makeMediaMessage = (media: Record<string, unknown>) => ({
      message_id: 'm-invalid-media',
      from_user_id: 'alice',
      item_list: [
        {
          type: 4,
          file_item: { media, file_name: 'bad.bin' },
        },
      ],
    })

    mockStartWithFirstPoll({
      json: {
        ret: 0,
        msgs: [makeMediaMessage({ encrypt_query_param: 'missing-key' })],
      },
    })
    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))
    const event = await messagePromise
    const component = event.message.components.find(
      (candidate) => candidate.type === 'file',
    )
    const errorHandler = jest.fn()
    adapter.onError(errorHandler)

    mockedRequestUrl.mockReset()
    mockedRequestUrl.mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(16),
    } as never)
    await expect(adapter.downloadFile(component!)).rejects.toThrow(/AES key/i)
    expect(errorHandler).toHaveBeenCalledWith(
      expect.any(Error),
      adapter,
      expect.objectContaining({ operation: 'receive' }),
    )
    await adapter.stop()

    const key = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const validMedia = {
      encrypt_query_param: 'http-error',
      aes_key: key.toString('base64'),
    }
    mockStartWithFirstPoll({
      json: { ret: 0, msgs: [makeMediaMessage(validMedia)] },
    })
    const httpAdapter = new WeixinOCAdapter()
    const httpMessagePromise = waitForNextMessage(httpAdapter)
    await httpAdapter.start(makeConfig({ botToken: 'tok' }))
    const httpEvent = await httpMessagePromise
    const httpComponent = httpEvent.message.components.find(
      (candidate) => candidate.type === 'file',
    )
    mockedRequestUrl.mockReset()
    mockedRequestUrl.mockResolvedValueOnce({
      status: 503,
      headers: {},
      arrayBuffer: new ArrayBuffer(0),
    } as never)
    await expect(httpAdapter.downloadFile(httpComponent!)).rejects.toThrow(
      /HTTP 503/,
    )
    await httpAdapter.stop()

    mockStartWithFirstPoll({
      json: { ret: 0, msgs: [makeMediaMessage(validMedia)] },
    })
    const largeAdapter = new WeixinOCAdapter()
    const largeMessagePromise = waitForNextMessage(largeAdapter)
    await largeAdapter.start(makeConfig({ botToken: 'tok' }))
    const largeEvent = await largeMessagePromise
    const largeComponent = largeEvent.message.components.find(
      (candidate) => candidate.type === 'file',
    )
    mockedRequestUrl.mockReset()
    mockedRequestUrl.mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: new ArrayBuffer(50 * 1024 * 1024 + 17),
    } as never)
    await expect(largeAdapter.downloadFile(largeComponent!)).rejects.toThrow(
      /exceeds.*limit/i,
    )
    await largeAdapter.stop()
  })
})

describe('WeixinOCAdapter — message conversion', () => {
  it('converts text, image, file, voice, and video items and caches the context_token', async () => {
    const mediaAesKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex')
    const encodedMediaAesKey = Buffer.from(
      mediaAesKey.toString('hex'),
      'utf8',
    ).toString('base64')
    mockStartWithFirstPoll({
      json: {
        ret: 0,
        get_updates_buf: 'buf-1',
        msgs: [
          {
            message_id: 'm1',
            from_user_id: 'alice',
            context_token: 'ctx-alice',
            message_type: 1,
            timestamp: 1_700_000_000,
            item_list: [
              { type: 1, text_item: { text: 'hello there' } },
              {
                type: 2,
                image_item: {
                  media: {
                    encrypt_query_param: 'image-param',
                    aes_key: encodedMediaAesKey,
                  },
                  aeskey: mediaAesKey.toString('hex'),
                  mid_size: 100,
                },
              },
              {
                type: 4,
                file_item: {
                  media: {
                    encrypt_query_param: 'file-param',
                    aes_key: encodedMediaAesKey,
                  },
                  file_name: 'report.pdf',
                  len: '123',
                },
              },
              {
                type: 3,
                voice_item: {
                  media: {
                    encrypt_query_param: 'voice-param',
                    aes_key: encodedMediaAesKey,
                  },
                  play_length: 3,
                },
              },
              {
                type: 5,
                video_item: {
                  media: {
                    encrypt_query_param: 'video-param',
                    aes_key: encodedMediaAesKey,
                  },
                },
              },
            ],
          },
        ],
      },
    })

    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))

    const event = await messagePromise
    expect(event.platformName).toBe('weixin_oc')
    expect(event.sessionKey).toBe('weixin_oc:private:alice')
    expect(event.chatType).toBe('private')
    expect(event.senderId).toBe('alice')
    expect(event.isFromBot).toBe(false)
    expect(event.message.plainText).toBe('hello there')

    const components = event.message.components
    expect(components).toContainEqual({ type: 'text', text: 'hello there' })
    expect(components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'image', mimeType: 'image/jpeg' }),
        expect.objectContaining({
          type: 'file',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          size: 123,
        }),
        expect.objectContaining({ type: 'audio', mimeType: 'audio/amr' }),
        expect.objectContaining({ type: 'video', mimeType: 'video/mp4' }),
      ]),
    )
    expect(components).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'unsupported', kind: 'image' }),
      ]),
    )

    await adapter.stop()
  })

  it('keeps an image URL as a plaintext attachment when no encrypted media is present', async () => {
    mockStartWithFirstPoll({
      json: {
        ret: 0,
        msgs: [
          {
            message_id: 'm-image-url',
            from_user_id: 'alice',
            item_list: [
              {
                type: 2,
                image_item: {
                  url: 'https://example.test/image.jpg',
                  media: {},
                },
              },
            ],
          },
        ],
      },
    })

    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))

    const event = await messagePromise
    const component = event.message.components.find(
      (candidate) => candidate.type === 'image',
    )
    expect(event.message.components).toContainEqual({
      type: 'image',
      url: 'https://example.test/image.jpg',
      mimeType: 'image/jpeg',
    })

    mockedRequestUrl.mockReset()
    mockedRequestUrl.mockResolvedValueOnce({
      status: 200,
      headers: {},
      arrayBuffer: bytesAsArrayBuffer(new TextEncoder().encode('plain-image')),
    } as never)
    const result = await adapter.downloadFile(component!)
    expect(result.fileName).toBe('image.jpg')
    expect(await readFile(result.tempPath)).toEqual(Buffer.from('plain-image'))
    await rm(result.tempPath, { force: true })

    await adapter.stop()
  })

  it('flags messages echoed back from the bot itself via message_type or the @im.bot suffix', async () => {
    mockStartWithFirstPoll({
      json: {
        ret: 0,
        msgs: [
          {
            message_id: 'm2',
            from_user_id: 'echo@im.bot',
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: 'echo' } }],
          },
        ],
      },
    })

    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))

    const event = await messagePromise
    expect(event.isFromBot).toBe(true)

    await adapter.stop()
  })
})

describe('WeixinOCAdapter — sendMessage', () => {
  it('rejects when the adapter has no token at all (never logged in)', async () => {
    const adapter = new WeixinOCAdapter()
    await expect(
      adapter.sendMessage('weixin_oc:private:alice', { text: 'hi' }),
    ).rejects.toThrow(/not logged in/)
  })

  it('rejects when there is no cached context_token for the recipient (bot cannot message first)', async () => {
    mockStartWithHangingPoll()
    const adapter = new WeixinOCAdapter()
    await adapter.start(makeConfig({ botToken: 'tok' }))
    await adapter.stop()

    await expect(
      adapter.sendMessage('weixin_oc:private:never-messaged', { text: 'hi' }),
    ).rejects.toThrow(/context_token/)
  })

  it('sends a text item using the cached context_token from the last inbound message', async () => {
    mockStartWithFirstPoll({
      json: {
        ret: 0,
        msgs: [
          {
            message_id: 'm1',
            from_user_id: 'alice',
            context_token: 'ctx-alice',
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: 'hi bot' } }],
          },
        ],
      },
    })

    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))
    await messagePromise

    mockedRequestUrl.mockResolvedValueOnce({
      json: { ret: 0, msg_id: 'sent-1' },
    } as never)
    const refs = await adapter.sendMessage('weixin_oc:private:alice', {
      text: 'hi human',
    })

    expect(refs).toEqual([
      {
        platformMessageId: 'sent-1',
        sessionKey: 'weixin_oc:private:alice',
        timestamp: expect.any(Number),
      },
    ])
    const sendCall = mockedRequestUrl.mock.calls.find(([params]) =>
      String(asRequestUrlParam(params).url).includes('sendmessage'),
    )
    expect(sendCall).toBeDefined()
    const sentBody = JSON.parse(
      bodyAsString(asRequestUrlParam(sendCall![0])),
    ) as {
      msg: { context_token: string; item_list: unknown[] }
    }
    expect(sentBody.msg.context_token).toBe('ctx-alice')
    expect(sentBody.msg.item_list).toEqual([
      { type: 1, text_item: { text: 'hi human' } },
    ])

    await adapter.stop()
    expect(asRequestUrlParam(sendCall![0]).headers).not.toHaveProperty(
      'Content-Length',
    )
  })

  it('B4: splits a long text reply into chunked sends at the 2048 cap instead of silently truncating', async () => {
    let pollCount = 0
    mockedRequestUrl.mockImplementation((async (request) => {
      const param = asRequestUrlParam(request)
      if (param.url.includes('/ilink/bot/msg/notifystart')) {
        return { json: { ret: 0 } } as never
      }
      if (param.url.includes('/ilink/bot/sendmessage')) {
        return { json: { ret: 0, msg_id: 'sent-chunk' } } as never
      }
      if (pollCount === 0) {
        pollCount += 1
        return {
          json: {
            ret: 0,
            msgs: [
              {
                message_id: 'm1',
                from_user_id: 'alice',
                context_token: 'ctx-alice',
                message_type: 1,
                item_list: [{ type: 1, text_item: { text: 'hi bot' } }],
              },
            ],
          },
        } as never
      }
      return hangForever()
    }) as typeof requestUrl)

    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))
    await messagePromise

    const longText = 'w'.repeat(4500)
    const refs = await adapter.sendMessage('weixin_oc:private:alice', {
      text: longText,
    })

    const sendCalls = mockedRequestUrl.mock.calls.filter(([params]) =>
      String(asRequestUrlParam(params).url).includes('sendmessage'),
    )
    // RED on the old behavior: one call whose text was truncated to 2048.
    expect(sendCalls).toHaveLength(3)
    const chunks = sendCalls.map(([params]) => {
      const body = JSON.parse(bodyAsString(asRequestUrlParam(params))) as {
        msg: { item_list: Array<{ type: number; text_item: { text: string } }> }
      }
      return body.msg.item_list[0].text_item.text
    })
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2048)
    }
    expect(chunks.join('')).toBe(longText)
    expect(refs).toHaveLength(3)

    await adapter.stop()
  })

  it('fix-round-1: long text + media sends media exactly once (not once per text chunk)', async () => {
    let pollCount = 0
    mockedRequestUrl.mockImplementation((async (request) => {
      const param = asRequestUrlParam(request)
      if (param.url.includes('/ilink/bot/msg/notifystart')) {
        return { json: { ret: 0 } } as never
      }
      if (param.url.includes('/ilink/bot/getuploadurl')) {
        return { json: { ret: 0, upload_param: 'upload-param' } } as never
      }
      if (param.url.includes('/c2c/upload')) {
        return {
          status: 200,
          headers: { 'x-encrypted-param': 'download-param' },
        } as never
      }
      if (param.url.includes('/ilink/bot/sendmessage')) {
        return { json: { ret: 0, msg_id: 'sent-mixed' } } as never
      }
      if (pollCount === 0) {
        pollCount += 1
        return {
          json: {
            ret: 0,
            msgs: [
              {
                message_id: 'm1',
                from_user_id: 'alice',
                context_token: 'ctx-alice',
                message_type: 1,
                item_list: [{ type: 1, text_item: { text: 'hi bot' } }],
              },
            ],
          },
        } as never
      }
      return hangForever()
    }) as typeof requestUrl)

    const adapter = new WeixinOCAdapter({
      app: {
        vault: {
          adapter: {
            readBinary: jest.fn(
              async () => new Uint8Array(Buffer.from('hello')).buffer,
            ),
          },
        },
      } as unknown as import('obsidian').App,
    })
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))
    await messagePromise

    const refs = await adapter.sendMessage('weixin_oc:private:alice', {
      text: 'w'.repeat(4500), // 3 chunks at the 2048 cap
      images: [
        {
          source: 'vault-path',
          path: 'exports/chart.png',
          mimeType: 'image/png',
          label: 'chart.png',
        },
      ],
    })

    const sendCalls = mockedRequestUrl.mock.calls.filter(([params]) =>
      String(asRequestUrlParam(params).url).includes('sendmessage'),
    )
    expect(sendCalls).toHaveLength(3)
    const itemLists = sendCalls.map(([params]) => {
      const body = JSON.parse(bodyAsString(asRequestUrlParam(params))) as {
        msg: { item_list: unknown[] }
      }
      return body.msg.item_list
    })
    const imageCount = itemLists.flat().filter(
      (item) => (item as { type?: number }).type === 2,
    ).length
    expect(imageCount).toBe(1)
    expect(
      itemLists[2].some((item) => (item as { type?: number }).type === 2),
    ).toBe(true)
    const textItems = itemLists
      .flat()
      .filter((item) => (item as { type?: number }).type === 1).length
    expect(textItems).toBe(3)
    expect(refs).toHaveLength(3)

    await adapter.stop()
  })

  it('uploads an image and sends its encrypted image item with the reply text', async () => {
    let pollCount = 0
    mockedRequestUrl.mockImplementation((async (request) => {
      const param = asRequestUrlParam(request)
      if (param.url.includes('/ilink/bot/msg/notifystart')) {
        return { json: { ret: 0 } } as never
      }
      if (param.url.includes('/ilink/bot/getuploadurl')) {
        return { json: { ret: 0, upload_param: 'upload-param' } } as never
      }
      if (param.url.includes('/c2c/upload')) {
        return {
          status: 200,
          headers: { 'x-encrypted-param': 'download-param' },
        } as never
      }
      if (param.url.includes('/ilink/bot/sendmessage')) {
        return { json: { ret: 0, msg_id: 'sent-2' } } as never
      }
      if (pollCount === 0) {
        pollCount += 1
        return {
          json: {
            ret: 0,
            msgs: [
              {
                message_id: 'm1',
                from_user_id: 'alice',
                context_token: 'ctx-alice',
                message_type: 1,
                item_list: [{ type: 1, text_item: { text: 'hi bot' } }],
              },
            ],
          },
        } as never
      }
      return hangForever()
    }) as typeof requestUrl)

    const readBinary = jest.fn(
      async () => new Uint8Array(Buffer.from('hello')).buffer,
    )
    const adapter = new WeixinOCAdapter({
      app: {
        vault: { adapter: { readBinary } },
      } as unknown as import('obsidian').App,
    })
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))
    await messagePromise

    await adapter.sendMessage('weixin_oc:private:alice', {
      text: 'Here is the chart.',
      images: [
        {
          source: 'vault-path',
          path: 'exports/chart.png',
          mimeType: 'image/png',
          label: 'chart.png',
        },
      ],
    })

    const uploadCall = mockedRequestUrl.mock.calls.find(([params]) =>
      String(asRequestUrlParam(params).url).includes('getuploadurl'),
    )
    expect(uploadCall).toBeDefined()
    const uploadBody = JSON.parse(
      bodyAsString(asRequestUrlParam(uploadCall![0])),
    ) as {
      filekey: string
      media_type: number
      to_user_id: string
      rawsize: number
      rawfilemd5: string
      filesize: number
      aeskey: string
    }
    expect(uploadBody).toMatchObject({
      media_type: 1,
      to_user_id: 'alice',
      rawsize: 5,
      rawfilemd5: '5d41402abc4b2a76b9719d911017c592',
      filesize: 16,
    })
    expect(uploadBody.filekey).toMatch(/^[0-9a-f]{32}$/)
    expect(uploadBody.aeskey).toMatch(/^[0-9a-f]{32}$/)
    expect(readBinary).toHaveBeenCalledWith('exports/chart.png')

    const cdnCall = mockedRequestUrl.mock.calls.find(([params]) =>
      String(asRequestUrlParam(params).url).includes('/c2c/upload'),
    )
    expect(cdnCall).toBeDefined()
    const encrypted = new Uint8Array(
      bodyAsArrayBuffer(asRequestUrlParam(cdnCall![0])),
    )
    expect(encrypted).toHaveLength(16)
    expect(Array.from(encrypted)).not.toEqual(Array.from(Buffer.from('hello')))

    const sendCalls = mockedRequestUrl.mock.calls.filter(([params]) =>
      String(asRequestUrlParam(params).url).includes('sendmessage'),
    )
    expect(sendCalls).toHaveLength(1)
    const sendBody = JSON.parse(
      bodyAsString(asRequestUrlParam(sendCalls[0][0])),
    ) as {
      msg: {
        item_list: Array<{
          type: number
          text_item?: { text: string }
          image_item?: {
            media: { encrypt_query_param: string; aes_key: string }
            mid_size: number
          }
        }>
      }
    }
    expect(sendBody.msg.item_list[0]).toEqual({
      type: 1,
      text_item: { text: 'Here is the chart.' },
    })
    expect(sendBody.msg.item_list[1]).toMatchObject({
      type: 2,
      image_item: {
        media: {
          encrypt_query_param: 'download-param',
        },
        mid_size: 16,
      },
    })
    expect(sendBody.msg.item_list).toHaveLength(2)
    expect(
      Buffer.from(
        sendBody.msg.item_list[1].image_item!.media.aes_key,
        'base64',
      ).toString('utf8'),
    ).toBe(uploadBody.aeskey)

    await adapter.stop()
  })

  it('uploads a file and sends its file item with the original filename and size', async () => {
    mockStartWithFirstPoll({
      json: {
        ret: 0,
        msgs: [
          {
            message_id: 'm1',
            from_user_id: 'alice',
            context_token: 'ctx-alice',
            message_type: 1,
            item_list: [{ type: 1, text_item: { text: 'hi bot' } }],
          },
        ],
      },
    })

    const adapter = new WeixinOCAdapter()
    const messagePromise = waitForNextMessage(adapter)
    await adapter.start(makeConfig({ botToken: 'tok' }))
    await messagePromise

    mockedRequestUrl
      .mockResolvedValueOnce({
        json: { ret: 0, upload_param: 'file-upload-param' },
      } as never)
      .mockResolvedValueOnce({
        status: 200,
        headers: { 'x-encrypted-param': 'file-download-param' },
      } as never)
      .mockResolvedValueOnce({
        json: { ret: 0, msg_id: 'sent-file-1' },
      } as never)

    await adapter.sendMessage('weixin_oc:private:alice', {
      files: [
        {
          source: 'base64',
          dataBase64: Buffer.from('hello file').toString('base64'),
          mimeType: 'text/plain',
          name: 'report.txt',
        },
      ],
    })

    const uploadCall = mockedRequestUrl.mock.calls.find(([params]) =>
      String(asRequestUrlParam(params).url).includes('getuploadurl'),
    )
    const uploadBody = JSON.parse(
      bodyAsString(asRequestUrlParam(uploadCall![0])),
    ) as { media_type: number; rawsize: number; filesize: number }
    expect(uploadBody).toMatchObject({
      media_type: 3,
      rawsize: 10,
      filesize: 16,
    })

    const sendCall = mockedRequestUrl.mock.calls.find(([params]) =>
      String(asRequestUrlParam(params).url).includes('sendmessage'),
    )
    const sentBody = JSON.parse(
      bodyAsString(asRequestUrlParam(sendCall![0])),
    ) as {
      msg: {
        item_list: Array<{
          type: number
          file_item?: {
            media: { encrypt_query_param: string }
            file_name: string
            len: string
          }
        }>
      }
    }
    expect(sentBody.msg.item_list).toEqual([
      {
        type: 4,
        file_item: {
          media: {
            encrypt_query_param: 'file-download-param',
            aes_key: expect.any(String),
            encrypt_type: 1,
          },
          file_name: 'report.txt',
          len: '10',
        },
      },
    ])

    await adapter.stop()
  })
})

describe('WeixinOCAdapter — contextTokens capacity', () => {
  it('evicts the least-recently-seen context_token once capacity (5000) is exceeded', async () => {
    // One over the plan-mandated CONTEXT_TOKEN_CAPACITY (5000) so the very
    // first sender's context_token gets LRU-evicted by the last one.
    const totalSenders = 5001
    const msgs = Array.from({ length: totalSenders }, (_, index) => ({
      message_id: `m-${index}`,
      from_user_id: `user-${index}`,
      context_token: `ctx-${index}`,
      message_type: 1,
      item_list: [{ type: 1, text_item: { text: `hi ${index}` } }],
    }))

    mockStartWithFirstPoll({ json: { ret: 0, msgs } })

    const adapter = new WeixinOCAdapter()
    const lastMessagePromise = new Promise<void>((resolve) => {
      const unsubscribe = adapter.onMessage((event) => {
        if (event.messageId === `m-${totalSenders - 1}`) {
          unsubscribe()
          resolve()
        }
      })
    })
    await adapter.start(makeConfig({ botToken: 'tok' }))
    await lastMessagePromise

    mockedRequestUrl.mockResolvedValueOnce({
      json: { ret: 0, msg_id: 'sent-evicted' },
    } as never)
    await expect(
      adapter.sendMessage('weixin_oc:private:user-0', { text: 'too late' }),
    ).rejects.toThrow(/context_token/)

    mockedRequestUrl.mockResolvedValueOnce({
      json: { ret: 0, msg_id: 'sent-still-cached' },
    } as never)
    await expect(
      adapter.sendMessage('weixin_oc:private:user-1', { text: 'still ok' }),
    ).resolves.toBeDefined()

    await adapter.stop()
  })
})

describe('WeixinOCAdapter — context_token TTL', () => {
  it('expires a cached context_token after 30 minutes, matching the plan-mandated TTL', async () => {
    const nowSpy = jest.spyOn(Date, 'now')
    try {
      nowSpy.mockReturnValue(0)
      mockStartWithFirstPoll({
        json: {
          ret: 0,
          msgs: [
            {
              message_id: 'm1',
              from_user_id: 'alice',
              context_token: 'ctx-alice',
              message_type: 1,
              item_list: [{ type: 1, text_item: { text: 'hi bot' } }],
            },
          ],
        },
      })

      const adapter = new WeixinOCAdapter()
      const messagePromise = waitForNextMessage(adapter)
      await adapter.start(makeConfig({ botToken: 'tok' }))
      await messagePromise
      await adapter.stop()

      // Just under the 30-minute TTL — still cached.
      nowSpy.mockReturnValue(29 * 60_000)
      mockedRequestUrl.mockResolvedValueOnce({
        json: { ret: 0, msg_id: 'sent-1' },
      } as never)
      await expect(
        adapter.sendMessage('weixin_oc:private:alice', { text: 'still ok' }),
      ).resolves.toBeDefined()

      // Past the 30-minute TTL — the cached token has lazily expired.
      nowSpy.mockReturnValue(31 * 60_000)
      await expect(
        adapter.sendMessage('weixin_oc:private:alice', { text: 'too late' }),
      ).rejects.toThrow(/context_token/)
    } finally {
      nowSpy.mockRestore()
    }
  })
})
