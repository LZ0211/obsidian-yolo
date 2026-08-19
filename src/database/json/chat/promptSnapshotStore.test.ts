/* eslint-disable import/no-nodejs-modules -- 测试文件直接使用 node 内置模块（fs/os/path） */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { App } from 'obsidian'

import type {
  SerializedChatMessage,
  SerializedChatUserMessage,
} from '../../../types/chat'
import { PromptSnapshotSqliteStore } from '../../sqlite/promptSnapshotSqliteStore'

import {
  clearAllPromptSnapshotStores,
  compactConversationMessagesForStorage,
  deletePromptSnapshotStore,
  readPromptSnapshotContent,
  readPromptSnapshotEntries,
} from './promptSnapshotStore'

describe('PromptSnapshotSqliteStore', () => {
  let directory: string
  let store: PromptSnapshotSqliteStore

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'prompt-snapshot-sqlite-'),
    )
    store = new PromptSnapshotSqliteStore(
      path.join(directory, 'conversation.sqlite'),
    )
  })

  afterEach(() => {
    store.close()
    fs.rmSync(directory, { recursive: true, force: true })
  })

  it('replaces entries and reads them back with timestamps preserved', () => {
    store.replace(
      'conversation-1',
      {
        hash1: { hash: 'hash1', content: 'one', createdAt: 1, updatedAt: 2 },
        hash2: {
          hash: 'hash2',
          content: ['a', 'b'],
          createdAt: 3,
          updatedAt: 4,
        },
      },
      new Set(['hash1', 'hash2']),
    )

    expect(store.readContent('conversation-1', 'hash1')).toBe('one')
    expect(store.readContent('conversation-1', 'hash2')).toEqual(['a', 'b'])
    expect(store.readContent('conversation-1', 'missing')).toBeNull()
    expect(store.readFullEntries('conversation-1')['hash1']).toEqual({
      content: 'one',
      createdAt: 1,
      updatedAt: 2,
    })
  })

  it('drops entries that are not in the keep set on the next replace', () => {
    store.replace(
      'conversation-1',
      {
        hash1: { hash: 'hash1', content: 'one', createdAt: 1, updatedAt: 1 },
        hash2: { hash: 'hash2', content: 'two', createdAt: 1, updatedAt: 1 },
      },
      new Set(['hash1', 'hash2']),
    )
    store.replace(
      'conversation-1',
      {
        hash1: { hash: 'hash1', content: 'one', createdAt: 1, updatedAt: 1 },
        hash2: { hash: 'hash2', content: 'two', createdAt: 1, updatedAt: 1 },
      },
      new Set(['hash1']),
    )

    expect(store.readContent('conversation-1', 'hash1')).toBe('one')
    expect(store.readContent('conversation-1', 'hash2')).toBeNull()
  })

  it('isolates conversations and clears all', () => {
    store.replace(
      'conversation-1',
      { hash1: { hash: 'hash1', content: 'one', createdAt: 1, updatedAt: 1 } },
      new Set(['hash1']),
    )
    store.replace(
      'conversation-2',
      { hash2: { hash: 'hash2', content: 'two', createdAt: 1, updatedAt: 1 } },
      new Set(['hash2']),
    )

    store.clearConversation('conversation-1')
    expect(store.readContent('conversation-1', 'hash1')).toBeNull()
    expect(store.readContent('conversation-2', 'hash2')).toBe('two')

    store.clearAll()
    expect(store.readContent('conversation-2', 'hash2')).toBeNull()
  })
})

describe('vault-file prompt snapshot store web gating', () => {
  // 浏览器 web 运行时标记（createWebYoloRuntime bootstrap 注入
  // app.__yoloWebChat，useJsonManagers 同款判定）：桌面端与 web 服务端
  // （宿主进程内）没有该标记。
  type AdapterSpy = ReturnType<typeof createSpyAdapter>
  const createSpyAdapter = () => ({
    exists: jest.fn().mockResolvedValue(false),
    mkdir: jest.fn().mockResolvedValue(undefined),
    read: jest.fn().mockResolvedValue(''),
    write: jest.fn().mockResolvedValue(undefined),
    remove: jest.fn().mockResolvedValue(undefined),
    list: jest.fn().mockResolvedValue({ files: [], folders: [] }),
  })

  const makeApp = (adapter: AdapterSpy, web: boolean): App =>
    ({
      vault: { adapter },
      ...(web ? { __yoloWebChat: {} } : {}),
    }) as unknown as App

  const userMessage: SerializedChatUserMessage = {
    role: 'user',
    id: 'user-1',
    content: null,
    promptContent: [{ type: 'text', text: 'big prompt' }],
    mentionables: [{ type: 'file', file: 'a.md' }],
    selectedSkills: [],
  }

  const asUserMessage = (message: SerializedChatMessage) =>
    message as SerializedChatUserMessage

  it('passes messages through untouched in the browser web runtime', async () => {
    const adapter = createSpyAdapter()
    const app = makeApp(adapter, true)
    const messages = [userMessage]

    const result = await compactConversationMessagesForStorage({
      app,
      conversationId: 'conversation-1',
      messages,
      settings: { yolo: { baseDir: 'YOLO' } },
    })

    // 原样通过：不触发 ensureUserDataRootDir 的桌面迁移 mkdir（web 权限引擎
    // 会 403），promptContent 保留给服务端压缩处理。
    expect(result).toEqual(messages)
    expect(asUserMessage(result[0]).promptContent).toEqual(
      userMessage.promptContent,
    )
    expect(adapter.exists).not.toHaveBeenCalled()
    expect(adapter.mkdir).not.toHaveBeenCalled()
    expect(adapter.write).not.toHaveBeenCalled()
  })

  it('returns empty snapshot reads and no-ops deletes in the browser web runtime', async () => {
    const adapter = createSpyAdapter()
    const app = makeApp(adapter, true)

    await expect(
      readPromptSnapshotContent({
        app,
        conversationId: 'conversation-1',
        hash: 'hash1',
      }),
    ).resolves.toBeNull()
    await expect(
      readPromptSnapshotEntries({
        app,
        conversationId: 'conversation-1',
        settings: null,
      }),
    ).resolves.toEqual({})
    await deletePromptSnapshotStore(app, 'conversation-1')
    await clearAllPromptSnapshotStores(app)

    expect(adapter.exists).not.toHaveBeenCalled()
    expect(adapter.list).not.toHaveBeenCalled()
    expect(adapter.remove).not.toHaveBeenCalled()
  })

  it('still persists snapshots on the desktop runtime', async () => {
    const adapter = createSpyAdapter()
    adapter.exists.mockResolvedValue(false)
    const app = makeApp(adapter, false)

    const compacted = await compactConversationMessagesForStorage({
      app,
      conversationId: 'conversation-1',
      messages: [userMessage],
      previousMessages: [],
      settings: { yolo: { baseDir: 'YOLO' } },
    })

    // 桌面：快照入库（mkdir + write），消息 promptContent 换 snapshotRef。
    expect(adapter.mkdir).toHaveBeenCalled()
    expect(adapter.write).toHaveBeenCalled()
    expect(asUserMessage(compacted[0]).promptContent).toBeNull()
    expect(typeof asUserMessage(compacted[0]).snapshotRef?.hash).toBe('string')
  })
})
