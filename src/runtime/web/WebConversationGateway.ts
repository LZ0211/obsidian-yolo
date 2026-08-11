// master 无 backup 的 core/conversation/* 子系统（已被 ChatManager 取代），
// 命令/域类型/投影统一收拢在本地 webConversationTypes（语义逐条对齐 backup）。
import { COMMAND_RESULT_STATUS } from '../../core/state/contracts'
import {
  ENTITY_TITLE_KIND,
  HYDRATION_STATUS,
} from '../../core/state/statuses'
import type {
  SaveYoloChatInput,
  YoloChatRecord,
  YoloRuntime,
} from '../yoloRuntime.types'

import type {
  CommandHandle,
  CommandResult,
  ConversationCommand,
  ConversationCommandValue,
} from './webConversationTypes'
import type {
  ConversationAggregateState,
  ConversationMessage,
  ConversationMetadata,
} from './webConversationTypes'
import type {
  ConversationMetadataPatch,
} from './webConversationTypes'
import type {
  ConversationGateway,
  MetadataPage,
  MetadataPageRequest,
} from './webConversationTypes'
import {
  type ConversationProjection,
  ConversationProjectionStore,
  createEmptyConversationState,
} from './webConversationTypes'

type WebChatPort = Pick<
  YoloRuntime['chat'],
  | 'list'
  | 'get'
  | 'save'
  | 'appendMessages'
  | 'editHistoricalTurn'
  | 'deleteHistoricalGroup'
  | 'claimHistoricalRetry'
  | 'delete'
  | 'updateTitle'
  | 'patchMetadata'
  | 'generateTitle'
>

type GatewayEntry = {
  projection: ConversationProjectionStore
  hydrated: boolean
  hydration: Promise<void> | null
  localSequence: number
  /** 本地删除标记：删除后 refresh 遇到 404 时保留，避免与"从未创建"
   *  的新标签页会话（同样 get 404）混淆。 */
  deleted: boolean
}

const toMetadata = (record: YoloChatRecord): ConversationMetadata => ({
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
  assistantId: record.assistantId,
  conversationModelId: record.conversationModelId,
  messageModelMap: record.messageModelMap,
  activeBranchByUserMessageId: record.activeBranchByUserMessageId,
  assistantGroupBoundaryMessageIds: record.assistantGroupBoundaryMessageIds,
  reasoningLevel: record.reasoningLevel,
  compaction: record.compaction,
  workingDirectory: record.workingDirectory,
  fileScopeLocked: record.fileScopeLocked,
  workspaceId: record.workspaceId,
  agentInstanceId: record.agentInstanceId,
  webBinding: record.webBinding,
  origin: record.origin,
  isPinned: record.isPinned,
  pinnedAt: record.pinnedAt,
  overrides: record.overrides,
})

const toState = (
  record: YoloChatRecord,
  sequence: number,
): ConversationAggregateState => {
  const messages = new Map(
    record.messages.map((message) => [message.id, message] as const),
  )
  return {
    ...createEmptyConversationState(record.id),
    sequence,
    title: record.title.trim()
      ? { kind: ENTITY_TITLE_KIND.NAMED, value: record.title.trim() }
      : { kind: ENTITY_TITLE_KIND.UNTITLED },
    metadata: toMetadata(record),
    messages,
    messageOrder: record.messages.map((message) => message.id),
  }
}

const messageFromSnapshot = (
  projection: ConversationProjection,
): ConversationMessage[] =>
  projection.timelineIds.flatMap((messageId) => {
    const item = projection.itemsById.get(messageId)
    return item ? [item.message] : []
  })

const accepted = <T>(
  sequence: number,
  value?: T,
): CommandResult<T> => ({
  status: COMMAND_RESULT_STATUS.ACCEPTED,
  sequence,
  value: value as T,
})

const conflict = (sequence: number): CommandResult<never> => ({
  status: COMMAND_RESULT_STATUS.CONFLICT,
  conflict: {
    code: 'stale_sequence',
    expectedGeneration: sequence,
    actualGeneration: sequence,
  },
})

const rejected = (message: string): CommandResult<never> => ({
  status: COMMAND_RESULT_STATUS.REJECTED,
  reason: { code: 'invalid_state', message },
})

const saveInputFromMetadata = (
  id: string,
  messages: ConversationMessage[],
  metadata: ConversationMetadata,
): SaveYoloChatInput => ({
  id,
  messages: messages as never,
  assistantId: metadata.assistantId ?? undefined,
  overrides: metadata.overrides,
  conversationModelId: metadata.conversationModelId,
  messageModelMap: metadata.messageModelMap,
  activeBranchByUserMessageId: metadata.activeBranchByUserMessageId,
  assistantGroupBoundaryMessageIds: metadata.assistantGroupBoundaryMessageIds,
  reasoningLevel: metadata.reasoningLevel,
  compaction: metadata.compaction,
  workingDirectory: metadata.workingDirectory,
  workspaceId: metadata.workspaceId,
  agentInstanceId: metadata.agentInstanceId,
  webBinding: metadata.webBinding,
  touchUpdatedAt: true,
})

export function createWebConversationGateway(input: {
  getChat: () => WebChatPort
}): ConversationGateway & {
  /** web 专属：历史加载前强制与服务端重新同步（客户端投影可能过期）。 */
  forceRefreshConversation: (conversationId: string) => Promise<void>
} {
  const entries = new Map<string, GatewayEntry>()

  const entryFor = (conversationId: string): GatewayEntry => {
    const existing = entries.get(conversationId)
    if (existing) return existing
    const created: GatewayEntry = {
      projection: new ConversationProjectionStore(conversationId),
      hydrated: false,
      hydration: null,
      localSequence: 0,
      deleted: false,
    }
    entries.set(conversationId, created)
    return created
  }

  const applyRecord = (
    conversationId: string,
    record: YoloChatRecord | null,
  ): void => {
    const entry = entryFor(conversationId)
    if (!record) {
      if (entry.deleted) {
        // 已删除会话的 404 刷新：继续推进本地序号，保留 deleted 标记。
        entry.localSequence += 1
        entry.projection.applyDurableState({
          ...createEmptyConversationState(conversationId),
          sequence: entry.localSequence,
          deleted: true,
        })
      } else {
        // 从未创建的会话（新标签页的 uuid）：保持 sequence 0，首次提交
        // 才会走 create_conversation → chat/save；否则客户端会误以为会话
        // 已存在，直接 append-messages 打到不存在的记录上（404 + Failed
        // to save）。
        entry.localSequence = 0
        entry.projection.applyDurableState(
          createEmptyConversationState(conversationId),
        )
      }
      return
    }
    entry.localSequence = Math.max(
      entry.localSequence,
      record.revision ?? 0,
      record.messages.length > 0 ? 1 : 0,
    )
    entry.projection.applyDurableState(
      toState(record, entry.localSequence),
    )
  }

  const refresh = async (conversationId: string): Promise<void> => {
    const record = await input.getChat().get(conversationId)
    applyRecord(conversationId, record)
  }

  const ensureHydrated = async (conversationId: string): Promise<void> => {
    const entry = entryFor(conversationId)
    // 服务端是权威：run 完成/历史编辑都会推进服务端 journal，客户端投影
    // 可能停留在发送时的旧快照。每次调用都重新拉取，避免后续 dispatch
    // 用过期消息列表/序号打到服务端（append baseCount 冲突、save 覆盖丢消息）。
    if (!entry.hydrated && !entry.hydration) {
      entry.projection.setHydrationStatus(HYDRATION_STATUS.HYDRATING)
      entry.hydration = refresh(conversationId)
        .then(() => {
          entry.hydrated = true
        })
        .catch((error) => {
          entry.projection.setHydrationStatus(
            HYDRATION_STATUS.FAILED,
            error instanceof Error ? error.message : String(error),
          )
          throw error
        })
        .finally(() => {
          entry.hydration = null
        })
      await entry.hydration
      return
    }
    await entry.hydration
    await refresh(conversationId)
  }

  /** web 专属：历史加载前强制与服务端重新同步（客户端投影可能过期——服务端
   * 在 run 完成后才把助手回复持久化进 journal）。 */
  const forceRefreshConversation = async (
    conversationId: string,
  ): Promise<void> => {
    await refresh(conversationId)
  }

  const saveCurrent = async (
    conversationId: string,
    metadataPatch: ConversationMetadataPatch = {},
  ): Promise<void> => {
    const entry = entryFor(conversationId)
    const projection = entry.projection.getSnapshot()
    const metadata = { ...projection.metadata, ...metadataPatch }
    await input.getChat().save(
      saveInputFromMetadata(
        conversationId,
        messageFromSnapshot(projection),
        metadata,
      ),
    )
    await refresh(conversationId)
  }

  const dispatch = <TCommand extends ConversationCommand>(
    command: TCommand,
  ): CommandHandle<TCommand> => {
    const settled = (async () => {
      await ensureHydrated(command.conversationId)
      const entry = entryFor(command.conversationId)
      const projection = entry.projection.getSnapshot()
      if (
        command.expectedSequence !== undefined &&
        command.expectedSequence !== projection.sequence
      ) {
        return conflict(projection.sequence)
      }

      switch (command.type) {
        case 'create_conversation': {
          const title =
            command.title?.kind === ENTITY_TITLE_KIND.NAMED
              ? command.title.value
              : ''
          const now = Date.now()
          await input.getChat().save(
            saveInputFromMetadata(command.conversationId, [], {
              createdAt: command.metadata?.createdAt ?? now,
              updatedAt: command.metadata?.updatedAt ?? now,
              ...command.metadata,
            }),
          )
          if (title) {
            await input.getChat().updateTitle(command.conversationId, title)
          }
          // updateTitle 也会推进服务端 journal revision，必须放在 title 之后
          // 刷新，否则下一次 dispatch（submit_user_message）的 expectedSequence
          // 会与服务端 revision 差 1 而误判为 stale conflict。
          await refresh(command.conversationId)
          return accepted(projection.sequence + 1, {
            conversationId: command.conversationId,
          })
        }
        case 'submit_user_message':
        case 'queue_user_message': {
          const append = input.getChat().appendMessages
          if (append) {
            const result = await append({
              id: command.conversationId,
              baseCount: projection.timelineIds.length,
              newMessages: [command.message as never],
            })
            if (result.conflict) return conflict(projection.sequence)
          } else {
            await input.getChat().save({
              id: command.conversationId,
              messages: [
                ...messageFromSnapshot(projection),
                command.message as never,
              ] as never,
              touchUpdatedAt: true,
            })
          }
          await refresh(command.conversationId)
          return accepted(projection.sequence + 1, {
            submissionId: command.submissionId,
          })
        }
        case 'edit_historical_turn': {
          const editHistoricalTurn = input.getChat().editHistoricalTurn
          if (!editHistoricalTurn) {
            return rejected('historical_edit_unavailable')
          }
          const record = await editHistoricalTurn({
            conversationId: command.conversationId,
            expectedRevision: projection.sequence,
            messageId: command.messageId,
            expectedGeneration: command.expectedMessageGeneration,
            replacement: command.message as never,
          })
          applyRecord(command.conversationId, record)
          return accepted(projection.sequence + 1)
        }
        case 'delete_historical_group': {
          const deleteHistoricalGroup = input.getChat().deleteHistoricalGroup
          if (!deleteHistoricalGroup) {
            return rejected('historical_delete_unavailable')
          }
          const record = await deleteHistoricalGroup({
            conversationId: command.conversationId,
            expectedRevision: projection.sequence,
            messageIds: command.messageIds,
            expectedGenerations: command.expectedMessageGenerations,
          })
          applyRecord(command.conversationId, record)
          return accepted(projection.sequence + 1)
        }
        case 'claim_historical_retry': {
          const claimHistoricalRetry = input.getChat().claimHistoricalRetry
          if (!claimHistoricalRetry) {
            return rejected('historical_retry_unavailable')
          }
          const record = await claimHistoricalRetry({
            conversationId: command.conversationId,
            expectedRevision: projection.sequence,
            messageId: command.messageId,
            expectedGeneration: command.expectedMessageGeneration,
          })
          applyRecord(command.conversationId, record)
          return accepted(projection.sequence + 1)
        }
        case 'patch_conversation_metadata':
          {
            const patchMetadata = input.getChat().patchMetadata
            // metadata-only 通道：服务端直接 patch journal，不重存消息列表，
            // 避免客户端投影消息与服务端存储的序列化形态不一致触发
            // edit_historical_turn 冲突（chat/save 500）。
            if (patchMetadata) {
              await patchMetadata(command.conversationId, command.patch)
              await refresh(command.conversationId)
              return accepted(projection.sequence + 1)
            }
            await saveCurrent(command.conversationId, command.patch)
            return accepted(projection.sequence + 1)
          }
        case 'generate_conversation_title': {
          const title =
            command.title.kind === ENTITY_TITLE_KIND.NAMED
              ? command.title.value
              : ''
          if (title) await input.getChat().updateTitle(command.conversationId, title)
          await refresh(command.conversationId)
          return accepted(projection.sequence + 1)
        }
        case 'commit_compaction':
          {
            const patchMetadata = input.getChat().patchMetadata
            if (patchMetadata) {
              await patchMetadata(command.conversationId, {
                compaction: command.compaction,
              })
              await refresh(command.conversationId)
              return accepted(projection.sequence + 1)
            }
            await saveCurrent(command.conversationId, {
              compaction: command.compaction,
            })
            return accepted(projection.sequence + 1)
          }
        case 'delete_conversation':
          await input.getChat().delete(command.conversationId)
          entry.deleted = true
          entry.projection.clearRuntimeMessages()
          entry.localSequence += 1
          entry.projection.applyDurableState({
            ...createEmptyConversationState(command.conversationId),
            sequence: entry.localSequence,
            deleted: true,
          })
          return accepted(entry.localSequence)
        case 'finalize_message': {
          const messages = messageFromSnapshot(projection)
          if (!messages.some((message) => message.id === command.message.id)) {
            entry.projection.replaceRuntimeMessages([
              ...messages,
              command.message,
            ])
          }
          return accepted(projection.sequence, { messageId: command.message.id })
        }
        case 'start_run':
        case 'begin_run_execution':
        case 'request_approval':
        case 'resolve_approval':
        case 'request_tool_execution':
        case 'settle_tool_execution':
        case 'attach_subagent':
        case 'settle_subagent':
        case 'complete_run':
        case 'fail_run':
        case 'abort_run':
        case 'retry_failed_submission':
        case 'dismiss_failed_submission':
          return accepted(projection.sequence)
        default:
          return rejected('unsupported_conversation_command')
      }
    })().catch((error) => rejected(error instanceof Error ? error.message : String(error)))

    return {
      commandId: command.commandId,
      settled: settled as Promise<
        CommandResult<ConversationCommandValue<TCommand>>
      >,
    }
  }

  return {
    dispatch,
    getSnapshot: (conversationId) => entryFor(conversationId).projection.getSnapshot(),
    subscribe: (conversationId, listener) => entryFor(conversationId).projection.subscribe(listener),
    forceRefreshConversation,
    listMetadataPage: async (request: MetadataPageRequest): Promise<MetadataPage> => {
      const rows = await input.getChat().list()
      const limit = Math.max(1, Math.min(request.limit ?? 50, 200))
      const offset = request.cursor ? Number.parseInt(request.cursor, 10) : 0
      const items = rows.slice(offset, offset + limit).map((row) => ({
        conversationId: row.id,
        sequence: (row as { revision?: number }).revision ?? 0,
        hash: `web:${row.id}:${(row as { revision?: number }).revision ?? 0}`,
        updatedAt: row.updatedAt,
      }))
      return {
        items,
        nextCursor:
          offset + limit < rows.length ? String(offset + limit) : undefined,
      }
    },
    ensureHydrated,
    pin: () => () => {},
    replaceRuntimeMessages: (conversationId, messages) =>
      entryFor(conversationId).projection.replaceRuntimeMessages(messages),
    clearRuntimeMessages: (conversationId) =>
      entryFor(conversationId).projection.clearRuntimeMessages(),
  }
}
