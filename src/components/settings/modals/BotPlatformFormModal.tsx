import { Eye, EyeOff } from 'lucide-react'
import { App, Notice } from 'obsidian'
import { toDataURL as qrCodeToDataURL } from 'qrcode'
import { Dispatch, SetStateAction, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../../contexts/language-context'
import { DEFAULT_ASSISTANT_ID } from '../../../core/agent/default-assistant'
import { WeixinOCAdapter } from '../../../core/bot/platforms/weixin/weixin-adapter'
import YoloPlugin from '../../../main'
import {
  BotPlatformConfig,
  BotPlatformDingtalkConfig,
  BotPlatformFeishuConfig,
  BotPlatformQqOfficialConfig,
  BotPlatformTelegramConfig,
  BotPlatformWeixinConfig,
  botPlatformConfigSchema,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianSecretInput } from '../../common/ObsidianSecretInput'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ReactModal } from '../../common/ReactModal'
import { useObsidianSettingPortalContainer } from '../../common/useObsidianSettingPortal'

type BotPlatformFormComponentProps = {
  plugin: YoloPlugin
  platform: BotPlatformConfig | null // null for new platform
  initialPlatformType?: BotPlatformConfig['platformType']
}

const createDefaultTelegramConfig = (): BotPlatformTelegramConfig => ({
  id: crypto.randomUUID(),
  name: '',
  enabled: true,
  assistantId: undefined,
  platformType: 'telegram',
  botToken: '',
  allowedUsers: [],
  allowedGroups: [],
  whitelistEnabled: true,
  startupUpdatePolicy: 'skip',
  pollingIntervalMs: 3000,
})

const createDefaultWeixinConfig = (): BotPlatformWeixinConfig => ({
  id: crypto.randomUUID(),
  name: '',
  enabled: true,
  assistantId: undefined,
  platformType: 'weixin_oc',
  botToken: undefined,
  baseUrl: 'https://ilinkai.weixin.qq.com',
  botId: undefined,
  loginTime: undefined,
  allowedUsers: [],
  allowedGroups: [],
  whitelistEnabled: true,
  pollTimeoutMs: 40_000,
})

const createDefaultDingtalkConfig = (): BotPlatformDingtalkConfig => ({
  id: crypto.randomUUID(),
  name: '',
  enabled: true,
  assistantId: undefined,
  platformType: 'dingtalk',
  allowedUsers: [],
  allowedGroups: [],
  whitelistEnabled: true,
  robotCode: '',
  clientId: '',
  clientSecret: '',
  streamMode: true,
})

const createDefaultFeishuConfig = (): BotPlatformFeishuConfig => ({
  id: crypto.randomUUID(),
  name: '',
  enabled: true,
  assistantId: undefined,
  platformType: 'feishu',
  allowedUsers: [],
  allowedGroups: [],
  whitelistEnabled: true,
  appId: '',
  appSecret: '',
})
const createDefaultQqOfficialConfig = (): BotPlatformQqOfficialConfig => ({
  id: crypto.randomUUID(),
  name: '',
  enabled: true,
  assistantId: undefined,
  platformType: 'qq_official',
  allowedUsers: [],
  allowedGroups: [],
  whitelistEnabled: true,
  appId: '',
  appSecret: '',
  enableC2c: true,
  enableGroup: true,
  enableGuild: true,
})

const createDefaultConfig = (
  platformType: BotPlatformConfig['platformType'],
): BotPlatformConfig => {
  switch (platformType) {
    case 'weixin_oc':
      return createDefaultWeixinConfig()
    case 'dingtalk':
      return createDefaultDingtalkConfig()
    case 'feishu':
      return createDefaultFeishuConfig()
    case 'qq_official':
      return createDefaultQqOfficialConfig()
    case 'telegram':
    default:
      return createDefaultTelegramConfig()
  }
}

const NAME_PLACEHOLDER_BY_PLATFORM: Record<
  BotPlatformConfig['platformType'],
  string
> = {
  telegram: 'My Telegram Bot',
  weixin_oc: 'My WeChat Bot',
  dingtalk: 'My DingTalk Bot',
  feishu: 'My Feishu Bot',
  qq_official: 'My QQ Bot',
}

export class AddBotPlatformModal extends ReactModal<BotPlatformFormComponentProps> {
  constructor(
    app: App,
    plugin: YoloPlugin,
    initialPlatformType: BotPlatformConfig['platformType'],
  ) {
    super({
      app,
      Component: BotPlatformFormComponent,
      props: { plugin, platform: null, initialPlatformType },
      options: {
        title: plugin.t('settings.bots.addPlatformTitle', 'Add bot platform'),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

export class EditBotPlatformModal extends ReactModal<BotPlatformFormComponentProps> {
  constructor(app: App, plugin: YoloPlugin, platform: BotPlatformConfig) {
    super({
      app,
      Component: BotPlatformFormComponent,
      props: { plugin, platform },
      options: {
        title: plugin
          .t('settings.bots.editPlatformTitle', 'Edit bot platform: {name}')
          .replace('{name}', platform.name || platform.platformType),
      },
      plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
  }
}

function BotPlatformFormComponent({
  plugin,
  platform,
  initialPlatformType,
  onClose,
}: BotPlatformFormComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const [formData, setFormData] = useState<BotPlatformConfig>(
    platform ?? createDefaultConfig(initialPlatformType ?? 'telegram'),
  )

  const assistantOptions = Object.fromEntries(
    plugin.settings.assistants.map((assistant) => [
      assistant.id,
      assistant.id === DEFAULT_ASSISTANT_ID
        ? t('settings.bots.defaultAssistant', 'Default')
        : assistant.name,
    ]),
  )

  const handleSubmit = () => {
    const execute = async () => {
      const validationResult = botPlatformConfigSchema.safeParse(formData)
      if (!validationResult.success) {
        new Notice(
          validationResult.error.issues.map((v) => v.message).join('\n'),
        )
        return
      }
      const validated = validationResult.data
      const existingPlatforms = plugin.settings.bots.platforms

      const nextPlatforms = platform
        ? existingPlatforms.map((p) => (p.id === validated.id ? validated : p))
        : [...existingPlatforms, validated]

      await plugin.setSettings({
        ...plugin.settings,
        bots: { ...plugin.settings.bots, platforms: nextPlatforms },
      })
      onClose()
    }

    void execute().catch((error) => {
      console.error('[YOLO] Failed to save bot platform:', error)
      new Notice('Failed to save bot platform settings.')
    })
  }

  return (
    <div className="yolo-provider-form">
      <ObsidianSetting
        name={t('settings.bots.form.name', 'Name')}
        desc={t(
          'settings.bots.form.nameDesc',
          'A friendly label to identify this bot configuration',
        )}
      >
        <ObsidianTextInput
          value={formData.name}
          placeholder={NAME_PLACEHOLDER_BY_PLATFORM[formData.platformType]}
          onChange={(value) =>
            setFormData((prev) => ({ ...prev, name: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.bots.form.assistant', 'Bind Agent')}
        desc={t(
          'settings.bots.form.assistantDesc',
          'Which assistant handles messages from this platform',
        )}
      >
        <ObsidianDropdown
          value={formData.assistantId ?? DEFAULT_ASSISTANT_ID}
          options={assistantOptions}
          onChange={(value) =>
            setFormData((prev) => ({ ...prev, assistantId: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.bots.form.enabled', 'Enabled')}
        desc={t(
          'settings.bots.form.enabledDesc',
          'Start bot when settings are saved',
        )}
      >
        <ObsidianToggle
          value={formData.enabled}
          onChange={(value) =>
            setFormData((prev) => ({ ...prev, enabled: value }))
          }
        />
      </ObsidianSetting>

      {formData.platformType === 'telegram' && (
        <TelegramFields formData={formData} setFormData={setFormData} />
      )}
      {formData.platformType === 'weixin_oc' && (
        <WeixinFields formData={formData} setFormData={setFormData} />
      )}
      {formData.platformType === 'dingtalk' && (
        <>
          <BotAccessFields formData={formData} setFormData={setFormData} />
          <DingtalkFields formData={formData} setFormData={setFormData} />
        </>
      )}
      {formData.platformType === 'feishu' && (
        <>
          <BotAccessFields formData={formData} setFormData={setFormData} />
          <FeishuFields formData={formData} setFormData={setFormData} />
        </>
      )}
      {formData.platformType === 'qq_official' && (
        <>
          <BotAccessFields formData={formData} setFormData={setFormData} />
          <QqOfficialFields formData={formData} setFormData={setFormData} />
        </>
      )}

      <ObsidianSetting>
        <ObsidianButton
          text={platform ? t('common.save', 'Save') : t('common.add', 'Add')}
          onClick={handleSubmit}
          cta
        />
        <ObsidianButton text={t('common.cancel', 'Cancel')} onClick={onClose} />
      </ObsidianSetting>
    </div>
  )
}

type BotAccessConfig = Extract<
  BotPlatformConfig,
  { platformType: 'dingtalk' | 'feishu' | 'qq_official' }
>

function QqOfficialFields({
  formData,
  setFormData,
}: {
  formData: BotPlatformQqOfficialConfig
  setFormData: Dispatch<SetStateAction<BotPlatformConfig>>
}) {
  return (
    <>
      <ObsidianSetting name="App ID">
        <ObsidianTextInput
          value={formData.appId}
          onChange={(appId) =>
            setFormData(
              (prev) => ({ ...prev, appId }) as BotPlatformQqOfficialConfig,
            )
          }
        />
      </ObsidianSetting>
      <ObsidianSetting name="App Secret">
        <ObsidianSecretInput
          value={formData.appSecret}
          onChange={(appSecret) =>
            setFormData(
              (prev) => ({ ...prev, appSecret }) as BotPlatformQqOfficialConfig,
            )
          }
        />
      </ObsidianSetting>
      <ObsidianSetting name="Private messages">
        <ObsidianToggle
          value={formData.enableC2c}
          onChange={(enableC2c) =>
            setFormData(
              (prev) => ({ ...prev, enableC2c }) as BotPlatformQqOfficialConfig,
            )
          }
        />
      </ObsidianSetting>
      <ObsidianSetting name="Group @ messages">
        <ObsidianToggle
          value={formData.enableGroup}
          onChange={(enableGroup) =>
            setFormData(
              (prev) =>
                ({ ...prev, enableGroup }) as BotPlatformQqOfficialConfig,
            )
          }
        />
      </ObsidianSetting>
      <ObsidianSetting name="Guild @ messages">
        <ObsidianToggle
          value={formData.enableGuild}
          onChange={(enableGuild) =>
            setFormData(
              (prev) =>
                ({ ...prev, enableGuild }) as BotPlatformQqOfficialConfig,
            )
          }
        />
      </ObsidianSetting>
    </>
  )
}

type BotAccessFieldsProps = {
  formData: BotAccessConfig
  setFormData: Dispatch<SetStateAction<BotPlatformConfig>>
}

function BotAccessFields({ formData, setFormData }: BotAccessFieldsProps) {
  const { t } = useLanguage()
  return (
    <>
      <ObsidianSetting
        name={t('settings.bots.form.whitelist', 'Whitelist')}
        desc={t(
          'settings.bots.form.whitelistDesc',
          'Only allow listed users and groups',
        )}
      >
        <ObsidianToggle
          value={formData.whitelistEnabled}
          onChange={(value) =>
            setFormData((prev) => ({ ...prev, whitelistEnabled: value }))
          }
        />
      </ObsidianSetting>
      <ObsidianSetting
        name={t('settings.bots.form.allowedUsers', 'Allowed Users')}
        desc={t(
          'settings.bots.form.allowedUsersDesc',
          'Platform sender IDs, comma-separated',
        )}
      >
        <ObsidianTextInput
          value={formData.allowedUsers.join(', ')}
          onChange={(value) =>
            setFormData((prev) => ({
              ...prev,
              allowedUsers: value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
            }))
          }
        />
      </ObsidianSetting>
      <ObsidianSetting
        name={t('settings.bots.form.allowedGroups', 'Allowed Groups')}
        desc={t(
          'settings.bots.form.allowedGroupsDesc',
          'Platform group/chat IDs, comma-separated',
        )}
      >
        <ObsidianTextInput
          value={formData.allowedGroups.join(', ')}
          onChange={(value) =>
            setFormData((prev) => ({
              ...prev,
              allowedGroups: value
                .split(',')
                .map((item) => item.trim())
                .filter(Boolean),
            }))
          }
        />
      </ObsidianSetting>
    </>
  )
}

type TelegramFieldsProps = {
  formData: BotPlatformTelegramConfig
  setFormData: Dispatch<SetStateAction<BotPlatformConfig>>
}

function TelegramFields({ formData, setFormData }: TelegramFieldsProps) {
  const { t } = useLanguage()

  return (
    <>
      <ObsidianSetting
        name={t('settings.bots.form.botToken', 'Bot Token')}
        desc={t(
          'settings.bots.form.botTokenDesc',
          'Get from @BotFather on Telegram. Stored as plaintext in plugin settings.',
        )}
        required
      >
        <ObsidianSecretInput
          value={formData.botToken}
          placeholder="123456:ABC-DEF..."
          onChange={(value) =>
            setFormData((prev) => ({ ...prev, botToken: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.bots.form.whitelist', 'Whitelist')}
        desc={t(
          'settings.bots.form.whitelistDesc',
          'Only allow listed users and groups',
        )}
      >
        <ObsidianToggle
          value={formData.whitelistEnabled}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformTelegramConfig),
              whitelistEnabled: value,
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.bots.form.allowedUsers', 'Allowed Users')}
        desc={t(
          'settings.bots.form.allowedUsersDesc',
          'Platform sender IDs, comma-separated',
        )}
      >
        <ObsidianTextInput
          value={formData.allowedUsers.join(', ')}
          placeholder="123456789, 987654321"
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformTelegramConfig),
              allowedUsers: value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.bots.form.allowedGroups', 'Allowed Groups')}
        desc={t(
          'settings.bots.form.allowedGroupsDesc',
          'Platform group/chat IDs, comma-separated',
        )}
      >
        <ObsidianTextInput
          value={formData.allowedGroups.join(', ')}
          placeholder="-1001234567890"
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformTelegramConfig),
              allowedGroups: value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.bots.form.startupPolicy', 'Startup Update Policy')}
        desc={t(
          'settings.bots.form.startupPolicyDesc',
          'Whether to process messages sent while the bot was offline',
        )}
      >
        <ObsidianDropdown
          value={formData.startupUpdatePolicy}
          options={{
            skip: t('settings.bots.form.startupPolicySkip', 'Skip pending'),
            consume: t(
              'settings.bots.form.startupPolicyConsume',
              'Consume pending',
            ),
          }}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformTelegramConfig),
              startupUpdatePolicy: value as 'skip' | 'consume',
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.bots.form.pollingInterval', 'Polling Interval')}
        desc={t(
          'settings.bots.form.pollingIntervalDesc',
          'Milliseconds between long-poll requests (min 1000)',
        )}
      >
        <ObsidianTextInput
          value={String(formData.pollingIntervalMs)}
          type="number"
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformTelegramConfig),
              pollingIntervalMs: Math.max(1000, Number(value) || 1000),
            }))
          }
        />
      </ObsidianSetting>
    </>
  )
}

type WeixinFieldsProps = {
  formData: BotPlatformWeixinConfig
  setFormData: Dispatch<SetStateAction<BotPlatformConfig>>
}

type QrLoginState =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'showing'; qrDataUrl: string; qrcode: string }
  | { phase: 'scanned'; qrDataUrl: string; qrcode: string }
  | { phase: 'confirmed' }
  | { phase: 'expired' }
  | { phase: 'error'; message: string }

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : JSON.stringify(error)
}

// Read-only masked-token display + show/hide toggle. Portaled into the
// enclosing ObsidianSetting's controlEl, alongside the "Scan QR Code" button,
// since plain JSX children of ObsidianSetting land outside the control row.
function WeixinTokenToggle({ botToken }: { botToken: string | undefined }) {
  const { t } = useLanguage()
  const [visible, setVisible] = useState(false)
  const container = useObsidianSettingPortalContainer()

  if (!container) return null

  return createPortal(
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ fontFamily: 'var(--font-monospace)', fontSize: 11 }}>
        {visible
          ? botToken || ''
          : '•'.repeat(Math.min(24, (botToken || '').length))}
      </span>
      <button
        type="button"
        className="clickable-icon"
        aria-label={
          visible
            ? t('settings.bots.form.hideToken', 'Hide token')
            : t('settings.bots.form.showToken', 'Show token')
        }
        onClick={() => setVisible((prev) => !prev)}
      >
        {visible ? <EyeOff size={16} /> : <Eye size={16} />}
      </button>
    </div>,
    container,
  )
}

function WeixinFields({ formData, setFormData }: WeixinFieldsProps) {
  const { t } = useLanguage()
  const [qrState, setQrState] = useState<QrLoginState>({ phase: 'idle' })
  // Standalone adapter instance used only to drive QR login — independent of
  // any adapter BotService may have running for this platform, so this modal
  // has no forward dependency on `main.ts`'s (Phase 6) live BotService wiring.
  const adapterRef = useRef<WeixinOCAdapter | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    // Cancel any in-flight QR poll if the modal closes/unmounts mid-login.
    return () => abortRef.current?.abort()
  }, [])

  const startQrLogin = () => {
    const execute = async () => {
      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      setQrState({ phase: 'loading' })
      const adapter = new WeixinOCAdapter({ baseUrl: formData.baseUrl })
      adapterRef.current = adapter

      const { qrcode, qrcodeUrl } = await adapter.requestQRCode()
      const qrDataUrl = await qrCodeToDataURL(qrcodeUrl ?? qrcode)
      if (controller.signal.aborted) return
      setQrState({ phase: 'showing', qrDataUrl, qrcode })

      while (!controller.signal.aborted) {
        const result = await adapter.pollQRStatus(qrcode, controller.signal)
        if (controller.signal.aborted) return

        if (result.status === 'expired') {
          setQrState({ phase: 'expired' })
          return
        }
        if (result.status === 'scanned') {
          setQrState({ phase: 'scanned', qrDataUrl, qrcode })
          continue
        }
        if (result.status === 'confirmed') {
          if (!result.botToken) {
            setQrState({
              phase: 'error',
              message: 'WeChat login confirmed but no bot_token was returned.',
            })
            return
          }
          setFormData((prev) => ({
            ...(prev as BotPlatformWeixinConfig),
            botToken: result.botToken,
            baseUrl:
              result.baseUrl || (prev as BotPlatformWeixinConfig).baseUrl,
            botId: result.botId,
            loginTime: Date.now(),
          }))
          setQrState({ phase: 'confirmed' })
          new Notice(
            t(
              'settings.bots.form.scanQrCodeConfirmed',
              'WeChat login successful. Click Save to keep these credentials.',
            ),
          )
          return
        }
        // 'pending' — keep polling.
      }
    }

    void execute().catch((error: unknown) => {
      if (abortRef.current?.signal.aborted) return
      console.error('[YOLO] WeChat QR login failed:', error)
      setQrState({ phase: 'error', message: toErrorMessage(error) })
    })
  }

  return (
    <>
      <ObsidianSetting
        name={t('settings.bots.form.loginStatus', 'Login Status')}
        desc={
          formData.botId
            ? t(
                'settings.bots.form.loggedInAs',
                'Logged in as {botId}',
              ).replace('{botId}', formData.botId)
            : t('settings.bots.form.notLoggedIn', 'Not logged in yet')
        }
      >
        <ObsidianButton
          text={t('settings.bots.form.scanQrCode', 'Scan QR Code')}
          disabled={qrState.phase === 'loading'}
          onClick={() => startQrLogin()}
        />
        {formData.botId && <WeixinTokenToggle botToken={formData.botToken} />}
      </ObsidianSetting>

      {(qrState.phase === 'showing' || qrState.phase === 'scanned') && (
        <ObsidianSetting
          name={t('settings.bots.form.scanQrCodePrompt', 'Scan with WeChat')}
          desc={
            qrState.phase === 'scanned'
              ? t(
                  'settings.bots.form.scanQrCodeScanned',
                  'Scanned — confirm the login on your phone.',
                )
              : t(
                  'settings.bots.form.scanQrCodeWaiting',
                  'Open WeChat and scan this code to log in.',
                )
          }
        >
          <img
            src={qrState.qrDataUrl}
            alt={t('settings.bots.form.scanQrCode', 'Scan QR Code')}
            width={160}
            height={160}
          />
        </ObsidianSetting>
      )}
      {qrState.phase === 'expired' && (
        <div className="yolo-settings-desc" style={{ margin: '4px 0' }}>
          {t(
            'settings.bots.form.scanQrCodeExpired',
            'QR code expired. Click "Scan QR Code" again to get a new one.',
          )}
        </div>
      )}
      {qrState.phase === 'error' && (
        <div className="yolo-settings-desc" style={{ margin: '4px 0' }}>
          {t('settings.bots.form.scanQrCodeError', 'QR login failed:')}{' '}
          {qrState.message}
        </div>
      )}

      <ObsidianSetting
        name={t('settings.bots.form.whitelist', 'Whitelist')}
        desc={t(
          'settings.bots.form.whitelistDesc',
          'Only allow listed users and groups',
        )}
      >
        <ObsidianToggle
          value={formData.whitelistEnabled}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformWeixinConfig),
              whitelistEnabled: value,
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.bots.form.allowedUsers', 'Allowed Users')}
        desc={t(
          'settings.bots.form.allowedUsersDesc',
          'Platform sender IDs, comma-separated',
        )}
      >
        <ObsidianTextInput
          value={formData.allowedUsers.join(', ')}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformWeixinConfig),
              allowedUsers: value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
            }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.bots.form.pollTimeout', 'Poll Timeout')}
        desc={t(
          'settings.bots.form.pollTimeoutDesc',
          'Milliseconds for each long-poll request',
        )}
      >
        <ObsidianTextInput
          value={String(formData.pollTimeoutMs)}
          type="number"
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformWeixinConfig),
              pollTimeoutMs: Math.max(1000, Number(value) || 40_000),
            }))
          }
        />
      </ObsidianSetting>
    </>
  )
}

type DingtalkFieldsProps = {
  formData: BotPlatformDingtalkConfig
  setFormData: Dispatch<SetStateAction<BotPlatformConfig>>
}

function DingtalkFields({ formData, setFormData }: DingtalkFieldsProps) {
  const { t } = useLanguage()

  return (
    <>
      <div className="yolo-settings-desc" style={{ margin: '8px 0' }}>
        {t(
          'settings.bots.form.dingtalkStreamModeOnly',
          'Only Stream Mode is supported — create a Stream Mode robot in the DingTalk Open Platform and paste its Robot Code / Client ID (AppKey) / Client Secret (AppSecret) below.',
        )}
      </div>
      <ObsidianSetting
        name={t('settings.bots.form.robotCode', 'Robot Code')}
        desc={t(
          'settings.bots.form.robotCodeDesc',
          'From the DingTalk Open Platform robot configuration page',
        )}
        required
      >
        <ObsidianTextInput
          value={formData.robotCode}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformDingtalkConfig),
              robotCode: value,
            }))
          }
        />
      </ObsidianSetting>
      <ObsidianSetting
        name={t('settings.bots.form.clientId', 'Client ID')}
        desc={t('settings.bots.form.clientIdDesc', 'AppKey of the robot app')}
        required
      >
        <ObsidianTextInput
          value={formData.clientId}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformDingtalkConfig),
              clientId: value,
            }))
          }
        />
      </ObsidianSetting>
      <ObsidianSetting
        name={t('settings.bots.form.clientSecret', 'Client Secret')}
        desc={t(
          'settings.bots.form.clientSecretDesc',
          'AppSecret of the robot app. Stored as plaintext in plugin settings.',
        )}
        required
      >
        <ObsidianSecretInput
          value={formData.clientSecret}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformDingtalkConfig),
              clientSecret: value,
            }))
          }
        />
      </ObsidianSetting>
      <ObsidianSetting
        name={t('settings.bots.form.streamMode', 'Stream Mode')}
        desc={t(
          'settings.bots.form.streamModeDesc',
          'Must stay enabled — webhook push mode is not supported',
        )}
      >
        <ObsidianToggle
          value={formData.streamMode}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformDingtalkConfig),
              streamMode: value,
            }))
          }
        />
      </ObsidianSetting>
    </>
  )
}

type FeishuFieldsProps = {
  formData: BotPlatformFeishuConfig
  setFormData: Dispatch<SetStateAction<BotPlatformConfig>>
}

function FeishuFields({ formData, setFormData }: FeishuFieldsProps) {
  const { t } = useLanguage()

  return (
    <>
      <ObsidianSetting
        name={t('settings.bots.form.appId', 'App ID')}
        desc={t(
          'settings.bots.form.appIdDesc',
          'From the Feishu/Lark Open Platform app configuration page',
        )}
        required
      >
        <ObsidianTextInput
          value={formData.appId}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformFeishuConfig),
              appId: value,
            }))
          }
        />
      </ObsidianSetting>
      <ObsidianSetting
        name={t('settings.bots.form.appSecret', 'App Secret')}
        desc={t(
          'settings.bots.form.appSecretDesc',
          'App Secret of the Feishu/Lark app. Stored as plaintext in plugin settings.',
        )}
        required
      >
        <ObsidianSecretInput
          value={formData.appSecret}
          onChange={(value) =>
            setFormData((prev) => ({
              ...(prev as BotPlatformFeishuConfig),
              appSecret: value,
            }))
          }
        />
      </ObsidianSetting>
    </>
  )
}
