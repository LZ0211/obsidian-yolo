/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import type { WorkspaceAccessPolicy } from '../../../types/assistant.types'
import type { WebChatConversation } from '../webAgentTypes'
import { WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import { type SaveChatRequest, registerChatRoutes } from './chatRoutes'
import { ConversationConflictError } from './routeUtils'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T | PromiseLike<T>) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve']
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

function waitForImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('chatRoutes', () => {
  it('accepts exact assistant group deletion input', async () => {
    const conversation = createConversation({
      id: 'chat-1',
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
    })
    const deleteHistoricalGroup = jest.fn().mockResolvedValue(conversation)
    const { router } = createHarness({
      findById: jest.fn().mockResolvedValue(conversation),
      deleteHistoricalGroup,
    })

    const response = await dispatch(
      router,
      'POST',
      '/api/chat/delete-history',
      {
        conversationId: 'chat-1',
        expectedRevision: 3,
        messageIds: ['assistant-1', 'tool-1'],
        expectedGenerations: { 'assistant-1': 0, 'tool-1': 0 },
      },
      { [WEB_SESSION_HEADER]: 'session-1' },
    )

    expect(response.statusCode).toBe(200)
    expect(deleteHistoricalGroup).toHaveBeenCalledWith({
      conversationId: 'chat-1',
      expectedRevision: 3,
      messageIds: ['assistant-1', 'tool-1'],
      expectedGenerations: { 'assistant-1': 0, 'tool-1': 0 },
    })
  })

  it('maps a delete CAS conflict to a refresh response', async () => {
    const conversation = createConversation({
      id: 'chat-1',
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
    })
    const { router } = createHarness({
      getChat: jest.fn().mockResolvedValue(conversation),
      deleteChat: jest.fn().mockRejectedValue(new ConversationConflictError()),
    })

    const response = await dispatch(
      router,
      'POST',
      '/api/chat/delete',
      { conversationId: 'chat-1' },
      { [WEB_SESSION_HEADER]: 'session-1' },
    )

    expect(response.statusCode).toBe(409)
    expect(response.jsonBody).toEqual({
      error: {
        code: 'conflict',
        message: 'Conversation changed — refresh and retry',
      },
    })
  })

  it('requires an authenticated web session to list chats', async () => {
    const { router } = createHarness()

    const res = await dispatch(router, 'GET', '/api/chat/list')

    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'session_expired',
        message: 'The web session has expired.',
      },
    })
  })

  it('lists only chats visible to the current session root binding', async () => {
    const listChats = jest.fn().mockResolvedValue([
      createConversation({
        id: 'chat-1',
        webBinding: {
          initialAgentId: 'agent-1',
          activeAgentId: 'agent-1',
          rootHash: 'root-1',
        },
      }),
      createConversation({
        id: 'chat-2',
        webBinding: {
          initialAgentId: 'agent-2',
          activeAgentId: 'agent-2',
          rootHash: 'root-2',
        },
      }),
      createConversation({
        id: 'legacy-chat',
      }),
    ])
    const { router, resolveChatBinding } = createHarness({ listChats })

    const res = await dispatch(router, 'GET', '/api/chat/list', undefined, {
      [WEB_SESSION_HEADER]: 'session-1',
    })

    expect(resolveChatBinding).toHaveBeenCalledWith('session-1')
    expect(listChats).toHaveBeenCalledWith()
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual([expect.objectContaining({ id: 'chat-1' })])
  })

  it('rejects runtime selector fields on protected chat routes', async () => {
    const { router } = createHarness()

    const listRes = await dispatch(
      router,
      'GET',
      '/api/chat/list?workspaceId=ws-a',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )
    expect(listRes.statusCode).toBe(400)
    expect(listRes.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message:
          'agentId, activeAgentId, agentInstanceId, rootHash, workspaceId, workspaceRoot, and client policy fields are not allowed on protected chat routes',
      },
    })

    const saveRes = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-1',
        messages: [],
        activeAgentId: 'agent-9',
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )
    expect(saveRes.statusCode).toBe(400)
    expect(saveRes.jsonBody).toEqual(listRes.jsonBody)
  })

  it.each([
    'workspaceRoot',
    'readAllowlist',
    'readDenylist',
    'writeDenylist',
    'workspacePolicy',
    'workspaceAccessPolicy',
    'readExtraIncludes',
    'readExcludes',
    'writeExcludes',
    'policy',
    'enabled',
  ])('rejects client file-policy field %s', async (field) => {
    const { router, saveChat } = createHarness()

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-1',
        messages: [],
        [field]: field === 'enabled' ? true : {},
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message:
          'agentId, activeAgentId, agentInstanceId, rootHash, workspaceId, workspaceRoot, and client policy fields are not allowed on protected chat routes',
      },
    })
    expect(saveChat).not.toHaveBeenCalled()
  })

  it('returns a chat when its persisted web root matches the session root', async () => {
    const chat = createConversation({
      id: 'chat-1',
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-2',
        rootHash: 'root-1',
      },
    })
    const { router } = createHarness({
      getChat: jest.fn().mockResolvedValue(chat),
    })

    const res = await dispatch(
      router,
      'GET',
      '/api/chat/get/chat-1',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual(chat)
  })

  it('returns 200 with a null body for an unknown conversation id', async () => {
    // 客户端标题生成会在 run 创建会话前探测 GET（getJsonOrNull 语义）；未知
    // id 是"没有数据"而非"访问错误"——200 + null 让网络层零 404 噪音，
    // 与 context.getChat 的 `WebChatConversation | null` 契约一致。
    const { router } = createHarness({
      getChat: jest.fn().mockResolvedValue(null),
    })

    const res = await dispatch(
      router,
      'GET',
      '/api/chat/get/chat-unknown',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toBeNull()
  })

  it('hides chats without a matching web root binding', async () => {
    const { router } = createHarness({
      getChat: jest.fn().mockResolvedValue(
        createConversation({
          id: 'chat-1',
          webBinding: {
            initialAgentId: 'agent-1',
            activeAgentId: 'agent-1',
            rootHash: 'root-2',
          },
        }),
      ),
    })

    const res = await dispatch(
      router,
      'GET',
      '/api/chat/get/chat-1',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(404)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'not_found',
        message: 'Not found',
      },
    })
  })

  it('hides same-root chats whose active agent is outside the session authorization', async () => {
    const hidden = createConversation({
      id: 'chat-1',
      webBinding: {
        initialAgentId: 'agent-3',
        activeAgentId: 'agent-3',
        rootHash: 'root-1',
      },
    })
    const { router } = createHarness({
      listChats: jest.fn().mockResolvedValue([hidden]),
      getChat: jest.fn().mockResolvedValue(hidden),
      binding: {
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
        allowedAgentIds: ['agent-1'],
        workspaceAccessPolicy: makeWorkspaceAccessPolicy(),
      },
    })

    const listRes = await dispatch(router, 'GET', '/api/chat/list', undefined, {
      [WEB_SESSION_HEADER]: 'session-1',
    })
    expect(listRes.statusCode).toBe(200)
    expect(listRes.jsonBody).toEqual([])

    const getRes = await dispatch(
      router,
      'GET',
      '/api/chat/get/chat-1',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )
    expect(getRes.statusCode).toBe(404)
  })

  it('hides orphaned web conversations from shared sessions', async () => {
    const orphaned = createConversation({
      id: 'chat-1',
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
        accessState: 'orphaned',
        orphanedReason: 'agent_deleted',
      },
    })
    const { router } = createHarness({
      listChats: jest.fn().mockResolvedValue([orphaned]),
      getChat: jest.fn().mockResolvedValue(orphaned),
    })

    const listRes = await dispatch(router, 'GET', '/api/chat/list', undefined, {
      [WEB_SESSION_HEADER]: 'session-1',
    })
    expect(listRes.statusCode).toBe(200)
    expect(listRes.jsonBody).toEqual([])

    const getRes = await dispatch(
      router,
      'GET',
      '/api/chat/get/chat-1',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )
    expect(getRes.statusCode).toBe(404)
  })

  it('saves a new chat with the current session binding metadata', async () => {
    const saveChat = jest.fn().mockResolvedValue(
      createConversation({
        id: 'chat-1',
        messages: [
          {
            id: 'm1',
            role: 'user',
            content: null,
            promptContent: 'hello',
            mentionables: [],
          },
        ],
        reasoningLevel: 'high',
        webBinding: {
          initialAgentId: 'agent-2',
          activeAgentId: 'agent-2',
          rootHash: 'root-1',
        },
      }),
    )
    const { router, findById } = createHarness({
      saveChat,
      findById: jest.fn().mockResolvedValue(null),
      binding: {
        activeAgentId: 'agent-2',
        rootHash: 'root-1',
        allowedAgentIds: ['agent-1', 'agent-2'],
        workspaceAccessPolicy: makeWorkspaceAccessPolicy(),
      },
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-1',
        messages: [{ id: 'm1', role: 'user', content: 'hello' }],
        reasoningLevel: 'high',
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(findById).toHaveBeenCalledWith('chat-1')
    expect(saveChat).toHaveBeenCalledWith({
      id: 'chat-1',
      messages: [{ id: 'm1', role: 'user', content: 'hello' }],
      overrides: undefined,
      conversationModelId: undefined,
      messageModelMap: undefined,
      activeBranchByUserMessageId: undefined,
      assistantGroupBoundaryMessageIds: undefined,
      reasoningLevel: 'high',
      compaction: undefined,
      touchUpdatedAt: undefined,
      webBinding: {
        initialAgentId: 'agent-2',
        activeAgentId: 'agent-2',
        rootHash: 'root-1',
      },
    })
    expect(res.statusCode).toBe(200)
  })

  it('saves a normalized compatible working directory for an empty conversation', async () => {
    const saveChat = jest.fn(async (request) =>
      createConversation({ ...request, id: request.id }),
    )
    const isVaultFolder = jest.fn(() => true)
    const { router } = createHarness({
      saveChat,
      findById: jest.fn().mockResolvedValue(null),
      isVaultFolder,
      binding: {
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
        allowedAgentIds: ['agent-1'],
        workspaceAccessPolicy: makeWorkspaceAccessPolicy(),
      },
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-1',
        messages: [],
        workingDirectory: '/Projects/Exam/',
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(200)
    expect(isVaultFolder).toHaveBeenCalledWith('/Projects/Exam')
    expect(saveChat).toHaveBeenCalledWith(
      expect.objectContaining({ workingDirectory: '/Projects/Exam' }),
    )
  })

  it('rejects a working directory outside the active Agent write policy', async () => {
    const { router, saveChat } = createHarness({
      isVaultFolder: jest.fn(() => true),
      binding: {
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
        allowedAgentIds: ['agent-1'],
        workspaceAccessPolicy: makeWorkspaceAccessPolicy(),
      },
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-1',
        messages: [],
        workingDirectory: '/Archive',
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message: 'workingDirectory is outside the active Agent file policy',
      },
    })
    expect(saveChat).not.toHaveBeenCalled()
  })

  it.each([null, 42, {}, []])(
    'rejects non-string workingDirectory value %#',
    async (workingDirectory) => {
      const { router, saveChat } = createHarness()

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/save',
        {
          id: 'chat-1',
          messages: [],
          workingDirectory,
        },
        {
          [WEB_SESSION_HEADER]: 'session-1',
        },
      )

      expect(res.statusCode).toBe(400)
      expect(res.jsonBody).toEqual({
        error: {
          code: 'invalid_request',
          message: 'workingDirectory must be a string',
        },
      })
      expect(saveChat).not.toHaveBeenCalled()
    },
  )

  it('rejects a directory change for a durable locked assistant-only conversation', async () => {
    const existing = createConversation({
      messages: [
        { id: 'assistant-1', role: 'assistant', content: 'kept' },
      ] as unknown as WebChatConversation['messages'],
      workingDirectory: '/Projects/Old',
      fileScopeLocked: true,
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
    } as Partial<WebChatConversation> & { fileScopeLocked?: boolean })
    const { router, saveChat } = createHarness({
      findById: jest.fn().mockResolvedValue(existing),
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-1',
        messages: existing.messages,
        workingDirectory: '/Projects/New',
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(409)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'conflict',
        message: 'Conversation working directory is locked',
      },
    })
    expect(saveChat).not.toHaveBeenCalled()
  })

  it.each(['/Projects/Missing', '/Projects/File.md'])(
    'rejects missing or non-folder working directory %s',
    async (workingDirectory) => {
      const { router, saveChat } = createHarness({
        isVaultFolder: jest.fn(() => false),
      })

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/save',
        {
          id: 'chat-1',
          messages: [],
          workingDirectory,
        },
        {
          [WEB_SESSION_HEADER]: 'session-1',
        },
      )

      expect(res.statusCode).toBe(400)
      expect(res.jsonBody).toEqual({
        error: {
          code: 'invalid_request',
          message: 'workingDirectory must be an existing Vault folder',
        },
      })
      expect(saveChat).not.toHaveBeenCalled()
    },
  )

  it.each([
    {
      label: 'add',
      existingWorkingDirectory: undefined,
      requestedWorkingDirectory: '/Projects/Exam',
    },
    {
      label: 'replace',
      existingWorkingDirectory: '/Projects/Old',
      requestedWorkingDirectory: '/Projects/Exam',
    },
  ])(
    'rejects $label workingDirectory after the conversation has started',
    async ({ existingWorkingDirectory, requestedWorkingDirectory }) => {
      const existing = createConversation({
        messages: [
          { id: 'user-1', role: 'user', content: 'started' },
        ] as unknown as WebChatConversation['messages'],
        workingDirectory: existingWorkingDirectory,
        webBinding: {
          initialAgentId: 'agent-1',
          activeAgentId: 'agent-1',
          rootHash: 'root-1',
        },
      })
      const { router, saveChat } = createHarness({
        findById: jest.fn().mockResolvedValue(existing),
      })

      const res = await dispatch(
        router,
        'POST',
        '/api/chat/save',
        {
          id: 'chat-1',
          messages: existing.messages,
          workingDirectory: requestedWorkingDirectory,
        },
        {
          [WEB_SESSION_HEADER]: 'session-1',
        },
      )

      expect(res.statusCode).toBe(409)
      expect(res.jsonBody).toEqual({
        error: {
          code: 'conflict',
          message: 'Conversation working directory is locked',
        },
      })
      expect(saveChat).not.toHaveBeenCalled()
    },
  )

  it('serializes first saves so one working directory wins and the conflict observes it', async () => {
    const store = new Map<string, WebChatConversation>()
    const firstSaveEntered = createDeferred<undefined>()
    const releaseFirstSave = createDeferred<undefined>()
    const secondFindStarted = createDeferred<undefined>()
    let findCount = 0
    let saveCount = 0
    const findById = jest.fn(async (id: string) => {
      findCount += 1
      if (findCount === 2) {
        secondFindStarted.resolve(undefined)
      }
      return store.get(id) ?? null
    })
    const saveChat = jest.fn(async (request: SaveChatRequest) => {
      saveCount += 1
      if (saveCount === 1) {
        firstSaveEntered.resolve(undefined)
        await releaseFirstSave.promise
      }
      const saved = createConversation(request)
      store.set(request.id, saved)
      return saved
    })
    const { router } = createHarness({ findById, saveChat })
    const headers = { [WEB_SESSION_HEADER]: 'session-1' }

    const firstResponse = dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-race',
        messages: [{ id: 'user-a', role: 'user', content: 'first' }],
        workingDirectory: '/Projects/Alpha',
      },
      headers,
    )
    await firstSaveEntered.promise

    const secondResponse = dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-race',
        messages: [{ id: 'user-b', role: 'user', content: 'second' }],
        workingDirectory: '/Projects/Beta',
      },
      headers,
    )
    await Promise.race([secondFindStarted.promise, waitForImmediate()])
    await Promise.resolve()
    releaseFirstSave.resolve(undefined)

    const [first, second] = await Promise.all([firstResponse, secondResponse])

    expect(first.statusCode).toBe(200)
    expect(second.statusCode).toBe(409)
    expect(second.jsonBody).toEqual({
      error: {
        code: 'conflict',
        message: 'Conversation working directory is locked',
      },
    })
    expect(store.get('chat-race')?.workingDirectory).toBe('/Projects/Alpha')
    expect(saveChat).toHaveBeenCalledTimes(1)
  })

  it('allows saves for different conversations to proceed independently', async () => {
    const releaseFirstSave = createDeferred<undefined>()
    const firstSaveEntered = createDeferred<undefined>()
    const otherSaveEntered = createDeferred<undefined>()
    const saveChat = jest.fn(async (request: SaveChatRequest) => {
      if (request.id === 'chat-a') {
        firstSaveEntered.resolve(undefined)
        await releaseFirstSave.promise
      } else {
        otherSaveEntered.resolve(undefined)
      }
      return createConversation(request)
    })
    const { router } = createHarness({ saveChat })
    const headers = { [WEB_SESSION_HEADER]: 'session-1' }

    const firstResponse = dispatch(
      router,
      'POST',
      '/api/chat/save',
      { id: 'chat-a', messages: [] },
      headers,
    )
    await firstSaveEntered.promise
    const otherResponse = dispatch(
      router,
      'POST',
      '/api/chat/save',
      { id: 'chat-b', messages: [] },
      headers,
    )

    const otherStartedBeforeRelease = await Promise.race([
      otherSaveEntered.promise.then(() => true),
      waitForImmediate().then(() => false),
    ])
    releaseFirstSave.resolve(undefined)
    const [first, other] = await Promise.all([firstResponse, otherResponse])

    expect(otherStartedBeforeRelease).toBe(true)
    expect(first.statusCode).toBe(200)
    expect(other.statusCode).toBe(200)
  })

  it('maps persisted working-directory lock errors to conflict and releases the queue', async () => {
    const saveChat = jest
      .fn<Promise<WebChatConversation | null>, [SaveChatRequest]>()
      .mockRejectedValueOnce(
        new Error('Conversation working directory is locked'),
      )
      .mockImplementationOnce(async (request) => createConversation(request))
    const { router } = createHarness({ saveChat })
    const headers = { [WEB_SESSION_HEADER]: 'session-1' }

    const conflictResponse = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-lock',
        messages: [],
        workingDirectory: '/Projects/Alpha',
      },
      headers,
    )
    const retryResponse = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-lock',
        messages: [],
        workingDirectory: '/Projects/Alpha',
      },
      headers,
    )

    expect(conflictResponse.statusCode).toBe(409)
    expect(conflictResponse.jsonBody).toEqual({
      error: {
        code: 'conflict',
        message: 'Conversation working directory is locked',
      },
    })
    expect(retryResponse.statusCode).toBe(200)
    expect(saveChat).toHaveBeenCalledTimes(2)
  })

  it('updates an existing chat only when its persisted web root matches the session root', async () => {
    const existing = createConversation({
      id: 'chat-1',
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
    })
    const saveChat = jest.fn().mockResolvedValue(
      createConversation({
        ...existing,
        messages: [{ id: 'm1', role: 'assistant', content: 'saved' }],
        webBinding: {
          initialAgentId: 'agent-1',
          activeAgentId: 'agent-2',
          rootHash: 'root-1',
        },
      }),
    )
    const { router } = createHarness({
      saveChat,
      findById: jest.fn().mockResolvedValue(existing),
      binding: {
        activeAgentId: 'agent-2',
        rootHash: 'root-1',
        allowedAgentIds: ['agent-1', 'agent-2'],
        workspaceAccessPolicy: makeWorkspaceAccessPolicy(),
      },
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-1',
        messages: [{ id: 'm1', role: 'assistant', content: 'saved' }],
        touchUpdatedAt: false,
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(saveChat).toHaveBeenCalledWith({
      id: 'chat-1',
      messages: [{ id: 'm1', role: 'assistant', content: 'saved' }],
      overrides: undefined,
      conversationModelId: undefined,
      messageModelMap: undefined,
      activeBranchByUserMessageId: undefined,
      assistantGroupBoundaryMessageIds: undefined,
      reasoningLevel: undefined,
      compaction: undefined,
      touchUpdatedAt: false,
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-2',
        rootHash: 'root-1',
      },
    })
    expect(res.statusCode).toBe(200)
  })

  it('fails closed for existing chats missing a web binding', async () => {
    const { router } = createHarness({
      findById: jest.fn().mockResolvedValue(
        createConversation({
          id: 'chat-1',
        }),
      ),
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/save',
      {
        id: 'chat-1',
        messages: [],
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(res.statusCode).toBe(404)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'not_found',
        message: 'Not found',
      },
    })
  })

  it('updates title for chats within the current session root', async () => {
    const updateChat = jest.fn().mockResolvedValue(
      createConversation({
        id: 'chat-1',
        title: 'Renamed',
        webBinding: {
          initialAgentId: 'agent-1',
          activeAgentId: 'agent-1',
          rootHash: 'root-1',
        },
      }),
    )
    const { router } = createHarness({
      updateChat,
      findById: jest.fn().mockResolvedValue(
        createConversation({
          id: 'chat-1',
          webBinding: {
            initialAgentId: 'agent-1',
            activeAgentId: 'agent-1',
            rootHash: 'root-1',
          },
        }),
      ),
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/update-title',
      { id: 'chat-1', title: 'Renamed', touchUpdatedAt: false },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(updateChat).toHaveBeenCalledWith(
      'chat-1',
      { title: 'Renamed' },
      { touchUpdatedAt: false },
    )
    expect(res.statusCode).toBe(200)
  })

  it('toggles pinned state for chats within the current session root', async () => {
    const updateChat = jest.fn().mockResolvedValue(
      createConversation({
        id: 'chat-1',
        isPinned: true,
        pinnedAt: 123,
        webBinding: {
          initialAgentId: 'agent-1',
          activeAgentId: 'agent-1',
          rootHash: 'root-1',
        },
      }),
    )
    const { router } = createHarness({
      updateChat,
      findById: jest.fn().mockResolvedValue(
        createConversation({
          id: 'chat-1',
          isPinned: false,
          webBinding: {
            initialAgentId: 'agent-1',
            activeAgentId: 'agent-1',
            rootHash: 'root-1',
          },
        }),
      ),
    })

    const realNow = Date.now
    Date.now = jest.fn(() => 123)
    try {
      const res = await dispatch(
        router,
        'POST',
        '/api/chat/toggle-pinned',
        { id: 'chat-1' },
        {
          [WEB_SESSION_HEADER]: 'session-1',
        },
      )

      expect(updateChat).toHaveBeenCalledWith('chat-1', {
        isPinned: true,
        pinnedAt: 123,
      })
      expect(res.statusCode).toBe(200)
    } finally {
      Date.now = realNow
    }
  })

  it('forwards title generation only for chats within the current session root', async () => {
    const existing = createConversation({
      id: 'chat-1',
      title: 'New chat',
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
    })
    const updated = createConversation({
      ...existing,
      title: 'Generated title',
    })
    const generateTitle = jest.fn().mockResolvedValue(undefined)
    const findById = jest
      .fn()
      .mockResolvedValueOnce(existing)
      .mockResolvedValueOnce(updated)
    const { router } = createHarness({
      generateTitle,
      findById,
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/generate-title',
      {
        conversationId: 'chat-1',
        messages: [{ id: 'm1', role: 'user', content: 'hello' }],
        force: true,
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(generateTitle).toHaveBeenCalledWith({
      conversationId: 'chat-1',
      messages: [{ id: 'm1', role: 'user', content: 'hello' }],
      force: true,
    })
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ title: 'Generated title' })
  })

  it('forwards export only for chats within the current session root', async () => {
    const exportToVault = jest.fn().mockResolvedValue({
      path: 'Exports/One.md',
    })
    const { router } = createHarness({
      exportToVault,
      findById: jest.fn().mockResolvedValue(
        createConversation({
          id: 'chat-1',
          webBinding: {
            initialAgentId: 'agent-1',
            activeAgentId: 'agent-1',
            rootHash: 'root-1',
          },
        }),
      ),
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/export',
      { conversationId: 'chat-1' },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(exportToVault).toHaveBeenCalledWith('chat-1')
    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual({ path: 'Exports/One.md' })
  })

  it('patches conversation metadata through the whitelisted patch route', async () => {
    const updateChat = jest.fn().mockResolvedValue(
      createConversation({
        id: 'chat-1',
        conversationModelId: 'model-2',
        webBinding: {
          initialAgentId: 'agent-1',
          activeAgentId: 'agent-1',
          rootHash: 'root-1',
        },
      }),
    )
    const { router } = createHarness({
      updateChat,
      findById: jest.fn().mockResolvedValue(
        createConversation({
          id: 'chat-1',
          webBinding: {
            initialAgentId: 'agent-1',
            activeAgentId: 'agent-1',
            rootHash: 'root-1',
          },
        }),
      ),
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/patch-metadata',
      {
        id: 'chat-1',
        patch: { conversationModelId: 'model-2', reasoningLevel: 'high' },
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(updateChat).toHaveBeenCalledWith(
      'chat-1',
      { conversationModelId: 'model-2', reasoningLevel: 'high' },
      { touchUpdatedAt: true },
    )
    expect(res.statusCode).toBe(200)
  })

  it('rejects unsupported metadata keys in the patch route', async () => {
    const updateChat = jest.fn()
    const { router } = createHarness({
      updateChat,
      findById: jest.fn().mockResolvedValue(
        createConversation({
          id: 'chat-1',
          webBinding: {
            initialAgentId: 'agent-1',
            activeAgentId: 'agent-1',
            rootHash: 'root-1',
          },
        }),
      ),
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/patch-metadata',
      {
        id: 'chat-1',
        patch: { arbitraryInjectedKey: true },
      },
      {
        [WEB_SESSION_HEADER]: 'session-1',
      },
    )

    expect(updateChat).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(400)
  })

  it('rejects a non-string working directory in the patch route', async () => {
    const updateChat = jest.fn()
    const { router } = createHarness({
      updateChat,
      findById: jest.fn().mockResolvedValue(
        createConversation({
          id: 'chat-1',
          webBinding: {
            initialAgentId: 'agent-1',
            activeAgentId: 'agent-1',
            rootHash: 'root-1',
          },
        }),
      ),
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/patch-metadata',
      { id: 'chat-1', patch: { workingDirectory: null } },
      { [WEB_SESSION_HEADER]: 'session-1' },
    )

    expect(updateChat).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(400)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message: 'workingDirectory must be a string',
      },
    })
  })

  it('normalizes and validates working directory metadata before updating', async () => {
    const existing = createConversation({
      id: 'chat-1',
      workingDirectory: '/Projects',
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
    })
    const updateChat = jest.fn().mockResolvedValue(existing)
    const isVaultFolder = jest.fn(() => true)
    const { router } = createHarness({
      updateChat,
      isVaultFolder,
      findById: jest.fn().mockResolvedValue(existing),
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/patch-metadata',
      { id: 'chat-1', patch: { workingDirectory: '/Projects/Exam/' } },
      { [WEB_SESSION_HEADER]: 'session-1' },
    )

    expect(isVaultFolder).toHaveBeenCalledWith('/Projects/Exam')
    expect(updateChat).toHaveBeenCalledWith(
      'chat-1',
      { workingDirectory: '/Projects/Exam' },
      { touchUpdatedAt: true },
    )
    expect(res.statusCode).toBe(200)
  })

  it.each([
    {
      label: 'a missing Vault folder',
      requested: '/Projects/Missing',
      isVaultFolder: () => false,
      locked: false,
      statusCode: 400,
      message: 'workingDirectory must be an existing Vault folder',
    },
    {
      label: 'a directory outside the Agent policy',
      requested: '/Archive',
      isVaultFolder: () => true,
      locked: false,
      statusCode: 400,
      message: 'workingDirectory is outside the active Agent file policy',
    },
    {
      label: 'a directory change after the file scope locks',
      requested: '/Projects/New',
      isVaultFolder: () => true,
      locked: true,
      statusCode: 409,
      message: 'Conversation working directory is locked',
    },
  ])('rejects $label in the metadata patch route', async (testCase) => {
    const existing = createConversation({
      id: 'chat-1',
      messages: testCase.locked
        ? ([
            { id: 'assistant-1', role: 'assistant', content: 'kept' },
          ] as unknown as WebChatConversation['messages'])
        : [],
      workingDirectory: '/Projects/Old',
      fileScopeLocked: testCase.locked,
      webBinding: {
        initialAgentId: 'agent-1',
        activeAgentId: 'agent-1',
        rootHash: 'root-1',
      },
    } as Partial<WebChatConversation> & { fileScopeLocked?: boolean })
    const updateChat = jest.fn()
    const { router } = createHarness({
      updateChat,
      isVaultFolder: jest.fn(testCase.isVaultFolder),
      findById: jest.fn().mockResolvedValue(existing),
    })

    const res = await dispatch(
      router,
      'POST',
      '/api/chat/patch-metadata',
      { id: 'chat-1', patch: { workingDirectory: testCase.requested } },
      { [WEB_SESSION_HEADER]: 'session-1' },
    )

    expect(updateChat).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(testCase.statusCode)
    expect(res.jsonBody).toEqual({
      error: {
        code: testCase.statusCode === 409 ? 'conflict' : 'invalid_request',
        message: testCase.message,
      },
    })
  })
})

function createHarness(
  overrides: Partial<Parameters<typeof registerChatRoutes>[1]> & {
    binding?: {
      activeAgentId: string
      rootHash: string
      allowedAgentIds: string[]
      workspaceAccessPolicy: WorkspaceAccessPolicy
    }
    isVaultFolder?: (path: string) => boolean
  } = {},
) {
  const router = new WebRouter()
  const resolveChatBinding = jest
    .fn()
    .mockImplementation((sessionId: string | null) => {
      if (!sessionId) {
        return {
          ok: false as const,
          statusCode: 401,
          body: {
            error: {
              code: 'session_expired',
              message: 'The web session has expired.',
            },
          },
        }
      }
      return {
        ok: true as const,
        binding: overrides.binding ?? {
          activeAgentId: 'agent-1',
          rootHash: 'root-1',
          allowedAgentIds: ['agent-1', 'agent-2'],
          workspaceAccessPolicy: makeWorkspaceAccessPolicy(),
        },
      }
    })
  const findById = overrides.findById ?? jest.fn()
  const saveChat =
    overrides.saveChat ??
    jest.fn(async (request) => ({
      ...createConversation({ id: request.id }),
      ...request,
    }))
  const isVaultFolder = overrides.isVaultFolder ?? jest.fn(() => true)

  registerChatRoutes(router, {
    listChats: overrides.listChats ?? jest.fn().mockResolvedValue([]),
    getChat: overrides.getChat ?? jest.fn(),
    deleteChat: overrides.deleteChat ?? jest.fn(),
    saveChat,
    generateTitle: overrides.generateTitle ?? jest.fn(),
    exportToVault:
      overrides.exportToVault ??
      jest.fn().mockResolvedValue({ path: 'Exports/One.md' }),
    createChat: overrides.createChat ?? jest.fn(),
    updateChat: overrides.updateChat ?? jest.fn(),
    appendMessages:
      overrides.appendMessages ??
      jest.fn().mockResolvedValue({ ok: true, updatedAt: Date.now() }),
    deleteHistoricalGroup: overrides.deleteHistoricalGroup,
    findById,
    resolveChatBinding,
    isVaultFolder,
  })

  return {
    router,
    resolveChatBinding,
    findById,
    saveChat,
    isVaultFolder,
  }
}

function makeWorkspaceAccessPolicy(): WorkspaceAccessPolicy {
  return {
    enabled: true,
    workspaceRoot: '/Projects',
    readExtraIncludes: [],
    readExcludes: [],
    writeExcludes: [],
  }
}

function createConversation(
  overrides: Partial<WebChatConversation> = {},
): WebChatConversation {
  return {
    id: 'chat-1',
    title: 'One',
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    schemaVersion: 1,
    ...overrides,
  }
}

async function dispatch(
  router: WebRouter,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const resolved = router.resolve(method, url)
  if (!resolved) {
    throw new Error(`missing route: ${method} ${url}`)
  }
  const req = createRequest({ method, url, body, headers })
  const res = createResponse()
  await resolved.handler(req as never, res as never, resolved.params)
  return res
}

function createRequest({
  method,
  url,
  body,
  headers,
}: {
  method: string
  url: string
  body?: unknown
  headers?: Record<string, string>
}) {
  const chunks =
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const stream = Readable.from(chunks) as Readable &
    EventEmitter & {
      method?: string
      url?: string
      headers: Record<string, string>
    }
  stream.method = method
  stream.url = url
  stream.headers = headers ?? {}
  return stream
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    setHeader: (name: string, value: string) => void
    end: (chunk?: string) => void
    write: (chunk: string) => void
    jsonBody: unknown
  }
  response.statusCode = 200
  response.writableEnded = false
  response.setHeader = () => {}
  response.write = (chunk) => {
    rawBody += chunk
  }
  response.end = (chunk) => {
    if (chunk) {
      rawBody += chunk
    }
    response.writableEnded = true
  }
  Object.defineProperty(response, 'jsonBody', {
    get() {
      return rawBody ? (JSON.parse(rawBody) as unknown) : null
    },
  })
  return response
}
