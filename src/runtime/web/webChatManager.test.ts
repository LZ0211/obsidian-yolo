import { EmptyChatTitleException } from '../../database/json/exception'
import type { ChatConversation } from '../../types/chat'
import type { ChatClient } from './webChatManager'

import { createWebChatManager } from './webChatManager'

function makeRecord(overrides: Partial<ChatConversation> = {}): ChatConversation {
  return {
    id: 'chat-1',
    schemaVersion: 1,
    createdAt: 1,
    updatedAt: 2,
    title: 'Titled',
    messages: [],
    ...overrides,
  } as ChatConversation
}

function makeClient(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    list: jest.fn(async () => []),
    get: jest.fn(async () => null),
    save: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
    updateTitle: jest.fn(async () => undefined),
    patchMetadata: jest.fn(async () => undefined),
    ...overrides,
  } as unknown as ChatClient
}

describe('createWebChatManager', () => {
  it('passes listChats through to the server-scoped chat client', async () => {
    const metadata = [
      { id: 'a', title: 'A', updatedAt: 1, schemaVersion: 1, isPinned: false },
    ]
    const client = makeClient({ list: jest.fn(async () => metadata) })
    const manager = createWebChatManager(client)

    await expect(manager.listChats()).resolves.toBe(metadata)
    expect(client.list).toHaveBeenCalledWith()
  })

  it('passes findById through to chat.get', async () => {
    const record = makeRecord()
    const client = makeClient({ get: jest.fn(async (id: string) =>
      id === 'chat-1' ? (record as never) : null,
    ) })
    const manager = createWebChatManager(client)

    await expect(manager.findById('chat-1')).resolves.toBe(record)
    await expect(manager.findById('missing')).resolves.toBeNull()
  })

  it('creates a conversation via save and returns the stored record', async () => {
    const record = makeRecord({ id: 'new-chat', title: 'New chat' })
    const client = makeClient({
      save: jest.fn(async () => undefined),
      get: jest.fn(async () => record as never),
    })
    const manager = createWebChatManager(client)

    const created = await manager.createChat({ id: 'new-chat', messages: [] })

    expect(created).toBe(record)
    expect(client.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'new-chat' }),
    )
  })

  it('generates an id when createChat is called without one', async () => {
    const client = makeClient({
      save: jest.fn(async () => undefined),
      get: jest.fn(async () => makeRecord({ id: 'generated' }) as never),
    })
    const manager = createWebChatManager(client)
    const randomSpy = jest
      .spyOn(globalThis.crypto, 'randomUUID')
      .mockReturnValue('generated' as never)

    await manager.createChat({ messages: [] })

    expect(client.save).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'generated' }),
    )
    randomSpy.mockRestore()
  })

  it('throws EmptyChatTitleException for an empty title on create', async () => {
    const manager = createWebChatManager(makeClient())

    await expect(
      manager.createChat({ id: 'x', title: '' }),
    ).rejects.toBeInstanceOf(EmptyChatTitleException)
  })

  it('persists message updates through save with the wire-form messages', async () => {
    const client = makeClient({
      get: jest.fn(async () => makeRecord({ id: 'chat-1' }) as never),
      save: jest.fn(async () => undefined),
    })
    const manager = createWebChatManager(client)
    const wireMessages = [{ role: 'user', content: 'hi' }]

    await manager.updateChat(
      'chat-1',
      { messages: wireMessages as never },
      { touchUpdatedAt: true },
    )

    expect(client.save).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chat-1',
        messages: wireMessages,
        touchUpdatedAt: true,
      }),
    )
    expect(client.updateTitle).not.toHaveBeenCalled()
  })

  it('returns null from updateChat when the conversation does not exist', async () => {
    const client = makeClient({ get: jest.fn(async () => null) })
    const manager = createWebChatManager(client)

    await expect(
      manager.updateChat('missing', { messages: [] }),
    ).resolves.toBeNull()
    expect(client.save).not.toHaveBeenCalled()
  })

  it('routes title updates to updateTitle and remaining metadata to patchMetadata', async () => {
    const record = makeRecord({ id: 'chat-1' })
    const client = makeClient({
      get: jest.fn(async () => record as never),
      updateTitle: jest.fn(async () => undefined),
      patchMetadata: jest.fn(async () => undefined),
    })
    const manager = createWebChatManager(client)

    const updated = await manager.updateChat('chat-1', {
      title: 'Renamed',
      isPinned: true,
      pinnedAt: 3,
    })

    expect(client.updateTitle).toHaveBeenCalledWith('chat-1', 'Renamed', undefined)
    expect(client.patchMetadata).toHaveBeenCalledWith('chat-1', {
      isPinned: true,
      pinnedAt: 3,
    })
    expect(updated).toBe(record)
  })

  it('throws EmptyChatTitleException for an empty title update', async () => {
    const manager = createWebChatManager(makeClient())

    await expect(
      manager.updateChat('chat-1', { title: '' }),
    ).rejects.toBeInstanceOf(EmptyChatTitleException)
  })

  it('deletes an existing conversation and reports success', async () => {
    const client = makeClient({
      get: jest.fn(async () => makeRecord() as never),
      delete: jest.fn(async () => undefined),
    })
    const manager = createWebChatManager(client)

    await expect(manager.deleteChat('chat-1')).resolves.toBe(true)
    expect(client.delete).toHaveBeenCalledWith('chat-1')
  })

  it('reports false when deleting a missing conversation', async () => {
    const client = makeClient({ get: jest.fn(async () => null) })
    const manager = createWebChatManager(client)

    await expect(manager.deleteChat('missing')).resolves.toBe(false)
    expect(client.delete).not.toHaveBeenCalled()
  })
})
