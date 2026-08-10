/**
 * `BotPlatformAdapterFactory` implementation — maps a `BotPlatformConfig` to
 * its concrete `PlatformAdapter`. `BotService` (Phase 1) takes this factory
 * as an injected dependency (`BotServiceDeps.createAdapter`) rather than
 * depending on adapter modules directly, so it doesn't need to statically
 * import every platform. `main.ts` (Phase 6) wires this factory in when
 * constructing `BotService`.
 *
 * `dingtalk` returns a real `DingTalkAdapter` instance (Stream Mode WebSocket
 * bot). Like Telegram, it needs an injected `App` to resolve vault-relative
 * paths for outgoing image/file attachments.
 *
 * `feishu` returns a real `FeishuAdapter` instance (Socket Mode WebSocket
 * bot), also needing an injected `App` for the same reason.
 */
import type { App } from 'obsidian'

import type { BotPlatformConfig } from '../../settings/schema/setting.types'

import type { BotPlatformAdapterFactory } from './bot-service'
import { DingTalkAdapter } from './platforms/dingtalk/dingtalk-adapter'
import { FeishuAdapter } from './platforms/feishu/feishu-adapter'
import { QQOfficialAdapter } from './platforms/qqofficial/qqofficial-adapter'
import { TelegramAdapter } from './platforms/telegram/telegram-adapter'
import { WeixinOCAdapter } from './platforms/weixin/weixin-adapter'
import type { PlatformAdapter } from './types'

export function createBotPlatformAdapterFactory(
  app: App,
): BotPlatformAdapterFactory {
  return (config: BotPlatformConfig): PlatformAdapter | null => {
    switch (config.platformType) {
      case 'telegram':
        return new TelegramAdapter(app)
      case 'weixin_oc':
        return new WeixinOCAdapter({ app, baseUrl: config.baseUrl })
      case 'dingtalk':
        return new DingTalkAdapter(app)
      case 'feishu':
        return new FeishuAdapter(app)
      case 'qq_official':
        return new QQOfficialAdapter()
      default:
        return null
    }
  }
}
