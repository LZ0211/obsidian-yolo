import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { BookOpen, Copy, Cpu, Folder, Plus, Trash2, Wrench } from 'lucide-react'
import { App, Platform, SuggestModal } from 'obsidian'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import { getAssistantModelDisplayLabel } from '../../../core/agent/assistant-model'
import {
  CONTEXT_MANAGE_LEGACY_SPLIT_TOOL_NAMES,
  FILE_EDIT_GROUP_TOOL_NAME,
  WEB_OPS_GROUP_TOOL_NAME,
  WEB_OPS_SPLIT_ACTION_TOOL_NAMES,
  getBuiltinToolUiMeta,
  isConsolidatedGroupEnabled,
} from '../../../core/agent/builtinToolUiMeta'
import { CONSOLIDATED_TOOL_ACTIONS } from '../../../core/agent/consolidated-tools'
import { isDefaultAssistantId } from '../../../core/agent/default-assistant'
import { getEnabledAssistantToolNames } from '../../../core/agent/tool-preferences'
import { isInjectedBridgeToolName } from '../../../core/mcp/injectionBridge'
import {
  LOCAL_FS_EDIT_TOOL_NAMES,
  USER_FACING_LOCAL_TOOL_SHORT_NAMES,
} from '../../../core/mcp/localFileToolNames'
import { getLocalFileTools } from '../../../core/mcp/localFileTools'
import { McpManager } from '../../../core/mcp/mcpManager'
import { humanizeSkillName } from '../../../core/skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../../core/skills/skillPolicy'
import { useLiteSkillEntries } from '../../../hooks/useLiteSkillEntries'
import { WorkspaceAgent } from '../../../settings/schema/setting.types'
import { Assistant } from '../../../types/assistant.types'
import { McpServerState, McpServerStatus } from '../../../types/mcp.types'
import { renderAssistantIcon } from '../../../utils/assistant-icon'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { AgentSkillsModal } from '../modals/AgentSkillsModal'
import { AgentToolsModal } from '../modals/AgentToolsModal'
import { AssistantsModal } from '../modals/AssistantsModal'

import { AgentAutoContextCompactionSection } from './AgentAutoContextCompactionSection'
import { AgentCliPathSection } from './AgentCliPathSection'
import { AgentImageReadingSection } from './AgentImageReadingSection'
import { AgentMcpServerSection } from './AgentMcpServerSection'
import { computeMcpStatusCounts } from './mcpStatusCounts'
import { NotificationSettingsSection } from './NotificationSettingsSection'

type AgentSectionProps = {
  app: App
}

const EDIT_FS_TOOL_NAME_SET = new Set<string>(LOCAL_FS_EDIT_TOOL_NAMES)
const SPLIT_WEB_TOOL_NAME_SET = new Set<string>(WEB_OPS_SPLIT_ACTION_TOOL_NAMES)
const SPLIT_CONTEXT_TOOL_NAME_SET = new Set<string>(
  CONTEXT_MANAGE_LEGACY_SPLIT_TOOL_NAMES,
)

class TemplatePickerModal extends SuggestModal<Assistant> {
  constructor(
    app: App,
    private assistants: Assistant[],
    private onPick: (id: string) => void,
  ) {
    super(app)
    this.setPlaceholder('Select a template…')
  }

  getSuggestions(query: string): Assistant[] {
    const q = query.toLowerCase()
    return this.assistants.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description ?? '').toLowerCase().includes(q),
    )
  }

  renderSuggestion(assistant: Assistant, el: HTMLElement) {
    el.createEl('div', { text: assistant.name })
    if (assistant.description) {
      el.createEl('small', {
        text: assistant.description,
        cls: 'yolo-settings-desc',
      })
    }
  }

  onChooseSuggestion(assistant: Assistant) {
    this.onPick(assistant.id)
  }
}

export function AgentSection({ app }: AgentSectionProps) {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()
  const plugin = usePlugin()
  const assistants = settings.assistants || []
  const workspaceAgents = settings.workspaceAgents || []
  const [mcpManager, setMcpManager] = useState<McpManager | null>(null)
  const [mcpServers, setMcpServers] = useState<McpServerState[]>([])
  const [mcpManagerLoading, setMcpManagerLoading] = useState(true)
  const [portalContainer, setPortalContainer] = useState<HTMLElement>()
  const sectionRef = useCallback((node: HTMLDivElement | null) => {
    setPortalContainer(node?.ownerDocument.body)
  }, [])

  useEffect(() => {
    let isMounted = true
    setMcpManagerLoading(true)
    void plugin
      .getMcpManager()
      .then((manager) => {
        if (!isMounted) {
          return
        }
        setMcpManager(manager)
        setMcpServers(manager.getServers())
        setMcpManagerLoading(false)
      })
      .catch((error: unknown) => {
        if (isMounted) {
          setMcpManagerLoading(false)
        }
        console.error(
          'Failed to initialize MCP manager in Agent section',
          error,
        )
      })

    return () => {
      isMounted = false
    }
  }, [plugin])

  useEffect(() => {
    if (!mcpManager) {
      return
    }
    const unsubscribe = mcpManager.subscribeServersChange((servers) => {
      setMcpServers(servers)
    })
    return () => {
      unsubscribe()
    }
  }, [mcpManager])

  const handleOpenAssistantsModal = (
    initialAssistantId?: string,
    initialCreate?: boolean,
  ) => {
    const modal = new AssistantsModal(
      app,
      plugin,
      initialAssistantId,
      initialCreate,
    )
    modal.open()
  }

  const handleDuplicateAssistant = async (assistant: Assistant) => {
    const copied: Assistant = {
      ...assistant,
      id: crypto.randomUUID(),
      name: `${assistant.name}${t('settings.agent.copySuffix', ' (copy)')}`,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    await setSettings({
      ...settings,
      assistants: [...assistants, copied],
    })
  }

  const handleDeleteAssistant = (assistant: Assistant) => {
    if (isDefaultAssistantId(assistant.id)) {
      return
    }

    let confirmed = false

    const modal = new ConfirmModal(app, {
      title: t('settings.agent.deleteConfirmTitle', 'Confirm delete agent'),
      message: `${t('settings.agent.deleteConfirmMessagePrefix', 'Are you sure you want to delete agent')} "${assistant.name}"${t('settings.agent.deleteConfirmMessageSuffix', '? This action cannot be undone.')}`,
      ctaText: t('common.delete'),
      onConfirm: () => {
        confirmed = true
      },
    })

    modal.onClose = () => {
      if (!confirmed) {
        return
      }

      void (async () => {
        const updatedAssistants = assistants.filter(
          (a) => a.id !== assistant.id,
        )
        await setSettings({
          ...settings,
          assistants: updatedAssistants,
          currentAssistantId:
            settings.currentAssistantId === assistant.id
              ? updatedAssistants[0]?.id
              : settings.currentAssistantId,
          quickAskAssistantId:
            settings.quickAskAssistantId === assistant.id
              ? updatedAssistants[0]?.id
              : settings.quickAskAssistantId,
        })
      })().catch((error: unknown) => {
        console.error('Failed to delete agent', error)
      })
    }

    modal.open()
  }

  const handleOpenWorkspaceAgentModal = (workspaceAgentId?: string) => {
    const modal = new AssistantsModal(app, plugin, undefined, false, {
      workspaceAgentId,
    })
    modal.open()
  }

  const handleNewWorkspaceAgent = () => {
    if (assistants.length === 0) {
      handleOpenAssistantsModal(undefined, true)
      return
    }
    if (assistants.length === 1) {
      const modal = new AssistantsModal(app, plugin, undefined, false, {
        workspaceAgentTemplateId: assistants[0].id,
      })
      modal.open()
      return
    }
    new TemplatePickerModal(app, assistants, (templateId) => {
      const modal = new AssistantsModal(app, plugin, undefined, false, {
        workspaceAgentTemplateId: templateId,
      })
      modal.open()
    }).open()
  }

  const handleDeleteWorkspaceAgent = (agent: WorkspaceAgent) => {
    let confirmed = false

    const modal = new ConfirmModal(app, {
      title: t(
        'settings.agent.deleteWorkspaceAgentTitle',
        'Confirm delete workspace agent',
      ),
      message: `${t('settings.agent.deleteWorkspaceAgentMessagePrefix', 'Are you sure you want to delete workspace agent')} "${agent.name}"${t('settings.agent.deleteWorkspaceAgentMessageSuffix', '? This action cannot be undone.')}`,
      ctaText: t('common.delete'),
      onConfirm: () => {
        confirmed = true
      },
    })

    modal.onClose = () => {
      if (!confirmed) return
      void (async () => {
        const updatedAgents = workspaceAgents.filter((a) => a.id !== agent.id)
        await setSettings({
          ...settings,
          workspaceAgents: updatedAgents,
          currentWorkspaceAgentId:
            settings.currentWorkspaceAgentId === agent.id
              ? updatedAgents[0]?.id
              : settings.currentWorkspaceAgentId,
        })
      })().catch((error: unknown) => {
        console.error('Failed to delete workspace agent', error)
      })
    }

    modal.open()
  }

  const handleOpenToolsModal = () => {
    const modal = new AgentToolsModal(app, plugin)
    modal.open()
  }

  const handleOpenSkillsModal = () => {
    const modal = new AgentSkillsModal(app, plugin)
    modal.open()
  }

  const handleToggleToolDisclosure = async (value: boolean) => {
    await setSettings({
      ...settings,
      mcp: {
        ...settings.mcp,
        enableToolDisclosure: value,
      },
    })
  }

  const mcpTools = useMemo(
    () =>
      mcpServers
        .filter((server) => server.status === McpServerStatus.Connected)
        .flatMap((server) =>
          server.tools.map((tool) => {
            const option = server.config.toolOptions[tool.name]
            return {
              id: `${server.name}:${tool.name}`,
              name: tool.name,
              source: server.name,
              serverId: server.name,
              enabled: !(option?.disabled ?? false),
            }
          }),
        ),
    [mcpServers],
  )

  const builtinTools = useMemo(() => {
    const toolOptions = settings.mcp.builtinToolOptions
    const tools = getLocalFileTools()
      .filter(
        (tool) =>
          !EDIT_FS_TOOL_NAME_SET.has(tool.name) &&
          !SPLIT_WEB_TOOL_NAME_SET.has(tool.name) &&
          !SPLIT_CONTEXT_TOOL_NAME_SET.has(tool.name) &&
          (USER_FACING_LOCAL_TOOL_SHORT_NAMES.includes(tool.name) ||
            isInjectedBridgeToolName(tool.name)),
      )
      .map((tool) => {
        const meta = getBuiltinToolUiMeta(tool.name)
        const groupActions = (
          CONSOLIDATED_TOOL_ACTIONS as Record<
            string,
            readonly string[] | undefined
          >
        )[tool.name]
        return {
          id: tool.name,
          label: meta ? t(meta.labelKey, meta.labelFallback) : tool.name,
          enabled: groupActions
            ? isConsolidatedGroupEnabled(toolOptions, tool.name, groupActions)
            : !(toolOptions[tool.name]?.disabled ?? false),
        }
      })

    const editSplitToolEnabled = LOCAL_FS_EDIT_TOOL_NAMES.every(
      (toolName) =>
        !(toolOptions[toolName]?.disabled ?? false) &&
        !(toolOptions[FILE_EDIT_GROUP_TOOL_NAME]?.disabled ?? false),
    )
    const fileEditMeta = getBuiltinToolUiMeta(FILE_EDIT_GROUP_TOOL_NAME)
    if (!fileEditMeta) {
      throw new Error('Missing built-in tool UI metadata for fs_edit_ops')
    }
    const fileEditTool = {
      id: FILE_EDIT_GROUP_TOOL_NAME,
      label: t(fileEditMeta.labelKey, fileEditMeta.labelFallback),
      enabled: editSplitToolEnabled,
    }

    // Synthetic groups mirror the Manage tools modal. `fs_file_ops` is a
    // retired group (path operations moved to the bash tool), and memory
    // mutations are internal-only; neither belongs in global settings.

    const webSplitToolEnabled = WEB_OPS_SPLIT_ACTION_TOOL_NAMES.every(
      (toolName) =>
        !(toolOptions[toolName]?.disabled ?? false) &&
        !(toolOptions[WEB_OPS_GROUP_TOOL_NAME]?.disabled ?? false),
    )
    const webOpsMeta = getBuiltinToolUiMeta(WEB_OPS_GROUP_TOOL_NAME)
    if (!webOpsMeta) {
      throw new Error('Missing built-in tool UI metadata for web_ops')
    }
    const webOpsTool = {
      id: WEB_OPS_GROUP_TOOL_NAME,
      label: t(webOpsMeta.labelKey, webOpsMeta.labelFallback),
      enabled: webSplitToolEnabled,
    }

    const fsReadIndex = tools.findIndex((tool) => tool.id === 'fs_read')
    if (fsReadIndex >= 0) {
      tools.splice(fsReadIndex, 0, fileEditTool)
      tools.splice(fsReadIndex + 1, 0, webOpsTool)
    } else {
      tools.push(fileEditTool)
      tools.push(webOpsTool)
    }

    return tools
  }, [settings.mcp.builtinToolOptions, t])

  const allSkillEntries = useLiteSkillEntries(app, { settings })
  const disabledSkillIds = settings.skills?.disabledSkillIds ?? []
  const disabledSkillSet = useMemo(
    () => new Set(disabledSkillIds),
    [disabledSkillIds],
  )
  const globallyEnabledSkillEntries = useMemo(
    () => allSkillEntries.filter((skill) => !disabledSkillSet.has(skill.name)),
    [allSkillEntries, disabledSkillSet],
  )

  const skillsCountLabel = t(
    'settings.agent.skillsCountWithEnabled',
    '{count} skills (enabled {enabled})',
  )
    .replace('{count}', String(allSkillEntries.length))
    .replace('{enabled}', String(globallyEnabledSkillEntries.length))

  const enabledToolsCount =
    builtinTools.filter((tool) => tool.enabled).length +
    mcpTools.filter((tool) => tool.enabled).length

  const toolsCountLabel = t(
    'settings.agent.toolsCountWithEnabled',
    '{count} tools (enabled {enabled})',
  )
    .replace('{count}', String(builtinTools.length + mcpTools.length))
    .replace('{enabled}', String(enabledToolsCount))

  const enabledConfiguredMcpServerCount = settings.mcp.servers.filter(
    (server) => server.enabled,
  ).length
  const mcpStatusCounts = computeMcpStatusCounts({
    servers: mcpServers,
    loading: mcpManagerLoading,
    enabledConfiguredCount: enabledConfiguredMcpServerCount,
  })
  const mcpLoadingCount = mcpStatusCounts.loading
  const mcpErrorCount = mcpStatusCounts.error
  const mcpToolStatusLabels = [
    mcpLoadingCount > 0
      ? t('settings.agent.mcpLoadingStatus', 'Loading {count} MCP...').replace(
          '{count}',
          String(mcpLoadingCount),
        )
      : null,
    mcpErrorCount > 0
      ? t(
          'settings.agent.mcpErrorStatus',
          '{count} MCP failed to connect',
        ).replace('{count}', String(mcpErrorCount))
      : null,
  ].filter((label): label is string => Boolean(label))

  const mcpCountLabel = t(
    'settings.agent.mcpServerCount',
    '{count} MCP servers connected',
  ).replace('{count}', String(mcpStatusCounts.labelCount))

  const toolTags = [
    ...builtinTools.map((tool) => ({
      key: `builtin:${tool.id}`,
      label: tool.label,
    })),
    ...mcpTools.map((tool) => ({ key: tool.id, label: tool.name })),
  ]

  const TAG_DISPLAY_LIMIT = 20
  const visibleToolTags = toolTags.slice(0, TAG_DISPLAY_LIMIT)
  const hiddenToolTagsCount = toolTags.length - visibleToolTags.length
  const visibleSkillEntries = globallyEnabledSkillEntries.slice(
    0,
    TAG_DISPLAY_LIMIT,
  )
  const hiddenSkillEntriesCount =
    globallyEnabledSkillEntries.length - visibleSkillEntries.length

  return (
    <div ref={sectionRef} className="yolo-settings-section yolo-agent-section">
      <div className="yolo-settings-header">
        {t('settings.agent.title', 'Agent')}
      </div>
      <div className="yolo-settings-desc yolo-agent-intro">
        {t(
          'settings.agent.desc',
          'Manage global tool availability. Enabled tools become selectable by agents; actual use must still be enabled in each agent.',
        )}
      </div>

      <section className="yolo-agent-block">
        <div className="yolo-agent-block-head">
          <div className="yolo-settings-sub-header">
            {t('settings.agent.globalCapabilities', 'Global capabilities')}
          </div>
          <div className="yolo-settings-desc">{mcpCountLabel}</div>
        </div>

        <div className="yolo-agent-cap-grid">
          <article className="yolo-agent-cap-card">
            <div className="yolo-agent-cap-title-row">
              <div className="yolo-agent-cap-title">
                <Wrench size={14} />
                <span>{t('settings.agent.tools', 'Tools')}</span>
              </div>
              <button
                type="button"
                className="mod-cta yolo-agent-tools-trigger"
                onClick={handleOpenToolsModal}
              >
                {t('settings.agent.manageTools', 'Manage tools')}
              </button>
            </div>
            <div className="yolo-agent-cap-count">
              <span>{toolsCountLabel}</span>
              {mcpToolStatusLabels.map((label) => (
                <span key={label} className="yolo-agent-cap-status">
                  {label}
                </span>
              ))}
            </div>
            <div className="yolo-agent-cap-tags">
              {visibleToolTags.map((tool) => (
                <span
                  key={tool.key}
                  className="yolo-agent-chip"
                  title={tool.label}
                >
                  {tool.label}
                </span>
              ))}
              {hiddenToolTagsCount > 0 && (
                <button
                  type="button"
                  className="yolo-agent-chip yolo-agent-chip--more"
                  onClick={handleOpenToolsModal}
                  title={t('settings.agent.viewAllTools', 'View all tools')}
                >
                  +{hiddenToolTagsCount}
                </button>
              )}
            </div>
          </article>

          <article className="yolo-agent-cap-card">
            <div className="yolo-agent-cap-title-row">
              <div className="yolo-agent-cap-title">
                <BookOpen size={14} />
                <span>{t('settings.agent.skills', 'Skills')}</span>
              </div>
              <button
                type="button"
                className="mod-cta yolo-agent-tools-trigger"
                onClick={handleOpenSkillsModal}
              >
                {t('settings.agent.manageSkills', 'Manage skills')}
              </button>
            </div>
            <div className="yolo-agent-cap-count">{skillsCountLabel}</div>
            <div className="yolo-agent-cap-tags">
              {visibleSkillEntries.map((skill) => (
                <span
                  key={skill.name}
                  className="yolo-agent-chip"
                  title={skill.name}
                >
                  {humanizeSkillName(skill.name)}
                </span>
              ))}
              {hiddenSkillEntriesCount > 0 && (
                <button
                  type="button"
                  className="yolo-agent-chip yolo-agent-chip--more"
                  onClick={handleOpenSkillsModal}
                  title={t('settings.agent.viewAllSkills', 'View all skills')}
                >
                  +{hiddenSkillEntriesCount}
                </button>
              )}
            </div>
          </article>
        </div>

        <ObsidianSetting
          name={t(
            'settings.agent.enableToolDisclosure',
            'On-demand tool disclosure',
          )}
          desc={t(
            'settings.agent.enableToolDisclosureDesc',
            'Beta: expose large tool schemas only when the model asks for them.',
          )}
        >
          <ObsidianToggle
            value={settings.mcp.enableToolDisclosure}
            onChange={(value) => void handleToggleToolDisclosure(value)}
          />
        </ObsidianSetting>
      </section>

      <section className="yolo-agent-block">
        <div className="yolo-agent-block-head">
          <div className="yolo-agent-block-head-title-row">
            <div className="yolo-settings-sub-header">
              {t('settings.agent.agents', 'Agents')}
            </div>
            <ObsidianButton
              text={t('settings.agent.newAgent', 'New agent')}
              onClick={() => handleOpenAssistantsModal(undefined, true)}
              cta
            />
          </div>
          <div className="yolo-settings-desc">
            {t(
              'settings.agent.agentsDesc',
              'Click Configure to edit each agent profile and prompt.',
            )}
          </div>
        </div>

        <div className="yolo-agent-grid">
          {assistants.map((assistant) => (
            <article
              key={assistant.id}
              className="yolo-agent-card yolo-agent-card--clickable"
              role="button"
              tabIndex={0}
              onClick={() => handleOpenAssistantsModal(assistant.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleOpenAssistantsModal(assistant.id)
                }
              }}
            >
              <div className="yolo-agent-card-top">
                <div className="yolo-agent-card-top-main">
                  <div className="yolo-agent-avatar">
                    {renderAssistantIcon(assistant.icon, 16)}
                  </div>
                  <div className="yolo-agent-main">
                    <div className="yolo-agent-name-row">
                      <div className="yolo-agent-name">{assistant.name}</div>
                    </div>
                    {assistant.description && (
                      <div className="yolo-agent-desc">
                        {assistant.description}
                      </div>
                    )}
                  </div>
                </div>

                <DropdownMenu.Root>
                  <DropdownMenu.Trigger
                    className="yolo-agent-card-menu-trigger"
                    onClick={(event) => event.stopPropagation()}
                  >
                    <span
                      className="yolo-agent-card-menu-trigger-dots"
                      aria-hidden="true"
                    >
                      ...
                    </span>
                  </DropdownMenu.Trigger>
                  <DropdownMenu.Portal container={portalContainer}>
                    <DropdownMenu.Content
                      className="yolo-agent-card-menu-popover"
                      align="end"
                      sideOffset={8}
                      onClick={(event) => event.stopPropagation()}
                    >
                      <ul className="yolo-agent-card-menu-list">
                        <DropdownMenu.Item
                          asChild
                          onSelect={() => {
                            void handleDuplicateAssistant(assistant)
                          }}
                        >
                          <li className="yolo-agent-card-menu-item">
                            <span className="yolo-agent-card-menu-icon">
                              <Copy size={16} />
                            </span>
                            {t('settings.agent.duplicate', 'Duplicate')}
                          </li>
                        </DropdownMenu.Item>
                        {!isDefaultAssistantId(assistant.id) && (
                          <DropdownMenu.Item
                            asChild
                            onSelect={() => handleDeleteAssistant(assistant)}
                          >
                            <li className="yolo-agent-card-menu-item yolo-agent-card-menu-danger">
                              <span className="yolo-agent-card-menu-icon">
                                <Trash2 size={16} />
                              </span>
                              {t('common.delete')}
                            </li>
                          </DropdownMenu.Item>
                        )}
                      </ul>
                    </DropdownMenu.Content>
                  </DropdownMenu.Portal>
                </DropdownMenu.Root>
              </div>

              <div className="yolo-agent-meta-row">
                <span className="yolo-agent-meta-item">
                  <Cpu size={12} />
                  {getAssistantModelDisplayLabel(
                    assistant.modelId,
                    t(
                      'settings.agent.followDefaultModel',
                      'Follow default model',
                    ),
                  )}
                </span>
                <span className="yolo-agent-meta-item">
                  <Wrench size={12} />
                  {assistant.enableTools
                    ? `${getEnabledAssistantToolNames(assistant).length} tools`
                    : '0 tools'}
                </span>
                <span className="yolo-agent-meta-item">
                  <BookOpen size={12} />
                  {`${
                    allSkillEntries.filter((skill) =>
                      isSkillEnabledForAssistant({
                        assistant,
                        skillName: skill.name,
                        disabledSkillNames: disabledSkillIds,
                      }),
                    ).length
                  } skills`}
                </span>
              </div>
            </article>
          ))}
          <article
            className="yolo-agent-create-card"
            role="button"
            tabIndex={0}
            onClick={() => handleOpenAssistantsModal(undefined, true)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                handleOpenAssistantsModal(undefined, true)
              }
            }}
          >
            <div className="yolo-agent-create-card-icon">
              <Plus size={28} />
            </div>
            <div className="yolo-agent-create-card-text">
              {t('settings.agent.newAgent', 'New agent')}
            </div>
          </article>
        </div>
      </section>

      <section className="yolo-agent-block">
        <div className="yolo-agent-block-head">
          <div className="yolo-agent-block-head-title-row">
            <div className="yolo-settings-sub-header">
              {t('settings.agent.workspaceAgents', 'Workspace Agents')}
            </div>
            <ObsidianButton
              text={t(
                'settings.agent.newWorkspaceAgent',
                'New workspace agent',
              )}
              onClick={() => handleNewWorkspaceAgent()}
              cta
            />
          </div>
          <div className="yolo-settings-desc">
            {t(
              'settings.agent.workspaceAgentsDesc',
              'Agent instances bound to working directories. Each derives from a template and limits its file access to a workspace root.',
            )}
          </div>
        </div>

        {workspaceAgents.length > 0 ? (
          <div className="yolo-agent-grid">
            {workspaceAgents.map((agent) => {
              const template = assistants.find(
                (tpl) => tpl.id === agent.templateId,
              )
              return (
                <article
                  key={agent.id}
                  className="yolo-agent-card yolo-agent-card--clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => handleOpenWorkspaceAgentModal(agent.id)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      handleOpenWorkspaceAgentModal(agent.id)
                    }
                  }}
                >
                  <div className="yolo-agent-card-top">
                    <div className="yolo-agent-card-top-main">
                      <div className="yolo-agent-avatar">
                        {renderAssistantIcon(template?.icon, 16)}
                      </div>
                      <div className="yolo-agent-main">
                        <div className="yolo-agent-name-row">
                          <div className="yolo-agent-name">{agent.name}</div>
                          {agent.disabled && (
                            <span className="yolo-agent-card-badge yolo-agent-card-badge--disabled">
                              {t('settings.agent.disabledBadge', 'disabled')}
                            </span>
                          )}
                        </div>
                        <div className="yolo-agent-desc">
                          <span className="yolo-agent-card-badge yolo-agent-card-badge--template">
                            {t('settings.agent.templateBadge', 'Template')}
                          </span>
                          <span className="yolo-agent-template-name">
                            {template?.name ?? agent.templateId}
                          </span>
                        </div>
                      </div>
                    </div>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger
                        className="yolo-agent-card-menu-trigger"
                        onClick={(event) => event.stopPropagation()}
                      >
                        <span
                          className="yolo-agent-card-menu-trigger-dots"
                          aria-hidden="true"
                        >
                          ...
                        </span>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal container={portalContainer}>
                        <DropdownMenu.Content
                          className="yolo-agent-card-menu-popover"
                          align="end"
                          sideOffset={8}
                          onClick={(event) => event.stopPropagation()}
                        >
                          <ul className="yolo-agent-card-menu-list">
                            <DropdownMenu.Item
                              asChild
                              onSelect={() => handleDeleteWorkspaceAgent(agent)}
                            >
                              <li className="yolo-agent-card-menu-item yolo-agent-card-menu-danger">
                                <span className="yolo-agent-card-menu-icon">
                                  <Trash2 size={16} />
                                </span>
                                {t('common.delete')}
                              </li>
                            </DropdownMenu.Item>
                          </ul>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </div>
                  <div className="yolo-agent-meta-row">
                    {template ? (
                      <>
                        <span className="yolo-agent-meta-item">
                          <Cpu size={12} />
                          {getAssistantModelDisplayLabel(
                            template.modelId,
                            t(
                              'settings.agent.followDefaultModel',
                              'Follow default model',
                            ),
                          )}
                        </span>
                        <span className="yolo-agent-meta-item">
                          <Wrench size={12} />
                          {template.enableTools
                            ? `${getEnabledAssistantToolNames(template).length} tools`
                            : '0 tools'}
                        </span>
                        <span className="yolo-agent-meta-item">
                          <BookOpen size={12} />
                          {`${
                            allSkillEntries.filter((skill) =>
                              isSkillEnabledForAssistant({
                                assistant: template,
                                skillName: skill.name,
                                disabledSkillNames: disabledSkillIds,
                              }),
                            ).length
                          } skills`}
                        </span>
                      </>
                    ) : null}
                    <span className="yolo-agent-meta-item">
                      <Folder size={12} />
                      {agent.workspacePolicy.workspaceRoot}
                    </span>
                  </div>
                </article>
              )
            })}
            <article
              className="yolo-agent-create-card"
              role="button"
              tabIndex={0}
              onClick={() => handleNewWorkspaceAgent()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleNewWorkspaceAgent()
                }
              }}
            >
              <div className="yolo-agent-create-card-icon">
                <Plus size={28} />
              </div>
              <div className="yolo-agent-create-card-text">
                {t('settings.agent.newWorkspaceAgent', 'New workspace agent')}
              </div>
            </article>
          </div>
        ) : (
          <div className="yolo-agent-grid">
            <article
              className="yolo-agent-create-card"
              role="button"
              tabIndex={0}
              onClick={() => handleNewWorkspaceAgent()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  handleNewWorkspaceAgent()
                }
              }}
            >
              <div className="yolo-agent-create-card-icon">
                <Plus size={28} />
              </div>
              <div className="yolo-agent-create-card-text">
                {t('settings.agent.newWorkspaceAgent', 'New workspace agent')}
              </div>
            </article>
          </div>
        )}
      </section>

      <section className="yolo-agent-block">
        <div className="yolo-agent-block-head">
          <div className="yolo-settings-sub-header">
            {t('settings.agent.agentCapabilitiesBlockTitle')}
          </div>
        </div>
        <div className="yolo-agent-sub-card">
          <div className="yolo-agent-sub-card-head">
            {t('settings.agent.imageReadingBlockTitle')}
          </div>
          <AgentImageReadingSection />
        </div>
        <div className="yolo-agent-sub-card">
          <div className="yolo-agent-sub-card-head">
            {t('settings.agent.autoContextCompactionBlockTitle')}
          </div>
          <AgentAutoContextCompactionSection />
        </div>
        <div className="yolo-agent-sub-card">
          <div className="yolo-agent-sub-card-head">
            {t('settings.agent.mcpServerBlockTitle')}
          </div>
          <AgentMcpServerSection />
        </div>
        {Platform.isDesktop && (
          <div className="yolo-agent-sub-card">
            <div className="yolo-agent-sub-card-head">
              {t('settings.agent.cliRuntimesBlockTitle', 'CLI runtimes')}
            </div>
            <AgentCliPathSection app={app} />
          </div>
        )}
      </section>

      <section className="yolo-agent-block">
        <div className="yolo-agent-block-head">
          <div className="yolo-settings-sub-header">
            {t('settings.etc.notifications', '通知提醒')}
          </div>
        </div>

        <NotificationSettingsSection />
      </section>
    </div>
  )
}
