import { Pencil, Plus, Trash2, Wrench } from 'lucide-react'
import { App, Notice } from 'obsidian'
import { useCallback, useMemo, useState } from 'react'
import { v4 as uuidv4 } from 'uuid'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  type WorkspaceAgent,
  type WorkspaceAgentPolicy,
} from '../../../settings/schema/setting.types'
import type { Assistant } from '../../../types/assistant.types'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { SimpleSelect } from '../../common/SimpleSelect'

import { WorkspaceAgentToolOverridesModal } from '../modals/WorkspaceAgentToolOverridesModal'
import { WorkspaceAgentScopeEditor } from './WorkspaceAgentScopeEditor'

// 未设置工作目录时统一为 vault 根（`/`），运行时归一为"全部允许"。
const defaultPolicy = (): WorkspaceAgentPolicy => ({
  workspaceRoot: '/',
  readAllowlist: [],
  readDenylist: [],
  writeDenylist: [],
})

/**
 * Workspace agent management (migrated from the local fork): each instance
 * inherits an upstream Assistant template and overrides a workspace
 * home-directory policy. The upstream assistant editor stays untouched.
 */
export function WorkspaceAgentsSection({ app }: { app: App }) {
  const { t } = useLanguage()
  const { settings, setSettings } = useSettings()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [toolOverridesAgentId, setToolOverridesAgentId] = useState<
    string | null
  >(null)
  const agents = settings.workspaceAgents ?? []

  const updateAgent = useCallback(
    (agentId: string, mutate: (agent: WorkspaceAgent) => WorkspaceAgent) => {
      void setSettings({
        ...settings,
        workspaceAgents: agents.map((agent) =>
          agent.id === agentId ? mutate(agent) : agent,
        ),
      }).catch((error: unknown) => {
        console.error('Failed to update workspace agent', error)
      })
    },
    [agents, setSettings, settings],
  )

  const createAgent = useCallback(
    (templateId: string) => {
      const now = Date.now()
      const agent: WorkspaceAgent = {
        id: uuidv4(),
        name: t('settings.workspaceAgents.defaultName', 'New workspace agent'),
        templateId,
        workspacePolicy: defaultPolicy(),
        createdAt: now,
        updatedAt: now,
      }
      void setSettings({
        ...settings,
        workspaceAgents: [...agents, agent],
      })
        .then(() => setEditingId(agent.id))
        .catch((error: unknown) => {
          console.error('Failed to create workspace agent', error)
        })
    },
    [agents, setSettings, settings, t],
  )

  const deleteAgent = useCallback(
    (agentId: string) => {
      void setSettings({
        ...settings,
        workspaceAgents: agents.filter((agent) => agent.id !== agentId),
      })
        .then(() => {
          if (editingId === agentId) setEditingId(null)
        })
        .catch((error: unknown) => {
          console.error('Failed to delete workspace agent', error)
        })
    },
    [agents, editingId, setSettings, settings],
  )

  const templateOptions = useMemo(
    () =>
      (settings.assistants ?? []).map((assistant) => ({
        id: assistant.id,
        name: assistant.name,
      })),
    [settings.assistants],
  )

  return (
    <div className="yolo-workspace-agents-section">
      <ObsidianSetting
        name={t(
          'settings.workspaceAgents.sectionTitle',
          'Workspace agents',
        )}
        desc={t(
          'settings.workspaceAgents.sectionDesc',
          'Each workspace agent inherits an Assistant template and adds a home-directory workspace policy.',
        )}
      >
        <SimpleSelect
          value=""
          options={[
            { value: '', label: t('common.add', 'Add') },
            ...templateOptions.map((option) => ({
              value: option.id,
              label: option.name,
            })),
          ]}
          onChange={(templateId) => {
            if (!templateId) return
            if (templateOptions.length === 0) {
              new Notice(
                t(
                  'settings.workspaceAgents.noTemplates',
                  'Create an Assistant first to use as a template.',
                ),
              )
              return
            }
            createAgent(templateId)
          }}
          placeholder={t('settings.workspaceAgents.pickTemplate', 'Pick a template')}
        />
      </ObsidianSetting>

      {agents.map((agent) => {
        const template = (settings.assistants ?? []).find(
          (candidate) => candidate.id === agent.templateId,
        )
        const isEditing = editingId === agent.id
        return (
          <div
            key={agent.id}
            className="yolo-workspace-agents-item"
            data-workspace-agent-id={agent.id}
          >
            <ObsidianSetting
              name={agent.name}
              desc={
                template
                  ? t(
                      'settings.workspaceAgents.template',
                      'Template: {name}',
                    ).replace('{name}', template.name)
                  : t(
                      'settings.workspaceAgents.missingTemplate',
                      'Missing template: {id}',
                    ).replace('{id}', agent.templateId)
              }
              nameExtra={
                <span className="yolo-workspace-agents-item-actions">
                  <button
                    type="button"
                    className="clickable-icon"
                    onClick={() => setEditingId(isEditing ? null : agent.id)}
                    aria-label={t('common.edit', 'Edit')}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="clickable-icon"
                    onClick={() => deleteAgent(agent.id)}
                    aria-label={t('common.delete', 'Delete')}
                  >
                    <Trash2 size={14} />
                  </button>
                </span>
              }
            >
              <ObsidianToggle
                value={agent.disabled !== true}
                onChange={(enabled) =>
                  updateAgent(agent.id, (current) => ({
                    ...current,
                    disabled: !enabled,
                    updatedAt: Date.now(),
                  }))
                }
              />
            </ObsidianSetting>

            {isEditing ? (
              <div className="yolo-workspace-agents-item-editor">
                <WorkspaceAgentScopeEditor
                  app={app}
                  vault={app.vault}
                  value={agent.workspacePolicy}
                  onChange={(nextPolicy) =>
                    updateAgent(agent.id, (current) => ({
                      ...current,
                      workspacePolicy: nextPolicy,
                      updatedAt: Date.now(),
                    }))
                  }
                />
                {template ? (
                  <button
                    type="button"
                    className="yolo-workspace-agents-tool-overrides-button"
                    onClick={() => setToolOverridesAgentId(agent.id)}
                  >
                    <Wrench size={14} />
                    <span>
                      {t(
                        'settings.workspaceAgents.toolOverridesButton',
                        'Tool overrides',
                      )}
                    </span>
                  </button>
                ) : null}
              </div>
            ) : null}
          </div>
        )
      })}

      {toolOverridesAgentId !== null ? (() => {
        const target = agents.find(
          (agent) => agent.id === toolOverridesAgentId,
        )
        const template = target
          ? (settings.assistants ?? []).find(
              (candidate) => candidate.id === target.templateId,
            )
          : undefined
        if (!target || !template) {
          setToolOverridesAgentId(null)
          return null
        }
        const close = () => setToolOverridesAgentId(null)
        return (
          <div className="yolo-workspace-agents-tool-overrides-modal">
            <WorkspaceAgentToolOverridesModal
              template={template}
              value={target.behaviorOverrides}
              onChange={(nextOverrides) => {
                updateAgent(target.id, (current) => ({
                  ...current,
                  behaviorOverrides: nextOverrides,
                  updatedAt: Date.now(),
                }))
              }}
              onClose={close}
            />
          </div>
        )
      })() : null}
    </div>
  )
}
