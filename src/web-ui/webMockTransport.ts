import {
  MOCK_ALLOWED_AGENTS,
  MOCK_CHAT_LIST,
  type MockChatConversationMetadata,
  buildMockLongTimelineMessages,
} from './mockFixtures'
import type { AllowedAgent, HistoryClient, ShellClient } from './webShellTypes'

export function createMockTransport(options?: {
  /** Mock assistant home directory. When set, the workspaceAccessPolicy on
   *  every mock assistant is forced to { enabled: true, workspaceRoot } so
   *  surfaces that read policy from settings (mention picker, useWorkspaceRoot)
   *  see the same home as the file tree (which reads bootstrap.workspaceRoot
   *  separately). Kept off by default so plain `?mock=1` is unchanged. */
  workspaceRoot?: string
  /** Number of deterministic user/assistant turns for timeline QA. */
  timelineTurns?: number
}): {
  client: ShellClient
  historyClient: HistoryClient
} {
  const workspaceRoot = (options?.workspaceRoot ?? '').trim()
  const timelineTurns = Math.max(
    0,
    Math.min(500, Math.trunc(options?.timelineTurns ?? 0)),
  )
  const now = Date.now()
  const agents: AllowedAgent[] = MOCK_ALLOWED_AGENTS
  const chats: MockChatConversationMetadata[] = MOCK_CHAT_LIST.map((chat) => ({
    ...chat,
  }))
  const items = [
    folder('00 Inbox'),
    file('00 Inbox/today.md', 2048, 'md'),
    file('00 Inbox/quick-note.md', 512, 'md'),
    folder('Projects'),
    folder('Projects/Smart RAG'),
    folder('Projects/Smart RAG/specs'),
    folder('Projects/Smart RAG/research'),
    file('Projects/Smart RAG/README.md', 4096, 'md'),
    file('Projects/Smart RAG/specs/web-runtime.md', 3320, 'md'),
    file('Projects/Smart RAG/specs/workspace-policy.md', 2780, 'md'),
    file('Projects/Smart RAG/research/metadata-search.json', 1024, 'json'),
    folder('Daily'),
    file('Daily/2026-06-27.md', 2210, 'md'),
    file('Daily/2026-06-26.md', 1240, 'md'),
    folder('References'),
    folder('References/API'),
    file('References/API/web-routes.md', 4512, 'md'),
    file('References/API/openapi.json', 8192, 'json'),
    folder('References/Assets'),
    file('References/Assets/diagram.png', 284000, 'png'),
    file('References/Assets/product-brief.pdf', 152000, 'pdf'),
    file('References/Obsidian DOM Map.md', 12880, 'md'),
    file('References/Assets/hello.py', 320, 'py'),
    file('References/Assets/styles.scss', 412, 'scss'),
    file('References/Assets/index.html', 840, 'html'),
    folder('Uploads'),
    file('Uploads/example.txt', 256, 'txt'),
    file('Uploads/import-log.csv', 780, 'csv'),
    folder('Archive'),
    folder('Archive/2026'),
    file('Archive/2026/release-notes.md', 1890, 'md'),
    file('README.md', 3310, 'md'),
  ]
  const fileText = new Map<string, string>([
    [
      '00 Inbox/today.md',
      '# Today\n\n- Review the web runtime shell\n- Check workspace file access\n- Polish the file tree UI\n',
    ],
    [
      '00 Inbox/quick-note.md',
      '# Quick note\n\nA small note used to preview Markdown rendering in the web file browser.\n',
    ],
    [
      'Projects/Smart RAG/README.md',
      '# Smart RAG\n\nThis is a mocked vault file.\n\n## Goals\n\n- Web runtime parity\n- Workspace-aware file access\n- Obsidian-like file navigation\n\n## Status\n\n| Feature | Status |\n| --- | --- |\n| Markdown preview | ✓ |\n| Code highlighting | ✓ |\n| CSV tables | ✓ |\n| Image preview | ✓ |\n\n> [!note] Getting Started\n> Open any file from the left panel to preview it here.\n\nSee [[Projects/Smart RAG/specs/web-runtime|Web Runtime Spec]] for architecture details.\n\n![diagram](../References/Assets/diagram.png)\n',
    ],
    [
      'Projects/Smart RAG/specs/web-runtime.md',
      '## Web Runtime\n\nThe web runtime forwards IO and LLM calls to the Obsidian host. UI-only affordances are allowed in the browser shell.\n',
    ],
    [
      'Projects/Smart RAG/specs/workspace-policy.md',
      '## Workspace Policy\n\nRead and write operations are filtered before tool results are rendered to the user.\n',
    ],
    [
      'Projects/Smart RAG/research/metadata-search.json',
      JSON.stringify(
        {
          query: 'select title, tags from /Projects where tags contains "rag"',
          rows: [{ title: 'Smart RAG', tags: ['rag', 'web'] }],
        },
        null,
        2,
      ),
    ],
    [
      'Daily/2026-06-27.md',
      '# 2026-06-27\n\n- Login uses compat modal.\n- History uses the existing conversation metadata shape.',
    ],
    [
      'Daily/2026-06-26.md',
      '# 2026-06-26\n\n- Fixed sidebar collapse animation.\n- Added right-click context menu to file tree.',
    ],
    [
      'References/API/web-routes.md',
      '# Web routes\n\n- `/api/vault/index`\n- `/api/vault/read`\n- `/api/vault/read-binary`\n- `/api/vault/write-binary`\n',
    ],
    [
      'References/API/openapi.json',
      JSON.stringify(
        { openapi: '3.1.0', info: { title: 'Mock API' } },
        null,
        2,
      ),
    ],
    [
      'References/Obsidian DOM Map.md',
      '# Obsidian DOM Map\n\n## Layout\n\n```html\n<div class="workspace">\n  <div class="workspace-ribbon side-dock-ribbon mod-left"></div>\n  <div class="workspace-split mod-left-split"></div>\n  <div class="workspace-split mod-vertical mod-root"></div>\n  <div class="workspace-split mod-right-split"></div>\n</div>\n```\n\n## Callout Examples\n\n> [!note] Note\n> This is a note callout.\n\n> [!warning] Warning\n> This is a warning callout.\n\n> [!tip] Pro Tip\n> Use `Ctrl+P` to open the command palette.\n\n> [!error] Error\n> Something went wrong.\n\n## Wiki Links\n\n- [[Projects/Smart RAG/README|Smart RAG Home]]\n- [[Projects/Smart RAG/specs/web-runtime]]\n- [[Daily/2026-06-27]]\n\n## Table\n\n| Name | Type | Description |\n| --- | --- | --- |\n| workspace | div | Root element |\n| workspace-ribbon | div | Left ribbon bar |\n| workspace-split | div | Resizable panel |\n\n## Inline Code\n\nThe `workspace-leaf` class wraps each leaf with `view-header` and `view-content` children.',
    ],
    [
      'References/Assets/hello.py',
      '#!/usr/bin/env python3\n"""Hello World module."""\n\n\ndef greet(name: str) -> str:\n    """Return a greeting for the given name."""\n    return f"Hello, {name}!"\n\n\nclass Greeter:\n    def __init__(self, prefix: str = "Hello"):\n        self.prefix = prefix\n\n    def greet(self, name: str) -> str:\n        return f"{self.prefix}, {name}!"\n\n\nif __name__ == "__main__":\n    print(greet("World"))\n',
    ],
    [
      'References/Assets/styles.scss',
      '$primary: #6366f1;\n$radius: 8px;\n\n.yolo-card {\n  background: var(--background-secondary);\n  border: 1px solid var(--background-modifier-border);\n  border-radius: $radius;\n  padding: 16px;\n\n  &__header {\n    display: flex;\n    align-items: center;\n    gap: 12px;\n    margin-bottom: 12px;\n  }\n\n  &__title {\n    font-size: 16px;\n    font-weight: 600;\n    color: $primary;\n  }\n\n  &__body {\n    color: var(--text-muted);\n    line-height: 1.6;\n  }\n}\n',
    ],
    [
      'References/Assets/index.html',
      '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>Mock Page</title>\n  <style>\n    body { font-family: system-ui; max-width: 640px; margin: 0 auto; padding: 24px; }\n    h1 { color: #6366f1; }\n  </style>\n</head>\n<body>\n  <h1>Hello from mock HTML</h1>\n  <p>This page demonstrates the HTML preview with source/rendered toggle.</p>\n</body>\n</html>\n',
    ],
    ['Uploads/example.txt', 'Uploaded files will appear here.'],
    [
      'Uploads/import-log.csv',
      'time,event\n09:00,created mock vault\n09:10,opened web file panel\n',
    ],
    [
      'Archive/2026/release-notes.md',
      '# Release notes\n\nOlder notes stay visible under nested folders.\n',
    ],
    [
      'README.md',
      '# Smart RAG Web Mock\n\nOpen with `?mock=1` to force fake web APIs.',
    ],
  ])

  let authenticated = false // Mock mode starts unauthenticated, mirrors real backend
  let activeAgentId = agents[0].id

  const cloneItem = (item: (typeof items)[number]) => ({
    ...item,
    stat: item.stat ? { ...item.stat } : undefined,
  })

  const getItems = () => items.map(cloneItem)

  const ensurePathMissing = (path: string, overwrite = false) => {
    const existing = items.find((item) => item.path === path)
    if (existing && !overwrite) {
      throw new Error('Path already exists')
    }
    if (existing && overwrite) {
      removePath(path, existing.kind === 'folder')
    }
  }

  const assertParentExists = (path: string) => {
    const parent = parentPath(path)
    if (!parent) return
    const folderItem = items.find(
      (item) => item.path === parent && item.kind === 'folder',
    )
    if (!folderItem) {
      throw new Error('Parent folder not found')
    }
  }

  const removePath = (path: string, recursive: boolean) => {
    const target = items.find((item) => item.path === path)
    if (!target) {
      throw new Error('Not found')
    }
    if (target.kind === 'folder') {
      const descendants = items.filter((item) =>
        item.path.startsWith(`${path}/`),
      )
      if (descendants.length > 0 && !recursive) {
        throw new Error('Folder is not empty')
      }
      for (const descendant of descendants) {
        fileText.delete(descendant.path)
      }
      for (let index = items.length - 1; index >= 0; index -= 1) {
        if (
          items[index].path === path ||
          items[index].path.startsWith(`${path}/`)
        ) {
          items.splice(index, 1)
        }
      }
      return
    }
    fileText.delete(path)
    const index = items.findIndex((item) => item.path === path)
    if (index >= 0) {
      items.splice(index, 1)
    }
  }

  const movePath = (fromPath: string, toPath: string, overwrite = false) => {
    const target = items.find((item) => item.path === fromPath)
    if (!target) {
      throw new Error('Not found')
    }
    if (fromPath === toPath) return
    assertParentExists(toPath)
    ensurePathMissing(toPath, overwrite)

    if (target.kind === 'folder') {
      const affected = items.filter(
        (item) =>
          item.path === fromPath || item.path.startsWith(`${fromPath}/`),
      )
      for (const item of affected) {
        const nextPath =
          item.path === fromPath
            ? toPath
            : `${toPath}/${item.path.slice(fromPath.length + 1)}`
        if (item.kind === 'file') {
          const text = fileText.get(item.path)
          if (text != null) {
            fileText.delete(item.path)
            fileText.set(nextPath, text)
          }
        }
        item.path = nextPath
        item.name = nextPath.split('/').pop() ?? nextPath
        if (item.kind === 'file') {
          item.basename = item.name.replace(/\.[^.]+$/, '')
        }
        if (item.stat) {
          item.stat.mtime = Date.now()
        }
      }
      return
    }

    const text = fileText.get(fromPath)
    if (text != null) {
      fileText.delete(fromPath)
      fileText.set(toPath, text)
    }
    target.path = toPath
    target.name = toPath.split('/').pop() ?? toPath
    target.basename = target.name.replace(/\.[^.]+$/, '')
    target.extension = target.name.includes('.')
      ? (target.name.split('.').pop() ?? '')
      : ''
    if (target.stat) {
      target.stat.mtime = Date.now()
    }
  }

  const client: ShellClient = {
    currentSessionId: null,
    async getBootstrap() {
      return {
        serverUrl: window.location.origin,
        phase: 2,
        authRequired: true,
        workspaceAgentConfigured: true,
        session: authenticated ? { agentId: activeAgentId } : null,
        allowedAgents: authenticated ? MOCK_ALLOWED_AGENTS : [],
        settings: { webRuntimeEnabled: true },
        pluginInfo: { id: 'smart-rag', name: 'Smart RAG', version: 'mock' },
        vaultName: 'Mock Vault',
        activeFile: null,
      }
    },
    async getSettings() {
      const workspaceAccessPolicy = workspaceRoot
        ? {
            enabled: true,
            workspaceRoot,
            readExtraIncludes: [],
            readExcludes: [],
            writeExcludes: [],
          }
        : undefined
      return {
        version: 72,
        currentAssistantId: 'mock-agent',
        assistants: [
          {
            id: 'mock-agent',
            name: 'Mock Agent',
            systemPrompt: '',
            modelId: 'openai/gpt-5',
            enableTools: true,
            includeBuiltinTools: true,
            ...(workspaceAccessPolicy ? { workspaceAccessPolicy } : {}),
          },
          {
            id: 'review-agent',
            name: 'Review Agent',
            systemPrompt: '',
            modelId: 'openai/gpt-5',
            enableTools: true,
            includeBuiltinTools: true,
            ...(workspaceAccessPolicy ? { workspaceAccessPolicy } : {}),
          },
        ],
        webRuntime: { enabled: true, host: '127.0.0.1', port: 19091 },
        chatOptions: {
          stream: true,
          continuationModelId: 'openai/gpt-4.1-mini',
          tabCompletionModelId: 'openai/gpt-4.1-mini',
        },
        // Minimal provider + model fixtures so the in-chat model switcher
        // populates. ModelSelect only renders the dropdown when there's at
        // least one enabled model whose providerId matches a known provider.
        providers: [
          { id: 'openai', type: 'openai', apiKey: 'mock', baseUrl: '' },
          { id: 'anthropic', type: 'anthropic', apiKey: 'mock', baseUrl: '' },
        ],
        chatModels: [
          {
            id: 'openai/gpt-5',
            providerId: 'openai',
            model: 'gpt-5',
            name: 'GPT-5',
            enable: true,
            // reasoningType drives ReasoningSelect's visibility — without it
            // the in-chat thinking-effort selector stays hidden.
            reasoningType: 'openai',
          },
          {
            id: 'openai/gpt-4.1-mini',
            providerId: 'openai',
            model: 'gpt-4.1-mini',
            name: 'GPT-4.1 Mini',
            enable: true,
            reasoningType: 'openai',
          },
          {
            id: 'anthropic/claude-opus-4-7',
            providerId: 'anthropic',
            model: 'claude-opus-4-7',
            name: 'Claude Opus 4.7',
            enable: true,
            reasoningType: 'anthropic',
          },
          {
            id: 'anthropic/claude-sonnet-4-6',
            providerId: 'anthropic',
            model: 'claude-sonnet-4-6',
            name: 'Claude Sonnet 4.6',
            enable: true,
            reasoningType: 'anthropic',
          },
        ],
        chatModelId: 'openai/gpt-5',
        chatTitleModelId: 'openai/gpt-4.1-mini',
        embeddingModelId: '',
        embeddingModels: [],
        mcpServers: [],
        ragOptions: { enabled: false },
        ragBackendSettings: {
          productionBackend: 'sqlite',
          rebuildRequired: false,
        },
        workspaceAgents: [
          {
            id: 'mock-agent',
            name: 'Mock Agent',
            templateId: 'mock-agent',
            disabled: false,
            workspacePolicy: {
              workspaceRoot,
              readAllowlist: [],
              readDenylist: [],
              writeDenylist: [],
            },
          },
          {
            id: 'review-agent',
            name: 'Review Agent',
            templateId: 'review-agent',
            disabled: false,
            workspacePolicy: {
              workspaceRoot,
              readAllowlist: [],
              readDenylist: [],
              writeDenylist: [],
            },
          },
        ],
      }
    },
    async getAgents() {
      // Mirrors the shape /api/agents returns server-side: the mock's
      // assistant ids already double as workspace-agent ids (no separate
      // templateId indirection), so the raw assistants fixture is already a
      // valid unified agent list.
      return [
        { id: 'mock-agent', name: 'Mock Agent', modelId: 'openai/gpt-5' },
        { id: 'review-agent', name: 'Review Agent', modelId: 'openai/gpt-5' },
      ]
    },
    async getSkills() {
      return []
    },
    async getWebAuthState() {
      if (!authenticated) return null
      return {
        session: { agentId: activeAgentId },
        allowedAgents: MOCK_ALLOWED_AGENTS,
      }
    },
    async loginWithShareToken(token: string) {
      if (!token.trim()) throw new Error('Invalid share token.')
      authenticated = true
      return {
        session: { agentId: activeAgentId },
        allowedAgents: MOCK_ALLOWED_AGENTS,
      }
    },
    async logout() {
      authenticated = false
    },
    async switchAgent(agentId: string) {
      activeAgentId = agentId
      return {
        session: { agentId: activeAgentId },
        allowedAgents: MOCK_ALLOWED_AGENTS,
      }
    },
    async listVaultFolder(path: string) {
      const normalized = path === '/' ? '' : path
      // Mirror Obsidian's `adapter.list` semantics: a listing returns all
      // descendants of the path, not just direct children. The file tree
      // groups results by parent, so recursive results still render correctly;
      // `fetchRemoteVaultIndex` relies on this to populate `app.vault` for
      // @-mention.
      const prefix = normalized ? `${normalized}/` : ''
      const items = getItems().filter((item) => {
        if (normalized === '') return true
        if (item.path === normalized) return false
        return item.path.startsWith(prefix)
      })
      return {
        items,
        nextCursor: null,
        hasMore: false,
      }
    },
    async searchVault(query: string) {
      const q = query.toLowerCase()
      const allItems = getItems()
      const matched = allItems.filter((item) => {
        if (item.path.toLowerCase().includes(q)) return true
        if (item.kind === 'file') {
          const content = fileText.get(item.path)
          if (content && content.toLowerCase().includes(q)) return true
        }
        return false
      })
      return {
        items: matched,
        nextCursor: null,
        hasMore: false,
      }
    },
    async previewVaultText(path: string) {
      const value = fileText.get(path)
      if (value == null) throw new Error('Not found')
      return value
    },
    async readVaultBinary(path: string) {
      if (path.endsWith('.png')) {
        return await makeMockPng(path)
      }
      if (path.endsWith('.pdf')) {
        return makeMockPdf(path)
      }
      return new Blob(['mock binary'], { type: 'application/octet-stream' })
    },
    async downloadVaultFile(path: string) {
      return new Blob([fileText.get(path) ?? 'mock download placeholder'], {
        type: 'text/plain',
      })
    },
    async writeVaultText(path: string, content: string, overwrite = false) {
      const existing = items.find((item) => item.path === path)
      if (!existing) {
        assertParentExists(path)
        ensurePathMissing(path, overwrite)
        items.push(file(path, content.length, path.split('.').pop() ?? 'txt'))
      } else if (existing.kind !== 'file') {
        throw new Error('Path is not a file')
      }
      fileText.set(path, content)
      const current = items.find(
        (item) => item.path === path && item.kind === 'file',
      )
      if (current?.stat) {
        current.stat.size = content.length
        current.stat.mtime = Date.now()
      }
    },
    async writeVaultBinary(path: string, data: ArrayBuffer, overwrite = false) {
      const placeholder = `[binary ${data.byteLength} bytes]`
      await client.writeVaultText(path, placeholder, overwrite)
    },
    async createVaultFile(path: string, content = '', overwrite = false) {
      assertParentExists(path)
      ensurePathMissing(path, overwrite)
      items.push(file(path, content.length, path.split('.').pop() ?? 'md'))
      fileText.set(path, content)
    },
    async createVaultFolder(path: string, overwrite = false) {
      assertParentExists(path)
      ensurePathMissing(path, overwrite)
      items.push(folder(path))
    },
    async renameVaultPath(fromPath: string, toPath: string, overwrite = false) {
      movePath(fromPath, toPath, overwrite)
    },
    async moveVaultPath(fromPath: string, toPath: string, overwrite = false) {
      movePath(fromPath, toPath, overwrite)
    },
    async deleteVaultFile(path: string) {
      removePath(path, false)
    },
    async deleteVaultFolder(path: string, recursive = false) {
      removePath(path, recursive)
    },
    async uploadVaultFiles(files) {
      const results: Array<
        { path: string; ok: true } | { path: string; ok: false; error: string }
      > = []
      for (const upload of files) {
        try {
          await client.writeVaultBinary(
            upload.path,
            upload.data,
            upload.overwrite ?? false,
          )
          results.push({ path: upload.path, ok: true })
        } catch (error) {
          results.push({
            path: upload.path,
            ok: false,
            error: error instanceof Error ? error.message : 'Upload failed',
          })
        }
      }
      return results
    },
    async getJson<T>(path: string): Promise<T> {
      if (path.startsWith('/api/agent/queue/peek'))
        return { messages: [] } as unknown as T
      if (path.startsWith('/api/chat/list'))
        return chats.map((c) => ({ ...c })) as unknown as T
      if (path.startsWith('/api/chat/get/')) {
        const id = decodeURIComponent(path.split('/api/chat/get/')[1] ?? '')
        const chat = chats.find((c) => c.id === id)
        if (!chat) return {} as T
        return {
          ...chat,
          messages: mockMessagesFor(chat.id, chat.title),
        } as unknown as T
      }
      if (path.startsWith('/api/vault/search'))
        return { results: [] } as unknown as T
      return {} as T
    },
    async getJsonOrNull<T>(path: string): Promise<T | null> {
      if (path.startsWith('/api/chat/get/')) {
        const id = decodeURIComponent(path.split('/api/chat/get/')[1] ?? '')
        const chat = chats.find((c) => c.id === id)
        if (!chat) return null
        return {
          ...chat,
          messages: mockMessagesFor(chat.id, chat.title),
        } as unknown as T
      }
      return (await this.getJson(path)) as T | null
    },
    async postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
      if (path.startsWith('/api/chat/delete')) {
        const id = body.conversationId as string
        const idx = chats.findIndex((c) => c.id === id)
        if (idx >= 0) chats.splice(idx, 1)
        return {} as T
      }
      if (path.startsWith('/api/chat/toggle-pinned')) {
        const id = body.id as string
        const chat = chats.find((c) => c.id === id)
        if (chat) chat.isPinned = !chat.isPinned
        return {} as T
      }
      if (path.startsWith('/api/chat/update-title')) {
        const id = body.id as string
        const title = body.title as string
        const chat = chats.find((c) => c.id === id)
        if (chat) {
          chat.title = title
          chat.updatedAt = Date.now()
        }
        return {} as T
      }
      if (path.startsWith('/api/chat/generate-title')) {
        const id = body.conversationId as string
        const chat = chats.find((c) => c.id === id)
        if (chat) chat.updatedAt = Date.now()
        return {} as T
      }
      return {} as T
    },
    async readVaultText(path: string): Promise<string> {
      return client.previewVaultText(path)
    },
    async openSseFetch(_path: string): Promise<Response> {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    },
  } as ShellClient

  // Dev diagnostic: log every mock api call so the last log before a hang
  // shows which call is stuck. Remove when mock is stable.
  const loggedClient = new Proxy(client, {
    get(target, prop) {
      const orig = (target as unknown as Record<string, unknown>)[String(prop)]
      if (typeof orig === 'function') {
        return (...args: unknown[]) => {
          const label = typeof args[0] === 'string' ? args[0] : ''
          console.debug(`[mock-api] ${String(prop)}${label ? ` ${label}` : ''}`)
          return (orig as (...a: unknown[]) => unknown).apply(target, args)
        }
      }
      return orig
    },
  })

  return {
    client: loggedClient,
    historyClient: {
      async listChats() {
        // Mirror production's canUseWebConversation gate (see
        // registerWebServerRoutes.ts:canUseWebConversation): chats are
        // visible only when their webBinding.activeAgentId matches the
        // session's active agent AND the binding isn't 'orphaned'. Chats
        // without a webBinding stay hidden in web context (they're
        // Obsidian-mode artifacts that didn't pick up a binding yet).
        return chats
          .filter((chat) => {
            const binding = chat.webBinding
            if (!binding) return false
            if (binding.accessState === 'orphaned') return false
            return binding.activeAgentId === activeAgentId
          })
          .map((chat) => ({ ...chat }))
      },
      async togglePinnedChat(id) {
        const chat = chats.find((c) => c.id === id)
        if (!chat) return
        const nextPinned = !chat.isPinned
        chat.isPinned = nextPinned
        chat.pinnedAt = nextPinned ? Date.now() : undefined
        chat.updatedAt = Date.now()
      },
      async updateChatTitle(id, title) {
        const chat = chats.find((c) => c.id === id)
        if (!chat) return
        chat.title = title
        chat.updatedAt = Date.now()
      },
      async retryChatTitle(id) {
        const chat = chats.find((c) => c.id === id)
        if (!chat) return
        chat.title = `Retry ${new Date().toLocaleTimeString()}`
        chat.updatedAt = Date.now()
      },
    },
  }

  function folder(path: string) {
    return {
      kind: 'folder' as const,
      path,
      name: path.split('/').pop() ?? path,
      stat: { ctime: now - 200000, mtime: now - 100000, size: 0 },
    }
  }

  function file(path: string, size: number, extension: string) {
    const name = path.split('/').pop() ?? path
    return {
      kind: 'file' as const,
      path,
      name,
      basename: name.replace(/\.[^.]+$/, ''),
      extension,
      stat: { ctime: now - size * 10, mtime: now - size * 5, size },
    }
  }

  function parentPath(path: string): string {
    const index = path.lastIndexOf('/')
    return index < 0 ? '' : path.slice(0, index)
  }

  async function makeMockPng(path: string): Promise<Blob> {
    // Render a visible image via canvas so the preview pane has something
    // recognisable to display (vs the prior 1x1 blue pixel that looked
    // like nothing rendered). Falls back to a tiny opaque PNG if canvas
    // isn't available (e.g. SSR / Node test env).
    try {
      const canvas = document.createElement('canvas')
      canvas.width = 320
      canvas.height = 200
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('no 2d context')
      const grad = ctx.createLinearGradient(0, 0, 320, 200)
      grad.addColorStop(0, '#6366f1')
      grad.addColorStop(1, '#ec4899')
      ctx.fillStyle = grad
      ctx.fillRect(0, 0, 320, 200)
      ctx.fillStyle = 'rgba(255,255,255,0.92)'
      ctx.font = 'bold 22px system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText('Mock Image', 160, 90)
      ctx.font = '14px system-ui, sans-serif'
      ctx.fillText(path.split('/').pop() ?? 'image.png', 160, 120)
      const blob: Blob | null = await new Promise((resolve) =>
        canvas.toBlob((b) => resolve(b), 'image/png'),
      )
      if (blob) return blob
    } catch {
      /* intentionally empty — fallback */
      // ignore and use fallback
    }
    const fallback = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde, 0x00, 0x00, 0x00,
      0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0xf8, 0xcf, 0xc0,
      0x00, 0x00, 0x07, 0x00, 0x01, 0x00, 0x4b, 0xb7, 0x30, 0x54, 0x00, 0x00,
      0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ])
    return new Blob([fallback], { type: 'image/png' })
  }

  function makeMockPdf(path: string): Blob {
    // Builds a minimal valid PDF with a /Contents stream that prints
    // visible text — the prior mock had a Page node without /Contents,
    // so the viewer showed an empty page. Offsets are computed at build
    // time so hand-edited offsets can't drift out of sync.
    const name = path.split('/').pop() ?? 'document.pdf'
    const stream =
      'BT /F1 22 Tf 72 720 Td (Mock PDF Preview) Tj ' +
      'T* 0 -28 Td /F1 14 Tf (' +
      name.replace(/[()\\]/g, '') +
      ') Tj ' +
      'T* 0 -24 Td (This is mock PDF content rendered by the web runtime.) Tj ET'
    const objects = [
      '<</Type/Catalog/Pages 2 0 R>>',
      '<</Type/Pages/Kids[3 0 R]/Count 1>>',
      '<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 5 0 R>>>>/Contents 4 0 R>>',
      `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
      '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>',
    ]
    let body = '%PDF-1.4\n'
    const offsets: number[] = []
    for (let i = 0; i < objects.length; i++) {
      offsets.push(body.length)
      body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`
    }
    const xrefOffset = body.length
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    for (const off of offsets) {
      body += String(off).padStart(10, '0') + ' 00000 n \n'
    }
    body += `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF`
    return new Blob([body], { type: 'application/pdf' })
  }

  function mockMessagesFor(chatId: string, title: string): unknown[] {
    if (timelineTurns > 0) {
      const messages = buildMockLongTimelineMessages(timelineTurns)
      if (typeof window !== 'undefined') {
        ;(
          window as Window & { __yoloMockTimelineItemCount?: number }
        ).__yoloMockTimelineItemCount = messages.length + 1
      }
      return messages
    }

    // Deterministic pseudo-content per conversation so each history entry
    // shows distinct messages when opened.
    const seed = chatId.length * 7 + title.length
    const userQ = `Help me refine the "${title}" workstream for the web runtime.`
    const assistantA =
      `Here's a plan for "${title}":\n\n` +
      `1. Confirm the workspace shell layout still matches the Obsidian reference.\n` +
      `2. Verify the ${chatId} data path is shared between the file tree and the chat surfaces.\n` +
      `3. Tidy up the ribbon entries (seed ${seed}).\n`
    const userFollowUp = 'Can you also check the tab title update path?'
    const assistantFollowUp =
      `Yes — when \`onConversationContextChange\` fires with a real title, ` +
      `the tab manager calls \`updateTabTitle\` and pins \`hasConversationTitle\`. ` +
      `Untitled conversations keep the assistant name as the tab title.`
    return [
      {
        role: 'user',
        id: `${chatId}-u1`,
        content: null,
        promptContent: userQ,
        mentionables: [],
        selectedSkills: [],
        selectedModelIds: [],
      },
      {
        role: 'assistant',
        id: `${chatId}-a1`,
        content: assistantA,
        metadata: { generationState: 'completed', durationMs: 1200 + seed },
      },
      {
        role: 'user',
        id: `${chatId}-u2`,
        content: null,
        promptContent: userFollowUp,
        mentionables: [],
        selectedSkills: [],
        selectedModelIds: [],
      },
      {
        role: 'assistant',
        id: `${chatId}-a2`,
        content: assistantFollowUp,
        metadata: { generationState: 'completed', durationMs: 900 + seed },
      },
    ]
  }
}
