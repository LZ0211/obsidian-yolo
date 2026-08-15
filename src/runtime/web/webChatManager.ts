import { EmptyChatTitleException } from '../../database/json/exception'
import type { ChatManager } from '../../database/json/chat/ChatManager'
import type {
  ChatConversation,
  ChatConversationMetadata,
} from '../../database/json/chat/types'
import type { SaveYoloChatInput, YoloRuntime } from '../yoloRuntime.types'

/**
 * Web 端的 ChatManager 等价物：把 Chat 组件/useChatHistory 消费的
 * 5 个持久化方法（listChats/findById/createChat/updateChat/deleteChat）
 * 映射到服务端 /api/chat/* 路由（session 作用域）。
 *
 * 为什么不能复用客户端本地 ChatManager：web 端会话由服务器端 AgentService
 * 持久化（直接写 vault 文件，origin=external-agent），客户端内存缓存看不到
 * 这些写入——本地 ChatManager 的 list/findById 会永远错过它们（表现为
 * 自动重命名 conversation_missing、下拉清单数据陈旧/跨 agent）。
 */
export type ChatClient = {
  list: YoloRuntime['chat']['list']
  get: YoloRuntime['chat']['get']
  save: YoloRuntime['chat']['save']
  delete: YoloRuntime['chat']['delete']
  updateTitle: YoloRuntime['chat']['updateTitle']
  patchMetadata: NonNullable<YoloRuntime['chat']['patchMetadata']>
}

export type WebChatManager = Pick<
  ChatManager,
  'listChats' | 'findById' | 'createChat' | 'updateChat' | 'deleteChat'
>

type ConversationUpdates = Parameters<ChatManager['updateChat']>[1]

export function createWebChatManager(chat: ChatClient): WebChatManager {
  const findById = async (id: string): Promise<ChatConversation | null> =>
    (await chat.get(id)) as ChatConversation | null

  const listChats = (): Promise<ChatConversationMetadata[]> => chat.list()

  const createChat = async (
    initialData: Partial<ChatConversation>,
  ): Promise<ChatConversation> => {
    if (initialData.title !== undefined && initialData.title.length === 0) {
      throw new EmptyChatTitleException()
    }
    const id = initialData.id ?? crypto.randomUUID()
    const input = {
      id,
      title: initialData.title,
      messages: initialData.messages ?? [],
      assistantId: initialData.assistantId,
      overrides: initialData.overrides,
      conversationModelId: initialData.conversationModelId,
      messageModelMap: initialData.messageModelMap,
      activeBranchByUserMessageId: initialData.activeBranchByUserMessageId,
      assistantGroupBoundaryMessageIds:
        initialData.assistantGroupBoundaryMessageIds,
      reasoningLevel: initialData.reasoningLevel,
      compaction: initialData.compaction,
      workingDirectory: initialData.workingDirectory,
      touchUpdatedAt: true,
    } as SaveYoloChatInput
    await chat.save(input)
    const created = await chat.get(id)
    if (!created) throw new Error('conversation_create_failed:not_found')
    return created as ChatConversation
  }

  const updateChat = async (
    id: string,
    updates: ConversationUpdates,
    options?: { touchUpdatedAt?: boolean },
  ): Promise<ChatConversation | null> => {
    if (updates.title !== undefined && updates.title.length === 0) {
      throw new EmptyChatTitleException()
    }

    if ('messages' in updates) {
      const current = await chat.get(id)
      if (!current) return null
      // 消息更新走全量 save（服务端 update 路由拒绝 messages 补丁）。
      // updates.messages 是持久化链路上的 wire 形态（serialize + compact），
      // 服务端原样落库、读取时再反序列化——此处不得二次序列化。
      const input = {
        id,
        messages: updates.messages,
        assistantId: updates.assistantId,
        overrides: updates.overrides,
        conversationModelId: updates.conversationModelId,
        messageModelMap: updates.messageModelMap,
        activeBranchByUserMessageId: updates.activeBranchByUserMessageId,
        assistantGroupBoundaryMessageIds: updates.assistantGroupBoundaryMessageIds,
        reasoningLevel: updates.reasoningLevel,
        compaction: updates.compaction,
        workingDirectory: updates.workingDirectory,
        touchUpdatedAt: options?.touchUpdatedAt,
      } as SaveYoloChatInput
      await chat.save(input)
      return (await chat.get(id)) as ChatConversation | null
    }

    if (updates.title !== undefined) {
      await chat.updateTitle(id, updates.title, options)
    }
    const patch: Record<string, unknown> = { ...updates }
    delete patch.title
    delete patch.messages
    if (Object.keys(patch).length > 0) {
      await chat.patchMetadata(id, patch)
    }
    return (await chat.get(id)) as ChatConversation | null
  }

  const deleteChat = async (id: string): Promise<boolean> => {
    const current = await chat.get(id)
    if (!current) return false
    await chat.delete(id)
    return true
  }

  return { listChats, findById, createChat, updateChat, deleteChat }
}
