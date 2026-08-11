/* eslint-disable no-restricted-globals -- web 运行时使用浏览器 localStorage/fetch（Obsidian 桌面端禁令不适用） */
/* eslint-disable obsidianmd/no-static-styles-assignment -- web 运行时 tab 显隐直接操作 style.display（桌面端 setCssProps 约定不适用） */
import type React from 'react'
import type { Root } from 'react-dom/client'

import type { ChatProps, ChatRef } from '../components/chat-view/Chat'
import { isUntitledConversationTitle } from '../hooks/useChatHistory'
import { createDiv } from '../runtime/web/obsidianDomCompat'
import { createWebCliRuntimeScope } from '../runtime/web/WebCliRuntimeScope'
import type { YoloRuntime } from '../runtime/yoloRuntime.types'

import type { ObsidianWebShell } from './obsidianShellDom'
import { renderChatIntoTarget } from './webChatMount'

export type ChatTabEntry = {
  id: string
  chatRef: React.RefObject<ChatRef>
  title: string
  hasConversationTitle: boolean
  tabHeaderEl: HTMLElement
  tabHeaderTitleEl: HTMLElement
  tabCloseButtonEl: HTMLElement
  leafEl: HTMLElement
  contentContainerEl: HTMLElement
  root: Root
  disposer: () => void
}

export type ChatTabManager = {
  createTab: () => Promise<ChatTabEntry>
  closeTab: (tabId: string) => Promise<void>
  openConversation: (conversationId: string) => Promise<void>
  updateTabTitle: (tabId: string, title: string) => void
  getActiveChatRef: () => ChatRef | null
  whenActiveChatReady: () => Promise<ChatRef>
  destroy: () => void
}

function createTabHeaderEl(
  tabId: string,
  title: string,
): {
  tabHeaderEl: HTMLElement
  titleEl: HTMLElement
  closeButtonEl: HTMLElement
} {
  const tabHeaderEl = document.createElement('div')
  tabHeaderEl.className = 'workspace-tab-header tappable'
  tabHeaderEl.draggable = true
  tabHeaderEl.setAttribute('data-tab-id', tabId)
  tabHeaderEl.setAttribute('data-type', 'yolo-chat')
  const tabHeaderInnerEl = createDiv(tabHeaderEl, 'workspace-tab-header-inner')
  createDiv(tabHeaderInnerEl, 'workspace-tab-header-inner-icon')
  const titleEl = createDiv(
    tabHeaderInnerEl,
    'workspace-tab-header-inner-title',
    (el) => el.setText(title),
  )
  createDiv(tabHeaderInnerEl, 'workspace-tab-header-status-container')
  const closeButtonEl = createDiv(
    tabHeaderInnerEl,
    'workspace-tab-header-inner-close-button',
  )
  closeButtonEl.setAttr('aria-label', 'Close tab')
  const closeSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  closeSvg.setAttribute('viewBox', '0 0 24 24')
  closeSvg.setAttribute('width', '16')
  closeSvg.setAttribute('height', '16')
  closeSvg.classList.add('svg-icon')
  const closePath = document.createElementNS(
    'http://www.w3.org/2000/svg',
    'path',
  )
  closePath.setAttribute('d', 'M18 6 6 18 M6 6l12 12')
  closePath.setAttribute('fill', 'none')
  closePath.setAttribute('stroke', 'currentColor')
  closePath.setAttribute('stroke-width', '2')
  closePath.setAttribute('stroke-linecap', 'round')
  closePath.setAttribute('stroke-linejoin', 'round')
  closeSvg.append(closePath)
  closeButtonEl.append(closeSvg)

  return { tabHeaderEl, titleEl, closeButtonEl }
}

function createTabContentEl(tabId: string): {
  leafEl: HTMLElement
  contentContainerEl: HTMLElement
} {
  const leafEl = document.createElement('div')
  leafEl.className = 'workspace-leaf'
  leafEl.setAttribute('data-tab-id', tabId)
  const leafContentEl = createDiv(leafEl, 'workspace-leaf-content')
  leafContentEl.setAttr('data-type', 'yolo-chat')
  // Obsidian's view hierarchy is leaf-content > view-content > view body.
  // Skipping view-content drops the standard padding/margin the chat expects.
  const contentContainerEl = createDiv(leafContentEl, 'view-content')
  return { leafEl, contentContainerEl }
}

async function waitForChatRef(entry: ChatTabEntry): Promise<ChatRef> {
  for (let i = 0; i < 20; i += 1) {
    if (entry.chatRef.current) return entry.chatRef.current

    await new Promise((resolve) => window.setTimeout(resolve, 0))
  }
  throw new Error('Chat tab ref did not become ready')
}

export function createChatTabManager(
  shell: ObsidianWebShell,
  runtime: YoloRuntime,
  options?: {
    dialogContainer?: HTMLElement | null
    /** Returns the current assistant display name from settings — same source
     * as AssistantSelector, so the tab title and the selector stay in sync. */
    getAssistantName?: () => string
    /** Returns whether the active workspace agent allows Agent mode. Resolved
     *  at render time so agent switches in the same session pick up new
     *  permissions without a tab remount. */
    getAgentModeAllowed?: () => boolean | null | undefined
    initialChatProps?: ChatProps
  },
): ChatTabManager {
  const tabs: ChatTabEntry[] = []
  let activeTabId: string | null = null
  let tabCounter = 0
  const dialogContainerEl =
    options?.dialogContainer ?? document.getElementById('app-root')
  const getAssistantName = options?.getAssistantName ?? (() => 'New chat')
  const getAgentModeAllowed = options?.getAgentModeAllowed ?? (() => null)

  const tabsInnerEl = shell.tabsInnerEl
  const tabsContainerEl = shell.centerTabsContainerEl

  // Clear the initial static tab header and leaf
  tabsInnerEl.empty()
  tabsContainerEl.empty()

  // When the user switches assistant via AssistantSelector, settings change.
  // Update every tab that hasn't loaded a real conversation title yet so its
  // header reflects the new assistant name.
  const unsubscribeSettings = runtime.settings.subscribe((next) => {
    const agents = (next as Record<string, unknown>).agents as
      | { id: string; name: string }[]
      | undefined
    const assistantName =
      agents?.find((a) => a.id === next.currentAssistantId)?.name ??
      getAssistantName()
    for (const entry of tabs) {
      if (entry.hasConversationTitle) continue
      entry.title = assistantName
      entry.tabHeaderTitleEl.setText(assistantName)
    }
  })

  // Wire up the "new tab" button
  shell.centerNewTabButtonEl.addEventListener('click', () => {
    void manager.createTab()
  })

  function switchToTab(tabId: string): void {
    const prevEntry = tabs.find((t) => t.id === activeTabId)
    const nextEntry = tabs.find((t) => t.id === tabId)
    if (!nextEntry) return

    if (prevEntry) {
      prevEntry.tabHeaderEl.removeClass('is-active')
      prevEntry.leafEl.removeClass('mod-active')
      prevEntry.leafEl.style.display = 'none'
    }

    nextEntry.tabHeaderEl.addClass('is-active')
    nextEntry.leafEl.addClass('mod-active')
    nextEntry.leafEl.style.display = ''
    activeTabId = tabId
  }

  async function closeTab(tabId: string): Promise<void> {
    const index = tabs.findIndex((t) => t.id === tabId)
    if (index < 0) return

    const entry = tabs[index]

    // If closing the last tab, create a new one first
    if (tabs.length === 1) {
      await manager.createTab()
    }

    // If closing the active tab, switch first
    if (activeTabId === tabId) {
      // Prefer the tab to the right, else the one to the left
      const nextIndex = index < tabs.length - 1 ? index + 1 : index - 1
      const nextEntry = tabs[nextIndex]
      if (nextEntry) {
        switchToTab(nextEntry.id)
      }
    }

    // Remove from array
    const idx = tabs.findIndex((t) => t.id === tabId)
    if (idx >= 0) {
      tabs.splice(idx, 1)
    }

    // Clean up
    entry.disposer()
    entry.tabHeaderEl.remove()
    entry.leafEl.remove()

    // If active tab was closed, ensure the new active tab is shown
    if (activeTabId && !tabs.some((t) => t.id === activeTabId)) {
      const remaining = tabs[tabs.length - 1]
      if (remaining) switchToTab(remaining.id)
    }
  }

  async function createTab(): Promise<ChatTabEntry> {
    const tabId = `chat-tab-${++tabCounter}`
    const title = getAssistantName()

    // Create tab header
    const header = createTabHeaderEl(tabId, title)
    tabsInnerEl.append(header.tabHeaderEl)

    // Create tab content leaf
    const content = createTabContentEl(tabId)
    content.leafEl.style.display = 'none'
    tabsContainerEl.append(content.leafEl)

    const chatRef: React.RefObject<ChatRef> = { current: null }
    let cliScope: ReturnType<typeof createWebCliRuntimeScope> | null = null
    let sessionId: string | null = null
    try {
      sessionId = localStorage.getItem('yolo-web-session-id')
    } catch {
      sessionId = null
    }
    // 当前会话 id（per-tab）：onConversationContextChange 跟踪，buildRuntime
    // 每次装配读它做会话绑定（Task 11 报告疑虑 1 的组装层约定——master Chat
    // 自持 currentConversationId，注入 effect 不监听它）。
    let currentConversationId: string | null = null
    const resolveCliScope = () => {
      cliScope ??= createWebCliRuntimeScope({
        baseUrl: window.location.origin,
        fetchImpl: (...args) => fetch(...args),
        sessionId,
      })
      return cliScope
    }
    // Chat 侧的 getCliRuntimeScope 契约是 Promise；buildRuntime 仍可用同步
    // 解析，避免每次组装都多一跳微任务。
    const getCliRuntimeScope = async () => resolveCliScope()
    // Task 11 契约签名 (runtime: YoloRuntime) => ChatRuntime：装配会话绑定的
    // web-native 契约 runtime（RemoteChatRuntimeAdapter 背书，'yolo' 主面）。
    // 函数身份由 webChatMount 的 ChatTabsMount memoize（每 tab 冻结）；会话
    // 级重绑定在服务端 /api/chat-runtime/* 落地后由组装层重建 tab 树实现
    // （Task 11 报告疑虑 2）。
    const buildRuntime = (
      _yoloRuntime: YoloRuntime,
    ): import('../core/chat-runtime/contract').ChatRuntime => {
      const scope = resolveCliScope()
      return scope.getChatRuntime('yolo', currentConversationId)
    }

    // Render the chat
    const { root, unmount } = renderChatIntoTarget(
      content.contentContainerEl,
      runtime,
      chatRef,
      {
        dialogContainer: dialogContainerEl,
        agentModeAllowed: getAgentModeAllowed(),
        initialChatProps: options?.initialChatProps,
        getCliRuntimeScope,
        buildRuntime,
        onConversationContextChange: (context) => {
          currentConversationId = context.currentConversationId ?? null
          const conversationTitle = context.currentConversationTitle
          // Keep the assistant name as the tab title until a real conversation
          // title exists — don't overwrite with the "New chat" fallback.
          if (
            !conversationTitle ||
            isUntitledConversationTitle(conversationTitle)
          ) {
            return
          }
          manager.updateTabTitle(tabId, conversationTitle.trim())
          const entry = tabs.find((t) => t.id === tabId)
          if (entry) entry.hasConversationTitle = true
        },
      },
    )

    const entry: ChatTabEntry = {
      id: tabId,
      chatRef,
      title,
      hasConversationTitle: false,
      tabHeaderEl: header.tabHeaderEl,
      tabHeaderTitleEl: header.titleEl,
      tabCloseButtonEl: header.closeButtonEl,
      leafEl: content.leafEl,
      contentContainerEl: content.contentContainerEl,
      root,
      disposer: () => {
        unmount()
        // Close any CLI EventSource streams the tab scope opened; otherwise
        // every closed tab keeps a live SSE connection to the web server.
        void cliScope?.dispose()
      },
    }

    tabs.push(entry)

    // Wire tab header events
    header.tabHeaderEl.addEventListener('click', () => switchToTab(tabId))
    header.closeButtonEl.addEventListener('click', (e) => {
      e.stopPropagation()
      void closeTab(tabId)
    })

    // Activate the new tab
    switchToTab(tabId)

    return entry
  }

  function updateTabTitle(tabId: string, title: string): void {
    const entry = tabs.find((t) => t.id === tabId)
    if (!entry) return
    entry.title = title
    entry.tabHeaderTitleEl.setText(title)
  }

  async function openConversation(conversationId: string): Promise<void> {
    const active = activeTabId ? tabs.find((t) => t.id === activeTabId) : null
    const entry = active ?? (await manager.createTab())
    switchToTab(entry.id)
    const ref = await waitForChatRef(entry)
    // 历史加载前强制刷新客户端 gateway 镜像：服务端 run 完成后才把助手回复
    // 持久化进 journal，客户端投影可能停留在发送时的旧快照（只有用户消息）。
    const gateway = runtime.getConversationGateway() as unknown as {
      forceRefreshConversation?: (conversationId: string) => Promise<void>
    }
    await gateway.forceRefreshConversation?.(conversationId)
    await ref.loadConversation(conversationId)
  }

  async function whenActiveChatReady(): Promise<ChatRef> {
    const entry = activeTabId ? tabs.find((t) => t.id === activeTabId) : null
    if (!entry) throw new Error('No active chat tab')
    return waitForChatRef(entry)
  }

  const manager: ChatTabManager = {
    createTab,
    closeTab,
    openConversation,
    updateTabTitle,
    getActiveChatRef: () => {
      const activeTab = tabs.find((t) => t.id === activeTabId)
      return activeTab?.chatRef.current ?? null
    },
    whenActiveChatReady,
    destroy: () => {
      unsubscribeSettings()
      for (const entry of [...tabs]) {
        entry.disposer()
      }
      tabs.length = 0
      activeTabId = null
      tabsInnerEl.empty()
      tabsContainerEl.empty()
    },
  }

  // Create the first default tab
  void manager.createTab()

  return manager
}
