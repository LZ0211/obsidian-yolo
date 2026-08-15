import { useMemo } from 'react'

import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianDropdown } from '../../common/ObsidianDropdown'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { useLanguage } from '../../../contexts/language-context'
import { generateLocalMcpServerToken } from '../../../core/mcp/localMcpServerConfig'
import type { YoloSettings } from '../../../settings/schema/setting.types'

type CliLlmInjectionSectionProps = {
  settings: YoloSettings
  setSettings: (settings: YoloSettings) => Promise<boolean> | void
}

export function CliLlmInjectionSection({
  settings,
  setSettings,
}: CliLlmInjectionSectionProps) {
  const { t } = useLanguage()
  const injection = settings.cliLlmInjection ?? {
    enabled: false,
    providerId: '',
    modelId: '',
  }

  const providerOptions = useMemo(() => {
    const options: Record<string, string> = {
      '': t(
        'settings.providers.cliInjection.providerPlaceholder',
        '选择 Provider',
      ),
    }
    for (const provider of settings.providers) {
      options[provider.id] = provider.id
    }
    return options
  }, [settings.providers, t])

  const modelOptions = useMemo(() => {
    const options: Record<string, string> = {
      '': t(
        'settings.providers.cliInjection.modelPlaceholder',
        '选择模型',
      ),
    }
    for (const model of settings.chatModels) {
      if (injection.providerId && model.providerId !== injection.providerId) {
        continue
      }
      options[model.id] = model.name || model.model || model.id
    }
    return options
  }, [settings.chatModels, injection.providerId, t])

  const update = (patch: {
    enabled?: boolean
    providerId?: string
    modelId?: string
  }) => {
    void setSettings({
      ...settings,
      cliLlmInjection: { ...injection, ...patch },
    })
  }

  return (
    <section className="yolo-models-block">
      <div className="yolo-models-block-head">
        <div className="yolo-models-block-head-title-row">
          <div className="yolo-settings-sub-header yolo-models-block-title">
            {t(
              'settings.providers.cliInjection.title',
              'CLI Runtime Provider 注入',
            )}
          </div>
          <div className="yolo-settings-desc yolo-models-block-desc">
            {t(
              'settings.providers.cliInjection.desc',
              '开启后 CLI runtime（Claude Code / Codex / Hermes / Pi / OpenCode）使用下方配置的 Provider 与模型；关闭时各 SDK 使用自身配置。',
            )}
          </div>
        </div>
      </div>

      <ObsidianSetting
        name={t(
          'settings.providers.cliInjection.enabledLabel',
          '启用 Provider 注入',
        )}
        desc={t(
          'settings.providers.cliInjection.enabledDesc',
          '将 YOLO 配置的 Provider 凭据与模型注入 CLI runtime 进程。',
        )}
        className="yolo-settings-card"
      >
        <ObsidianToggle
          value={injection.enabled}
          onChange={(value) => update({ enabled: value })}
        />
      </ObsidianSetting>

      {injection.enabled && (
        <>
          <ObsidianSetting
            name={t(
              'settings.providers.cliInjection.providerLabel',
              'Provider',
            )}
            desc={t(
              'settings.providers.cliInjection.providerDesc',
              'CLI runtime 将使用该 Provider 的地址与凭据。',
            )}
            className="yolo-settings-card"
          >
            <ObsidianDropdown
              value={injection.providerId ?? ''}
              options={providerOptions}
              onChange={(providerId) =>
                update({ providerId, modelId: '' })
              }
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.providers.cliInjection.modelLabel', '模型')}
            desc={t(
              'settings.providers.cliInjection.modelDesc',
              'CLI runtime 将使用该模型（需要选择 Provider 后可选）。',
            )}
            className="yolo-settings-card"
          >
            <ObsidianDropdown
              value={injection.modelId ?? ''}
              options={modelOptions}
              disabled={!injection.providerId}
              onChange={(modelId) => update({ modelId })}
            />
          </ObsidianSetting>
        </>
      )}
    </section>
  )
}

export function CliMcpSharingSection({
  settings,
  setSettings,
}: {
  settings: YoloSettings
  setSettings: (settings: YoloSettings) => Promise<boolean> | void
}) {
  const { t } = useLanguage()
  const sharing = settings.cliMcpSharing ?? { enabled: false }
  const localServer = settings.mcp.localServer

  const update = (enabled: boolean) => {
    // 开启共享时确保本地 MCP 服务已启用且 token 存在。
    void setSettings({
      ...settings,
      cliMcpSharing: { enabled },
      ...(enabled
        ? {
            mcp: {
              ...settings.mcp,
              localServer: {
                ...localServer,
                enabled: true,
                token: localServer.token || generateLocalMcpServerToken(),
              },
            },
          }
        : {}),
    })
  }

  return (
    <section className="yolo-models-block">
      <div className="yolo-models-block-head">
        <div className="yolo-models-block-head-title-row">
          <div className="yolo-settings-sub-header yolo-models-block-title">
            {t('settings.providers.cliMcpSharing.title', 'CLI Runtime MCP 共享')}
          </div>
          <div className="yolo-settings-desc yolo-models-block-desc">
            {t(
              'settings.providers.cliMcpSharing.desc',
              '开启后通过 HTTP 把 YOLO 本地 MCP 服务共享给 CLI runtime（Claude Code / Hermes / OpenCode）；关闭时各 SDK 使用自身配置。',
            )}
          </div>
        </div>
      </div>
      <ObsidianSetting
        name={t(
          'settings.providers.cliMcpSharing.enabledLabel',
          '启用 MCP 共享',
        )}
        desc={t(
          'settings.providers.cliMcpSharing.enabledDesc',
          '写入各 CLI 的 MCP 配置（.claude.json / opencode.json），指向本地 MCP HTTP 服务。开启时自动启用本地 MCP 服务并生成 token。',
        )}
        className="yolo-settings-card"
      >
        <ObsidianToggle value={sharing.enabled} onChange={update} />
      </ObsidianSetting>
      {sharing.enabled && !localServer.token.trim() && (
        <div className="yolo-settings-desc">
          {t(
            'settings.providers.cliMcpSharing.noToken',
            '本地 MCP 服务的 token 未生成，请先启用本地 MCP 服务。',
          )}
        </div>
      )}
    </section>
  )
}
