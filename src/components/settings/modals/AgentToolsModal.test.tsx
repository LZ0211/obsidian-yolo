/** @jest-environment jsdom */

import type { App } from 'obsidian'
import { act } from 'react'
import type { ComponentType, ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

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
    settings: { mcp: { builtinToolOptions: {} } },
    setSettings: jest.fn(),
  }),
}))

jest.mock('../../common/ObsidianToggle', () => ({
  ObsidianToggle: () => null,
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
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })

  it('keeps the switch column beside the description column', () => {
    const plugin = {
      settings: { mcp: { builtinToolOptions: {} } },
      t: (key: string, fallback?: string) => fallback ?? key,
      setSettings: jest.fn(),
      addSettingsChangeListener: jest.fn(),
    }
    const modal = new AgentToolsModal(
      {} as App,
      plugin as never,
    ) as unknown as CapturedModal

    act(() => {
      root.render(
        <modal.Component {...modal.props} onClose={() => undefined} />,
      )
    })

    const header = container.querySelector('.yolo-builtin-tools-table-header')
    const row = container.querySelector('.yolo-builtin-tools-table-row')
    expect(header?.children).toHaveLength(4)
    expect(row?.children).toHaveLength(4)
    expect(
      row?.children[1].querySelector('.yolo-mcp-tool-description'),
    ).not.toBeNull()
  })
})
