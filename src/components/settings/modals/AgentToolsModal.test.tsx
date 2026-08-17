/** @jest-environment jsdom */

import type { App } from 'obsidian'
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import {
  getInstalledInjectionBridge,
  installYoloInjectionBridge,
  uninstallYoloInjectionBridge,
} from '../../../core/mcp/injectionBridge'
import type { McpTool } from '../../../types/mcp.types'

const mockListAvailableTools = jest.fn(async (): Promise<McpTool[]> => [])
const mockSetSettings = jest.fn()
const mockSettings = {
  mcp: {
    builtinCapabilityOptions: {},
    injectedToolOptions: {} as Record<string, { disabled?: boolean }>,
  },
}
let mockToolCatalogListener: (() => void) | undefined
const mockUnsubscribeToolCatalog = jest.fn()
const mockSubscribeToolCatalog = jest.fn((listener: () => void) => {
  mockToolCatalogListener = listener
  return () => {
    mockToolCatalogListener = undefined
    mockUnsubscribeToolCatalog()
  }
})
const mockGetMcpManager = jest.fn(async () => ({
  listAvailableTools: mockListAvailableTools,
  subscribeToolCatalog: mockSubscribeToolCatalog,
}))

jest.mock('../../../main', () => ({
  __esModule: true,
  default: class YoloPlugin {},
}))

jest.mock('../../common/ReactModal', () => ({
  ReactModal: class {
    Component: unknown
    props: unknown
    modalEl = { classList: { add: jest.fn() } }

    constructor({ Component, props }: { Component: unknown; props: unknown }) {
      this.Component = Component
      this.props = props
    }
  },
}))

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

jest.mock('../../../contexts/settings-context', () => ({
  SettingsProvider: ({ children }: { children: ReactNode }) => children,
  useSettings: () => ({
    settings: mockSettings,
    setSettings: mockSetSettings,
  }),
}))

jest.mock('../../common/ObsidianToggle', () => ({
  ObsidianToggle: ({
    value,
    onChange,
  }: {
    value: boolean
    onChange: (value: boolean) => void
  }) => (
    <button
      type="button"
      data-testid="tool-toggle"
      data-value={String(value)}
      onClick={() => onChange(!value)}
    />
  ),
}))

jest.mock('../common/CollapsibleToolDescription', () => ({
  CollapsibleToolDescription: ({ description }: { description: string }) => (
    <div className="yolo-mcp-tool-description">{description}</div>
  ),
}))

jest.mock('../sections/McpSection', () => ({
  McpSection: () => null,
}))

jest.mock('./JsSandboxConfigModal', () => ({
  JsSandboxConfigModal: class {},
}))

jest.mock('./SubagentConfigModal', () => ({
  SubagentConfigModal: class {},
}))

jest.mock('./TerminalCommandConfigModal', () => ({
  TerminalCommandConfigModal: class {},
}))

jest.mock('./WebSearchSettingsModal', () => ({
  WebSearchSettingsModal: class {},
}))

import { AgentToolsModal } from './AgentToolsModal'

type CapturedModal = {
  Component: ComponentType<{ app: App; plugin: unknown; onClose: () => void }>
  props: { app: App; plugin: unknown }
}

describe('AgentToolsModal layout', () => {
  let container: HTMLDivElement
  let root: Root
  let rootUnmounted = false

  beforeAll(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    })
  })

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    rootUnmounted = false
    mockListAvailableTools.mockReset()
    mockListAvailableTools.mockResolvedValue([])
    mockSubscribeToolCatalog.mockClear()
    mockUnsubscribeToolCatalog.mockClear()
    mockGetMcpManager.mockClear()
    mockToolCatalogListener = undefined
    mockSetSettings.mockReset()
    mockSettings.mcp.injectedToolOptions = {}
  })

  afterEach(() => {
    if (!rootUnmounted) {
      act(() => root.unmount())
    }
    container.remove()
    uninstallYoloInjectionBridge()
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })

  it('keeps the switch column beside the description column', async () => {
    const plugin = {
      settings: { mcp: { builtinCapabilityOptions: {} } },
      t: (key: string, fallback?: string) => fallback ?? key,
      setSettings: jest.fn(),
      addSettingsChangeListener: jest.fn(),
      getMcpManager: mockGetMcpManager,
    }
    const modal = new AgentToolsModal(
      {} as App,
      plugin as never,
    ) as unknown as CapturedModal

    await act(async () => {
      root.render(
        <modal.Component {...modal.props} onClose={() => undefined} />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    const header = container.querySelector('.yolo-builtin-tools-table-header')
    const row = container.querySelector('.yolo-builtin-tools-table-row')
    expect(header?.children).toHaveLength(4)
    expect(row?.children).toHaveLength(4)
    expect(
      row?.children[1].querySelector('.yolo-mcp-tool-description'),
    ).not.toBeNull()
  })

  it('does not list internal memory mutation tools', async () => {
    const plugin = {
      settings: { mcp: { builtinCapabilityOptions: {} } },
      t: (key: string, fallback?: string) => fallback ?? key,
      setSettings: jest.fn(),
      addSettingsChangeListener: jest.fn(),
      getMcpManager: mockGetMcpManager,
    }
    const modal = new AgentToolsModal(
      {} as App,
      plugin as never,
    ) as unknown as CapturedModal

    await act(async () => {
      root.render(
        <modal.Component {...modal.props} onClose={() => undefined} />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(container.textContent).not.toContain('Memory Toolset')
    expect(container.textContent).not.toContain('Send Attachment')
  })

  it('subscribes to and displays live yolo_bridge tools by plugin group', async () => {
    const uninstall = installYoloInjectionBridge()
    getInstalledInjectionBridge()?.registerTool(
      {
        name: 'plugin_tool',
        description: 'Plugin tool description',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => 'ok',
      'external-plugin',
      'External plugin tools',
    )
    mockListAvailableTools.mockResolvedValue([
      {
        name: 'yolo_bridge__plugin_tool',
        description: 'Plugin tool description',
        inputSchema: { type: 'object', properties: {} },
      },
    ])

    const plugin = {
      settings: { mcp: { builtinCapabilityOptions: {} } },
      t: (key: string, fallback?: string) => fallback ?? key,
      setSettings: jest.fn(),
      addSettingsChangeListener: jest.fn(),
      getMcpManager: mockGetMcpManager,
    }
    const modal = new AgentToolsModal(
      {} as App,
      plugin as never,
    ) as unknown as CapturedModal

    await act(async () => {
      root.render(
        <modal.Component {...modal.props} onClose={() => undefined} />,
      )
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(mockListAvailableTools).toHaveBeenCalledWith({
      includeBuiltinTools: true,
      includeDisabledInjectedTools: true,
    })
    expect(mockSubscribeToolCatalog).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('External plugin tools')
    expect(container.textContent).toContain('plugin_tool')
    expect(container.textContent).toContain('Plugin tool description')

    const injectedRow = Array.from(
      container.querySelectorAll('.yolo-builtin-tools-table-row'),
    ).find((candidate) => candidate.textContent?.includes('plugin_tool'))
    const toggle = injectedRow?.querySelector<HTMLButtonElement>(
      '[data-testid="tool-toggle"]',
    )
    expect(toggle?.dataset.value).toBe('true')

    await act(async () => {
      toggle?.click()
      await Promise.resolve()
    })
    expect(mockSetSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        mcp: expect.objectContaining({
          injectedToolOptions: {
            plugin_tool: { disabled: true },
          },
        }),
      }),
    )

    act(() => {
      root.unmount()
      rootUnmounted = true
    })
    expect(mockToolCatalogListener).toBeUndefined()
    expect(mockUnsubscribeToolCatalog).toHaveBeenCalledTimes(1)
    uninstall()
  })
})
