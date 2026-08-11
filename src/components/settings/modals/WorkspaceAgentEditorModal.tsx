import { Wrench } from 'lucide-react'
import { App } from 'obsidian'
import { useCallback, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { SettingsProvider } from '../../../contexts/settings-context'
import { useSettings } from '../../../contexts/settings-context'
import YoloPlugin from '../../../main'
import type { WorkspaceAgent } from '../../../settings/schema/setting.types'
import type { Assistant } from '../../../types/assistant.types'
import { ReactModal } from '../../common/ReactModal'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { WorkspaceAgentScopeEditor } from '../sections/WorkspaceAgentScopeEditor'

import { WorkspaceAgentSkillOverridesModal } from './WorkspaceAgentSkillOverridesModal'
import { WorkspaceAgentToolOverridesModal } from './WorkspaceAgentToolOverridesModal'

type Props = {
  app: App
  plugin: YoloPlugin
  agentId: string
}

export class WorkspaceAgentEditorModal extends ReactModal<Props> {
  constructor(app: App, plugin: YoloPlugin, agentId: string) {
    super({
      app,
      Component: WorkspaceAgentEditorWrapper,
      props: { app, plugin, agentId },
      options: {
        title: plugin.t(
          'settings.workspaceAgents.editorTitle',
          'Edit workspace agent',
        ),
        className: 'yolo-modal--wide',
      },
      plugin,
    })
  }
}

function WorkspaceAgentEditorWrapper(props: Props & { onClose: () => void }) {
  const { plugin } = props
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <WorkspaceAgentEditor {...props} />
    </SettingsProvider>
  )
}

function WorkspaceAgentEditor({
  app,
  plugin,
  agentId,
  onClose,
}: Props & { onClose: () => void }) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const [showToolOverrides, setShowToolOverrides] = useState(false)
  const [showSkillOverrides, setShowSkillOverrides] = useState(false)

  const agent = (settings.workspaceAgents ?? []).find(
    (candidate) => candidate.id === agentId,
  )
  const template = agent
    ? (settings.assistants ?? []).find(
        (candidate) => candidate.id === agent.templateId,
      )
    : undefined

  const updateAgent = useCallback(
    (mutate: (current: WorkspaceAgent) => WorkspaceAgent) => {
      if (!agent) return
      void setSettings({
        ...settings,
        workspaceAgents: (settings.workspaceAgents ?? []).map((candidate) =>
          candidate.id === agent.id ? mutate(candidate) : candidate,
        ),
      }).catch((error: unknown) => {
        console.error('Failed to update workspace agent', error)
      })
    },
    [agent, setSettings, settings],
  )

  if (!agent) {
    onClose()
    return null
  }

  return (
    <div className="yolo-workspace-agent-editor">
      <ObsidianSetting name={t('settings.workspaceAgents.agentName', 'Name')}>
        <ObsidianTextInput
          value={agent.name}
          onChange={(name) =>
            updateAgent((current) => ({
              ...current,
              name,
              updatedAt: Date.now(),
            }))
          }
          placeholder={t(
            'settings.workspaceAgents.agentNamePlaceholder',
            'Agent name',
          )}
        />
      </ObsidianSetting>
      <ObsidianSetting
        name={t('settings.workspaceAgents.agentModeAllowed', 'Agent mode')}
        desc={t(
          'settings.workspaceAgents.agentModeAllowedDesc',
          'When off, this workspace agent only exposes Ask mode.',
        )}
      >
        <ObsidianToggle
          value={agent.behaviorOverrides?.agentModeAllowed !== false}
          onChange={(allowed) =>
            updateAgent((current) => ({
              ...current,
              behaviorOverrides: {
                ...(current.behaviorOverrides ?? {}),
                agentModeAllowed: allowed,
              },
              updatedAt: Date.now(),
            }))
          }
        />
      </ObsidianSetting>
      <ObsidianSetting
        name={t(
          'settings.workspaceAgents.promptOverride',
          'Prompt override',
        )}
        desc={t(
          'settings.workspaceAgents.promptOverrideDesc',
          'Overrides the template system prompt. Empty inherits the template.',
        )}
      >
        <ObsidianTextArea
          value={agent.behaviorOverrides?.systemPromptOverride ?? ''}
          onChange={(prompt) =>
            updateAgent((current) => ({
              ...current,
              behaviorOverrides: {
                ...(current.behaviorOverrides ?? {}),
                systemPromptOverride: prompt || undefined,
              },
              updatedAt: Date.now(),
            }))
          }
          placeholder={t(
            'settings.workspaceAgents.promptOverridePlaceholder',
            'Inherit from template',
          )}
        />
      </ObsidianSetting>
      <WorkspaceAgentScopeEditor
        app={app}
        vault={app.vault}
        value={agent.workspacePolicy}
        onChange={(nextPolicy) =>
          updateAgent((current) => ({
            ...current,
            workspacePolicy: nextPolicy,
            updatedAt: Date.now(),
          }))
        }
      />
      {template ? (
        <div className="yolo-workspace-agents-item-actions-row">
          <button
            type="button"
            className="yolo-workspace-agents-tool-overrides-button"
            onClick={() => setShowToolOverrides(true)}
          >
            <Wrench size={14} />
            <span>
              {t(
                'settings.workspaceAgents.toolOverridesButton',
                'Tool overrides',
              )}
            </span>
          </button>
          <button
            type="button"
            className="yolo-workspace-agents-tool-overrides-button"
            onClick={() => setShowSkillOverrides(true)}
          >
            <Wrench size={14} />
            <span>
              {t(
                'settings.workspaceAgents.skillOverridesButton',
                'Skill overrides',
              )}
            </span>
          </button>
        </div>
      ) : null}

      {showToolOverrides && template ? (
        <div className="yolo-workspace-agents-tool-overrides-modal">
          <WorkspaceAgentToolOverridesModal
            template={template as Assistant}
            value={agent.behaviorOverrides}
            onChange={(nextOverrides) => {
              updateAgent((current) => ({
                ...current,
                behaviorOverrides: nextOverrides,
                updatedAt: Date.now(),
              }))
            }}
            onClose={() => setShowToolOverrides(false)}
          />
        </div>
      ) : null}
      {showSkillOverrides && template ? (
        <div className="yolo-workspace-agents-skill-overrides-modal">
          <WorkspaceAgentSkillOverridesModal
            template={template as Assistant}
            value={agent.behaviorOverrides}
            onChange={(nextOverrides) => {
              updateAgent((current) => ({
                ...current,
                behaviorOverrides: nextOverrides,
                updatedAt: Date.now(),
              }))
            }}
            onClose={() => setShowSkillOverrides(false)}
          />
        </div>
      ) : null}
      <div className="modal-button-container yolo-workspace-agent-editor-actions">
        <button onClick={onClose}>{t('common.close', 'Close')}</button>
      </div>
    </div>
  )
}
