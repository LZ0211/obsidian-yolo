jest.mock('./createWebCompatApp', () => ({
  createWebCompatApp: jest.fn(() => {
    const files = new Map<string, { path: string }>()
    return {
      workspace: {
        getActiveFile: jest.fn(() => null),
        getLeavesOfType: jest.fn(() => []),
        getLeaf: jest.fn(),
      },
      vault: {
        read: jest.fn(),
        readBinary: jest.fn(),
        getAbstractFileByPath: jest.fn((path: string) => files.get(path) ?? null),
        getFileByPath: jest.fn((path: string) => files.get(path) ?? null),
        getFolderByPath: jest.fn(),
        getFiles: jest.fn(() => Array.from(files.values())),
        createFolder: jest.fn(),
        modify: jest.fn(),
        create: jest.fn(),
      },
      fileManager: {
        trashFile: jest.fn(),
      },
      __yoloRefreshIndex: (nextIndex: Array<{ kind: string; path: string }>) => {
        files.clear()
        for (const entry of nextIndex) {
          if (entry.kind === 'file') {
            files.set(entry.path, { path: entry.path })
          }
        }
      },
    }
  }),
}))

jest.mock('./createWebCompatPlugin', () => ({
  createWebCompatPlugin: jest.fn(() => ({})),
}))

jest.mock('./createWebCompatibilityBridge', () => ({
  createWebCompatibilityBridge: jest.fn(() => ({
    app: {},
    plugin: {},
    TFile: class {},
    TFolder: class {},
    MarkdownView: class {},
    MarkdownRenderer: {},
    platform: {
      isMacOS: false,
      isDesktopApp: false,
      isPhone: false,
      isIosApp: false,
    },
    keymap: {
      isModEvent: jest.fn(() => false),
    },
    utils: {
      htmlToMarkdown: jest.fn((html: string) => html),
      normalizePath: jest.fn((path: string) => path),
    },
  })),
}))

jest.mock('./createWebMcpManager', () => ({
  createWebMcpManager: jest.fn(() => ({})),
}))

// useChatHistory 模块加载会引入 React app-context，测试环境（node env）无
// React；serialize/deserialize 的 mentionable 转换复用纯模块真实实现
// （对齐 mcpRoutes.test.ts 的既有模式）。
jest.mock('../../hooks/useChatHistory', () => {
  const { deserializeMentionable, serializeMentionable } =
    jest.requireActual('../../utils/chat/mentionable')
  return {
    serializeChatMessage: (message: never) => ({
      ...(message as Record<string, unknown>),
      mentionables: ((message as { mentionables?: unknown[] }).mentionables ??
        [])
        .map((m) => serializeMentionable(m as never))
        .filter((m) => m !== null),
    }),
    deserializeChatMessage: jest.fn((message: never, app: never) => ({
      ...(message as Record<string, unknown>),
      mentionables: ((message as { mentionables?: unknown[] }).mentionables ??
        [])
        .map((m) => deserializeMentionable(m as never, app))
        .filter((m) => m !== null),
    })),
  }
})

import { createWebYoloRuntime } from './createWebYoloRuntime'

describe('createWebYoloRuntime', () => {
  it('does not send workspaceId selectors in web chat list requests', async () => {
    const api = {
      getJson: jest.fn(async () => []),
      getJsonOrNull: jest.fn(),
      postJson: jest.fn(),
      openSseFetch: jest.fn(),
    } as {
      getJson: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: {
          webRuntimeEnabled: true,
        },
      },
      initialSettings: {
        version: 72,
      } as never,
      initialVaultIndex: [],
    })

    await runtime.chat.list({ workspaceId: 'ws-a' })

    expect(api.getJson).toHaveBeenCalledWith('/api/chat/list')
  })

  it('exposes the conversation gateway required by the Chat projection', () => {
    const api = {
      getJson: jest.fn(async () => []),
      getJsonOrNull: jest.fn(),
      postJson: jest.fn(),
      openSseFetch: jest.fn(),
    } as {
      getJson: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: { webRuntimeEnabled: true },
      },
      initialSettings: { version: 72 } as never,
      initialVaultIndex: [],
    })

    expect(
      typeof (runtime as { getConversationGateway?: unknown })
        .getConversationGateway,
    ).toBe('function')
  })

  it('commits submissions through the web conversation gateway', async () => {
    let record = {
      id: 'conv-1',
      schemaVersion: 1,
      createdAt: 1,
      title: '',
      messages: [],
      updatedAt: 1,
      revision: 1,
    }
    const api = {
      getJson: jest.fn(async () => []),
      getJsonOrNull: jest.fn(async () => record),
      postJson: jest.fn(async (path: string, input: Record<string, unknown>) => {
        if (path === '/api/chat/append-messages') {
          record = {
            ...record,
            messages: [...record.messages, ...(input.newMessages as never[])],
            updatedAt: 2,
            revision: 2,
          }
        }
        return {}
      }),
      openSseFetch: jest.fn(),
    } as {
      getJson: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: { webRuntimeEnabled: true },
      },
      initialSettings: { version: 72 } as never,
      initialVaultIndex: [],
    })

    const gateway = runtime.getConversationGateway()
    const result = await gateway.dispatch({
      type: 'submit_user_message',
      commandId: 'command-1',
      payloadFingerprint: 'fingerprint-1',
      correlationId: 'correlation-1',
      producer: 'chat',
      conversationId: 'conv-1',
      submissionId: 'submission-1',
      message: {
        role: 'user',
        id: 'message-1',
        content: null,
        promptContent: 'hello',
        mentionables: [],
        selectedSkills: [],
        selectedModelIds: [],
      },
    }).settled

    expect(result).toMatchObject({ status: 'accepted' })
    expect(api.postJson).toHaveBeenCalledWith(
      '/api/chat/append-messages',
      expect.objectContaining({
        id: 'conv-1',
        baseCount: 0,
      }),
    )
    const snapshot = gateway.getSnapshot('conv-1')
    expect(
      snapshot.timelineIds.some((messageId) => messageId === 'message-1'),
    ).toBe(true)
  })

  it('getAgents() returns the server-resolved initialAgents list, not a re-derivation from settings', async () => {
    // Regression: the web client used to call getUnifiedAgentList(currentSettings)
    // locally, re-deriving the unified list from the raw (and separately
    // id-scoped) settings.assistants/workspaceAgents arrays. That duplicated
    // — and could disagree with — the server's own resolution in GET
    // /api/agents. The runtime should just trust the pre-resolved list it was
    // seeded with.
    const api = {
      getJson: jest.fn(async () => []),
      getJsonOrNull: jest.fn(),
      postJson: jest.fn(),
      openSseFetch: jest.fn(),
    } as {
      getJson: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: {
          webRuntimeEnabled: true,
        },
      },
      // Deliberately empty/irrelevant assistants array — if getAgents() were
      // still deriving from settings, this would produce an empty list.
      initialSettings: {
        version: 72,
        assistants: [],
        workspaceAgents: [],
      } as never,
      initialAgents: [
        { id: 'agent-1', name: 'Agent 1', systemPrompt: '' },
      ] as never,
      initialVaultIndex: [],
    })

    expect(runtime.getAgents().map((a) => a.id)).toEqual(['agent-1'])
  })

  it('normalizes primed user messages before exposing running state', async () => {
    const api = {
      getJson: jest.fn(async () => []),
      getJsonOrNull: jest.fn(),
      postJson: jest.fn(async () => ({
        conversationId: 'conv-1',
        runId: 'run-1',
      })),
      openSseFetch: jest.fn(async () => ({
        ok: false,
        status: 500,
        body: null,
      })),
    } as {
      getJson: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: {
          webRuntimeEnabled: true,
        },
      },
      initialSettings: {
        version: 72,
      } as never,
      initialVaultIndex: [],
    })

    const states: Array<{ messages: Array<{ mentionables?: unknown[] }> }> = []
    const unsubscribe = runtime.agent.subscribe(
      'conv-1',
      (state) => states.push(state as never),
      { emitCurrent: false },
    )

    await runtime.agent.run({
      conversationId: 'conv-1',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: null,
        },
      ],
    } as never)

    unsubscribe()

    expect(states[0]?.messages[0]).toMatchObject({
      mentionables: [],
    })
  })

  it('recovers the running state when the run start request fails', async () => {
    const api = {
      getJson: jest.fn(async () => []),
      getJsonOrNull: jest.fn(),
      postJson: jest.fn(async () => {
        throw new Error('upstream 503')
      }),
      openSseFetch: jest.fn(),
    } as {
      getJson: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: {
          webRuntimeEnabled: true,
        },
      },
      initialSettings: {
        version: 72,
      } as never,
      initialVaultIndex: [],
    })

    const states: Array<{
      status?: string
      errorMessage?: string
      isRunning?: boolean
      messageIds?: string[]
    }> = []
    const unsubscribe = runtime.agent.subscribe(
      'conv-1',
      (state) => {
        states.push({
          status: state.status,
          errorMessage: state.errorMessage,
          isRunning: runtime.agent.isRunning('conv-1'),
          messageIds: state.messages.map((message) => message.id),
        } as never)
      },
      { emitCurrent: false },
    )

    await expect(
      runtime.agent.run({
        conversationId: 'conv-1',
        messages: [
          {
            role: 'user',
            id: 'user-1',
            content: null,
            promptContent: null,
          },
        ],
      } as never),
    ).rejects.toThrow('upstream 503')

    unsubscribe()

    const failed = states[states.length - 1]
    expect(failed?.status).toBe('error')
    expect(failed?.errorMessage).toContain('503')
    expect(failed?.isRunning).toBe(false)
    expect(failed?.messageIds).toEqual(['user-1'])
    expect(runtime.agent.isRunning('conv-1')).toBe(false)
  })

  it('hydrates compat vault files from the vault index endpoint', async () => {
    const api = {
      getJson: jest.fn(async (path: string) => {
        if (path === '/api/vault/index?limit=5000') {
          return {
            items: [
              {
                kind: 'folder',
                path: 'Docs',
                name: 'Docs',
              },
              {
                kind: 'file',
                path: 'Docs/readme.md',
                name: 'readme.md',
                basename: 'readme',
                extension: 'md',
                stat: { ctime: 1, mtime: 2, size: 3 },
              },
            ],
            nextCursor: null,
            hasMore: false,
          }
        }
        return []
      }),
      listVaultIndex: jest.fn(async () => ({
        items: [
          {
            kind: 'folder',
            path: 'Docs',
            name: 'Docs',
          },
          {
            kind: 'file',
            path: 'Docs/readme.md',
            name: 'readme.md',
            basename: 'readme',
            extension: 'md',
            stat: { ctime: 1, mtime: 2, size: 3 },
          },
        ],
        nextCursor: null,
        hasMore: false,
      })),
      getJsonOrNull: jest.fn(),
      postJson: jest.fn(),
      openSseFetch: jest.fn(),
    } as {
      getJson: jest.Mock
      listVaultIndex: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: {
          webRuntimeEnabled: true,
        },
      },
      initialSettings: {
        version: 72,
      } as never,
      initialVaultIndex: [],
    })

    await runtime.vault.listIndex?.()

    expect(api.listVaultIndex).toHaveBeenCalledWith({ limit: 5000, cursor: undefined })
    expect(runtime.vault.getFileByPath('Docs/readme.md')).toMatchObject({
      path: 'Docs/readme.md',
    })
  })

  it('approveToolCall emits normalized state to subscribers when response includes state', async () => {
    // normalizeWebChatMessage only normalizes user messages (adds mentionables,
    // selectedSkills etc.) — assistant messages are returned unchanged.
    const incomingState = {
      conversationId: 'conv-1',
      status: 'idle',
      messages: [
        {
          id: 'm1',
          role: 'user',
          content: null,
          promptContent: 'hello',
          // intentionally omitting mentionables — normalizer must fill it in
        },
      ],
      compaction: [],
      pendingCompactionAnchorMessageId: null,
    }
    const api = {
      getJson: jest.fn(async () => []),
      getJsonOrNull: jest.fn(),
      postJson: jest.fn(async () => ({
        approved: true,
        state: incomingState,
      })),
      openSseFetch: jest.fn(),
    } as {
      getJson: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: { webRuntimeEnabled: true },
      },
      initialSettings: { version: 72 } as never,
      initialVaultIndex: [],
    })

    const emittedStates: unknown[] = []
    const unsubscribe = runtime.agent.subscribe(
      'conv-1',
      (state) => emittedStates.push(state),
      { emitCurrent: false },
    )

    const approved = await runtime.agent.approveToolCall({
      conversationId: 'conv-1',
      toolCallId: 'tc-1',
    } as never)

    unsubscribe()

    expect(approved).toBe(true)
    expect(emittedStates).toHaveLength(1)
    // normalizeAgentState must fill in missing mentionables
    expect(
      (emittedStates[0] as { messages: Array<{ mentionables?: unknown[] }> })
        .messages[0],
    ).toMatchObject({ mentionables: [] })
    expect(api.postJson).toHaveBeenCalledWith('/api/agent/tool/approve', {
      conversationId: 'conv-1',
      toolCallId: 'tc-1',
    })
  })

  it('approveToolCall does NOT emit state when the response has no state property', async () => {
    const api = {
      getJson: jest.fn(async () => []),
      getJsonOrNull: jest.fn(),
      postJson: jest.fn(async () => ({ approved: false })),
      openSseFetch: jest.fn(),
    } as {
      getJson: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: { webRuntimeEnabled: true },
      },
      initialSettings: { version: 72 } as never,
      initialVaultIndex: [],
    })

    const emittedStates: unknown[] = []
    const unsubscribe = runtime.agent.subscribe(
      'conv-1',
      (state) => emittedStates.push(state),
      { emitCurrent: false },
    )

    const approved = await runtime.agent.approveToolCall({
      conversationId: 'conv-1',
      toolCallId: 'tc-stale',
    } as never)

    unsubscribe()

    expect(approved).toBe(false)
    // No state in response → subscribers must NOT be called
    expect(emittedStates).toHaveLength(0)
  })

  it('rejectToolCall returns the rejected boolean from the server response', async () => {
    const api = {
      getJson: jest.fn(async () => []),
      getJsonOrNull: jest.fn(),
      postJson: jest.fn(async () => ({ rejected: true })),
      openSseFetch: jest.fn(),
    } as {
      getJson: jest.Mock
      getJsonOrNull: jest.Mock
      postJson: jest.Mock
      openSseFetch: jest.Mock
    }

    const runtime = createWebYoloRuntime({
      api: api as never,
      bootstrap: {
        serverUrl: 'http://127.0.0.1:27123',
        phase: 2,
        workspaceAgentConfigured: true,
        authRequired: false,
        session: { agentId: 'agent-1' },
        allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
        settings: { webRuntimeEnabled: true },
      },
      initialSettings: { version: 72 } as never,
      initialVaultIndex: [],
    })

    const rejected = await runtime.agent.rejectToolCall({
      conversationId: 'conv-1',
      toolCallId: 'tc-1',
    } as never)

    expect(rejected).toBe(true)
    expect(api.postJson).toHaveBeenCalledWith('/api/agent/tool/reject', {
      conversationId: 'conv-1',
      toolCallId: 'tc-1',
    })
  })

  it('reconnects the run stream with cursor replay after a mid-stream failure (E2)', async () => {
    jest.useFakeTimers()
    try {
      const makeStream = () => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null =
          null
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController
          },
        })
        const encoder = new TextEncoder()
        return {
          body,
          feed: (frame: string) => controller?.enqueue(encoder.encode(frame)),
          error: (err: unknown) => controller?.error(err),
          close: () => controller?.close(),
        }
      }
      const firstStream = makeStream()
      const secondStream = makeStream()

      const api = {
        getJson: jest.fn(async () => []),
        getJsonOrNull: jest.fn(),
        postJson: jest.fn(async () => ({
          conversationId: 'conv-1',
          runId: 'run-1',
        })),
        openSseFetch: jest
          .fn()
          .mockReturnValueOnce({
            ok: true,
            body: firstStream.body,
          })
          .mockReturnValueOnce({
            ok: true,
            body: secondStream.body,
          }),
      } as {
        getJson: jest.Mock
        getJsonOrNull: jest.Mock
        postJson: jest.Mock
        openSseFetch: jest.Mock
      }

      const runtime = createWebYoloRuntime({
        api: api as never,
        bootstrap: {
          serverUrl: 'http://127.0.0.1:27123',
          phase: 2,
          workspaceAgentConfigured: true,
          authRequired: false,
          session: { agentId: 'agent-1' },
          allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
          settings: { webRuntimeEnabled: true },
        },
        initialSettings: { version: 72 } as never,
        initialVaultIndex: [],
      })

      const states: string[] = []
      runtime.agent.subscribe(
        'conv-1',
        (state) => states.push(state.status),
        { emitCurrent: false },
      )

      await runtime.agent.run({
        conversationId: 'conv-1',
        messages: [],
      } as never)

      // 首条流：先收到一个带 id 的事件（cursor=1），随后 mid-stream 断线。
      firstStream.feed(
        `id: 1\ndata: ${JSON.stringify({ type: 'state', status: 'running' })}\n\n`,
      )
      await jest.advanceTimersByTimeAsync(0)
      firstStream.error(new Error('connection reset'))
      await jest.advanceTimersByTimeAsync(0)

      // 退避 1s 后重连，重放 cursor 之后的记录。
      await jest.advanceTimersByTimeAsync(1_000)
      expect(api.openSseFetch).toHaveBeenCalledTimes(2)
      const secondUrl = api.openSseFetch.mock.calls[1]?.[0] as string
      expect(secondUrl).toContain('/api/agent/stream/run-1')
      expect(secondUrl).toContain('cursor=1')

      // 重连流正常结束（终态）→ 收尾拉全量状态，绝不落入 error 态。
      secondStream.feed(
        `id: 2\ndata: ${JSON.stringify({ type: 'state', status: 'completed' })}\n\n`,
      )
      secondStream.close()
      await jest.advanceTimersByTimeAsync(0)

      expect(states).toContain('running')
      expect(states).toContain('completed')
      expect(states).not.toContain('error')
    } finally {
      jest.useRealTimers()
    }
  })

  it('restarts the queue event stream after a failure (E2)', async () => {
    jest.useFakeTimers()
    try {
      const makeStream = () => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null =
          null
        const body = new ReadableStream<Uint8Array>({
          start(streamController) {
            controller = streamController
          },
        })
        return {
          body,
          close: () => controller?.close(),
        }
      }
      const okStream = makeStream()

      const api = {
        getJson: jest.fn(async () => []),
        getJsonOrNull: jest.fn(),
        postJson: jest.fn(),
        openSseFetch: jest
          .fn()
          .mockRejectedValueOnce(new Error('queue stream down'))
          .mockReturnValueOnce({ ok: true, body: okStream.body }),
      } as {
        getJson: jest.Mock
        getJsonOrNull: jest.Mock
        postJson: jest.Mock
        openSseFetch: jest.Mock
      }

      const runtime = createWebYoloRuntime({
        api: api as never,
        bootstrap: {
          serverUrl: 'http://127.0.0.1:27123',
          phase: 2,
          workspaceAgentConfigured: true,
          authRequired: false,
          session: { agentId: 'agent-1' },
          allowedAgents: [{ id: 'agent-1', name: 'Agent 1' }],
          settings: { webRuntimeEnabled: true },
        },
        initialSettings: { version: 72 } as never,
        initialVaultIndex: [],
      })

      const listener = jest.fn()
      runtime.agent.subscribeToPendingExternalAgentResults(listener)
      await jest.advanceTimersByTimeAsync(0)

      // 首次连接失败 → 退避重试后第二次连接成功。
      await jest.advanceTimersByTimeAsync(1_000)
      expect(api.openSseFetch).toHaveBeenCalledTimes(2)

      // 服务端关闭流 → started 标记复位，再次订阅会重新拉起连接。
      okStream.close()
      await jest.advanceTimersByTimeAsync(0)
      runtime.agent.subscribeToPendingExternalAgentResults(jest.fn())
      await jest.advanceTimersByTimeAsync(0)
      expect(api.openSseFetch).toHaveBeenCalledTimes(3)
    } finally {
      jest.useRealTimers()
    }
  })
})
