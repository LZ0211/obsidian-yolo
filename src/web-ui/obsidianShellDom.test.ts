/**
 * @jest-environment jsdom
 */
/* eslint-disable @microsoft/sdl/no-inner-html -- 测试 DOM fixture 直接赋值 innerHTML 是 jest+jsdom 标准做法 */
/* eslint-disable @typescript-eslint/no-deprecated -- 断言 centerViewActionsEl 兼容字段（Task 7 迁移前该字段就是被测对象） */
import { Platform } from '../runtime/web/obsidianCompat'

import { createObsidianWebShell } from './obsidianShellDom'
import { createChatTabManager } from './webChatTabs'

// useChatHistory 拖入宿主全栈（Anthropic SDK/数据库 store/plugin context），
// webChatTabs 只消费其中的纯函数 isUntitledConversationTitle——按真实语义 mock。
jest.mock('../hooks/useChatHistory', () => ({
  isUntitledConversationTitle: (title: string | null | undefined): boolean =>
    (title?.trim() ?? '').length === 0,
}))

// createChatTabManager normally renders React via renderChatIntoTarget, which
// requires a fully-wired runtime. The tab-manager replacement regression test
// below uses a stub runtime, so mock the mount entrypoint to avoid touching
// React/providers. The other tests in this file don't use createChatTabManager
// or renderChatIntoTarget, so this mock is safe for the whole file.
jest.mock('./webChatMount', () => ({
  renderChatIntoTarget: () => ({
    root: { unmount: jest.fn() },
    unmount: jest.fn(),
  }),
}))

describe('createObsidianWebShell', () => {
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
    document.body.classList.remove('is-mobile', 'is-phone', 'is-tablet')
  })

  it('uses local fallback fonts without eager unavailable font requests', () => {
    const load = jest.fn()
    ;(document as unknown as { fonts: FontFaceSet }).fonts = {
      load,
    } as unknown as FontFaceSet

    const root = document.getElementById('root') as HTMLElement
    const shell = createObsidianWebShell(root)

    expect(load).not.toHaveBeenCalled()
    expect(
      document.body.style.getPropertyValue('--font-interface-override'),
    ).toBe('ui-sans-serif')
    expect(document.body.style.getPropertyValue('--font-text-override')).toBe(
      'ui-sans-serif',
    )
    expect(
      document.body.style.getPropertyValue('--font-monospace-override'),
    ).toBe('ui-monospace')

    shell.destroy()
  })

  it('uses Obsidian tab header icons instead of sidebar toggle icons', () => {
    const root = document.getElementById('root') as HTMLElement
    createObsidianWebShell(root)

    const newTabIcon = root.querySelector(
      '.workspace-tab-header-new-tab .clickable-icon svg',
    )
    const tabListIcon = root.querySelector(
      '.workspace-tab-header-tab-list .clickable-icon svg',
    )
    const sidebarToggleIcon = root.querySelector(
      '.sidebar-toggle-button .clickable-icon svg',
    )

    expect(newTabIcon).not.toBeNull()
    expect(tabListIcon).not.toBeNull()
    expect(sidebarToggleIcon).not.toBeNull()
    expect(newTabIcon?.classList.contains('sidebar-toggle-button-icon')).toBe(
      false,
    )
    expect(tabListIcon?.classList.contains('sidebar-toggle-button-icon')).toBe(
      false,
    )
    expect(
      sidebarToggleIcon?.classList.contains('sidebar-toggle-button-icon'),
    ).toBe(true)
  })

  it('adds sidebar-toggle-icon-inner only inside desktop sidebar toggle icons', () => {
    const root = document.getElementById('root') as HTMLElement
    createObsidianWebShell(root)

    expect(
      root.querySelectorAll('.sidebar-toggle-button .sidebar-toggle-icon-inner')
        .length,
    ).toBe(2)
    expect(
      root.querySelector(
        '.workspace-tab-header-new-tab .sidebar-toggle-icon-inner',
      ),
    ).toBeNull()
    expect(
      root.querySelector(
        '.workspace-tab-header-tab-list .sidebar-toggle-icon-inner',
      ),
    ).toBeNull()
  })

  it('debounces title fade updates from window resize events', () => {
    jest.useFakeTimers()
    try {
      const root = document.getElementById('root') as HTMLElement
      const shell = createObsidianWebShell(root)
      const titleContainer = root.querySelector(
        '.view-header-title-container',
      ) as HTMLElement
      const toggleClass = jest.spyOn(titleContainer, 'toggleClass')
      toggleClass.mockClear()

      window.dispatchEvent(new Event('resize'))
      window.dispatchEvent(new Event('resize'))

      expect(toggleClass).not.toHaveBeenCalled()
      jest.advanceTimersByTime(10)
      expect(toggleClass).toHaveBeenCalledTimes(2)

      shell.destroy()
    } finally {
      jest.useRealTimers()
    }
  })

  it('keeps center view actions attached to a visible tab header anchor', () => {
    const root = document.createElement('div')
    document.body.append(root)

    const shell = createObsidianWebShell(root)

    expect(shell.centerViewActionsEl.isConnected).toBe(true)
    const visibleViewHeader =
      shell.centerViewActionsEl.closest<HTMLElement>('.view-header')
    expect({
      attachedToTabHeader:
        shell.centerViewActionsEl.closest('.workspace-tab-header-container') !=
        null,
      hiddenInViewHeader: visibleViewHeader?.style.display === 'none',
    }).toEqual({
      attachedToTabHeader: true,
      hiddenInViewHeader: false,
    })

    shell.destroy()
  })

  it('removes shell-owned body classes and css variables on destroy', () => {
    const root = document.createElement('div')
    document.body.append(root)

    const shell = createObsidianWebShell(root)
    shell.destroy()

    expect(document.body.classList.contains('obsidian-app')).toBe(false)
    expect(document.body.classList.contains('show-ribbon')).toBe(false)
    expect(document.body.classList.contains('show-view-header')).toBe(false)
    expect(document.body.classList.contains('styled-scrollbars')).toBe(false)
    expect(document.body.classList.contains('is-mobile')).toBe(false)
    expect(document.body.classList.contains('is-tablet')).toBe(false)
    expect(document.body.classList.contains('is-phone')).toBe(false)
    expect(document.body.classList.contains('mod-toolbar-open')).toBe(false)
    expect(document.documentElement.style.getPropertyValue('font-size')).toBe(
      '',
    )
    expect(document.body.style.getPropertyValue('--font-text-size')).toBe('')
  })

  it('keeps shell anchors connected after tab-manager destroy and recreate', () => {
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)

    // createChatTabManager subscribes to settings on construction to track
    // the active assistant's name. Provide a minimal stub that satisfies
    // the contract without pulling in createWebYoloRuntime.
    const runtime = {
      settings: {
        subscribe: () => () => {},
        get: () => ({ assistants: [], currentAssistantId: '' }),
      },
    } as never
    const managerA = createChatTabManager(shell, runtime, {
      dialogContainer: root,
    })
    managerA.destroy()
    const managerB = createChatTabManager(shell, runtime, {
      dialogContainer: root,
    })

    expect(shell.centerTabsContainerEl.isConnected).toBe(true)
    expect(shell.centerTopBarActionsEl.isConnected).toBe(true)

    managerB.destroy()
    shell.destroy()
  })

  it('creates the mobile shell without throwing and skips the legacy navbar/toolbar mounts', () => {
    Platform.isMobile = true
    Platform.isPhone = true
    Platform.isDesktop = false

    const root = document.createElement('div')
    document.body.append(root)

    expect(() => createObsidianWebShell(root)).not.toThrow()
    // Superseded by the drawer-based mobile design — the ported
    // Obsidian-mobile navbar/toolbar skeleton is never mounted.
    expect(root.querySelector('.mobile-navbar-action-menu')).toBeNull()
    expect(root.querySelector('.mobile-toolbar')).toBeNull()
  })

  it('does not mount a mobile drawer or hamburger on desktop', () => {
    const root = document.getElementById('root') as HTMLElement
    const shell = createObsidianWebShell(root)

    expect(shell.mobileDrawer).toBeNull()
    expect(root.querySelector('.yolo-mobile-drawer')).toBeNull()
    expect(root.querySelector('.yolo-mobile-hamburger')).toBeNull()

    shell.destroy()
  })

  describe('mobile drawer', () => {
    beforeEach(() => {
      Platform.isMobile = true
      Platform.isPhone = true
      Platform.isDesktop = false
      document.body.classList.add('is-mobile')
    })

    it('mounts the drawer and hamburger on mobile', () => {
      const root = document.createElement('div')
      document.body.append(root)
      const shell = createObsidianWebShell(root)

      expect(shell.mobileDrawer).not.toBeNull()
      expect(root.querySelector('.yolo-mobile-drawer')).not.toBeNull()
      expect(root.querySelector('.yolo-mobile-drawer-backdrop')).not.toBeNull()
      expect(
        shell.appContainerEl.querySelector('.yolo-mobile-hamburger'),
      ).not.toBeNull()

      shell.destroy()
    })

    it('opens and closes the drawer via the hamburger button', () => {
      const root = document.createElement('div')
      document.body.append(root)
      const shell = createObsidianWebShell(root)
      const hamburger = shell.appContainerEl.querySelector<HTMLElement>(
        '.yolo-mobile-hamburger',
      )
      const drawerEl = shell.mobileDrawer?.drawerEl

      expect(drawerEl?.classList.contains('is-open')).toBe(false)
      hamburger?.click()
      expect(drawerEl?.classList.contains('is-open')).toBe(true)
      hamburger?.click()
      expect(drawerEl?.classList.contains('is-open')).toBe(false)

      shell.destroy()
    })

    it('closes the drawer when the backdrop is clicked', () => {
      const root = document.createElement('div')
      document.body.append(root)
      const shell = createObsidianWebShell(root)

      shell.mobileDrawer?.open()
      expect(shell.mobileDrawer?.drawerEl.classList.contains('is-open')).toBe(
        true,
      )
      shell.mobileDrawer?.backdropEl.click()
      expect(shell.mobileDrawer?.drawerEl.classList.contains('is-open')).toBe(
        false,
      )

      shell.destroy()
    })

    it('switchPanel toggles the active slot and ribbon icon', () => {
      const root = document.createElement('div')
      document.body.append(root)
      const shell = createObsidianWebShell(root)
      const drawer = shell.mobileDrawer
      expect(drawer).not.toBeNull()
      if (!drawer) return

      expect(drawer.slots.history.classList.contains('is-hidden')).toBe(false)
      expect(drawer.slots.preview.classList.contains('is-hidden')).toBe(true)

      drawer.switchPanel('preview')

      expect(drawer.slots.history.classList.contains('is-hidden')).toBe(true)
      expect(drawer.slots.preview.classList.contains('is-hidden')).toBe(false)
      const previewIcon = drawer.ribbonActionsEl.querySelector(
        '[data-panel="preview"]',
      )
      const filesIcon = drawer.ribbonActionsEl.querySelector(
        '[data-panel="files"]',
      )
      expect(previewIcon?.classList.contains('is-active')).toBe(true)
      expect(filesIcon?.classList.contains('is-active')).toBe(false)

      shell.destroy()
    })

    it('makes setLeftVisible/setRightVisible no-ops on mobile', () => {
      const root = document.createElement('div')
      document.body.append(root)
      const shell = createObsidianWebShell(root)

      expect(() => shell.setLeftVisible(false)).not.toThrow()
      expect(() => shell.setRightVisible(false)).not.toThrow()

      shell.destroy()
    })

    it('opens the drawer on a rightward swipe starting from the left half', () => {
      Object.defineProperty(window, 'innerWidth', {
        value: 400,
        configurable: true,
      })
      const root = document.createElement('div')
      document.body.append(root)
      const shell = createObsidianWebShell(root)
      const drawerEl = shell.mobileDrawer?.drawerEl

      dispatchTouch(shell.workspaceEl, 'touchstart', 50, 200)
      dispatchTouch(shell.workspaceEl, 'touchmove', 130, 200)

      expect(drawerEl?.classList.contains('is-open')).toBe(true)

      shell.destroy()
    })

    it('ignores a swipe starting from the right half of the screen', () => {
      Object.defineProperty(window, 'innerWidth', {
        value: 400,
        configurable: true,
      })
      const root = document.createElement('div')
      document.body.append(root)
      const shell = createObsidianWebShell(root)
      const drawerEl = shell.mobileDrawer?.drawerEl

      dispatchTouch(shell.workspaceEl, 'touchstart', 350, 200)
      dispatchTouch(shell.workspaceEl, 'touchmove', 100, 200)

      expect(drawerEl?.classList.contains('is-open')).toBe(false)

      shell.destroy()
    })

    it('ignores a mostly-vertical drag (scroll) from the left half', () => {
      Object.defineProperty(window, 'innerWidth', {
        value: 400,
        configurable: true,
      })
      const root = document.createElement('div')
      document.body.append(root)
      const shell = createObsidianWebShell(root)
      const drawerEl = shell.mobileDrawer?.drawerEl

      dispatchTouch(shell.workspaceEl, 'touchstart', 50, 200)
      dispatchTouch(shell.workspaceEl, 'touchmove', 80, 320)

      expect(drawerEl?.classList.contains('is-open')).toBe(false)

      shell.destroy()
    })

    it('allows the swipe gesture to reopen the drawer after a backdrop-tap close', () => {
      Object.defineProperty(window, 'innerWidth', {
        value: 400,
        configurable: true,
      })
      const root = document.createElement('div')
      document.body.append(root)
      const shell = createObsidianWebShell(root)
      const drawerEl = shell.mobileDrawer?.drawerEl

      shell.mobileDrawer?.open()
      expect(drawerEl?.classList.contains('is-open')).toBe(true)
      shell.mobileDrawer?.backdropEl.click()
      expect(drawerEl?.classList.contains('is-open')).toBe(false)

      dispatchTouch(shell.workspaceEl, 'touchstart', 50, 200)
      dispatchTouch(shell.workspaceEl, 'touchmove', 130, 200)

      expect(drawerEl?.classList.contains('is-open')).toBe(true)

      shell.destroy()
    })
  })
})

function dispatchTouch(
  target: HTMLElement,
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  clientX: number,
  clientY: number,
): void {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'touches', {
    value: [{ clientX, clientY }],
    configurable: true,
  })
  target.dispatchEvent(event)
}

describe('Platform.isMobile body class', () => {
  it('applies body.is-mobile for a narrow viewport even when Platform.isMobile is false', () => {
    // 390px 视口（手机宽或窄窗）必须切换到移动抽屉布局：桌面固定侧栏会把
    // 主聊天挤成残废且没有任何可发现的恢复入口。
    Object.defineProperty(window, 'innerWidth', {
      value: 390,
      configurable: true,
    })
    Platform.isMobile = false
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    expect(document.body.classList.contains('is-mobile')).toBe(true)
    // 测试环境的 matchMedia mock 恒判定 tablet（600x600+），此处断言移动
    // 布局已启用即可；phone/tablet 细分由媒体查询决定。
    expect(
      document.body.classList.contains('is-phone') ||
        document.body.classList.contains('is-tablet'),
    ).toBe(true)
    shell.destroy()
    root.remove()
    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      configurable: true,
    })
    document.body.classList.remove('is-mobile', 'is-phone', 'is-tablet')
  })

  it('keeps the desktop layout for a wide viewport without a mobile UA', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1440,
      configurable: true,
    })
    Platform.isMobile = false
    const root = document.createElement('div')
    document.body.append(root)
    const shell = createObsidianWebShell(root)
    expect(document.body.classList.contains('is-mobile')).toBe(false)
    shell.destroy()
    root.remove()
  })

  it('labels the desktop sidebar toggle for discoverability', () => {
    Object.defineProperty(window, 'innerWidth', {
      value: 1440,
      configurable: true,
    })
    Platform.isMobile = false
    const root = document.createElement('div')
    document.body.append(root)
    createObsidianWebShell(root)
    const toggles = root.querySelectorAll<HTMLElement>('.sidebar-toggle-button')
    expect(toggles.length).toBeGreaterThan(0)
    for (const toggle of toggles) {
      expect(toggle.getAttribute('aria-label')).toBe('Toggle sidebar')
    }
    root.remove()
  })
})
