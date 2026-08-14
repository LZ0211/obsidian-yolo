const fakeBotInstances: FakeTelegramBot[] = []
let pendingGetMe: Promise<{
  id: number
  is_bot: boolean
  first_name: string
  username: string
}> | null = null

class FakeTelegramBot {
  readonly token: string
  readonly options: unknown
  readonly getMeMock = jest.fn().mockResolvedValue({
    id: 1,
    is_bot: true,
    first_name: 'Test',
    username: 'TestBot',
  })
  readonly sendMessageMock = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ message_id: 100, date: 1_700_000_000 }),
    )
  readonly sendPhotoMock = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ message_id: 101, date: 1_700_000_000 }),
    )
  readonly sendDocumentMock = jest
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ message_id: 102, date: 1_700_000_000 }),
    )
  readonly downloadFileMock = jest.fn()
  readonly stopPollingMock = jest.fn().mockResolvedValue(undefined)
  readonly startPollingMock = jest.fn().mockResolvedValue(undefined)
  private readonly listeners = new Map<
    string,
    Array<(...args: never[]) => void>
  >()

  constructor(token: string, options: unknown) {
    this.token = token
    this.options = options
    fakeBotInstances.push(this)
  }

  on(event: string, listener: (...args: never[]) => void): this {
    const list = this.listeners.get(event) ?? []
    list.push(listener)
    this.listeners.set(event, list)
    return this
  }

  trigger(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      ;(listener as (...args: unknown[]) => void)(...args)
    }
  }

  async getMe() {
    if (pendingGetMe) return pendingGetMe
    return this.getMeMock()
  }

  async sendMessage(chatId: unknown, text: unknown, opts: unknown) {
    return this.sendMessageMock(chatId, text, opts)
  }

  async sendPhoto(
    chatId: unknown,
    photo: unknown,
    opts: unknown,
    fileOptions?: unknown,
  ) {
    return this.sendPhotoMock(chatId, photo, opts, fileOptions)
  }

  async sendDocument(
    chatId: unknown,
    doc: unknown,
    opts: unknown,
    fileOptions?: unknown,
  ) {
    return this.sendDocumentMock(chatId, doc, opts, fileOptions)
  }

  async downloadFile(fileId: string, dir: string) {
    return this.downloadFileMock(fileId, dir)
  }

  async stopPolling() {
    return this.stopPollingMock()
  }

  async startPolling(opts?: unknown) {
    return this.startPollingMock(opts)
  }
}

jest.mock('node-telegram-bot-api', () => ({
  TelegramBot: FakeTelegramBot,
}))

import * as fsPromises from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import type { Message, MessageEntity } from 'node-telegram-bot-api'
import { FileSystemAdapter } from 'obsidian'
import type { App } from 'obsidian'

import type { BotPlatformTelegramConfig } from '../../../../settings/schema/setting.types'
import { encodeSessionKey } from '../../types'
import type { MessageComponent } from '../../types'

import { TelegramAdapter } from './telegram-adapter'

function makeConfig(
  overrides: Partial<BotPlatformTelegramConfig> = {},
): BotPlatformTelegramConfig {
  return {
    id: 'bot-1',
    name: 'MyBot',
    enabled: true,
    platformType: 'telegram',
    botToken: 'test-token',
    allowedUsers: [],
    allowedGroups: [],
    whitelistEnabled: true,
    startupUpdatePolicy: 'skip',
    pollingIntervalMs: 3000,
    ...overrides,
  }
}

function makeFakeApp(): App {
  return {
    vault: { adapter: new FileSystemAdapter() },
  } as unknown as App
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    message_id: 1,
    date: 1_700_000_000,
    chat: { id: 555, type: 'private' },
    from: { id: 42, is_bot: false, first_name: 'Alice' },
    ...overrides,
  } as Message
}

async function startAdapter(
  config: Partial<BotPlatformTelegramConfig> = {},
): Promise<{ adapter: TelegramAdapter; bot: FakeTelegramBot }> {
  const adapter = new TelegramAdapter(makeFakeApp())
  await adapter.start(makeConfig(config))
  const bot = fakeBotInstances[fakeBotInstances.length - 1]
  return { adapter, bot }
}

beforeEach(() => {
  fakeBotInstances.length = 0
  pendingGetMe = null
})

describe('TelegramAdapter — message conversion', () => {
  it('converts a plain text message', async () => {
    const { adapter, bot } = await startAdapter()
    const received: unknown[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    bot.trigger('message', makeMessage({ text: 'hello world' }))
    await Promise.resolve()

    expect(received).toHaveLength(1)
    const event = received[0] as {
      sessionKey: string
      chatType: string
      senderId: string
      senderName: string
      message: { components: MessageComponent[]; plainText: string }
    }
    expect(event.sessionKey).toBe('telegram:private:555')
    expect(event.chatType).toBe('private')
    expect(event.senderId).toBe('42')
    expect(event.senderName).toBe('Alice')
    expect(event.message.plainText).toBe('hello world')
    expect(event.message.components).toEqual([
      { type: 'text', text: 'hello world' },
    ])
  })

  it('converts a photo message with caption', async () => {
    const { adapter, bot } = await startAdapter()
    const received: unknown[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    bot.trigger(
      'message',
      makeMessage({
        text: undefined,
        caption: 'a nice photo',
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 10, height: 10 },
          { file_id: 'large', file_unique_id: 'l', width: 100, height: 100 },
        ],
      }),
    )
    await Promise.resolve()

    const event = received[0] as {
      message: { components: MessageComponent[] }
    }
    expect(event.message.components).toEqual([
      { type: 'image', fileId: 'large', mimeType: 'image/jpeg' },
      { type: 'text', text: 'a nice photo' },
    ])
  })

  it('converts a document message', async () => {
    const { adapter, bot } = await startAdapter()
    const received: unknown[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    bot.trigger(
      'message',
      makeMessage({
        text: undefined,
        document: {
          file_id: 'doc1',
          file_unique_id: 'd1',
          file_name: 'notes.pdf',
          mime_type: 'application/pdf',
          file_size: 1234,
        },
      }),
    )
    await Promise.resolve()

    const event = received[0] as {
      message: { components: MessageComponent[] }
    }
    expect(event.message.components).toEqual([
      {
        type: 'file',
        fileId: 'doc1',
        mimeType: 'application/pdf',
        name: 'notes.pdf',
        size: 1234,
      },
    ])
  })

  it('parses a slash command with an explicit target bot', async () => {
    const { adapter, bot } = await startAdapter()
    const received: unknown[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    const entities: MessageEntity[] = [
      { type: 'bot_command', offset: 0, length: 12 },
    ]
    bot.trigger('message', makeMessage({ text: '/reset@MyBot now', entities }))
    await Promise.resolve()

    const event = received[0] as {
      command?: { name: string; targetBotId?: string; args?: string }
    }
    expect(event.command).toEqual({
      name: 'reset',
      targetBotId: 'MyBot',
      args: 'now',
    })
  })

  it('detects a reply-to message with a text preview', async () => {
    const { adapter, bot } = await startAdapter()
    const received: unknown[] = []
    adapter.onMessage((event) => {
      received.push(event)
    })

    bot.trigger(
      'message',
      makeMessage({
        text: 'sure thing',
        reply_to_message: makeMessage({ message_id: 9, text: 'original text' }),
      }),
    )
    await Promise.resolve()

    const event = received[0] as {
      message: { components: MessageComponent[] }
    }
    expect(event.message.components).toContainEqual({
      type: 'reply_to',
      messageId: '9',
      preview: 'original text',
    })
  })
})

describe('TelegramAdapter — polling error recovery', () => {
  it('stops and restarts polling after 3 non-fatal failures within the window', async () => {
    const { adapter, bot } = await startAdapter()
    const errors: unknown[] = []
    adapter.onError((error) => {
      errors.push(error)
    })

    bot.trigger('polling_error', new Error('ETIMEDOUT'))
    bot.trigger('polling_error', new Error('ETIMEDOUT'))
    expect(bot.stopPollingMock).not.toHaveBeenCalled()
    expect(adapter.health()).toBe('degraded')

    bot.trigger('polling_error', new Error('ETIMEDOUT'))
    await new Promise((resolve) => setImmediate(resolve))

    expect(bot.stopPollingMock).toHaveBeenCalledTimes(1)
    expect(bot.startPollingMock).toHaveBeenCalledTimes(1)
    expect(errors).toHaveLength(3)
    expect(adapter.health()).toBe('running')
  })

  it('emits fatal errors immediately without counting toward the threshold', async () => {
    const { adapter, bot } = await startAdapter()
    const errors: unknown[] = []
    adapter.onError((error) => {
      errors.push(error)
    })

    const fatal = Object.assign(new Error('fatal transport failure'), {
      code: 'EFATAL',
    })
    bot.trigger('polling_error', fatal)

    expect(errors).toHaveLength(1)
    expect(bot.stopPollingMock).not.toHaveBeenCalled()
    expect(adapter.health()).toBe('failed')
  })

  it('does not restart polling on a bot that was stopped while recovery was in flight', async () => {
    const { adapter, bot } = await startAdapter()
    const errors: unknown[] = []
    adapter.onError((error) => {
      errors.push(error)
    })

    // Hold the recovery's stopPolling teardown so recreatePolling is
    // suspended mid-flight when stop() lands.
    let releaseStopPolling!: () => void
    const stopPollingGate = new Promise<void>((resolve) => {
      releaseStopPolling = resolve
    })
    bot.stopPollingMock.mockReturnValueOnce(stopPollingGate)

    bot.trigger('polling_error', new Error('ETIMEDOUT'))
    bot.trigger('polling_error', new Error('ETIMEDOUT'))
    bot.trigger('polling_error', new Error('ETIMEDOUT'))
    await Promise.resolve() // recreatePolling now awaits the gated stopPolling

    await adapter.stop()
    releaseStopPolling()
    await new Promise((resolve) => setImmediate(resolve))

    expect(errors).toHaveLength(3)
    expect(bot.startPollingMock).not.toHaveBeenCalled()
    expect(adapter.health()).toBe('stopped')
  })
})

describe('TelegramAdapter — sendMessage', () => {
  it('splits long text into chunks at the max message length', async () => {
    const { adapter, bot } = await startAdapter()
    const longText = `${'a'.repeat(4090)} ${'b'.repeat(20)}`

    await adapter.sendMessage('telegram:private:555', { text: longText })

    expect(bot.sendMessageMock).toHaveBeenCalledTimes(2)
    const [firstChunk] = bot.sendMessageMock.mock.calls[0] as [unknown, string]
    expect(firstChunk).toBe('555')
    const [, secondCallText] = bot.sendMessageMock.mock.calls[1] as [
      unknown,
      string,
    ]
    expect(secondCallText.length).toBeLessThanOrEqual(4096)
  })

  it('B3: carries message_thread_id on replies to forum-topic sessions', async () => {
    const { adapter, bot } = await startAdapter()
    const sessionKey = encodeSessionKey('telegram', 'group', '555', '42')

    await adapter.sendMessage(sessionKey, { text: 'topic reply' })

    expect(bot.sendMessageMock).toHaveBeenCalledTimes(1)
    const [, , options] = bot.sendMessageMock.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ]
    // RED on the old behavior: the options object had no message_thread_id,
    // so the reply landed in the channel's general thread instead of the topic.
    expect(options).toMatchObject({ message_thread_id: 42 })
  })

  it('omits message_thread_id for non-topic sessions', async () => {
    const { adapter, bot } = await startAdapter()

    await adapter.sendMessage('telegram:private:555', { text: 'plain' })

    const [, , options] = bot.sendMessageMock.mock.calls[0] as [
      unknown,
      string,
      Record<string, unknown>,
    ]
    expect(options.message_thread_id).toBeUndefined()
  })

  it('sends an image via a url source', async () => {
    const { adapter, bot } = await startAdapter()

    await adapter.sendMessage('telegram:private:555', {
      images: [
        {
          source: 'url',
          url: 'https://example.com/pic.png',
          mimeType: 'image/png',
          label: 'a pic',
        },
      ],
    })

    expect(bot.sendPhotoMock).toHaveBeenCalledWith(
      '555',
      'https://example.com/pic.png',
      expect.objectContaining({ caption: 'a pic' }),
      undefined,
    )
  })

  it('sends a file via a base64 source', async () => {
    const { adapter, bot } = await startAdapter()

    await adapter.sendMessage('telegram:private:555', {
      files: [
        {
          source: 'base64',
          dataBase64: Buffer.from('hello').toString('base64'),
          mimeType: 'text/plain',
          name: 'hello.txt',
        },
      ],
    })

    expect(bot.sendDocumentMock).toHaveBeenCalledTimes(1)
    const [, doc, , fileOptions] = bot.sendDocumentMock.mock.calls[0] as [
      unknown,
      Buffer,
      unknown,
      { filename: string; contentType: string },
    ]
    expect(Buffer.from(doc).toString()).toBe('hello')
    expect(fileOptions).toEqual({
      filename: 'hello.txt',
      contentType: 'text/plain',
    })
  })

  it('rejects an oversized base64 image before calling Telegram', async () => {
    const { adapter, bot } = await startAdapter()

    await expect(
      adapter.sendMessage('telegram:private:555', {
        images: [
          {
            source: 'base64',
            dataBase64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64'),
            mimeType: 'image/png',
          },
        ],
      }),
    ).rejects.toThrow(/exceeds.*image.*limit/i)

    expect(bot.sendPhotoMock).not.toHaveBeenCalled()
  })
})

describe('TelegramAdapter — downloadFile', () => {
  it('downloads a file to a temp directory and reports its size', async () => {
    const { adapter, bot } = await startAdapter()
    bot.downloadFileMock.mockImplementation(
      async (fileId: string, dir: string) => {
        const filePath = path.join(dir, 'remote-name.pdf')
        await fsPromises.writeFile(filePath, 'file-bytes')
        return filePath
      },
    )

    const result = await adapter.downloadFile({
      type: 'file',
      fileId: 'doc-abc',
      mimeType: 'application/pdf',
      name: 'notes.pdf',
    })

    expect(bot.downloadFileMock).toHaveBeenCalledWith(
      'doc-abc',
      expect.stringContaining(os.tmpdir()),
    )
    expect(result.fileName).toBe('notes.pdf')
    expect(result.mimeType).toBe('application/pdf')
    expect(result.size).toBe('file-bytes'.length)
    expect(result.tempPath.endsWith('remote-name.pdf')).toBe(true)
  })

  it('rejects components with no fileId', async () => {
    const { adapter } = await startAdapter()
    await expect(
      adapter.downloadFile({ type: 'text', text: 'no file here' }),
    ).rejects.toThrow(/no fileId/)
  })
})

describe('TelegramAdapter — lifecycle', () => {
  it('does not resurrect a bot when stop() lands during getMe()', async () => {
    let releaseGetMe!: (value: {
      id: number
      is_bot: boolean
      first_name: string
      username: string
    }) => void
    pendingGetMe = new Promise((resolve) => {
      releaseGetMe = resolve
    })

    const adapter = new TelegramAdapter(makeFakeApp())
    const starting = adapter.start(makeConfig())
    await new Promise((resolve) => setImmediate(resolve))
    const bot = fakeBotInstances[0]
    expect(bot).toBeDefined()

    await adapter.stop()
    releaseGetMe({
      id: 1,
      is_bot: true,
      first_name: 'Test',
      username: 'TestBot',
    })
    await starting

    expect(adapter.health()).toBe('stopped')
    expect(bot.stopPollingMock).toHaveBeenCalled()
  })

  it('reports stopped health before start and after stop', async () => {
    const adapter = new TelegramAdapter(makeFakeApp())
    expect(adapter.health()).toBe('stopped')

    await adapter.start(makeConfig())
    expect(adapter.health()).toBe('running')

    await adapter.stop()
    expect(adapter.health()).toBe('stopped')
  })

  it('throws when sendStreamingMessage is called', async () => {
    const { adapter } = await startAdapter()
    expect(() => adapter.sendStreamingMessage('telegram:private:555')).toThrow(
      /not supported/,
    )
  })
})
