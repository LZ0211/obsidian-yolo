// lodash.isequal ships CommonJS, so a plain default import resolves to
// undefined under ts-jest (no esModuleInterop) even though it works fine
// through esbuild's production bundling. Same workaround as
// `useChatTimelineReadModel.test.ts`.
jest.mock('lodash.isequal', () => {
  const actual = jest.requireActual('lodash.isequal') as unknown
  return { __esModule: true, default: actual }
})

jest.mock('./agent-runner', () => ({
  runBotAgentTurn: jest.fn(),
}))

import type {
  BotPlatformConfig,
  BotPlatformTelegramConfig,
  BotPlatformWeixinConfig,
  BotsSettings,
  YoloSettings,
} from '../../settings/schema/setting.types'
import type { AgentService } from '../agent/service'
import type { ChatMessage } from '../../types/chat'
import type { McpManager } from '../mcp/mcpManager'

import { runBotAgentTurn } from './agent-runner'
import { BotService, formatBotConversationTitle } from './bot-service'
import type { BotServiceDeps } from './bot-service'
import { encodeSessionKey } from './types'
import type { PlatformAdapter, PlatformMessageEvent } from './types'

function makeTelegramConfig(
  overrides: Partial<BotPlatformTelegramConfig> = {},
): BotPlatformTelegramConfig {
  return {
    id: 'bot-1',
    name: 'MyBot',
    enabled: true,
    platformType: 'telegram',
    botToken: 'token',
    allowedUsers: ['u1'],
    allowedGroups: ['g1'],
    whitelistEnabled: true,
    startupUpdatePolicy: 'skip',
    pollingIntervalMs: 3000,
    ...overrides,
  }
}

function makeWeixinConfig(
  overrides: Partial<BotPlatformWeixinConfig> = {},
): BotPlatformWeixinConfig {
  return {
    id: 'bot-1',
    name: 'WeChat',
    enabled: true,
    platformType: 'weixin_oc',
    botToken: 'token',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    allowedUsers: ['u1'],
    allowedGroups: [],
    whitelistEnabled: true,
    pollTimeoutMs: 40_000,
    ...overrides,
  }
}

function makeBotsSettings(overrides: Partial<BotsSettings> = {}): BotsSettings {
  return {
    enabled: true,
    whitelistEnabled: true,
    groupChatEnabled: true,
    adminUsers: ['admin1'],
    platforms: [makeTelegramConfig()],
    sessionMappings: [],
    ...overrides,
  }
}

function makeFakeAdapter(): PlatformAdapter & {
  start: jest.Mock
  stop: jest.Mock
  health: jest.Mock
  sendMessage: jest.Mock
  downloadFile: jest.Mock
  onMessage: jest.Mock
  onError: jest.Mock
} {
  return {
    meta: {
      name: 'telegram',
      displayName: 'Telegram',
      description: '',
      version: '1.0.0',
    },
    capabilities: {
      markdownMode: 'none',
      supportsImage: true,
      supportsFile: true,
      supportsStreaming: false,
      maxMessageLength: 4096,
      maxImageSize: 1,
      maxFileSize: 1,
    },
    start: jest.fn().mockResolvedValue(undefined),
    stop: jest.fn().mockResolvedValue(undefined),
    health: jest.fn().mockReturnValue('running'),
    sendMessage: jest.fn().mockResolvedValue([]),
    sendStreamingMessage: jest.fn(),
    downloadFile: jest.fn(),
    onMessage: jest.fn().mockReturnValue(jest.fn()),
    onError: jest.fn().mockReturnValue(jest.fn()),
    getBotUsername: jest.fn().mockReturnValue(undefined),
  }
}

function makeHarness(botsSettingsOverrides: Partial<BotsSettings> = {}) {
  let settings: YoloSettings = {
    bots: makeBotsSettings(botsSettingsOverrides),
  } as unknown as YoloSettings

  const getSettings = jest.fn(() => settings)
  const saveSettings = jest.fn(async (next: YoloSettings) => {
    settings = next
  })
  const settingsListeners: Array<(settings: YoloSettings) => void> = []
  const registerSettingsListener = jest.fn(
    (listener: (settings: YoloSettings) => void) => {
      settingsListeners.push(listener)
      return () => {
        const index = settingsListeners.indexOf(listener)
        if (index !== -1) settingsListeners.splice(index, 1)
      }
    },
  )

  const conversations = new Map<string, readonly ChatMessage[]>()
  let nextConversationId = 1
  const createChat = jest.fn(
    async (initial: { id?: string; title?: string }) => {
      const conversationId = initial.id ?? `conv-${nextConversationId++}`
      conversations.set(conversationId, [])
      return conversationId
    },
  )
  const findById = jest.fn(async (id: string) => conversations.get(id) ?? null)
  const conversationGateway = {
    dispatch: jest.fn((command: { type: string; conversationId: string; title?: { kind?: string; value?: string }; commandId?: string }) => {
      if (command.type !== 'create_conversation') {
        throw new Error(`unexpected bot command: ${command.type}`)
      }
      const title =
        command.title?.kind === 'named' ? command.title.value : 'New chat'
      const settled = createChat({
        id: command.conversationId,
        title,
      }).then(() => ({
        status: 'accepted' as const,
        sequence: 1,
        value: { conversationId: command.conversationId },
      }))
      return { commandId: command.commandId, settled }
    }),
  } as unknown as { dispatch: (command: unknown) => { settled: Promise<{ status: string }> } }

  const adaptersByPlatformId = new Map<
    string,
    ReturnType<typeof makeFakeAdapter>
  >()
  const createAdapter = jest.fn((config: BotPlatformConfig) => {
    const adapter = makeFakeAdapter()
    adaptersByPlatformId.set(config.id, adapter)
    return adapter
  })

  const getAgentService = jest.fn(() => ({}) as unknown as AgentService)
  const getMcpManager = jest.fn(async () => ({}) as unknown as McpManager)
  const notifyUser = jest.fn()
  const vault = {
    createBinary: jest.fn().mockResolvedValue({}),
    createFolder: jest.fn().mockResolvedValue({}),
    getAbstractFileByPath: jest.fn(),
  }
  const app = { vault } as unknown as BotServiceDeps['app']

  const deps: BotServiceDeps = {
    app,
    getSettings,
    saveSettings,
    registerSettingsListener,
    createConversation: (title: string) => {
      const conversationId = `conv-${nextConversationId}`
      const settled = conversationGateway.dispatch({
        type: 'create_conversation',
        conversationId,
        title: { kind: 'named', value: title },
      } as never).settled
      return settled.then((r: { status: string }) =>
        r.status === 'accepted' || r.status === 'already_applied'
          ? conversationId
          : Promise.reject(new Error('create failed')),
      )
    },
    loadConversation: findById,
    createAdapter,
    getAgentService,
    getMcpManager,
    notifyUser,
    // English label resolution for the platform segments of bot conversation
    // titles; every other key falls back to its fallback string.
    translate: jest.fn((key: string, fallback: string) => {
      const labels: Record<string, string> = {
        'settings.bots.platformName.telegram': 'Telegram',
        'settings.bots.platformName.weixin': 'WeChat',
      }
      return labels[key] ?? fallback
    }),
  }

  const service = new BotService(deps)

  return {
    service,
    getSettings,
    saveSettings,
    registerSettingsListener,
    triggerSettingsChange: (next: YoloSettings) => {
      settings = next
      settingsListeners.forEach((listener) => listener(next))
    },
    createChat,
    findById,
    conversationGateway,
    createAdapter,
    adaptersByPlatformId,
    notifyUser,
    app,
    vault,
    getCurrentSettings: () => settings,
  }
}

function makeEvent(
  overrides: Partial<PlatformMessageEvent> = {},
): PlatformMessageEvent {
  return {
    platformName: 'telegram',
    messageId: 'm1',
    sessionKey: encodeSessionKey('telegram', 'private', 'u1'),
    chatType: 'private',
    senderId: 'u1',
    senderName: 'User One',
    message: {
      components: [{ type: 'text', text: 'hello' }],
      plainText: 'hello',
      rawMessage: {},
      timestamp: 0,
    },
    ...overrides,
  }
}

describe('BotService lifecycle', () => {
  it('initialize() starts adapters for enabled platforms when bots.enabled', async () => {
    const h = makeHarness()
    await h.service.initialize()
    expect(h.createAdapter).toHaveBeenCalledTimes(1)
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    expect(adapter.start).toHaveBeenCalledTimes(1)
  })

  it('initialize() does not start any adapter when bots.enabled is false', async () => {
    const h = makeHarness({ enabled: false })
    await h.service.initialize()
    expect(h.createAdapter).not.toHaveBeenCalled()
  })

  it('B2: stops the platform when the global switch is flipped during the start handshake', async () => {
    const h = makeHarness()
    let releaseStart!: () => void
    const startBlocked = new Promise<void>((resolve) => {
      releaseStart = resolve
    })
    // Hold the adapter's start() open so the settings change lands while the
    // (network-bound) handshake is still in flight.
    const originalCreateAdapter = h.createAdapter
    h.createAdapter.mockImplementationOnce((config: BotPlatformConfig) => {
      const adapter = originalCreateAdapter(config)
      adapter.start.mockReturnValueOnce(startBlocked)
      return adapter
    })

    const initialized = h.service.initialize()
    await Promise.resolve() // let the initial start enter the blocked handshake
    // Flipping bots.enabled off mid-handshake must be consumed and stop the
    // platform — RED on the old behavior: the settings listener was only
    // registered after initialize() resolved, so this change was dropped and
    // the platform kept running.
    h.triggerSettingsChange({
      ...h.getCurrentSettings(),
      bots: { ...h.getCurrentSettings().bots, enabled: false },
    })
    releaseStart()
    await initialized

    expect(h.adaptersByPlatformId.get('bot-1')!.stop).toHaveBeenCalledTimes(1)
  })

  it('cleanup() stops every running adapter and unsubscribes from settings', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    await h.service.cleanup()
    expect(adapter.stop).toHaveBeenCalledTimes(1)
    expect(adapter.onMessage.mock.results[0]?.value).toHaveBeenCalledTimes(1)
    expect(adapter.onError.mock.results[0]?.value).toHaveBeenCalledTimes(1)
  })

  it('cleanup() is idempotent and does not restart adapters', async () => {
    const h = makeHarness()
    await h.service.initialize()

    await Promise.all([h.service.cleanup(), h.service.cleanup()])

    const adapter = h.adaptersByPlatformId.get('bot-1')!
    expect(adapter.stop).toHaveBeenCalledTimes(1)
    expect(h.createAdapter).toHaveBeenCalledTimes(1)
  })

  it('does not start queued turns after cleanup aborts the service', async () => {
    let releaseFirstTurn!: () => void
    const firstTurnBlocked = new Promise<void>((resolve) => {
      releaseFirstTurn = resolve
    })
    const runTurn = jest.mocked(runBotAgentTurn)
    runTurn.mockImplementationOnce(async () => firstTurnBlocked)

    const h = makeHarness()
    await h.service.initialize()

    await h.service.handleIncoming(
      makeEvent({ messageId: 'cleanup-first' }),
      makeTelegramConfig(),
    )
    await Promise.resolve()
    await Promise.resolve()
    expect(runTurn).toHaveBeenCalledTimes(1)

    await h.service.handleIncoming(
      makeEvent({ messageId: 'cleanup-second' }),
      makeTelegramConfig(),
    )

    const cleanup = h.service.cleanup()
    releaseFirstTurn()
    await cleanup

    expect(runTurn).toHaveBeenCalledTimes(1)
  })

  it('onSettingsChanged starts a newly added platform', async () => {
    const h = makeHarness({ platforms: [] })
    await h.service.initialize()
    expect(h.createAdapter).not.toHaveBeenCalled()

    await h.service.onSettingsChanged(
      h.getCurrentSettings().bots,
      makeBotsSettings(),
    )
    expect(h.createAdapter).toHaveBeenCalledTimes(1)
  })

  it('onSettingsChanged stops a removed platform', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!

    await h.service.onSettingsChanged(
      h.getCurrentSettings().bots,
      makeBotsSettings({ platforms: [] }),
    )
    expect(adapter.stop).toHaveBeenCalledTimes(1)
  })

  it('onSettingsChanged restarts a platform whose config changed', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const firstAdapter = h.adaptersByPlatformId.get('bot-1')!

    const changedConfig = makeTelegramConfig({ botToken: 'new-token' })
    await h.service.onSettingsChanged(
      h.getCurrentSettings().bots,
      makeBotsSettings({ platforms: [changedConfig] }),
    )
    expect(firstAdapter.stop).toHaveBeenCalledTimes(1)
    expect(h.createAdapter).toHaveBeenCalledTimes(2)
  })

  it('onSettingsChanged does not restart a platform whose config is unchanged', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!

    await h.service.onSettingsChanged(
      h.getCurrentSettings().bots,
      makeBotsSettings(),
    )
    expect(adapter.stop).not.toHaveBeenCalled()
    expect(h.createAdapter).toHaveBeenCalledTimes(1)
  })

  it('onSettingsChanged stops everything when bots.enabled flips to false', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!

    await h.service.onSettingsChanged(
      h.getCurrentSettings().bots,
      makeBotsSettings({ enabled: false }),
    )
    expect(adapter.stop).toHaveBeenCalledTimes(1)
  })

  it('a settings listener registered by initialize() drives onSettingsChanged', async () => {
    const h = makeHarness({ platforms: [] })
    await h.service.initialize()
    expect(h.createAdapter).not.toHaveBeenCalled()

    h.triggerSettingsChange({
      bots: makeBotsSettings(),
    } as unknown as YoloSettings)
    // onSettingsChanged runs asynchronously off the listener; flush microtasks.
    await Promise.resolve()
    await Promise.resolve()
    expect(h.createAdapter).toHaveBeenCalledTimes(1)
  })

  it('uses the previous settings snapshot when the settings listener fires', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!

    h.triggerSettingsChange({
      bots: makeBotsSettings({ platforms: [] }),
    } as unknown as YoloSettings)
    await Promise.resolve()
    await Promise.resolve()

    expect(adapter.stop).toHaveBeenCalledTimes(1)
  })
})

describe('BotService.handleIncoming', () => {
  it('keeps the adapter-provided filename extension for non-file attachments', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    const os = await import('node:os')
    const path = await import('node:path')
    const fs = await import('node:fs/promises')
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yolo-bot-test-'))
    const tempPath = path.join(tempDir, 'source.png')
    await fs.writeFile(tempPath, Buffer.from('x'))
    adapter.downloadFile.mockResolvedValueOnce({
      fileName: 'received.png',
      mimeType: 'image/png',
      size: 1,
      tempPath,
    })

    await h.service.handleIncoming(
      makeEvent({
        messageId: 'm-image',
        message: {
          components: [{ type: 'image', mimeType: 'image/png' }],
          plainText: '',
          rawMessage: {},
          timestamp: 0,
        },
      }),
      makeTelegramConfig(),
    )

    // Compare the vault path and the actual bytes: jest 29 on Node 24 does not
    // deep-equal an ArrayBuffer against the expected Buffer, so asserting the
    // content directly keeps the test environment-agnostic.
    const createBinaryCalls = h.vault.createBinary.mock.calls as unknown as Array<
      [string, ArrayBuffer]
    >
    expect(createBinaryCalls).toHaveLength(1)
    expect(createBinaryCalls[0][0]).toMatch(/m-image-0-received\.png$/)
    const writtenBytes = new Uint8Array(createBinaryCalls[0][1])
    expect(writtenBytes.byteLength).toBe(1)
    expect(writtenBytes[0]).toBe(0x78) // 'x'
    await expect(fs.stat(tempPath)).rejects.toThrow()
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('ignores events marked isFromBot', async () => {
    const h = makeHarness()
    await h.service.initialize()
    await h.service.handleIncoming(
      makeEvent({ isFromBot: true }),
      makeTelegramConfig(),
    )
    expect(h.createChat).not.toHaveBeenCalled()
  })

  it('drops events with a malformed sessionKey without throwing', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
    await expect(
      h.service.handleIncoming(
        makeEvent({ sessionKey: 'bad' }),
        makeTelegramConfig(),
      ),
    ).resolves.toBeUndefined()
    expect(h.createChat).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('dedupes a repeated messageId (same platform/session/thread)', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const event = makeEvent()
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).toHaveBeenCalledTimes(1)

    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).toHaveBeenCalledTimes(1) // not called again
  })

  it('denies an unauthorized sender (not whitelisted, not admin)', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const event = makeEvent({ senderId: 'stranger', messageId: 'm-denied' })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).not.toHaveBeenCalled()
  })

  it('allows an admin even if not on the platform allowedUsers list', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const event = makeEvent({
      senderId: 'admin1',
      messageId: 'm-admin',
      sessionKey: encodeSessionKey('telegram', 'private', 'admin1'),
    })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).toHaveBeenCalledTimes(1)
  })

  it('allows everyone when whitelistEnabled is false', async () => {
    const config = makeTelegramConfig({ whitelistEnabled: false })
    const h = makeHarness({ platforms: [config] })
    await h.service.initialize()
    const event = makeEvent({ senderId: 'stranger', messageId: 'm-open' })
    await h.service.handleIncoming(event, config)
    expect(h.createChat).toHaveBeenCalledTimes(1)
  })

  it('honors the global whitelist switch for every platform config', async () => {
    const h = makeHarness({ whitelistEnabled: false })
    await h.service.initialize()
    const event = makeEvent({
      senderId: 'stranger',
      messageId: 'm-global-open',
    })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).toHaveBeenCalledTimes(1)
  })

  it('does not run a disabled session mapping', async () => {
    const h = makeHarness({
      sessionMappings: [
        {
          sessionKey: encodeSessionKey('telegram', 'private', 'u1'),
          platformName: 'telegram',
          chatType: 'private',
          platformChatId: 'u1',
          conversationId: 'conv-disabled',
          createdAt: 0,
          lastActiveAt: 0,
          disabled: true,
        },
      ],
    })
    await h.service.initialize()
    await h.service.handleIncoming(
      makeEvent({ messageId: 'm-disabled' }),
      makeTelegramConfig(),
    )
    expect(h.createChat).not.toHaveBeenCalled()
  })

  it('creates a conversation + session mapping on first contact, then reuses it', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const event1 = makeEvent({ messageId: 'm1' })
    await h.service.handleIncoming(event1, makeTelegramConfig())
    expect(h.createChat).toHaveBeenCalledTimes(1)

    const mapping = h
      .getCurrentSettings()
      .bots.sessionMappings.find((m) => m.sessionKey === event1.sessionKey)
    expect(mapping?.conversationId).toEqual(expect.any(String))

    const event2 = makeEvent({ messageId: 'm2' })
    await h.service.handleIncoming(event2, makeTelegramConfig())
    expect(h.createChat).toHaveBeenCalledTimes(1) // reused, not recreated
  })

  it('repairs a session mapping whose conversation no longer exists', async () => {
    const sessionKey = encodeSessionKey('telegram', 'private', 'u1')
    const h = makeHarness({
      sessionMappings: [
        {
          sessionKey,
          platformName: 'telegram',
          chatType: 'private',
          platformChatId: 'u1',
          conversationId: 'conv-missing',
          createdAt: 0,
          lastActiveAt: 0,
        },
      ],
    })
    await h.service.initialize()

    await h.service.handleIncoming(
      makeEvent({ messageId: 'm-repair', sessionKey }),
      makeTelegramConfig(),
    )

    expect(h.findById).toHaveBeenCalledWith('conv-missing')
    expect(h.createChat).toHaveBeenCalledTimes(1)
    expect(
      h
        .getCurrentSettings()
        .bots.sessionMappings.find((m) => m.sessionKey === sessionKey)
        ?.conversationId,
    ).toEqual(expect.any(String))
  })

  it('group chat: drops non-wake traffic even when groupChatEnabled', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const event = makeEvent({
      chatType: 'group',
      senderId: 'u1',
      messageId: 'g1',
      sessionKey: encodeSessionKey('telegram', 'group', 'g1'),
    })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).not.toHaveBeenCalled()
  })

  it('group chat: wakes on mentionedBotId', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const event = makeEvent({
      chatType: 'group',
      senderId: 'u1',
      messageId: 'g2',
      sessionKey: encodeSessionKey('telegram', 'group', 'g1'),
      mentionedBotId: 'MyBot',
    })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).toHaveBeenCalledTimes(1)
  })

  it("group chat: does not wake for other bots' targeted commands", async () => {
    const h = makeHarness()
    await h.service.initialize()
    const event = makeEvent({
      chatType: 'group',
      senderId: 'u1',
      messageId: 'g4',
      sessionKey: encodeSessionKey('telegram', 'group', 'g1'),
      command: { name: 'help', targetBotId: 'SomeOtherBot' },
    })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).not.toHaveBeenCalled()
    expect(
      h.adaptersByPlatformId.get('bot-1')!.sendMessage,
    ).not.toHaveBeenCalled()
  })

  it('group chat: wakes on a bare command without an explicit target bot', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    const event = makeEvent({
      chatType: 'group',
      senderId: 'u1',
      messageId: 'g6',
      sessionKey: encodeSessionKey('telegram', 'group', 'g1'),
      command: { name: 'help' },
    })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      event.sessionKey,
      expect.objectContaining({
        text: expect.stringContaining('Available commands'),
      }),
    )
  })

  it('group chat: wakes on a command targeted at this bot by its username', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    ;(adapter.getBotUsername as jest.Mock).mockReturnValue('mybot_username')
    const event = makeEvent({
      chatType: 'group',
      senderId: 'u1',
      messageId: 'g7',
      sessionKey: encodeSessionKey('telegram', 'group', 'g1'),
      command: { name: 'help', targetBotId: 'MyBot_Username' },
    })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      event.sessionKey,
      expect.objectContaining({
        text: expect.stringContaining('Available commands'),
      }),
    )
  })

  it('group chat: drops everything when groupChatEnabled is false', async () => {
    const h = makeHarness({ groupChatEnabled: false })
    await h.service.initialize()
    const event = makeEvent({
      chatType: 'group',
      senderId: 'u1',
      messageId: 'g5',
      sessionKey: encodeSessionKey('telegram', 'group', 'g1'),
      mentionedBotId: 'MyBot',
    })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).not.toHaveBeenCalled()
  })

  it('/help sends the help text without creating a conversation', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    const event = makeEvent({ messageId: 'c1', command: { name: 'help' } })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      event.sessionKey,
      expect.objectContaining({
        text: expect.stringContaining('Available commands'),
      }),
    )
    expect(h.createChat).not.toHaveBeenCalled()
  })

  it('/status reports "no conversation" before first contact', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    const event = makeEvent({ messageId: 'c2', command: { name: 'status' } })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      event.sessionKey,
      expect.objectContaining({
        text: expect.stringContaining('No conversation bound'),
      }),
    )
  })

  it('/reset denies a non-admin sender', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    const event = makeEvent({ messageId: 'c3', command: { name: 'reset' } })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      event.sessionKey,
      expect.objectContaining({
        text: expect.stringContaining('not authorized'),
      }),
    )
    expect(h.createChat).not.toHaveBeenCalled()
  })

  it('/reset creates a fresh conversation for an admin sender', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    const sessionKey = encodeSessionKey('telegram', 'private', 'admin1')
    const event = makeEvent({
      messageId: 'c4',
      senderId: 'admin1',
      sessionKey,
      command: { name: 'reset' },
    })
    await h.service.handleIncoming(event, makeTelegramConfig())
    expect(h.createChat).toHaveBeenCalledTimes(1)
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      sessionKey,
      expect.objectContaining({ text: expect.stringContaining('reset') }),
    )
    expect(
      h
        .getCurrentSettings()
        .bots.sessionMappings.find((m) => m.sessionKey === sessionKey)
        ?.conversationId,
    ).toEqual(expect.any(String))
  })
})

describe('BotService adapter diagnostics', () => {
  it('notifies the user when WeChat reports an expired session', async () => {
    const h = makeHarness({ platforms: [makeWeixinConfig()] })
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    const onError = adapter.onError.mock.calls[0][0] as Parameters<
      PlatformAdapter['onError']
    >[0]

    onError(
      new Error('WeChat session expired; re-login (QR scan) required.'),
      adapter,
      { operation: 'receive', retryable: false },
    )

    expect(h.notifyUser).toHaveBeenCalledWith(
      expect.stringContaining('WeChat bot login expired'),
    )
  })

  it('notifies the user on non-retryable send failures (credential expiry)', async () => {
    const h = makeHarness({ platforms: [makeWeixinConfig()] })
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    const onError = adapter.onError.mock.calls[0][0] as Parameters<
      PlatformAdapter['onError']
    >[0]

    onError(
      new Error('WeChat sendmessage failed: ret=0 errcode=-14 session expired'),
      adapter,
      { operation: 'send', sessionKey: 'k', retryable: false },
    )

    expect(h.notifyUser).toHaveBeenCalledWith(
      expect.stringContaining('Bot reply failed to send'),
    )
  })

  it('does not notify on retryable send failures (transient network blips)', async () => {
    const h = makeHarness({ platforms: [makeWeixinConfig()] })
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    const onError = adapter.onError.mock.calls[0][0] as Parameters<
      PlatformAdapter['onError']
    >[0]

    onError(
      new Error('WeChat sendmessage failed: ret=1 network'),
      adapter,
      { operation: 'send', sessionKey: 'k', retryable: true },
    )

    expect(h.notifyUser).not.toHaveBeenCalled()
  })
})

describe('BotService runtime health', () => {
  it('reports the live adapter health for a started platform', async () => {
    const h = makeHarness()
    await h.service.initialize()
    const adapter = h.adaptersByPlatformId.get('bot-1')!
    adapter.health.mockReturnValue('degraded')
    expect(h.service.getHealth('bot-1')).toEqual({
      status: 'degraded',
      started: true,
    })
  })

  it('reports stopped + the last start error for a platform whose start failed', async () => {
    const h = makeHarness()
    await h.service.initialize()
    // The config diff below triggers a restart, which builds a fresh adapter
    // via createAdapter — make every adapter it produces fail to start.
    const originalCreateAdapter =
      h.createAdapter.getMockImplementation() as (config: BotPlatformConfig) => ReturnType<typeof makeFakeAdapter>
    h.createAdapter.mockImplementation((config) => {
      const adapter = originalCreateAdapter(config)
      adapter.start.mockRejectedValue(new Error('getMe failed: 401'))
      return adapter
    })

    h.triggerSettingsChange({
      bots: makeBotsSettings({
        platforms: [makeTelegramConfig({ id: 'bot-1', botToken: 'new-token' })],
      }),
    } as unknown as YoloSettings)
    // Flush the whole settings-change → stop → start chain (more than two
    // microtask hops, so drain with a macrotask).
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(h.service.getHealth('bot-1')).toEqual({
      status: 'stopped',
      started: false,
      startError: 'getMe failed: 401',
    })
  })

  it('reports stopped without error for a disabled platform', async () => {
    const h = makeHarness()
    await h.service.initialize()
    expect(h.service.getHealth('missing-platform')).toEqual({
      status: 'stopped',
      started: false,
    })
  })
})

describe('BotService disable aborts in-flight turns', () => {
  it('aborts queued turns before stopping adapters when bots.enabled flips off', async () => {
    // runBotAgentTurn is a shared module-level mock — calls from earlier
    // tests accumulate, so isolate this test's observation window.
    ;(runBotAgentTurn as jest.Mock).mockClear()
    // Hold the turn in flight so disable has something to abort.
    let releaseTurn: (() => void) | undefined
    ;(runBotAgentTurn as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseTurn = resolve
        }),
    )
    const h = makeHarness()
    await h.service.initialize()
    void h.service.handleIncoming(
      makeEvent({ messageId: 'm-abort' }),
      makeTelegramConfig(),
    )
    // Let the queued turn reach runBotAgentTurn (mocked, still pending).
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(runBotAgentTurn).toHaveBeenCalledTimes(1)
    const { abortSignal } = (runBotAgentTurn as jest.Mock).mock
      .calls[0][0] as {
      abortSignal: AbortSignal
    }

    h.triggerSettingsChange({
      bots: makeBotsSettings({ enabled: false }),
    } as unknown as YoloSettings)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(abortSignal.aborted).toBe(true)
    expect(h.adaptersByPlatformId.get('bot-1')!.stop).toHaveBeenCalled()
    releaseTurn?.()
  })
})

describe('Bot conversation titles', () => {
  const TITLE_PATTERN = /^Telegram · User One · \d{2}-\d{2} \d{2}:\d{2}$/

  it('titles new conversations `{platform} · {sender} · {MM-DD HH:mm}`', async () => {
    const h = makeHarness()
    await h.service.initialize()
    await h.service.handleIncoming(makeEvent({ messageId: 'm-title' }), makeTelegramConfig())
    expect(h.createChat).toHaveBeenCalledWith(
      expect.objectContaining({ title: expect.stringMatching(TITLE_PATTERN) }),
    )
    const mapping = h
      .getCurrentSettings()
      .bots.sessionMappings.find(
        (m) => m.sessionKey === encodeSessionKey('telegram', 'private', 'u1'),
      )
    expect(mapping?.conversationTitle).toMatch(TITLE_PATTERN)
  })

  it('omits the sender segment when the inbound event has no sender name', async () => {
    const h = makeHarness()
    await h.service.initialize()
    await h.service.handleIncoming(
      makeEvent({ messageId: 'm-anon', senderName: '  ' }),
      makeTelegramConfig(),
    )
    expect(h.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(
          /^Telegram · \d{2}-\d{2} \d{2}:\d{2}$/,
        ),
      }),
    )
  })

  it('uses the i18n platform label (localized) in the title', async () => {
    const config = makeWeixinConfig({ id: 'bot-wx' })
    const h = makeHarness({ platforms: [config] })
    await h.service.initialize()
    await h.service.handleIncoming(
      makeEvent({
        messageId: 'm-weixin',
        platformName: 'weixin_oc',
        sessionKey: encodeSessionKey('weixin_oc', 'private', 'u1'),
      }),
      config,
    )
    expect(h.createChat).toHaveBeenCalledWith(
      expect.objectContaining({
        title: expect.stringMatching(/^WeChat · User One · \d{2}-\d{2} \d{2}:\d{2}$/),
      }),
    )
  })
})

describe('formatBotConversationTitle', () => {
  it('joins platform label, sender name and local MM-DD HH:mm time', () => {
    expect(
      formatBotConversationTitle({
        platformLabel: '微信',
        senderName: '小明',
        createdAt: new Date(2026, 7, 12, 9, 5).getTime(),
      }),
    ).toBe('微信 · 小明 · 08-12 09:05')
  })

  it('omits the sender segment when it is empty or whitespace-only', () => {
    expect(
      formatBotConversationTitle({
        platformLabel: 'Telegram',
        senderName: '',
        createdAt: new Date(2026, 0, 2, 23, 59).getTime(),
      }),
    ).toBe('Telegram · 01-02 23:59')
  })
})
