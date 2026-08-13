import { App, Notice, Platform } from 'obsidian'
import React, { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import type { BotPlatformHealth } from '../../../core/bot/bot-service'
import YoloPlugin from '../../../main'
import {
  BotPlatformConfig,
  BotsSettings,
} from '../../../settings/schema/setting.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { EditBotPlatformModal } from '../modals/BotPlatformFormModal'
import { BotPlatformPickerModal } from '../modals/BotPlatformPickerModal'

type BotsTabProps = {
  app: App
  plugin: YoloPlugin
}

const PLATFORM_BADGE_STYLE: Record<
  BotPlatformConfig['platformType'],
  { label: string; background: string; color: string }
> = {
  telegram: {
    label: 'Telegram',
    background: 'rgba(84,170,235,.13)',
    color: '#54aaeb',
  },
  weixin_oc: {
    label: 'WeChat',
    background: 'rgba(7,193,96,.13)',
    color: '#07c160',
  },
  dingtalk: {
    label: 'DingTalk',
    background: 'rgba(0,132,255,.13)',
    color: '#0084ff',
  },
  feishu: {
    label: 'Feishu',
    background: 'rgba(51,112,255,.13)',
    color: '#3370ff',
  },
  qq_official: {
    label: 'QQ',
    background: 'rgba(18,150,219,.13)',
    color: '#1296db',
  },
}

/** Poll cadence for the runtime health dots while the Bots tab is open. */
const HEALTH_POLL_INTERVAL_MS = 5000

const HEALTH_STATUS_LABEL_KEY: Record<BotPlatformHealth['status'], string> = {
  running: 'settings.bots.health.running',
  degraded: 'settings.bots.health.degraded',
  failed: 'settings.bots.health.failed',
  stopped: 'settings.bots.health.stopped',
}

export function BotsTab({ app, plugin }: BotsTabProps) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const bots = settings.bots

  const describePlatform = (platform: BotPlatformConfig): string => {
    switch (platform.platformType) {
      case 'telegram':
        return `${platform.botToken ? t('settings.bots.tokenConfigured', 'Token configured') : t('settings.bots.noTokenSet', 'No token set')} · ${t(
          'settings.bots.whitelist',
          'Whitelist',
        )} ${
          platform.whitelistEnabled
            ? t('settings.bots.whitelistOn', 'on')
            : t('settings.bots.whitelistOff', 'off')
        }`
      case 'weixin_oc':
        return platform.botId
          ? t('settings.bots.form.loggedInAs', 'Logged in as {botId}').replace(
              '{botId}',
              platform.botId,
            )
          : t('settings.bots.form.notLoggedIn', 'Not logged in yet')
      case 'dingtalk':
        return t(
          'settings.bots.describeRobotCode',
          'Robot code: {robotCode}',
        ).replace(
          '{robotCode}',
          platform.robotCode || t('settings.bots.unset', '(unset)'),
        )
      case 'feishu':
        return t('settings.bots.describeAppId', 'App ID: {appId}').replace(
          '{appId}',
          platform.appId || t('settings.bots.unset', '(unset)'),
        )
      default:
        return ''
    }
  }

  // Runtime health per platform id, polled while the tab is open — the
  // configured `platform.enabled` flag alone would lie about whether the
  // adapter actually came up (start failure, session expiry, degraded polls).
  const [healthByPlatform, setHealthByPlatform] = useState<
    Record<string, BotPlatformHealth>
  >({})
  useEffect(() => {
    const refresh = () => {
      const botService = plugin.getBotService()
      if (!botService) return
      setHealthByPlatform((previous) => {
        const next: Record<string, BotPlatformHealth> = {}
        for (const platform of settings.bots.platforms) {
          next[platform.id] = botService.getHealth(platform.id)
        }
        return next
      })
    }
    refresh()
    const timer = window.setInterval(refresh, HEALTH_POLL_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [plugin, settings.bots.platforms])

  const healthStatusLabel = (status: BotPlatformHealth['status']): string =>
    t(
      HEALTH_STATUS_LABEL_KEY[status],
      {
        running: 'Running',
        degraded: 'Degraded',
        failed: 'Failed',
        stopped: 'Stopped',
      }[status],
    )

  const testConnection = (platform: BotPlatformConfig) => {
    const botService = plugin.getBotService()
    if (!botService) {
      new Notice(
        t(
          'settings.bots.botServiceNotRunning',
          'Bot Platform is not running. Enable it first.',
        ),
      )
      return
    }
    const health = botService.getHealth(platform.id)
    if (health.startError) {
      new Notice(
        t(
          'settings.bots.connectionFailed',
          'Connection failed: {error}',
        ).replace('{error}', health.startError),
      )
      return
    }
    new Notice(
      t('settings.bots.connectionTestResult', 'Connection: {status}').replace(
        '{status}',
        healthStatusLabel(health.status),
      ),
    )
  }

  // Desktop-only: the adapters long-poll over node HTTP / child processes
  // (see `startBotService`'s `Platform.isDesktop` gate; the web server has no
  // bot routes). On mobile the whole tab is replaced by a notice instead of
  // silently no-op'ing.
  if (!Platform.isDesktop) {
    return (
      <div className="yolo-settings-section">
        <section className="yolo-settings-block">
          <div className="yolo-settings-block-content">
            <div className="yolo-settings-desc">
              {t(
                'settings.bots.desktopOnly',
                'Bot Platform is only supported on desktop.',
              )}
            </div>
          </div>
        </section>
      </div>
    )
  }

  const updateBots = (patch: Partial<BotsSettings>) => {
    void setSettings({ ...settings, bots: { ...bots, ...patch } })
  }

  const updatePlatform = (id: string, patch: Partial<BotPlatformConfig>) => {
    updateBots({
      platforms: bots.platforms.map((platform) =>
        platform.id === id
          ? ({ ...platform, ...patch } as BotPlatformConfig)
          : platform,
      ),
    })
  }

  const platformDotColor = (platform: BotPlatformConfig): string => {
    if (!platform.enabled) return 'var(--text-muted)'
    const health = healthByPlatform[platform.id]
    if (!health || !health.started) {
      return health?.startError ? 'var(--text-error)' : 'var(--text-muted)'
    }
    switch (health.status) {
      case 'running':
        return 'var(--text-success)'
      case 'degraded':
        return 'var(--text-warning)'
      case 'failed':
        return 'var(--text-error)'
      case 'stopped':
        return 'var(--text-muted)'
    }
  }

  const deletePlatform = (platform: BotPlatformConfig) => {
    new ConfirmModal(app, {
      title: t('settings.bots.deletePlatformTitle', 'Delete bot platform'),
      message: t(
        'settings.bots.deletePlatformMessage',
        'Remove "{name}"? This cannot be undone.',
      ).replace('{name}', platform.name || platform.platformType),
      ctaText: t('common.delete', 'Delete'),
      onConfirm: () => {
        updateBots({
          platforms: bots.platforms.filter((p) => p.id !== platform.id),
        })
      },
    }).open()
  }

  const archiveMapping = (sessionKey: string, archive: boolean) => {
    updateBots({
      sessionMappings: bots.sessionMappings.map((mapping) =>
        mapping.sessionKey === sessionKey
          ? { ...mapping, archivedAt: archive ? Date.now() : undefined }
          : mapping,
      ),
    })
  }

  return (
    <div>
      {/* ===== GLOBAL ===== */}
      <div className="yolo-settings-section">
        <section className="yolo-settings-block">
          <div className="yolo-settings-block-head">
            <div className="yolo-settings-block-head-title-row">
              <div className="yolo-settings-sub-header yolo-settings-block-title">
                {t('settings.bots.globalTitle', 'Global')}
              </div>
            </div>
          </div>
          <div className="yolo-settings-block-content">
            <ObsidianSetting
              name={t('settings.bots.enable', 'Enable Bot Platform')}
              desc={t(
                'settings.bots.enableDesc',
                'Start or stop all configured bot platform connections',
              )}
            >
              <ObsidianToggle
                value={bots.enabled}
                onChange={(value) => updateBots({ enabled: value })}
              />
            </ObsidianSetting>

            <ObsidianSetting
              name={t('settings.bots.whitelist', 'Enable Whitelist')}
              desc={t(
                'settings.bots.whitelistDesc',
                'Only allow messages from users/groups explicitly permitted per platform',
              )}
            >
              <ObsidianToggle
                value={bots.whitelistEnabled}
                onChange={(value) => updateBots({ whitelistEnabled: value })}
              />
            </ObsidianSetting>

            <ObsidianSetting
              name={t('settings.bots.groupChat', 'Enable Group Chat')}
              desc={t(
                'settings.bots.groupChatDesc',
                'Allow bots to respond in group conversations (requires group in allowed list)',
              )}
            >
              <ObsidianToggle
                value={bots.groupChatEnabled}
                onChange={(value) => updateBots({ groupChatEnabled: value })}
              />
            </ObsidianSetting>

            <ObsidianSetting
              name={t('settings.bots.adminUsers', 'Admin Users')}
              desc={t(
                'settings.bots.adminUsersDesc',
                'Platform sender IDs who can run /reset and manage commands. Comma-separated.',
              )}
            >
              <ObsidianTextInput
                value={bots.adminUsers.join(', ')}
                placeholder="123456789"
                onChange={(value) =>
                  updateBots({
                    adminUsers: value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </ObsidianSetting>
          </div>
        </section>
      </div>

      {/* ===== PLATFORM LIST ===== */}
      <div className="yolo-settings-section">
        <section className="yolo-settings-block">
          <div className="yolo-settings-block-head">
            <div className="yolo-settings-block-head-title-row">
              <div className="yolo-settings-sub-header yolo-settings-block-title">
                {t('settings.bots.platformsTitle', 'Platforms')}
              </div>
              <div className="yolo-settings-desc yolo-settings-block-desc">
                {t(
                  'settings.bots.platformsDesc',
                  'Manage bot platform connections. Each platform runs a separate adapter.',
                )}
              </div>
            </div>
            <div className="yolo-settings-block-action">
              <ObsidianButton
                cta
                text={t('settings.bots.addPlatform', '+ Add Platform')}
                onClick={() => new BotPlatformPickerModal(app, plugin).open()}
              />
            </div>
          </div>

          <div className="yolo-settings-block-content">
            {bots.platforms.length === 0 && (
              <div className="yolo-settings-desc">
                {t(
                  'settings.bots.noPlatforms',
                  'No bot platforms configured yet.',
                )}
              </div>
            )}
            {bots.platforms.map((platform) => {
              const badge = PLATFORM_BADGE_STYLE[platform.platformType]
              const health = healthByPlatform[platform.id]
              // A start failure or a degraded/failed runtime state is a real
              // problem the user must see — not just a grey dot.
              const healthIssue = health?.startError
                ? {
                    kind: 'start' as const,
                    message: t(
                      'settings.bots.connectionFailed',
                      'Connection failed: {error}',
                    ).replace('{error}', health.startError),
                  }
                : health?.started &&
                    (health.status === 'degraded' || health.status === 'failed')
                  ? {
                      kind: 'status' as const,
                      message: healthStatusLabel(health.status),
                    }
                  : null
              return (
                <div
                  className="setting-item yolo-settings-card"
                  key={platform.id}
                >
                  <div className="setting-item-info">
                    <div
                      className="setting-item-name"
                      style={{ display: 'flex', alignItems: 'center', gap: 6 }}
                    >
                      <span
                        style={{
                          display: 'inline-block',
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: platformDotColor(platform),
                        }}
                      />
                      {platform.name || badge.label}
                    </div>
                    <div className="setting-item-description">
                      <span
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 2,
                          padding: '0 5px',
                          borderRadius: 4,
                          fontSize: 9,
                          fontWeight: 600,
                          textTransform: 'uppercase' as const,
                          background: badge.background,
                          color: badge.color,
                          marginRight: 6,
                        }}
                      >
                        {badge.label}
                      </span>
                      {describePlatform(platform)}
                    </div>
                    {healthIssue && (
                      <div
                        className="setting-item-description"
                        style={{ color: 'var(--text-error)' }}
                      >
                        {healthIssue.message}
                      </div>
                    )}
                  </div>
                  <div className="setting-item-control yolo-item-control">
                    <ObsidianButton
                      text={t(
                        'settings.bots.testConnection',
                        'Test Connection',
                      )}
                      onClick={() => testConnection(platform)}
                    />
                    <ObsidianButton
                      text={t('common.edit', 'Edit')}
                      onClick={() =>
                        new EditBotPlatformModal(app, plugin, platform).open()
                      }
                    />
                    <ObsidianButton
                      text={
                        platform.enabled
                          ? t('settings.bots.stop', 'Stop')
                          : t('settings.bots.start', 'Start')
                      }
                      onClick={() =>
                        updatePlatform(platform.id, {
                          enabled: !platform.enabled,
                        })
                      }
                    />
                    <ObsidianButton
                      text={t('common.delete', 'Delete')}
                      onClick={() => deletePlatform(platform)}
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>

      {/* ===== SESSIONS ===== */}
      <div className="yolo-settings-section">
        <section className="yolo-settings-block">
          <div className="yolo-settings-block-head">
            <div className="yolo-settings-block-head-title-row">
              <div className="yolo-settings-sub-header yolo-settings-block-title">
                {t('settings.bots.sessionsTitle', 'Sessions')}
              </div>
              <div className="yolo-settings-desc yolo-settings-block-desc">
                {t(
                  'settings.bots.sessionsDesc',
                  'Bot session mappings to conversations',
                )}
              </div>
            </div>
          </div>
          <div className="yolo-settings-block-content">
            {bots.sessionMappings.length === 0 && (
              <div className="yolo-settings-desc">
                {t('settings.bots.noSessions', 'No bot sessions yet.')}
              </div>
            )}
            {bots.sessionMappings.map((mapping) => {
              const isArchived = !!mapping.archivedAt
              return (
                <div
                  className="setting-item yolo-settings-card"
                  key={mapping.sessionKey}
                >
                  <div className="setting-item-info">
                    <div
                      className="setting-item-name"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        opacity: isArchived ? 0.55 : 1,
                      }}
                    >
                      <span
                        style={{
                          display: 'inline-block',
                          width: 7,
                          height: 7,
                          borderRadius: '50%',
                          background: isArchived
                            ? 'var(--text-muted)'
                            : 'var(--text-success)',
                        }}
                      />
                      {mapping.sessionKey}
                    </div>
                    <div className="setting-item-description">
                      → {mapping.conversationId}
                      {mapping.conversationTitle
                        ? ` · ${mapping.conversationTitle}`
                        : ''}{' '}
                      · {t('settings.bots.lastActive', 'Last active')}:{' '}
                      {new Date(mapping.lastActiveAt).toLocaleString()}
                      {isArchived
                        ? ` (${t('settings.bots.archived', 'archived')})`
                        : ''}
                    </div>
                  </div>
                  <div className="setting-item-control yolo-item-control">
                    <ObsidianButton
                      text={t('settings.bots.openChat', 'Open Chat')}
                      onClick={() =>
                        void plugin.openChatView({
                          initialConversationId: mapping.conversationId,
                          placement: 'sidebar',
                        })
                      }
                    />
                    <ObsidianButton
                      text={
                        isArchived
                          ? t('settings.bots.unarchive', 'Unarchive')
                          : t('settings.bots.archive', 'Archive')
                      }
                      onClick={() =>
                        archiveMapping(mapping.sessionKey, !isArchived)
                      }
                    />
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      </div>
    </div>
  )
}
