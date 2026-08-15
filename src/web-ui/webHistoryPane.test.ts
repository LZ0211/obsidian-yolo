/**
 * @jest-environment jsdom
 */

import { installDomCompat } from '../runtime/web/obsidianDomCompat'

import { renderHistoryPane } from './webHistoryPane'

// useChatHistory 拖入宿主全栈（Anthropic SDK/数据库 store/plugin context），
// 本测试只消费其中的纯函数 getConversationDisplayTitle——按真实语义 mock。
jest.mock('../hooks/useChatHistory', () => ({
  getConversationDisplayTitle: (
    title: string | null | undefined,
    fallback: string,
  ): string => (title?.trim() ? title.trim() : fallback),
}))

describe('renderHistoryPane', () => {
  beforeEach(() => {
    installDomCompat()
  })

  it('opens the selected conversation through the shared opener', async () => {
    const parent = document.createElement('div')
    const openConversation = jest.fn().mockResolvedValue(undefined)
    const historyClient = {
      listChats: async () => [
        { id: 'conv-1', title: 'A', updatedAt: 1, schemaVersion: 1 },
      ],
      togglePinnedChat: async () => {},
      updateChatTitle: async () => {},
      retryChatTitle: async () => {},
    }

    await renderHistoryPane(
      parent,
      historyClient,
      openConversation,
      () => {},
      () => true,
      async () => {},
    )

    const row = parent.querySelector<HTMLElement>(
      '.yolo-chat-list-dropdown-item',
    )
    expect(row).not.toBeNull()

    row!.click()

    expect(openConversation).toHaveBeenCalledWith('conv-1')
  })

  it('deletes through the shared chat cleanup', async () => {
    const parent = document.createElement('div')
    const deleteConversation = jest.fn().mockResolvedValue(undefined)
    const historyClient = {
      listChats: async () => [
        { id: 'conv-1', title: 'A', updatedAt: 1, schemaVersion: 1 },
      ],
      togglePinnedChat: async () => {},
      updateChatTitle: async () => {},
      retryChatTitle: async () => {},
    }

    await renderHistoryPane(
      parent,
      historyClient,
      async () => {},
      () => {},
      () => true,
      deleteConversation,
    )

    parent.querySelector<HTMLButtonElement>('[aria-label="Delete"]')?.click()
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(deleteConversation).toHaveBeenCalledWith('conv-1')
  })
})
