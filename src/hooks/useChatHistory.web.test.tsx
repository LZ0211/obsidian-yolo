/**
 * @jest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import type { YoloRuntime } from '../runtime/yoloRuntime.types'

import { useChatHistory } from './useChatHistory'

const chatManager = {
  listChats: jest.fn().mockResolvedValue([]),
  findById: jest.fn().mockResolvedValue(null),
  createChat: jest.fn().mockResolvedValue(undefined),
  deleteChat: jest.fn().mockResolvedValue(true),
}
const dropConversation = jest.fn()
const deleteRemoteConversation = jest.fn().mockResolvedValue(true)
const saveRemoteConversation = jest.fn().mockResolvedValue(undefined)
const getRemoteConversation = jest.fn().mockResolvedValue({
  id: 'conversation-existing',
  title: 'Existing conversation',
  messages: [],
  createdAt: 1,
  updatedAt: 1,
})
const generateRemoteTitle = jest.fn().mockResolvedValue('Server title')
const runtime = {
  mode: 'web',
  chat: {
    delete: deleteRemoteConversation,
    get: getRemoteConversation,
    save: saveRemoteConversation,
    generateTitle: generateRemoteTitle,
  },
} as unknown as YoloRuntime

;(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

jest.mock('lodash.debounce', () => ({
  __esModule: true,
  default: (callback: (...args: unknown[]) => unknown) =>
    Object.assign(callback, { cancel: jest.fn() }),
}))
jest.mock('../contexts/app-context', () => ({ useApp: () => ({}) }))
jest.mock('../contexts/language-context', () => ({
  useLanguage: () => ({ language: 'en' }),
}))
jest.mock('../contexts/plugin-context', () => ({
  usePlugin: () => ({
    getAgentService: () => ({ dropConversation }),
  }),
}))
jest.mock('../contexts/settings-context', () => ({
  useSettings: () => ({ settings: {}, setSettings: jest.fn() }),
}))
jest.mock('../database/json/chat/promptSnapshotStore', () => ({
  compactConversationMessagesForStorage: jest.fn(
    async ({ messages }: { messages: unknown[] }) => messages,
  ),
}))
jest.mock('../runtime/YoloRuntimeProvider', () => ({
  useOptionalYoloRuntime: () => runtime,
}))
jest.mock('../utils/chat/generateConversationTitle', () => ({
  AUTO_TITLE_FAILURE_COOLDOWN_MS: 1,
  generateConversationTitleText: jest.fn(),
  buildFallbackTitle: jest.fn(),
}))
jest.mock('./useJsonManagers', () => ({ useChatManager: () => chatManager }))

describe('useChatHistory web runtime', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('creates a new conversation through the web runtime', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    let history: ReturnType<typeof useChatHistory> | null = null

    function Probe() {
      history = useChatHistory()
      return null
    }

    await act(async () => root.render(<Probe />))
    await act(async () =>
      history?.createOrUpdateConversationImmediately('conversation-new', [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'hello',
          mentionables: [],
          selectedSkills: [],
          selectedModelIds: [],
        },
      ]),
    )

    expect(saveRemoteConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'conversation-new',
        messages: [expect.objectContaining({ id: 'user-1' })],
      }),
    )
    expect(chatManager.createChat).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('loads a conversation through the web runtime', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    let history: ReturnType<typeof useChatHistory> | null = null

    function Probe() {
      history = useChatHistory()
      return null
    }

    await act(async () => root.render(<Probe />))
    await act(async () => {
      await history?.getConversationById('conversation-existing')
    })

    expect(getRemoteConversation).toHaveBeenCalledWith('conversation-existing')
    expect(chatManager.findById).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })

  it('generates titles through the server route in web runtime', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    let history: ReturnType<typeof useChatHistory> | null = null

    function Probe() {
      history = useChatHistory()
      return null
    }

    const untitledConversation = {
      id: 'conversation-new',
      title: '',
      messages: [],
      createdAt: 1,
      updatedAt: 1,
    }
    chatManager.findById.mockResolvedValue(untitledConversation)

    await act(async () => root.render(<Probe />))
    let title: string | null = null
    await act(async () => {
      title =
        (await history?.generateConversationTitle('conversation-new', [
          {
            role: 'user',
            id: 'user-1',
            content: null,
            promptContent: 'hello harness',
            mentionables: [],
            selectedSkills: [],
            selectedModelIds: [],
          },
        ])) ?? null
    })

    // 服务端路由生成（apiKey 不离开服务端），标题由服务端落库——本地不写回。
    expect(title).toBe('Server title')
    expect(generateRemoteTitle).toHaveBeenCalledWith(
      'conversation-new',
      [expect.objectContaining({ id: 'user-1' })],
      { force: false },
    )
    expect(generateRemoteTitle).toHaveBeenCalledTimes(1)

    await act(async () => root.unmount())
  })

  it('deletes through the web runtime instead of the compat vault manager', async () => {
    const host = document.createElement('div')
    const root = createRoot(host)
    let history: ReturnType<typeof useChatHistory> | null = null

    function Probe() {
      history = useChatHistory()
      return null
    }

    await act(async () => root.render(<Probe />))
    await act(async () => history?.deleteConversation('conversation-1'))

    expect(deleteRemoteConversation).toHaveBeenCalledWith('conversation-1')
    expect(chatManager.deleteChat).not.toHaveBeenCalled()
    expect(dropConversation).not.toHaveBeenCalled()

    await act(async () => root.unmount())
  })
})
