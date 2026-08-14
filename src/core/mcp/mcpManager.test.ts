jest.mock('obsidian')

import { App, Platform, TFile } from 'obsidian'

import type { ApplyViewState } from '../../types/apply-view.types'
import { McpServerStatus } from '../../types/mcp.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { McpNotAvailableException } from './exception'
import { McpManager } from './mcpManager'

const OBSIDIAN_CONFIG_DIR = ['.', 'obsidian'].join('')

describe('McpManager mobile built-in tool behavior', () => {
  const originalIsDesktop = Platform.isDesktop

  beforeEach(() => {
    Platform.isDesktop = false
  })

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  function createManager(
    openApplyReview: (state: unknown) => Promise<boolean> = jest.fn(),
    builtinToolOptions: Record<
      string,
      {
        disabled?: boolean
        actionOptions?: Record<string, { disabled?: boolean }>
      }
    > = {},
  ) {
    const file = Object.assign(new TFile(), {
      path: 'note.md',
      extension: 'md',
      stat: { size: 20 },
    })

    return new McpManager({
      pluginId: 'test-plugin',
      app: {
        vault: {
          configDir: OBSIDIAN_CONFIG_DIR,
          getAbstractFileByPath: jest.fn().mockReturnValue(file),
          getFileByPath: jest.fn().mockReturnValue(file),
          read: jest.fn().mockResolvedValue('hello world'),
          readBinary: jest.fn().mockResolvedValue(new ArrayBuffer(0)),
          modify: jest.fn(),
          create: jest.fn(),
        },
      } as unknown as App,
      settings: {
        mcp: {
          servers: [],
          builtinToolOptions,
        },
        webSearch: {
          providers: [],
          defaultProviderId: undefined,
          common: {
            resultSize: 8,
            searchTimeoutMs: 15000,
            scrapeTimeoutMs: 20000,
          },
        },
      } as never,
      openApplyReview,
      registerSettingsListener: () => () => {},
    })
  }

  it('lists built-in tools on mobile when requested', async () => {
    const manager = createManager()

    await expect(
      manager.listAvailableTools({ includeBuiltinTools: true }),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'yolo_local__fs_write' }),
      ]),
    )
    await expect(
      manager.listAvailableTools({ includeBuiltinTools: false }),
    ).resolves.toEqual([])
  })

  it('lists web_scrape without a configured web search provider', async () => {
    const manager = createManager()

    const tools = await manager.listAvailableTools({
      includeBuiltinTools: true,
    })

    expect(tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'yolo_local__web_scrape' }),
      ]),
    )
    expect(tools).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'yolo_local__web_search' }),
      ]),
    )
  })

  it('keeps file editing tools obeying only their own group switch', async () => {
    const manager = createManager(jest.fn(), {
      fs_edit_ops: { disabled: true },
      fs_edit: { disabled: false },
      fs_write: { disabled: false },
    })

    const toolNames = (
      await manager.listAvailableTools({ includeBuiltinTools: true })
    ).map((tool) => tool.name)

    expect(toolNames).not.toContain('yolo_local__fs_edit')
    expect(toolNames).not.toContain('yolo_local__fs_write')
  })

  it('enforces consolidated action disabled state at execution time', () => {
    const manager = createManager(jest.fn(), {
      scheduled_task_ops: {
        actionOptions: { create: { disabled: true } },
      },
    })

    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'yolo_local__scheduled_task_ops',
        conversationId: 'chat-1',
        requestArgs: { action: 'create' },
        requireAutoExecution: true,
      }),
    ).toBe(false)
    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'yolo_local__scheduled_task_ops',
        conversationId: 'chat-1',
        requestArgs: { action: 'list' },
        requireAutoExecution: true,
      }),
    ).toBe(true)
  })

  it('scopes consolidated standing approvals to the approved action', () => {
    const manager = createManager()

    manager.allowToolForConversation(
      'yolo_local__scheduled_task_ops',
      'chat-1',
      { action: 'create', prompt: 'backup' },
    )

    expect(manager.getAllowedTools('chat-1')).toEqual([
      'yolo_local__scheduled_task_ops::create',
    ])
    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'yolo_local__scheduled_task_ops',
        conversationId: 'chat-1',
        requestArgs: { action: 'create', prompt: 'backup' },
        requireAutoExecution: false,
      }),
    ).toBe(true)
    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'yolo_local__scheduled_task_ops',
        conversationId: 'chat-1',
        requestArgs: { action: 'delete', taskId: 'task-1' },
        requireAutoExecution: false,
      }),
    ).toBe(false)
  })

  it('executes built-in tools on mobile', async () => {
    const manager = createManager()

    await expect(
      manager.callTool({
        name: 'yolo_local__fs_write',
        args: {
          path: 'note.md',
          content: 'updated content',
        },
      }),
    ).resolves.toMatchObject({
      status: ToolCallResponseStatus.Success,
      data: expect.objectContaining({
        type: 'text',
      }),
    })
  })

  it('aborts active built-in tool calls on mobile', async () => {
    const manager = createManager(() => new Promise<boolean>(() => {}))

    const pendingResult = manager.callTool({
      name: 'yolo_local__fs_edit',
      id: 'tool-call-1',
      args: {
        path: 'note.md',
        oldText: 'hello world',
        newText: 'updated',
      },
      requireReview: true,
    })

    expect(manager.abortToolCall('tool-call-1')).toBe(true)
    await expect(pendingResult).resolves.toEqual({
      status: ToolCallResponseStatus.Aborted,
    })
  })

  it('preserves the rejection reason returned by a reviewed built-in tool', async () => {
    const manager = createManager(async (state) => {
      const review = state as ApplyViewState
      review.callbacks?.onComplete?.({
        finalContent: 'hello world',
        review: {
          totalChanges: 1,
          rejectedChanges: [
            {
              index: 1,
              originalText: 'hello world',
              proposedText: 'updated',
            },
          ],
        },
      })
      return true
    })

    await expect(
      manager.callTool({
        name: 'yolo_local__fs_edit',
        args: {
          path: 'note.md',
          oldText: 'hello world',
          newText: 'updated',
        },
        requireReview: true,
      }),
    ).resolves.toEqual({
      status: ToolCallResponseStatus.Rejected,
      reason:
        'Explicit user decision: this change was rejected in the review UI. This is not an edit or matching failure. Do not retry it with another locator or tool this turn; acknowledge the decision and wait for the user.',
    })
  })

  it('still rejects remote MCP tools on mobile', async () => {
    const manager = createManager()

    const result = await manager.callTool({
      name: 'demo__remote_tool',
      args: {},
    })

    expect(result).toEqual({
      status: ToolCallResponseStatus.Error,
      error: new McpNotAvailableException().message,
    })
  })
})

describe('McpManager connected tool catalog', () => {
  it('materializes the connect-time snapshot without another tools/list call', async () => {
    const originalIsDesktop = Platform.isDesktop
    Platform.isDesktop = true
    const manager = new McpManager({
      pluginId: 'test-plugin',
      app: {
        vault: { adapter: {}, configDir: OBSIDIAN_CONFIG_DIR },
      } as unknown as App,
      settings: {
        mcp: { servers: [], builtinToolOptions: {} },
      } as never,
      openApplyReview: jest.fn(),
      registerSettingsListener: () => () => {},
    })
    Platform.isDesktop = originalIsDesktop
    const listTools = jest.fn()
    ;(manager as unknown as { servers: unknown[] }).servers = [
      {
        name: 'remote',
        status: McpServerStatus.Connected,
        client: { listTools },
        tools: [
          {
            name: 'search',
            description: 'Search',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
        config: { toolOptions: {} },
      },
    ]

    await expect(manager.listAvailableTools()).resolves.toEqual([
      expect.objectContaining({ name: 'remote__search' }),
    ])
    await expect(
      manager.listAvailableTools({ chatModelModalities: ['vision'] }),
    ).resolves.toEqual([expect.objectContaining({ name: 'remote__search' })])
    expect(listTools).not.toHaveBeenCalled()
  })
})

describe('McpManager per-conversation tool allowance lifecycle', () => {
  const originalIsDesktop = Platform.isDesktop

  beforeEach(() => {
    Platform.isDesktop = false
  })

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  function createManager() {
    return new McpManager({
      pluginId: 'test-plugin',
      app: {
        vault: { configDir: OBSIDIAN_CONFIG_DIR },
      } as unknown as App,
      settings: {
        mcp: { servers: [], builtinToolOptions: {} },
        webSearch: {
          providers: [],
          defaultProviderId: undefined,
          common: {
            resultSize: 8,
            searchTimeoutMs: 15000,
            scrapeTimeoutMs: 20000,
          },
        },
      } as never,
      openApplyReview: jest.fn(),
      registerSettingsListener: () => () => {},
    })
  }

  it('grants and reports the conversation-scoped allowance', () => {
    const manager = createManager()

    manager.allowToolForConversation('yolo_local__fs_write', 'chat-1', {
      path: 'A.md',
      content: 'x',
    })

    // The arg-scoped action key is recorded alongside the tool-name key.
    expect(manager.getAllowedTools('chat-1')).toEqual([
      'yolo_local__fs_write::write',
      'yolo_local__fs_write',
    ])
    // Execution is allowed for the granting conversation…
    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'yolo_local__fs_write',
        conversationId: 'chat-1',
        requestArgs: { path: 'A.md', content: 'x' },
        requireAutoExecution: false,
      }),
    ).toBe(true)
    // …but never leaks into another conversation.
    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'yolo_local__fs_write',
        conversationId: 'chat-2',
        requestArgs: { path: 'A.md', content: 'x' },
        requireAutoExecution: false,
      }),
    ).toBe(false)
    expect(manager.getAllowedTools('chat-2')).toEqual([])
  })

  it('revokes the whole conversation allowance on removeAllowedTools', () => {
    const manager = createManager()

    manager.allowToolForConversation('yolo_local__fs_read', 'chat-1')
    manager.allowToolForConversation('yolo_local__fs_read', 'chat-2')

    manager.removeAllowedTools('chat-1')

    expect(manager.getAllowedTools('chat-1')).toEqual([])
    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'yolo_local__fs_read',
        conversationId: 'chat-1',
        requireAutoExecution: false,
      }),
    ).toBe(false)
    // The other conversation's grant is untouched.
    expect(manager.getAllowedTools('chat-2')).toEqual(['yolo_local__fs_read'])
    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'yolo_local__fs_read',
        conversationId: 'chat-2',
        requireAutoExecution: false,
      }),
    ).toBe(true)

    // Revoking an unknown conversation is a safe no-op.
    expect(() => manager.removeAllowedTools('never-granted')).not.toThrow()
  })

  it('leaves no residue when a conversationId is reused after deletion', () => {
    const manager = createManager()

    manager.allowToolForConversation('yolo_local__fs_read', 'chat-1')
    // The conversation is deleted; its allowances must not survive.
    manager.removeAllowedTools('chat-1')
    // A new chat reuses the same id.
    expect(manager.getAllowedTools('chat-1')).toEqual([])
    expect(
      manager.isToolExecutionAllowed({
        requestToolName: 'yolo_local__fs_read',
        conversationId: 'chat-1',
        requireAutoExecution: false,
      }),
    ).toBe(false)
  })

  it('clears every allowance on cleanup', () => {
    const manager = createManager()

    manager.allowToolForConversation('yolo_local__fs_read', 'chat-1')
    manager.allowToolForConversation('yolo_local__fs_read', 'chat-2')
    manager.cleanup()

    expect(manager.getAllowedTools('chat-1')).toEqual([])
    expect(manager.getAllowedTools('chat-2')).toEqual([])
  })
})
