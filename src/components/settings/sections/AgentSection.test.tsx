import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const mockUseSettings = jest.fn()
const mockUseLanguage = jest.fn()
const mockUsePlugin = jest.fn()
const mockGetLocalFileTools = jest.fn()

jest.mock('obsidian', () => ({
  App: class App {},
  Platform: { isDesktop: true },
  SuggestModal: class SuggestModal {},
}))

jest.mock('@radix-ui/react-dropdown-menu', () => ({
  Root: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Trigger: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Content: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Item: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}))

jest.mock('../../../contexts/settings-context', () => ({
  useSettings: () => mockUseSettings(),
}))

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => mockUseLanguage(),
}))

jest.mock('../../../contexts/plugin-context', () => ({
  usePlugin: () => mockUsePlugin(),
}))

jest.mock('../../../core/mcp/localFileTools', () => ({
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES: [
    'memory_add',
    'memory_update',
    'memory_delete',
  ],
  getLocalFileTools: () => mockGetLocalFileTools(),
}))

jest.mock('../../../core/mcp/injectionBridge', () => ({
  isInjectedBridgeToolName: () => false,
}))

jest.mock('../../../core/mcp/mcpManager', () => ({
  McpManager: class McpManager {},
}))

jest.mock('../../../core/skills/liteSkills', () => ({
  humanizeSkillName: (name: string) => name,
}))

jest.mock('../../../core/skills/skillPolicy', () => ({
  isSkillEnabledForAssistant: () => true,
}))

jest.mock('../../../hooks/useLiteSkillEntries', () => ({
  useLiteSkillEntries: () => [],
}))

jest.mock('../../../utils/assistant-icon', () => ({
  renderAssistantIcon: () => null,
}))

jest.mock('../../common/ObsidianButton', () => ({
  ObsidianButton: (props: { text?: string; onClick?: () => void }) => (
    <button type="button">{props.text}</button>
  ),
}))

jest.mock('../../common/ObsidianSetting', () => ({
  ObsidianSetting: (props: {
    name?: string
    desc?: string
    children?: React.ReactNode
  }) => (
    <section>
      {props.name}
      {props.desc}
      {props.children}
    </section>
  ),
}))

jest.mock('../../common/ObsidianToggle', () => ({
  ObsidianToggle: () => null,
}))

jest.mock('../../modals/ConfirmModal', () => ({ ConfirmModal: class {} }))
jest.mock('../modals/AgentSkillsModal', () => ({ AgentSkillsModal: class {} }))
jest.mock('../modals/AgentToolsModal', () => ({ AgentToolsModal: class {} }))
jest.mock('../modals/AssistantsModal', () => ({ AssistantsModal: class {} }))

jest.mock('./AgentAutoContextCompactionSection', () => ({
  AgentAutoContextCompactionSection: () => null,
}))
jest.mock('./AgentCliPathSection', () => ({ AgentCliPathSection: () => null }))
jest.mock('./AgentImageReadingSection', () => ({
  AgentImageReadingSection: () => null,
}))
jest.mock('./AgentMcpServerSection', () => ({
  AgentMcpServerSection: () => null,
}))
jest.mock('./NotificationSettingsSection', () => ({
  NotificationSettingsSection: () => null,
}))
jest.mock('./mcpStatusCounts', () => ({
  computeMcpStatusCounts: () => ({ loading: 0, error: 0, labelCount: 0 }),
}))

import { AgentSection } from './AgentSection'

const renderAgentSection = (): string =>
  renderToStaticMarkup(<AgentSection app={{} as never} />)

beforeEach(() => {
  mockUseSettings.mockReturnValue({
    settings: {
      assistants: [],
      workspaceAgents: [],
      mcp: {
        builtinCapabilityOptions: {},
        servers: [],
        enableToolDisclosure: false,
      },
      skills: { disabledSkillIds: [] },
    },
    setSettings: jest.fn(),
  })
  mockUseLanguage.mockReturnValue({
    t: (_key: string, fallback: string) => fallback,
  })
  mockUsePlugin.mockReturnValue({ getMcpManager: jest.fn() })
  mockGetLocalFileTools.mockReturnValue([])
})

describe('AgentSection builtin tool rows', () => {
  it('restores the Workspace Agents settings entry', () => {
    mockUseSettings.mockReturnValue({
      settings: {
        assistants: [
          {
            id: 'template-1',
            name: 'Workspace template',
            description: 'Template description',
            icon: 'bot',
            enableTools: true,
          },
        ],
        workspaceAgents: [
          {
            id: 'workspace-agent-1',
            name: 'Workspace agent',
            templateId: 'template-1',
            workspacePolicy: {
              workspaceRoot: 'D:/workspace',
              readAllowlist: [],
              readDenylist: [],
              writeDenylist: [],
            },
            shareTokens: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        mcp: {
          builtinCapabilityOptions: {},
          servers: [],
          enableToolDisclosure: false,
        },
        skills: { disabledSkillIds: [] },
      },
      setSettings: jest.fn(),
    })

    const html = renderAgentSection()

    expect(html).toContain('Workspace Agents')
    expect(html).toContain('Workspace agent')
    expect(html).toContain('New workspace agent')
  })

  it('renders Workspace Agents below the Agents section', () => {
    mockUseSettings.mockReturnValue({
      settings: {
        assistants: [
          {
            id: 'template-1',
            name: 'Assistant template',
            enableTools: false,
          },
        ],
        workspaceAgents: [
          {
            id: 'workspace-agent-1',
            name: 'Workspace agent',
            templateId: 'template-1',
            workspacePolicy: {
              workspaceRoot: 'D:/workspace',
              readAllowlist: [],
              readDenylist: [],
              writeDenylist: [],
            },
            shareTokens: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        mcp: {
          builtinCapabilityOptions: {},
          injectedToolOptions: {},
          servers: [],
          enableToolDisclosure: false,
        },
        skills: { disabledSkillIds: [] },
      },
      setSettings: jest.fn(),
    })

    const html = renderAgentSection()
    const agentsIndex = html.indexOf('>Agents</div>')
    const workspaceAgentsIndex = html.indexOf('>Workspace Agents</div>')

    expect(agentsIndex).toBeGreaterThanOrEqual(0)
    expect(workspaceAgentsIndex).toBeGreaterThan(agentsIndex)
  })

  it('uses translated labels for workspace agent capability counts', () => {
    mockUseSettings.mockReturnValue({
      settings: {
        assistants: [
          {
            id: 'template-1',
            name: 'Workspace template',
            enableTools: false,
          },
        ],
        workspaceAgents: [
          {
            id: 'workspace-agent-1',
            name: 'Workspace agent',
            templateId: 'template-1',
            workspacePolicy: {
              workspaceRoot: 'D:/workspace',
              readAllowlist: [],
              readDenylist: [],
              writeDenylist: [],
            },
            shareTokens: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ],
        mcp: {
          builtinCapabilityOptions: {},
          servers: [],
          enableToolDisclosure: false,
        },
        skills: { disabledSkillIds: [] },
      },
      setSettings: jest.fn(),
    })
    mockUseLanguage.mockReturnValue({
      t: (key: string, fallback: string) => {
        if (key === 'settings.agent.toolsCount')
          return 'translated tools {count}'
        if (key === 'settings.agent.skillsCount')
          return 'translated skills {count}'
        return fallback
      },
    })

    const html = renderAgentSection()

    expect(html).toContain('translated tools 0')
    expect(html).toContain('translated skills 0')
  })

  it('keeps internal memory operations out of the global settings rows', () => {
    mockGetLocalFileTools.mockReturnValue([
      { name: 'fs_read' },
      { name: 'fs_edit' },
      { name: 'fs_write' },
      { name: 'memory_add' },
      { name: 'memory_update' },
      { name: 'memory_delete' },
      { name: 'web_search' },
      { name: 'web_scrape' },
      { name: 'meta_search' },
      { name: 'project_ops' },
      { name: 'scheduled_task_ops' },
    ])

    const html = renderAgentSection()

    expect(html).not.toContain('Memory Toolset')
    expect(html).not.toContain('Add Memory')
    expect(html).not.toContain('Update Memory')
    expect(html).not.toContain('Delete Memory')
    // fs_edit_ops / web_ops synthetic rows still render.
    expect(html).toContain('File Editing Toolset')
    expect(html).toContain('Web Search Toolset')
    // Advertised tools still render by their own meta.
    expect(html).toContain('Read File')
    expect(html).toContain('Search Metadata')
  })

  it('does not render the retired fs_file_ops group row', () => {
    // fs_file_ops is a dead group: path operations moved to the bash tool and
    // the Manage tools modal does not show it either. Matching that surface,
    // the main Agent page must not fabricate a row for it.
    mockGetLocalFileTools.mockReturnValue([{ name: 'fs_read' }])

    const html = renderAgentSection()

    expect(html).not.toContain('Path Operation Toolset')
  })
})
