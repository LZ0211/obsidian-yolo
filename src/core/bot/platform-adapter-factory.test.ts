import { requestUrl } from 'obsidian'
import type { App } from 'obsidian'

import type { BotPlatformConfig } from '../../settings/schema/setting.types'

import { createBotPlatformAdapterFactory } from './platform-adapter-factory'
import { DingTalkAdapter } from './platforms/dingtalk/dingtalk-adapter'
import { FeishuAdapter } from './platforms/feishu/feishu-adapter'
import { QQOfficialAdapter } from './platforms/qqofficial/qqofficial-adapter'
import { TelegramAdapter } from './platforms/telegram/telegram-adapter'
import { WeixinOCAdapter } from './platforms/weixin/weixin-adapter'

// Relies on the global `__mocks__/obsidian.ts` mock (already exports
// `requestUrl`/`Platform`/`FileSystemAdapter`) rather than overriding the
// whole module the way `weixin-adapter.test.ts` does — this suite also
// constructs `TelegramAdapter`/`DingTalkAdapter`, which need `Platform` from
// that same mock.
const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

function makeApp(): App {
  return {} as unknown as App
}

function makeTelegramConfig(): BotPlatformConfig {
  return {
    id: 'bot-1',
    name: 'My Telegram Bot',
    enabled: true,
    platformType: 'telegram',
    botToken: 'token',
    allowedUsers: [],
    allowedGroups: [],
    whitelistEnabled: true,
    startupUpdatePolicy: 'skip',
    pollingIntervalMs: 3000,
  }
}

function makeWeixinConfig(
  overrides: Partial<
    Extract<BotPlatformConfig, { platformType: 'weixin_oc' }>
  > = {},
): BotPlatformConfig {
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

function makeDingtalkConfig(): BotPlatformConfig {
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
  }
}

function makeFeishuConfig(): BotPlatformConfig {
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
  }
}

function makeQqOfficialConfig(): BotPlatformConfig {
  return {
    id: 'qq-1',
    name: 'My QQ Bot',
    enabled: true,
    platformType: 'qq_official',
    allowedUsers: [],
    allowedGroups: [],
    whitelistEnabled: true,
    appId: 'app-1',
    appSecret: 'secret-1',
    enableC2c: true,
    enableGroup: true,
    enableGuild: true,
  }
}

beforeEach(() => {
  mockedRequestUrl.mockReset()
})

describe('createBotPlatformAdapterFactory', () => {
  it('creates a TelegramAdapter for platformType "telegram"', () => {
    const factory = createBotPlatformAdapterFactory(makeApp())
    const adapter = factory(makeTelegramConfig())
    expect(adapter).toBeInstanceOf(TelegramAdapter)
  })

  it('creates a WeixinOCAdapter constructed with the config\'s baseUrl for platformType "weixin_oc"', async () => {
    mockedRequestUrl.mockResolvedValueOnce({
      json: { qrcode: 'key-abc', interval: 3000 },
    } as never)

    const factory = createBotPlatformAdapterFactory(makeApp())
    const adapter = factory(
      makeWeixinConfig({ baseUrl: 'https://custom.example.com' }),
    )
    expect(adapter).toBeInstanceOf(WeixinOCAdapter)

    // The factory passes `config.baseUrl` into the adapter's constructor
    // rather than defaulting it — verified via an observable HTTP call
    // (`requestQRCode()`) instead of reaching into the adapter's private
    // `baseUrl` field.
    await (adapter as WeixinOCAdapter).requestQRCode()
    expect(mockedRequestUrl).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining('https://custom.example.com'),
      }),
    )
  })

  it('creates a DingTalkAdapter for platformType "dingtalk"', () => {
    const factory = createBotPlatformAdapterFactory(makeApp())
    const adapter = factory(makeDingtalkConfig())
    expect(adapter).toBeInstanceOf(DingTalkAdapter)
  })

  it('creates a FeishuAdapter for platformType "feishu"', () => {
    const factory = createBotPlatformAdapterFactory(makeApp())
    const adapter = factory(makeFeishuConfig())
    expect(adapter).toBeInstanceOf(FeishuAdapter)
  })

  it('creates a QQOfficialAdapter for platformType "qq_official"', () => {
    expect(
      createBotPlatformAdapterFactory(makeApp())(makeQqOfficialConfig()),
    ).toBeInstanceOf(QQOfficialAdapter)
  })

  it('returns null for an unsupported/unknown platformType', () => {
    const factory = createBotPlatformAdapterFactory(makeApp())
    const config = {
      ...makeTelegramConfig(),
      platformType: 'unknown',
    } as unknown as BotPlatformConfig

    expect(factory(config)).toBeNull()
  })
})
