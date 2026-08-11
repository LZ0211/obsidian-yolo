/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块 */
import { randomUUID } from 'node:crypto'

import type { ChatUserMessage } from '../../types/chat'
import type { YoloChatRecord } from '../yoloRuntime.types'

import { createWebConversationGateway } from './WebConversationGateway'
import type { ConversationCommand } from './webConversationTypes'

const makeUserMessage = (id: string): ChatUserMessage =>
  ({
    id,
    role: 'user',
    content: 'hello',
    promptContent: 'hello',
    mentionables: [],
    selectedSkills: [],
    selectedModelIds: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    messageGeneration: 0,
  }) as unknown as ChatUserMessage

const makeCommand = (
  draft: Pick<ConversationCommand, 'type' | 'conversationId'> &
    Partial<ConversationCommand>,
): ConversationCommand =>
  ({
    commandId: `test:${randomUUID()}`,
    payloadFingerprint: `fp:${randomUUID()}`,
    correlationId: 'test',
    producer: 'chat',
    ...draft,
  }) as ConversationCommand

describe('createWebConversationGateway', () => {
  it('keeps a missing conversation at sequence 0 so the first submit creates it', async () => {
    const saves: unknown[] = []
    const appends: unknown[] = []
    const records = new Map<string, unknown>()
    const chat = {
      list: async () => [] as YoloChatRecord[],
      get: async (id: string) => records.get(id) ?? null,
      save: async (input: unknown) => {
        const record = {
          id: (input as { id: string }).id,
          title: '',
          messages: (input as { messages: unknown[] }).messages ?? [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revision: 1,
        }
        records.set(record.id, record)
        saves.push(input)
        return record
      },
      appendMessages: async (input: unknown) => {
        appends.push(input)
        return { conflict: false }
      },
      editHistoricalTurn: async () => null,
      deleteHistoricalGroup: async () => null,
      claimHistoricalRetry: async () => null,
      delete: async () => true,
      updateTitle: async () => {},
      generateTitle: async () => null,
    }
    const gateway = createWebConversationGateway({ getChat: () => chat as never })

    await gateway.ensureHydrated('conv-new')
    const hydrated = gateway.getSnapshot('conv-new')
    // 回归点：缺失会话水合后 sequence 必须是 0，客户端 persistConversation
    // 才会走 create_conversation；之前误为 1 导致直接 append 404。
    expect(hydrated.sequence).toBe(0)

    const createResult = await gateway.dispatch(
      makeCommand({
        type: 'create_conversation',
        conversationId: 'conv-new',
        title: { kind: 'untitled' },
        metadata: { createdAt: 1, updatedAt: 1 },
        expectedSequence: 0,
      }),
    ).settled
    expect(createResult.status).toBe('accepted')
    expect(saves).toHaveLength(1)

    const submitResult = await gateway.dispatch(
      makeCommand({
        type: 'submit_user_message',
        conversationId: 'conv-new',
        submissionId: 'msg-1',
        message: makeUserMessage('msg-1'),
        expectedSequence: 1,
      }),
    ).settled
    expect(submitResult.status).toBe('accepted')
    expect(appends).toHaveLength(1)
    expect(
      (appends[0] as { baseCount: number }).baseCount,
    ).toBe(0)
  })

  it('preserves the deleted marker when a deleted conversation refreshes to 404', async () => {
    const records = new Map<string, unknown>()
    const chat = {
      list: async () => [] as YoloChatRecord[],
      get: async (id: string) => records.get(id) ?? null,
      save: async (input: unknown) => {
        const record = {
          id: (input as { id: string }).id,
          title: '',
          messages: [] as unknown[],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revision: 1,
        }
        records.set(record.id, record)
        return record
      },
      appendMessages: async () => ({ conflict: false }),
      editHistoricalTurn: async () => null,
      deleteHistoricalGroup: async () => null,
      claimHistoricalRetry: async () => null,
      delete: async () => true,
      updateTitle: async () => {},
      generateTitle: async () => null,
    }
    const gateway = createWebConversationGateway({ getChat: () => chat as never })
    await gateway.ensureHydrated('conv-del')

    await gateway.dispatch(
      makeCommand({
        type: 'delete_conversation',
        conversationId: 'conv-del',
        expectedSequence: 0,
      }),
    ).settled
    expect(gateway.getSnapshot('conv-del').sequence).toBeGreaterThan(0)

    await gateway.ensureHydrated('conv-del')
    // 已删除会话 refresh 后仍保持已存在状态（sequence > 0），不能退化成
    // 新会话（sequence 0），否则删除后再次提交会悄悄重建。
    expect(gateway.getSnapshot('conv-del').sequence).toBeGreaterThan(0)
  })

  it('forceRefreshConversation re-syncs a hydrated projection from the server', async () => {
    const records = new Map<string, unknown>()
    const chat = {
      list: async () => [] as YoloChatRecord[],
      get: async (id: string) => records.get(id) ?? null,
      save: async (input: unknown) => {
        const record = {
          id: (input as { id: string }).id,
          title: '',
          messages: (input as { messages: unknown[] }).messages ?? [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revision: 1,
        }
        records.set(record.id, record)
        return record
      },
      appendMessages: async () => ({ conflict: false }),
      editHistoricalTurn: async () => null,
      deleteHistoricalGroup: async () => null,
      claimHistoricalRetry: async () => null,
      delete: async () => true,
      updateTitle: async () => {},
      generateTitle: async () => null,
    }
    const gateway = createWebConversationGateway({ getChat: () => chat as never })

    await gateway.dispatch(
      makeCommand({
        type: 'create_conversation',
        conversationId: 'conv-stale',
        title: { kind: 'untitled' },
        metadata: { createdAt: 1, updatedAt: 1 },
        expectedSequence: 0,
      }),
    ).settled
    // 水合后的本地投影：只有创建时的空记录。
    expect(gateway.getSnapshot('conv-stale').timelineIds).toEqual([])

    // 服务端（同一 chat 存储）在 run 完成后持久化了助手回复。
    const record = records.get('conv-stale') as {
      messages: Array<{ id: string }>
      revision: number
    }
    record.messages = [
      { id: 'u1' } as { id: string },
      { id: 'a1' } as { id: string },
    ]
    record.revision = 3

    // 历史加载前强制刷新 → 本地投影同步到服务端最新。
    await gateway.forceRefreshConversation('conv-stale')
    expect(gateway.getSnapshot('conv-stale').timelineIds).toEqual(['u1', 'a1'])
    expect(gateway.getSnapshot('conv-stale').sequence).toBeGreaterThanOrEqual(3)
  })

  it('re-syncs a stale projection before a later submit so append uses the current baseCount', async () => {
    const records = new Map<string, unknown>()
    const appends: unknown[] = []
    const chat = {
      list: async () => [] as YoloChatRecord[],
      get: async (id: string) => records.get(id) ?? null,
      save: async (input: unknown) => {
        const current = records.get((input as { id: string }).id) as
          | { messages: unknown[]; revision: number }
          | undefined
        const record = {
          id: (input as { id: string }).id,
          title: '',
          messages: (input as { messages: unknown[] }).messages ?? [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          revision: (current?.revision ?? 0) + 1,
        }
        records.set(record.id, record)
        return record
      },
      appendMessages: async (input: {
        id: string
        baseCount: number
        newMessages: Array<{ id: string }>
      }) => {
        appends.push(input)
        const current = records.get(input.id) as {
          messages: Array<{ id: string }>
          revision: number
        }
        if (current.messages.length !== input.baseCount) {
          return { conflict: true }
        }
        current.messages = [...current.messages, ...input.newMessages]
        current.revision += 1
        return { conflict: false }
      },
      editHistoricalTurn: async () => null,
      deleteHistoricalGroup: async () => null,
      claimHistoricalRetry: async () => null,
      delete: async () => true,
      updateTitle: async () => {},
      generateTitle: async () => null,
    }
    const gateway = createWebConversationGateway({ getChat: () => chat as never })

    await gateway.dispatch(
      makeCommand({
        type: 'create_conversation',
        conversationId: 'conv-later-submit',
        title: { kind: 'untitled' },
        metadata: { createdAt: 1, updatedAt: 1 },
        expectedSequence: 0,
      }),
    ).settled
    await gateway.dispatch(
      makeCommand({
        type: 'submit_user_message',
        conversationId: 'conv-later-submit',
        submissionId: 'u1',
        message: makeUserMessage('u1'),
        expectedSequence: 1,
      }),
    ).settled

    // 服务端（同一 chat 存储）在 run 完成后持久化了助手回复。
    const record = records.get('conv-later-submit') as {
      messages: Array<{ id: string }>
      revision: number
    }
    record.messages = [
      { id: 'u1' },
      { id: 'a1' },
    ] as Array<{ id: string }>
    record.revision = 3

    // 客户端投影停留在发送时的旧快照（只有 u1）。第二次提交前 ensureHydrated
    // 必须重新拉取服务端，否则 append baseCount=1 会对 2 条消息冲突。
    await gateway.ensureHydrated('conv-later-submit')
    const synced = gateway.getSnapshot('conv-later-submit')
    expect(synced.timelineIds).toEqual(['u1', 'a1'])
    expect(synced.sequence).toBe(3)

    const submitResult = await gateway.dispatch(
      makeCommand({
        type: 'submit_user_message',
        conversationId: 'conv-later-submit',
        submissionId: 'u2',
        message: makeUserMessage('u2'),
        expectedSequence: synced.sequence,
      }),
    ).settled
    expect(submitResult.status).toBe('accepted')
    expect((appends.at(-1) as { baseCount: number }).baseCount).toBe(2)
  })
})
