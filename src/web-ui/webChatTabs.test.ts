/**
 * @jest-environment jsdom
 */
/* eslint-disable @microsoft/sdl/no-inner-html -- 测试 DOM fixture 直接赋值 innerHTML 是 jest+jsdom 标准做法 */
import { Platform } from '../runtime/web/obsidianCompat'
import type { YoloRuntime } from '../runtime/yoloRuntime.types'

import { createObsidianWebShell } from './obsidianShellDom'
import { createChatTabManager } from './webChatTabs'

// useChatHistory 拖入宿主全栈（Anthropic SDK/数据库 store/plugin context），
// webChatTabs 只消费其中的纯函数 isUntitledConversationTitle——按真实语义 mock。
jest.mock('../hooks/useChatHistory', () => ({
  isUntitledConversationTitle: (title: string | null | undefined): boolean =>
    (title?.trim() ?? '').length === 0,
}))

// renderChatIntoTarget mounts React which requires a fully-wired runtime.
// Mock it globally so tab operations can be tested without React/providers.
const mockRenderChatIntoTarget = jest.fn((..._args: unknown[]) => ({
  root: { unmount: jest.fn() },
  unmount: jest.fn(),
}))
jest.mock('./webChatMount', () => ({
  renderChatIntoTarget: (...args: unknown[]) =>
    mockRenderChatIntoTarget(...args),
}))

// ── helpers ─────────────────────────────────────────────────────────────────

function makeRuntime(): YoloRuntime {
  const settingsListeners = new Set<(s: unknown) => void>()
  return {
    settings: {
      subscribe: (listener: (s: unknown) => void) => {
        settingsListeners.add(listener)
        return () => settingsListeners.delete(listener)
      },
      get: jest.fn(() => ({ assistants: [], currentAssistantId: '' })),
    },
  } as never
}

// ── setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>'
  document.body.classList.remove('is-mobile', 'is-phone', 'is-tablet')
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: query === '(min-width: 600px) and (min-height: 600px)',
      media: query,
      onchange: null,
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      addListener: jest.fn(),
      removeListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }),
  })
  ;(document as unknown as { fonts: FontFaceSet }).fonts = {
    load: jest.fn(),
  } as unknown as FontFaceSet
  Platform.isMobile = false
  Platform.isPhone = false
  Platform.isDesktop = true
})

afterEach(() => {
  Platform.isMobile = false
  Platform.isPhone = false
  Platform.isDesktop = true
})

// ── tests ─────────────────────────────────────────────────────────────────

describe('createChatTabManager', () => {
  it('creates one default tab on construction', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const runtime = makeRuntime()

    const manager = createChatTabManager(shell, runtime, {
      dialogContainer: root,
    })

    // Flush the async createTab() that fires in the constructor
    await new Promise((r) => setTimeout(r, 0))

    const tabs = shell.tabsInnerEl.querySelectorAll('.workspace-tab-header')
    expect(tabs.length).toBe(1)

    manager.destroy()
    shell.destroy()
  })

  it('createTab adds a second tab and makes it active', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const manager = createChatTabManager(shell, makeRuntime(), {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))

    await manager.createTab()

    const tabs = shell.tabsInnerEl.querySelectorAll('.workspace-tab-header')
    expect(tabs.length).toBe(2)
    // The newly created tab should be marked active
    const activeTabs = shell.tabsInnerEl.querySelectorAll(
      '.workspace-tab-header.is-active',
    )
    expect(activeTabs.length).toBe(1)

    manager.destroy()
    shell.destroy()
  })

  it('clicking a non-active tab header switches the active tab', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const manager = createChatTabManager(shell, makeRuntime(), {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))

    const tab1Header = shell.tabsInnerEl.querySelector<HTMLElement>(
      '.workspace-tab-header',
    )!

    // Create a second tab (becomes active)
    await manager.createTab()

    // Tab 1 is now inactive — click it
    expect(tab1Header.classList.contains('is-active')).toBe(false)
    tab1Header.click()

    expect(tab1Header.classList.contains('is-active')).toBe(true)

    manager.destroy()
    shell.destroy()
  })

  it('closeTab on the last remaining tab creates a new one before closing', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const manager = createChatTabManager(shell, makeRuntime(), {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))

    const firstTabHeader = shell.tabsInnerEl.querySelector<HTMLElement>(
      '.workspace-tab-header',
    )!
    const firstTabId = firstTabHeader.getAttribute('data-tab-id')!

    await manager.closeTab(firstTabId)

    // Should still have exactly one tab (the replacement)
    const remainingTabs = shell.tabsInnerEl.querySelectorAll(
      '.workspace-tab-header',
    )
    expect(remainingTabs.length).toBe(1)
    // The remaining tab must be a different (new) one
    expect(remainingTabs[0]?.getAttribute('data-tab-id')).not.toBe(firstTabId)

    manager.destroy()
    shell.destroy()
  })

  it('closing the active tab switches focus to an adjacent tab', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const manager = createChatTabManager(shell, makeRuntime(), {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))

    // Create a second tab (tab 2 is active)
    const entry2 = await manager.createTab()
    const tab2Id = entry2.id

    // Close the active tab (tab 2)
    await manager.closeTab(tab2Id)

    // Tab 1 should now be active
    const remainingHeaders = shell.tabsInnerEl.querySelectorAll(
      '.workspace-tab-header',
    )
    expect(remainingHeaders.length).toBe(1)
    expect(remainingHeaders[0]?.classList.contains('is-active')).toBe(true)

    manager.destroy()
    shell.destroy()
  })

  it('updateTabTitle changes the header text of the target tab', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const manager = createChatTabManager(shell, makeRuntime(), {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))

    const tabHeader = shell.tabsInnerEl.querySelector<HTMLElement>(
      '.workspace-tab-header',
    )!
    const tabId = tabHeader.getAttribute('data-tab-id')!

    manager.updateTabTitle(tabId, 'My New Chat Title')

    const titleEl = tabHeader.querySelector<HTMLElement>(
      '.workspace-tab-header-inner-title',
    )
    expect(titleEl?.textContent).toBe('My New Chat Title')

    manager.destroy()
    shell.destroy()
  })

  it('close button click closes the tab without bubbling to the header', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const manager = createChatTabManager(shell, makeRuntime(), {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))

    // Create a second tab so closing the first one doesn't trigger replacement
    await manager.createTab()

    const tab1Header = shell.tabsInnerEl.querySelector<HTMLElement>(
      '.workspace-tab-header',
    )!
    const tab1Id = tab1Header.getAttribute('data-tab-id')!
    const closeBtn = tab1Header.querySelector<HTMLElement>(
      '.workspace-tab-header-inner-close-button',
    )!

    // Click the close button on tab 1
    closeBtn.click()
    await new Promise((r) => setTimeout(r, 0))

    // Tab 1 should be gone
    const remainingIds = Array.from(
      shell.tabsInnerEl.querySelectorAll<HTMLElement>('.workspace-tab-header'),
    ).map((el) => el.getAttribute('data-tab-id'))
    expect(remainingIds).not.toContain(tab1Id)

    manager.destroy()
    shell.destroy()
  })

  it('destroy calls disposer for every tab and empties the container', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const manager = createChatTabManager(shell, makeRuntime(), {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))
    await manager.createTab()

    manager.destroy()

    expect(
      shell.tabsInnerEl.querySelectorAll('.workspace-tab-header').length,
    ).toBe(0)
    expect(
      shell.centerTabsContainerEl.querySelectorAll('.workspace-leaf').length,
    ).toBe(0)

    shell.destroy()
  })

  it('shell anchor elements remain connected after manager destroy and re-creation', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const runtime = makeRuntime()

    const managerA = createChatTabManager(shell, runtime, {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))
    managerA.destroy()

    const managerB = createChatTabManager(shell, runtime, {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))

    expect(shell.centerTabsContainerEl.isConnected).toBe(true)
    expect(shell.centerTopBarActionsEl.isConnected).toBe(true)

    managerB.destroy()
    shell.destroy()
  })

  it('destroy closes CLI event streams opened by the tab scope', async () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    const manager = createChatTabManager(shell, makeRuntime(), {
      dialogContainer: root,
    })
    await new Promise((r) => setTimeout(r, 0))

    const renderCall = mockRenderChatIntoTarget.mock.calls.at(-1)
    const renderOptions = renderCall?.[3] as
      | {
          getCliRuntimeScope?: () => Promise<{
            selectConversationRuntime: (runtimeId: string) => void
            dispose: () => Promise<void>
          }>
        }
      | undefined
    const getCliRuntimeScope = renderOptions?.getCliRuntimeScope
    const scope = await getCliRuntimeScope?.()
    expect(scope).toBeDefined()

    const instances: Array<{ url: string; close: jest.Mock }> = []
    class FakeEventSource {
      close = jest.fn()
      constructor(public readonly url: string) {
        instances.push(this)
      }
      addEventListener(): void {}
    }
    const originalEventSource = globalThis.EventSource
    globalThis.EventSource = FakeEventSource as unknown as typeof EventSource
    const originalFetch = globalThis.fetch
    globalThis.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch

    scope?.selectConversationRuntime('codex')
    await new Promise((r) => setTimeout(r, 0))

    expect(instances.length).toBeGreaterThan(0)

    manager.destroy()

    expect(instances[0]?.close).toHaveBeenCalled()
    globalThis.EventSource = originalEventSource
    globalThis.fetch = originalFetch
    shell.destroy()
  })
})
