/** @jest-environment jsdom */

import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import { yoloSettingsSchema } from '../../../settings/schema/setting.types'
import type { Assistant } from '../../../types/assistant.types'

const mockUseSettings = jest.fn()
const mockSkillEntries: never[] = []
const mockPlugin = {
  app: {},
  getMcpManager: jest.fn(async () => ({
    listAvailableTools: jest.fn(async () => []),
  })),
  getWorkspaceAgentRootHash: jest.fn(() => null),
}

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
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}))

jest.mock('../../../contexts/plugin-context', () => ({
  usePlugin: () => mockPlugin,
}))

jest.mock('../../../hooks/useLiteSkillEntries', () => ({
  useLiteSkillEntries: () => mockSkillEntries,
}))

jest.mock('../../common/ObsidianButton', () => ({
  ObsidianButton: ({ text }: { text?: string }) => <button>{text}</button>,
}))
jest.mock('../../common/ObsidianSetting', () => ({
  ObsidianSetting: ({
    name,
    desc,
    children,
  }: {
    name?: string
    desc?: string
    children?: React.ReactNode
  }) => (
    <section>
      {name}
      {desc}
      {children}
    </section>
  ),
}))
jest.mock('../../common/ObsidianTextArea', () => ({
  ObsidianTextArea: () => null,
}))
jest.mock('../../common/ObsidianTextInput', () => ({
  ObsidianTextInput: () => null,
}))
jest.mock('../../common/ObsidianToggle', () => ({
  ObsidianToggle: () => null,
}))
jest.mock('../../common/SimpleSelect', () => ({ SimpleSelect: () => null }))
jest.mock('../../modals/ConfirmModal', () => ({ ConfirmModal: class {} }))
jest.mock('./AgentWorkspaceScopeEditor', () => ({
  AgentWorkspaceScopeEditor: () => null,
}))
jest.mock('./TemplateWorkspaceScopeEditor', () => ({
  AgentWorkspaceScopeEditor: () => null,
}))

import { AgentsSectionContent } from './AgentsSectionContent'

const template: Assistant = {
  id: 'assistant-1',
  name: 'Template',
  systemPrompt: '',
  enableTools: true,
  includeBuiltinTools: true,
  enabledToolNames: [],
  toolPreferences: {},
  toolServerPreferences: {},
  enabledSkills: [],
  skillPreferences: {},
  workspaceScope: { enabled: true, include: [], exclude: [] },
  createdAt: 1,
  updatedAt: 1,
}

const renderEditor = async (workspaceAgent: boolean): Promise<string> => {
  const settings = yoloSettingsSchema.parse({
    assistants: [template],
    workspaceAgents: workspaceAgent
      ? [
          {
            id: 'workspace-agent-1',
            name: 'Workspace agent',
            templateId: template.id,
            workspacePolicy: {
              workspaceRoot: '/',
              readAllowlist: [],
              readDenylist: [],
              writeDenylist: [],
            },
            shareTokens: [],
            createdAt: 1,
            updatedAt: 1,
          },
        ]
      : [],
  })
  mockUseSettings.mockReturnValue({ settings, setSettings: jest.fn() })

  const container = document.createElement('div')
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <AgentsSectionContent
        app={{} as never}
        onClose={() => undefined}
        {...(workspaceAgent
          ? { workspaceAgentId: 'workspace-agent-1' }
          : { initialAssistantId: template.id })}
      />,
    )
  })
  const text = container.textContent ?? ''
  act(() => root.unmount())
  return text
}

describe('AgentsSectionContent workspace agent tabs', () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    })
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })

  it('shows token management for workspace agents', async () => {
    await expect(renderEditor(true)).resolves.toContain('Tokens')
  })

  it('does not show token management for assistant templates', async () => {
    await expect(renderEditor(false)).resolves.not.toContain('Tokens')
  })
})
