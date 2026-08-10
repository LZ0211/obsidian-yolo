import { App } from 'obsidian'

import dingtalkLogo from '../../../assets/bot-icons/dingtalk.svg'
import feishuLogo from '../../../assets/bot-icons/feishu.svg'
import qqLogo from '../../../assets/bot-icons/qq.svg'
import telegramLogo from '../../../assets/bot-icons/telegram.svg'
import wechatLogo from '../../../assets/bot-icons/wechat.svg'
import { useLanguage } from '../../../contexts/language-context'
import YoloPlugin from '../../../main'
import { BotPlatformConfig } from '../../../settings/schema/setting.types'
import { ReactModal } from '../../common/ReactModal'

import { AddBotPlatformModal } from './BotPlatformFormModal'

type BotPlatformPickerProps = {
  app: App
  plugin: YoloPlugin
}

type PickerTile = {
  platformType: BotPlatformConfig['platformType']
  monogram: string
  /** Inlined brand logo (data-URL via esbuild). Falls back to monogram. */
  logo?: string
  labelKey: string
  labelFallback: string
  descKey: string
  descFallback: string
  tint: string
  badge?: { key: string; fallback: string; variant: 'amber' | 'mute' }
  disabled?: boolean
}

const TILES: PickerTile[] = [
  {
    platformType: 'telegram',
    monogram: 'TG',
    logo: telegramLogo,
    labelKey: 'settings.bots.picker.telegramLabel',
    labelFallback: 'Telegram',
    descKey: 'settings.bots.picker.telegramDesc',
    descFallback: 'Bot API · long polling',
    tint: 'blue',
  },
  {
    platformType: 'weixin_oc',
    monogram: '微',
    logo: wechatLogo,
    labelKey: 'settings.bots.picker.weixinLabel',
    labelFallback: 'WeChat',
    descKey: 'settings.bots.picker.weixinDesc',
    descFallback: 'Personal account · official ClawBot interface',
    tint: 'green',
  },
  {
    platformType: 'dingtalk',
    monogram: '钉',
    logo: dingtalkLogo,
    labelKey: 'settings.bots.picker.dingtalkLabel',
    labelFallback: 'DingTalk',
    descKey: 'settings.bots.picker.dingtalkDesc',
    descFallback: 'Enterprise robot · stream mode',
    tint: 'slate',
  },
  {
    platformType: 'feishu',
    monogram: '飞',
    logo: feishuLogo,
    labelKey: 'settings.bots.picker.feishuLabel',
    labelFallback: 'Feishu',
    descKey: 'settings.bots.picker.feishuDesc',
    descFallback: 'Lark Open Platform · socket mode',
    tint: 'purple',
  },
  {
    platformType: 'qq_official',
    monogram: 'Q',
    logo: qqLogo,
    labelKey: 'settings.bots.picker.qqOfficialLabel',
    labelFallback: 'QQ Bot',
    descKey: 'settings.bots.picker.qqOfficialDesc',
    descFallback: 'API · Gateway',
    tint: 'blue',
  },
]

export class BotPlatformPickerModal extends ReactModal<BotPlatformPickerProps> {
  constructor(app: App, plugin: YoloPlugin) {
    super({
      app,
      Component: BotPlatformPickerComponent,
      props: { app, plugin },
      options: {
        title: plugin.t('settings.bots.pickerTitle', 'Add bot platform'),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-provider-picker-modal')
  }
}

function BotPlatformPickerComponent({
  app,
  plugin,
  onClose,
}: BotPlatformPickerProps & { onClose: () => void }) {
  const { t } = useLanguage()

  const openPlatform = (platformType: BotPlatformConfig['platformType']) => {
    onClose()
    new AddBotPlatformModal(app, plugin, platformType).open()
  }

  return (
    <div className="yolo-provider-picker">
      <div className="yolo-provider-picker__grid">
        {TILES.map((tile) => {
          return (
            <button
              key={tile.platformType}
              type="button"
              className="yolo-provider-picker__tile"
              data-tint={tile.tint}
              disabled={tile.disabled}
              style={
                tile.disabled
                  ? { opacity: 0.55, cursor: 'not-allowed' }
                  : undefined
              }
              onClick={() => {
                if (tile.disabled) return
                openPlatform(tile.platformType)
              }}
            >
              <div className="yolo-provider-picker__tile-head">
                <TileIcon tile={tile} />
                <div className="yolo-provider-picker__tile-text">
                  <div className="yolo-provider-picker__tile-name">
                    {t(tile.labelKey, tile.labelFallback)}
                  </div>
                  <div className="yolo-provider-picker__tile-badges">
                    <span className="yolo-pp-badge yolo-pp-badge--mute">
                      {t(tile.descKey, tile.descFallback)}
                    </span>
                    {tile.badge && (
                      <span
                        className={`yolo-pp-badge yolo-pp-badge--${tile.badge.variant}`}
                      >
                        {t(tile.badge.key, tile.badge.fallback)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function TileIcon({ tile }: { tile: PickerTile }) {
  if (tile.logo) {
    return (
      <div
        className="yolo-provider-picker__tile-icon yolo-provider-picker__tile-icon--logo"
        data-tint={tile.tint}
      >
        <img src={tile.logo} alt="" draggable={false} />
      </div>
    )
  }
  const isCJK = /[一-龥]/.test(tile.monogram)
  return (
    <div
      className={`yolo-provider-picker__tile-icon yolo-provider-picker__tile-icon--mono${
        isCJK ? ' yolo-provider-picker__tile-icon--cjk' : ''
      }`}
      data-tint={tile.tint}
    >
      {tile.monogram}
    </div>
  )
}
