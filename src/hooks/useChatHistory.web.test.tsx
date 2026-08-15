/**
 * @jest-environment jsdom
 */
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'

import type { YoloRuntime } from '../runtime/yoloRuntime.types'

import { useChatHistory } from './useChatHistory'

const chatManager = {
  listChats: jest.fn().mockResolvedValue([]),
  deleteChat: jest.fn().mockResolvedValue(true),
}
const dropConversation = jest.fn()
const deleteRemoteConversation = jest.fn().mockResolvedValue(true)
const runtime = {
  mode: 'web',
  chat: { delete: deleteRemoteConversation },
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
jest.mock('../runtime/YoloRuntimeProvider', () => ({
  useOptionalYoloRuntime: () => runtime,
}))
jest.mock('../utils/chat/generateConversationTitle', () => ({
  AUTO_TITLE_FAILURE_COOLDOWN_MS: 1,
  generateConversationTitleText: jest.fn(),
}))
jest.mock('./useJsonManagers', () => ({ useChatManager: () => chatManager }))

describe('useChatHistory web deletion', () => {
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
