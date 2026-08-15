/* eslint-disable no-alert -- web 运行时使用浏览器原生 prompt/confirm（Obsidian 桌面端 Modal 约定不适用） */
import {
  WebApiClient,
  type WebBootstrapPayload,
  createWebYoloRuntime,
} from '../runtime/web-entry'
import type { YoloRuntime } from '../runtime/yoloRuntime.types'

import { createObsidianFileTree } from './obsidianFileTreeDom'
import { createObsidianPreviewPane } from './obsidianPreviewDom'
import {
  type ObsidianWebShell,
  createObsidianWebShell,
} from './obsidianShellDom'
import { renderLightweightModalView } from './webAuthModal'
import { createChatTabManager } from './webChatTabs'
import { renderHistoryPane } from './webHistoryPane'
import { createMockTransport } from './webMockTransport'
import type {
  HistoryClient,
  LeftPaneMode,
  ReadyShellState,
  ShellState,
} from './webShellTypes'
import { classifyPreviewKind, normalizeVaultPath } from './webWorkspaceUtils'

function isMockBootstrap(bootstrap: WebBootstrapPayload): boolean {
  return bootstrap.pluginInfo?.version === 'mock'
}

/** Read the current assistant display name from runtime settings — the same
 * source AssistantSelector uses — so the tab title and the selector never
 * diverge. */
function makeAssistantNameGetter(runtime: YoloRuntime): () => string {
  return () => {
    const settings = runtime.settings.get()
    const agents = runtime.getAgents()
    const current =
      agents.find((a) => a.id === settings.currentAssistantId)?.name ??
      agents[0]?.name ??
      '新会话'
    return current
  }
}

/** Build a HistoryClient backed by runtime.chat.* and emit a window event after
 * each metadata mutation so the chat header's ChatListDropdown stays in sync
 * with the sidebar history pane. */
function buildHistoryClient(runtime: YoloRuntime): HistoryClient {
  const emitUpdated = () =>
    window.dispatchEvent(new CustomEvent('yolo:chat-history-updated'))
  return {
    listChats: () => runtime.chat.list(),
    togglePinnedChat: async (id) => {
      await runtime.chat.togglePinned(id)
      emitUpdated()
    },
    updateChatTitle: async (id, title) => {
      await runtime.chat.updateTitle(id, title)
      emitUpdated()
    },
    retryChatTitle: async (id) => {
      const conversation = await runtime.chat.get(id)
      if (!conversation) return
      await runtime.chat.generateTitle(id, conversation.messages, {
        force: true,
      })
      emitUpdated()
    },
  }
}

// ReadyController separates shell-owned state (preserved across agent switch)
// from runtime-owned state (rebuilt on agent switch).
//
// Preserved across agent switch:
// - shell DOM (ObsidianWebShell)
// - file tree instance and expanded state (fileMgr)
// - preview pane instance and current preview target (previewPane)
// - leftPaneMode and history visibility state
//
// Rebuilt across agent switch:
// - tabManager (and the runtime-backed chat React trees it owns)
// - center topbar title
// - nothing else unless a shell-owned invariant actually changed
type ReadyController = {
  shell: ObsidianWebShell
  fileMgr: ReturnType<typeof createObsidianFileTree> | null
  previewPane: ReturnType<typeof createObsidianPreviewPane>
  tabManager: ReturnType<typeof createChatTabManager> | null
  leftPaneMode: LeftPaneMode
  replaceRuntime: (next: ReadyShellState) => Promise<void>
  destroy: () => void
}

// Resolve the active workspace agent's capability flags from the current
// shell state. Returns null when state is not ready or when the active agent
// isn't found in `allowedAgents` (e.g. agent switch in flight). Capability
// fields default to undefined when the bootstrap didn't include them, which
// the chat side treats as "allowed" — same as desktop Obsidian.
function resolveAgentModeAllowed(
  state: ShellState,
): boolean | null | undefined {
  if (state.status !== 'ready') return null
  const ready = state
  const match = ready.allowedAgents.find((a) => a.id === ready.agentId)
  return match?.agentModeAllowed
}

function App(): void {
  // Restore the persisted theme as early as possible so users don't see a
  // dark-light flash on reload. The ribbon button below writes the choice.
  try {
    const saved = window.localStorage?.getItem('yolo-web-theme')
    if (saved === 'light') {
      document.body.classList.remove('theme-dark')
      document.body.classList.add('theme-light')
    } else if (saved === 'dark') {
      document.body.classList.remove('theme-light')
      document.body.classList.add('theme-dark')
    }
  } catch {
    // localStorage may be unavailable; fall through to the default 'theme-dark'
    // class baked into index.html.
  }

  let state: ShellState = { status: 'loading' }
  const rootEl = document.getElementById('app-root')!
  let currentShellDisposer: (() => void) | null = null
  let currentReadyController: ReadyController | null = null
  rootEl.empty()

  const searchParams = new URLSearchParams(window.location.search)
  // NOTE: backup 的 ?virtuosoHarness=1 调试入口（virtuosoHarness.tsx）不接线——
  // 它依赖 backup 独有的 ChatTimelineVirtuoso（react-virtuoso 时间线实现），
  // master 的时间线是 ChatTimelineList；文件保留在仓库但不进生产构建。
  const preferMock = searchParams.get('mock') === '1'
  const mockTimelineTurnsRaw = searchParams.get('timelineTurns') ?? '0'
  const mockTimelineTurnsParsed = /^\d+$/.test(mockTimelineTurnsRaw)
    ? Number.parseInt(mockTimelineTurnsRaw, 10)
    : 0
  const mockTimelineTurns = preferMock
    ? Math.max(0, Math.min(500, mockTimelineTurnsParsed))
    : undefined
  // ?home=Notes/Project or ?home=Notes%2FProject. The mock transport doesn't
  // carry workspaceAccessPolicy itself, so the demo's home is sourced from
  // the URL. Real bootstrap (non-mock) gets workspaceRoot from the backend.
  const mockHomeOverride = (searchParams.get('home') ?? '').trim()

  function resolveWorkspaceRoot(
    bootstrap: WebBootstrapPayload,
    mock: boolean,
  ): string {
    if (mock && mockHomeOverride) return mockHomeOverride
    return bootstrap.workspaceRoot ?? ''
  }
  const realClient = new WebApiClient({ baseUrl: window.location.origin })
  // ?home=... has to flow into BOTH the bootstrap (so the file tree reads it
  // via ReadyShellState) AND the mock settings's assistant.workspaceAccessPolicy
  // (so the mention picker / useWorkspaceRoot pick it up from the same source
  // the Obsidian-side runtime uses).
  const mockTransport = createMockTransport({
    workspaceRoot: mockHomeOverride,
    timelineTurns: mockTimelineTurns,
  })

  void loadShellState()

  async function loadShellState(): Promise<void> {
    if (preferMock) {
      await loadMockShellState()
      return
    }

    try {
      const bootstrap = await realClient.getBootstrap()
      if (!bootstrap.workspaceAgentConfigured) {
        setState({ status: 'setup', client: realClient, mock: false })
        return
      }

      const authState = await realClient.getWebAuthState()
      if (!authState?.session) {
        setState({
          status: 'login',
          client: realClient,
          loginError: null,
          loggingIn: false,
          mock: false,
        })
        return
      }

      const mockShell = isMockBootstrap(bootstrap)
      const runtime = await createRuntime(realClient, bootstrap)
      setState({
        status: 'ready',
        client: realClient,
        historyClient: buildHistoryClient(runtime),
        runtime,
        allowedAgents: authState.allowedAgents ?? bootstrap.allowedAgents ?? [],
        agentId: authState.session.agentId,
        mock: mockShell,
        workspaceRoot: resolveWorkspaceRoot(bootstrap, mockShell),
      })
      if (preferMock) {
        await loadMockShellState()
        return
      }
    } catch (error) {
      setState({
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  async function loadMockShellState(): Promise<void> {
    const bootstrap = await mockTransport.client.getBootstrap()
    if (!bootstrap.workspaceAgentConfigured) {
      setState({ status: 'setup', client: mockTransport.client, mock: true })
      return
    }

    const authState = await mockTransport.client.getWebAuthState()
    if (!authState?.session) {
      setState({
        status: 'login',
        client: mockTransport.client,
        loginError: null,
        loggingIn: false,
        mock: true,
      })
      return
    }

    const runtime = await createRuntime(
      mockTransport.client as WebApiClient,
      bootstrap,
    )

    setState({
      status: 'ready',
      client: mockTransport.client,
      historyClient: buildHistoryClient(runtime),
      runtime,
      allowedAgents: authState.allowedAgents ?? bootstrap.allowedAgents ?? [],
      agentId: authState.session.agentId,
      mock: true,
      workspaceRoot: resolveWorkspaceRoot(bootstrap, true),
    })
  }

  async function createRuntime(
    c: WebApiClient,
    bootstrap: WebBootstrapPayload,
  ): Promise<YoloRuntime> {
    const [settings, agents] = await Promise.all([
      c.getSettings(),
      c.getAgents(),
    ])
    const runtime = createWebYoloRuntime({
      api: c,
      bootstrap,
      initialSettings: settings as never,
      initialAgents: agents,
      initialVaultIndex: [],
    })
    // Populate `app.vault.getFiles()` so @-mention and other vault-aware
    // surfaces see the full file list. Errors are non-fatal — the chat still
    // works without the index, just with an empty @-mention list.
    void runtime.vault.listIndex?.().catch((err) => {
      console.warn('Failed to load vault index for @-mention', err)
    })
    return runtime
  }

  function setState(next: ShellState): void {
    const previous = state
    state = next

    // Fast path: ready -> ready with the same client means only the runtime
    // (and runtime-owned subtrees) changed. Preserve the shell DOM, file tree,
    // preview pane, and left-pane state by delegating to the ready controller.
    if (
      previous.status === 'ready' &&
      next.status === 'ready' &&
      currentReadyController &&
      previous.client === next.client
    ) {
      void currentReadyController.replaceRuntime(next)
      return
    }

    currentShellDisposer?.()
    currentShellDisposer = null
    currentReadyController = null
    rootEl.empty()

    try {
      if (state.status === 'loading') renderLoading()
      else if (state.status === 'setup') renderSetup()
      else if (state.status === 'login') renderLogin()
      else if (state.status === 'ready') renderShell()
      else renderError()
    } catch (error) {
      state = {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      }
      rootEl.empty()
      renderError()
    }
  }

  function renderLoading(): void {
    const main = document.createElement('main')
    main.className = 'yolo-web-shell'
    main.textContent = '正在加载 Smart RAG…'
    rootEl.append(main)
  }

  function renderSetup(): void {
    currentShellDisposer = renderLightweightModalView(rootEl, {
      title: '尚未配置远程访问',
      description:
        '当前没有配置可用的工作区智能体。请在 Obsidian 桌面端的插件设置中创建工作区智能体并生成访问令牌。',
    })
  }

  function renderError(): void {
    currentShellDisposer = renderLightweightModalView(rootEl, {
      title: 'Web 运行时错误',
      description: (state as Extract<ShellState, { status: 'error' }>).message,
    })
  }

  function renderLogin(): void {
    const loginState = state as Extract<ShellState, { status: 'login' }>
    currentShellDisposer = renderLightweightModalView(rootEl, {
      title: '登录智能体',
      description: '请输入你的智能体访问令牌。',
      submitLabel: loginState.loggingIn ? '登录中…' : '登录',
      error: loginState.loginError,
      loading: loginState.loggingIn,
      password: true,
      onSubmit: async (value) => {
        const token = value.trim()
        if (!token) return

        setState({ ...loginState, loginError: null, loggingIn: true })

        try {
          const auth = await loginState.client.loginWithShareToken(token)
          const bootstrap = await loginState.client.getBootstrap()
          const mockShell = loginState.mock || isMockBootstrap(bootstrap)
          const runtime = await createRuntime(
            loginState.client as WebApiClient,
            bootstrap,
          )

          setState({
            status: 'ready',
            client: loginState.client,
            historyClient: buildHistoryClient(runtime),
            runtime,
            allowedAgents: auth.allowedAgents ?? bootstrap.allowedAgents ?? [],
            agentId: auth.session.agentId,
            mock: mockShell,
            workspaceRoot: resolveWorkspaceRoot(bootstrap, mockShell),
          })
        } catch (err) {
          setState({
            ...loginState,
            loginError: err instanceof Error ? err.message : '登录失败。',
            loggingIn: false,
          })
        }
      },
    })
  }

  function renderShell(): void {
    const readyState = state as ReadyShellState
    const shell = createObsidianWebShell(rootEl)
    const disposers: Array<() => void> = [() => shell.destroy()]

    // Runtime disposer is mutable so replaceRuntime can dispose the previous
    // runtime while keeping shell destroy wired to the current runtime.
    let disposeRuntime: () => void = () => {
      ;(
        readyState.runtime as unknown as { __yoloDispose?: () => void }
      ).__yoloDispose?.()
    }
    disposers.push(() => disposeRuntime())

    let tabManager: ReturnType<typeof createChatTabManager>
    const openConversation = async (conversationId: string): Promise<void> => {
      if (!tabManager) throw new Error('Chat tabs are not initialized')
      await tabManager.openConversation(conversationId)
    }
    let leftPaneMode: LeftPaneMode = 'history'
    let fileMgr: ReturnType<typeof createObsidianFileTree> | null = null
    let filesPaneInitialized = false
    let historyRefreshToken = 0
    let historyRendering = false

    // On mobile, files/preview/history each get their own persistent drawer
    // slot instead of sharing shell.leftLeafContentEl/rightContentEl — see
    // docs/superpowers/plans/2026-06-30-mobile-web-layout.md (PR2).
    const filesHost = shell.mobileDrawer?.slots.files ?? shell.leftLeafContentEl
    const historyHost =
      shell.mobileDrawer?.slots.history ?? shell.leftLeafContentEl
    const previewHost =
      shell.mobileDrawer?.slots.preview ?? shell.rightContentEl

    const openPreviewPanel = () => {
      shell.setRightVisible(true)
      shell.mobileDrawer?.switchPanel('preview')
      shell.mobileDrawer?.open()
    }

    const previewPane = createObsidianPreviewPane(
      previewHost,
      readyState.client as never,
      {
        titleParentEl: shell.rightHeaderTitleParentEl,
        titleEl: shell.rightHeaderTitleEl,
        actionsEl: shell.rightHeaderActionsEl,
      },
    )
    disposers.push(() => previewPane.destroy())
    disposers.push(() => fileMgr?.destroy())

    const clearHistoryPane = () => {
      historyHost
        .querySelectorAll('.yolo-web-history-pane')
        .forEach((node) => node.remove())
    }

    const ensureFilesPane = () => {
      if (filesPaneInitialized) return
      fileMgr = createObsidianFileTree(
        filesHost,
        readyState.client as never,
        {
          onOpenFile: (item) => {
            ;(
              (state as ReadyShellState).runtime.app as unknown as {
                __yoloSetActiveFile?: (file: typeof item | null) => void
              }
            ).__yoloSetActiveFile?.(item)
          },
          onOpenFolder: () => {},
          onPreview: (target, item) => {
            if (item && classifyPreviewKind(item) !== 'unsupported') {
              openPreviewPanel()
            }
            previewPane.openPreview(target, item)
          },
          onOperationError: (message) => {
            window.dispatchEvent(
              new CustomEvent('yolo:web-show-error', {
                detail: { message },
              }),
            )
          },
          refreshTree: () => {
            void fileMgr?.refresh()
          },
          onVaultMutated: () => {
            // Re-fetch the vault index so `app.vault.getFiles()` (used by
            // @-mention and other vault-aware surfaces) reflects the new
            // create/rename/move/delete/upload state.
            const r = (state as ReadyShellState).runtime
            void r.vault.listIndex?.().catch((err) => {
              console.warn('Failed to refresh vault index after mutation', err)
            })
          },
          prompts: {
            requestRename: async (item) =>
              window.prompt('请输入新名称：', item.name),
            requestMove: async (item) =>
              window.prompt('请输入目标路径：', item.path),
            requestDelete: async (item) =>
              window.confirm(`Delete ${item.path}?`),
          },
        },
        // Read from the latest state, not the closure-captured readyState,
        // so a fileMgr created after replaceRuntime picks up the new home.
        { workspaceRoot: (state as ReadyShellState).workspaceRoot },
      )
      filesPaneInitialized = true
    }

    const setFilesPaneVisible = (visible: boolean) => {
      if (shell.mobileDrawer) {
        // The drawer's slot switching (switchPanel) already owns which of
        // files/preview/history is visible; the desktop show/hide dance
        // below doesn't apply since files and history live in separate
        // slots on mobile rather than sharing one host div.
        return
      }
      shell.leftLeafContentEl
        .querySelectorAll(
          '.yolo-web-files-nav-header, .yolo-web-files-nav-container, .yolo-web-files-state',
        )
        .forEach((node) => node.toggleClass('is-hidden', !visible))
    }

    const renderFilesPane = () => {
      clearHistoryPane()
      ensureFilesPane()
      setFilesPaneVisible(true)
    }

    const renderHistory = async () => {
      if (historyRendering) return
      historyRendering = true
      try {
        clearHistoryPane()
        ensureFilesPane()
        setFilesPaneVisible(false)
        const requestToken = ++historyRefreshToken
        const current = state as ReadyShellState
        await renderHistoryPane(
          historyHost,
          current.historyClient,
          openConversation,
          () => {
            void tabManager
              .whenActiveChatReady()
              .then((ref) => ref.openNewChat())
              .catch((err) =>
                console.warn('Failed to start new conversation:', err),
              )
          },
          () =>
            requestToken === historyRefreshToken && leftPaneMode === 'history',
          async (conversationId) => {
            const chatRef = await tabManager.whenActiveChatReady()
            await chatRef.deleteConversationWithCleanup(conversationId)
          },
        )
      } finally {
        historyRendering = false
      }
    }

    const renderLeftPane = () => {
      shell.leftRibbonFilesButtonEl.toggleClass(
        'is-active',
        leftPaneMode === 'files',
      )
      shell.leftRibbonHistoryButtonEl.toggleClass(
        'is-active',
        leftPaneMode === 'history',
      )
      shell.leftTabHeaderTitleEl.setText(
        leftPaneMode === 'files' ? '资源管理器' : '历史会话',
      )
      if (leftPaneMode === 'files') renderFilesPane()
      else void renderHistory()
    }

    shell.leftRibbonFilesButtonEl.addEventListener('click', () => {
      leftPaneMode = 'files'
      renderLeftPane()
    })
    shell.leftRibbonHistoryButtonEl.addEventListener('click', () => {
      leftPaneMode = 'history'
      renderLeftPane()
    })

    if (shell.mobileDrawer) {
      const drawer = shell.mobileDrawer
      const filesBtn = drawer.ribbonActionsEl.querySelector<HTMLElement>(
        '[data-panel="files"]',
      )
      const previewBtn = drawer.ribbonActionsEl.querySelector<HTMLElement>(
        '[data-panel="preview"]',
      )
      const historyBtn = drawer.ribbonActionsEl.querySelector<HTMLElement>(
        '[data-panel="history"]',
      )
      filesBtn?.addEventListener('click', () => {
        leftPaneMode = 'files'
        renderLeftPane()
        drawer.switchPanel('files')
        drawer.open()
      })
      historyBtn?.addEventListener('click', () => {
        leftPaneMode = 'history'
        renderLeftPane()
        drawer.switchPanel('history')
        drawer.open()
      })
      previewBtn?.addEventListener('click', () => {
        drawer.switchPanel('preview')
        drawer.open()
      })
    }

    const historyUpdatedListener = () => {
      if (leftPaneMode === 'history') {
        void renderHistory()
      }
    }
    window.addEventListener('yolo:chat-history-updated', historyUpdatedListener)
    disposers.push(() =>
      window.removeEventListener(
        'yolo:chat-history-updated',
        historyUpdatedListener,
      ),
    )

    const openFileListener = ((e: CustomEvent<{ path?: string }>) => {
      const rawPath = e.detail?.path
      if (!rawPath) return
      try {
        const path = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath
        previewPane.openPreview({
          path: normalizeVaultPath(path),
          source: 'cite',
        })
        openPreviewPanel()
      } catch {
        /* intentionally empty */
        //
      }
    }) as EventListener

    const openLinkListener = ((
      e: CustomEvent<{ resolvedPath?: string | null }>,
    ) => {
      const rawPath = e.detail?.resolvedPath
      if (!rawPath) return
      try {
        const path = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath
        previewPane.openPreview({
          path: normalizeVaultPath(path),
          source: 'cite',
        })
        openPreviewPanel()
      } catch {
        /* intentionally empty */
        //
      }
    }) as EventListener

    window.addEventListener('yolo:web-open-file', openFileListener)
    window.addEventListener('yolo:web-open-link', openLinkListener)
    disposers.push(() => {
      window.removeEventListener('yolo:web-open-file', openFileListener)
      window.removeEventListener('yolo:web-open-link', openLinkListener)
    })

    // The center tab-list button has no real popup in this pass; hide it
    // entirely (icon + button) so it doesn't look interactive.
    shell.centerTabListButtonEl.addClass('is-hidden')
    shell.centerTabListButtonEl.setAttribute('aria-hidden', 'true')

    function renderCenterTopBar(next: ReadyShellState): void {
      shell.centerTopBarTitleEl.empty()

      const activeAgent = next.allowedAgents.find(
        (agent) => agent.id === next.agentId,
      )
      const title = document.createElement('span')
      title.className = 'yolo-web-center-topbar-title-text'
      title.textContent = activeAgent?.name ?? next.agentId
      shell.centerTopBarTitleEl.append(title)
    }

    function renderLeftRibbonLogout(): void {
      const settingsHost =
        shell.mobileDrawer?.ribbonSettingsEl ?? shell.leftRibbonSettingsEl
      settingsHost.empty()

      // Theme toggle, sits above the logout action. Flips the
      // 'theme-dark' / 'theme-light' class pair on <body> (matching the
      // Obsidian convention used by app.css; index.html boots 'theme-dark').
      // Persisted to localStorage so reloads keep the user's choice.
      const themeBtn = document.createElement('div')
      themeBtn.className = 'side-dock-ribbon-action clickable-icon'
      const refreshThemeBtn = () => {
        const isDark = document.body.classList.contains('theme-dark')
        themeBtn.setAttribute(
          'aria-label',
          isDark ? '切换到浅色主题' : '切换到深色主题',
        )
        themeBtn.title = isDark ? '切换到浅色主题' : '切换到深色主题'
        themeBtn.replaceChildren()
        if (isDark) appendSunIcon(themeBtn)
        else appendMoonIcon(themeBtn)
      }
      themeBtn.addEventListener('click', () => {
        const isDark = document.body.classList.contains('theme-dark')
        document.body.classList.remove(isDark ? 'theme-dark' : 'theme-light')
        document.body.classList.add(isDark ? 'theme-light' : 'theme-dark')
        try {
          window.localStorage?.setItem(
            'yolo-web-theme',
            isDark ? 'light' : 'dark',
          )
        } catch {
          /* intentionally empty */
          // localStorage may be unavailable (private mode / blocked); ignore.
        }
        refreshThemeBtn()
      })
      refreshThemeBtn()
      settingsHost.append(themeBtn)

      const btn = document.createElement('div')
      btn.className = 'side-dock-ribbon-action clickable-icon'
      btn.setAttribute('aria-label', '退出登录')
      btn.title = '退出登录'
      appendLogoutIcon(btn)
      btn.addEventListener('click', () => void handleLogout())
      settingsHost.append(btn)
    }

    async function replaceRuntime(next: ReadyShellState): Promise<void> {
      // Tear down only the runtime-owned subtrees: the chat tab manager (and
      // the React trees it owns) plus the previous runtime. Shell-owned state
      // (file tree, preview pane, left-pane mode, listeners) is preserved
      // UNLESS workspaceRoot changed — switching to an assistant with a
      // different home requires re-scoping the file tree to the new root.
      const prevWorkspaceRoot = (state as ReadyShellState).workspaceRoot
      const workspaceRootChanged = prevWorkspaceRoot !== next.workspaceRoot

      tabManager.destroy()
      tabManager = createChatTabManager(shell, next.runtime, {
        dialogContainer: rootEl,
        getAssistantName: makeAssistantNameGetter(next.runtime),
        // Resolved lazily so agent switches mid-session pick up the new
        // permissions without re-creating the tab manager.
        getAgentModeAllowed: () => resolveAgentModeAllowed(state),
        sessionId: next.client.currentSessionId,
      })
      disposeRuntime()
      disposeRuntime = () => {
        ;(
          next.runtime as unknown as { __yoloDispose?: () => void }
        ).__yoloDispose?.()
      }

      if (workspaceRootChanged) {
        fileMgr?.destroy()
        fileMgr = null
        filesPaneInitialized = false
      }

      renderCenterTopBar(next)
      state = next

      if (workspaceRootChanged && leftPaneMode === 'files') {
        // Force re-init so the new fileMgr reads the new workspaceRoot from
        // the now-updated state. History pane is unaffected.
        ensureFilesPane()
        setFilesPaneVisible(true)
      }
    }

    renderCenterTopBar(readyState)
    renderLeftRibbonLogout()
    tabManager = createChatTabManager(shell, readyState.runtime, {
      dialogContainer: rootEl,
      getAssistantName: makeAssistantNameGetter(readyState.runtime),
      getAgentModeAllowed: () => resolveAgentModeAllowed(state),
      sessionId: readyState.client.currentSessionId,
    })
    disposers.push(() => tabManager.destroy())

    const controller: ReadyController = {
      shell,
      fileMgr,
      previewPane,
      tabManager,
      leftPaneMode,
      replaceRuntime,
      destroy: () => {
        for (const dispose of [...disposers].reverse()) dispose()
      },
    }
    currentReadyController = controller
    currentShellDisposer = controller.destroy

    renderLeftPane()
    shell.setRightVisible(false)
  }

  async function handleLogout(): Promise<void> {
    const readyState = state as ReadyShellState
    try {
      await readyState.client.logout()
    } catch (err) {
      const msg = err instanceof Error ? err.message : '退出登录失败'
      window.dispatchEvent(
        new CustomEvent('yolo:web-show-error', { detail: { message: msg } }),
      )
      return
    }
    setState({
      status: 'login',
      client: readyState.client,
      loginError: null,
      loggingIn: false,
      mock: readyState.mock,
    })
  }

  function appendSvgIcon(
    parent: HTMLElement,
    paths: string[],
    cls: string,
  ): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.classList.add('svg-icon', cls)
    for (const d of paths) {
      const path = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      )
      path.setAttribute('d', d)
      svg.append(path)
    }
    parent.append(svg)
  }

  function appendSunIcon(parent: HTMLElement): void {
    // lucide sun icon
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.classList.add('svg-icon', 'lucide-sun')
    const circle = document.createElementNS(
      'http://www.w3.org/2000/svg',
      'circle',
    )
    circle.setAttribute('cx', '12')
    circle.setAttribute('cy', '12')
    circle.setAttribute('r', '4')
    svg.append(circle)
    for (const d of [
      'M12 2v2',
      'M12 20v2',
      'm4.93 4.93 1.41 1.41',
      'm17.66 17.66 1.41 1.41',
      'M2 12h2',
      'M20 12h2',
      'm6.34 17.66-1.41 1.41',
      'm19.07 4.93-1.41 1.41',
    ]) {
      const path = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      )
      path.setAttribute('d', d)
      svg.append(path)
    }
    parent.append(svg)
  }

  function appendMoonIcon(parent: HTMLElement): void {
    appendSvgIcon(parent, ['M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z'], 'lucide-moon')
  }

  function appendLogoutIcon(parent: HTMLElement): void {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('width', '16')
    svg.setAttribute('height', '16')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('fill', 'none')
    svg.setAttribute('stroke', 'currentColor')
    svg.setAttribute('stroke-width', '2')
    svg.setAttribute('stroke-linecap', 'round')
    svg.setAttribute('stroke-linejoin', 'round')
    svg.classList.add('svg-icon', 'lucide-log-out')
    for (const d of [
      'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4',
      'm16 17 5-5-5-5',
      'M21 12H9',
    ]) {
      const path = document.createElementNS(
        'http://www.w3.org/2000/svg',
        'path',
      )
      path.setAttribute('d', d)
      svg.append(path)
    }
    parent.append(svg)
  }
}

const rootEl = document.getElementById('app-root')
if (!rootEl) throw new Error('Missing #app-root element')

App()
