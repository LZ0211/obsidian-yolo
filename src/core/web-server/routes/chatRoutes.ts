// eslint-disable-next-line import/no-nodejs-modules -- type-only import，编译后消失，无运行时 node 依赖
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { ChatConversation } from '../../../database/json/chat/types'
import type { WorkspaceAccessPolicy } from '../../../types/assistant.types'
import {
  isAgentCompatibleWithDirectory,
  isConversationFileScopeLocked,
  normalizeConversationWorkingDirectory,
} from '../../workspace/conversationFileScope'
import type {
  ChatWebBinding,
  WebChatConversation,
  WebChatConversationMetadata,
} from '../webAgentTypes'
import { writeJson } from '../WebHttpServer'
import { type WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import {
  type ApiError,
  apiError,
  isConversationConflictError,
  readJsonBody,
} from './routeUtils'

const PROTECTED_SELECTOR_FIELDS = [
  'workspaceId',
  'agentInstanceId',
  'agentId',
  'activeAgentId',
  'rootHash',
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
] as const

const PROTECTED_SELECTOR_MESSAGE =
  'agentId, activeAgentId, agentInstanceId, rootHash, workspaceId, workspaceRoot, and client policy fields are not allowed on protected chat routes'
const WORKING_DIRECTORY_LOCKED_MESSAGE =
  'Conversation working directory is locked'

export type SaveChatRequest = {
  id: string
  messages: ChatConversation['messages']
  overrides?: ChatConversation['overrides']
  conversationModelId?: ChatConversation['conversationModelId']
  messageModelMap?: ChatConversation['messageModelMap']
  activeBranchByUserMessageId?: ChatConversation['activeBranchByUserMessageId']
  assistantGroupBoundaryMessageIds?: ChatConversation['assistantGroupBoundaryMessageIds']
  reasoningLevel?: ChatConversation['reasoningLevel']
  compaction?: ChatConversation['compaction']
  workingDirectory?: ChatConversation['workingDirectory']
  touchUpdatedAt?: boolean
  webBinding: ChatWebBinding
}

export type ChatRouteBinding = {
  activeAgentId: string
  rootHash: string
  allowedAgentIds: string[]
  workspaceAccessPolicy: WorkspaceAccessPolicy
}

export type DeleteHistoricalGroupRouteInput =
  | {
      conversationId: string
      expectedRevision: number
      messageId: string
      expectedGeneration: number
    }
  | {
      conversationId: string
      expectedRevision: number
      messageIds: readonly string[]
      expectedGenerations: Readonly<Record<string, number>>
    }

export type ChatRoutesContext = {
  listChats: () => Promise<WebChatConversationMetadata[]>
  getChat: (conversationId: string) => Promise<WebChatConversation | null>
  findById: (conversationId: string) => Promise<WebChatConversation | null>
  createChat: (
    chat: Partial<WebChatConversation>,
  ) => Promise<WebChatConversation>
  updateChat: (
    conversationId: string,
    updates: Partial<
      Omit<
        WebChatConversation,
        'id' | 'createdAt' | 'updatedAt' | 'schemaVersion'
      >
    >,
    options?: {
      touchUpdatedAt?: boolean
    },
  ) => Promise<WebChatConversation | null>
  deleteChat: (conversationId: string) => Promise<boolean>
  saveChat: (request: SaveChatRequest) => Promise<WebChatConversation | null>
  appendMessages: (
    id: string,
    baseCount: number,
    newMessages: ChatConversation['messages'],
    metadata: Partial<
      Omit<
        WebChatConversation,
        'id' | 'createdAt' | 'updatedAt' | 'schemaVersion' | 'messages'
      >
    >,
  ) => Promise<{ ok: true; updatedAt: number } | { ok: false; conflict: true }>
  editHistoricalTurn?: (input: {
    conversationId: string
    expectedRevision: number
    messageId: string
    expectedGeneration: number
    replacement: ChatConversation['messages'][number]
  }) => Promise<WebChatConversation | null>
  deleteHistoricalGroup?: (
    input: DeleteHistoricalGroupRouteInput,
  ) => Promise<WebChatConversation | null>
  claimHistoricalRetry?: (input: {
    conversationId: string
    expectedRevision: number
    messageId: string
    expectedGeneration: number
  }) => Promise<WebChatConversation | null>
  generateTitle: (request: {
    conversationId: string
    messages: ChatConversation['messages']
    force?: boolean
  }) => Promise<void>
  exportToVault: (conversationId: string) => Promise<{ path: string }>
  isVaultFolder: (path: string) => boolean
  resolveChatBinding: (
    sessionId: string | null,
  ) =>
    | { ok: true; binding: ChatRouteBinding }
    | { ok: false; statusCode: number; body: ApiError }
}

export function registerChatRoutes(
  router: WebRouter,
  context: ChatRoutesContext,
): void {
  const conversationSaveQueue = new Map<string, Promise<void>>()

  router.get('/api/chat/list', async (req, res) => {
    const binding = requireChatBinding(req.headers, req.url, context)
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const chats = await context.listChats()
    writeJson(
      res,
      200,
      chats.filter((chat) => canAccessConversation(chat, binding.binding)),
    )
  })

  router.get('/api/chat/get/:id', async (req, res, params) => {
    const binding = requireChatBinding(req.headers, req.url, context)
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const chat = await context.getChat(params.id)
    if (!chat || !canAccessConversation(chat, binding.binding)) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }
    writeJson(res, 200, chat)
  })

  router.post('/api/chat/delete', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }

    const binding = requireChatBinding(
      req.headers,
      undefined,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const conversationId = body.value.conversationId
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'conversationId is required'),
      )
      return
    }

    const chat = await context.getChat(conversationId)
    if (!chat || !canAccessConversation(chat, binding.binding)) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    let deleted: boolean
    try {
      deleted = await context.deleteChat(conversationId)
    } catch (error) {
      if (isConversationConflictError(error)) {
        writeJson(
          res,
          409,
          apiError('conflict', 'Conversation changed — refresh and retry'),
        )
        return
      }
      throw error
    }
    if (!deleted) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }
    writeJson(res, 200, { deleted: true })
  })

  router.post('/api/chat/save', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }

    const binding = requireChatBinding(
      req.headers,
      undefined,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const parsed = parseSaveChatRequest(body.value)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }

    await withConversationSaveLock(
      conversationSaveQueue,
      parsed.value.id,
      async () => {
        const existing = await context.findById(parsed.value.id)
        if (
          existing != null &&
          !canAccessConversation(existing, binding.binding)
        ) {
          writeJson(res, 404, apiError('not_found', 'Not found'))
          return
        }

        const workingDirectory = validateWorkingDirectoryForSave({
          requested: parsed.value.workingDirectory,
          existing,
          binding: binding.binding,
          isVaultFolder: context.isVaultFolder,
        })
        if (!workingDirectory.ok) {
          writeJson(
            res,
            workingDirectory.statusCode,
            apiError(workingDirectory.code, workingDirectory.message),
          )
          return
        }

        const initialAgentId =
          existing?.webBinding?.initialAgentId ?? binding.binding.activeAgentId
        let saved: ChatConversation | null
        try {
          saved = await context.saveChat({
            ...parsed.value,
            ...(workingDirectory.value === undefined
              ? {}
              : { workingDirectory: workingDirectory.value }),
            webBinding: {
              initialAgentId,
              activeAgentId: binding.binding.activeAgentId,
              rootHash: binding.binding.rootHash,
            },
          })
        } catch (error) {
          if (isWorkingDirectoryLockError(error)) {
            writeJson(
              res,
              409,
              apiError('conflict', WORKING_DIRECTORY_LOCKED_MESSAGE),
            )
            return
          }
          if (isConversationConflictError(error)) {
            writeJson(
              res,
              409,
              apiError('conflict', 'Conversation changed — refresh and retry'),
            )
            return
          }
          throw error
        }
        const result = saved ?? (await context.findById(parsed.value.id))
        writeJson(res, 200, result ? toConversationMetadata(result) : null)
      },
    )
  })

  router.post('/api/chat/append-messages', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }

    const binding = requireChatBinding(
      req.headers,
      undefined,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const id = body.value.id
    if (typeof id !== 'string' || id.length === 0) {
      writeJson(res, 400, apiError('invalid_request', 'id is required'))
      return
    }
    const baseCount = body.value.baseCount
    if (
      typeof baseCount !== 'number' ||
      !Number.isInteger(baseCount) ||
      baseCount < 0
    ) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'baseCount must be a non-negative integer'),
      )
      return
    }
    if (!Array.isArray(body.value.newMessages)) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'newMessages is required'),
      )
      return
    }

    const existing = await context.findById(id)
    if (!existing || !canAccessConversation(existing, binding.binding)) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    const metadata: Partial<
      Omit<
        WebChatConversation,
        'id' | 'createdAt' | 'updatedAt' | 'schemaVersion' | 'messages'
      >
    > = {
      overrides: body.value.overrides as ChatConversation['overrides'],
      conversationModelId: body.value
        .conversationModelId as ChatConversation['conversationModelId'],
      messageModelMap: body.value
        .messageModelMap as ChatConversation['messageModelMap'],
      activeBranchByUserMessageId: body.value
        .activeBranchByUserMessageId as ChatConversation['activeBranchByUserMessageId'],
      assistantGroupBoundaryMessageIds: body.value
        .assistantGroupBoundaryMessageIds as ChatConversation['assistantGroupBoundaryMessageIds'],
      reasoningLevel: body.value
        .reasoningLevel as ChatConversation['reasoningLevel'],
      compaction: body.value.compaction as ChatConversation['compaction'],
      webBinding: {
        initialAgentId:
          existing.webBinding?.initialAgentId ?? binding.binding.activeAgentId,
        activeAgentId: binding.binding.activeAgentId,
        rootHash: binding.binding.rootHash,
      },
    }

    const result = await context.appendMessages(
      id,
      baseCount,
      body.value.newMessages as ChatConversation['messages'],
      metadata,
    )

    if (!result.ok) {
      writeJson(
        res,
        409,
        apiError('conflict', 'Message count mismatch — use full save'),
      )
      return
    }
    writeJson(res, 200, { updatedAt: result.updatedAt })
  })

  const handleHistoricalMutation = async (
    req: IncomingMessage,
    res: ServerResponse,
    kind: 'edit' | 'delete' | 'retry',
  ): Promise<void> => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const binding = requireChatBinding(
      req.headers,
      undefined,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }
    const value = body.value
    const conversationId = value.conversationId
    const expectedRevision = value.expectedRevision as number
    const messageId = value.messageId
    const expectedGeneration = value.expectedGeneration as number
    const messageIds = value.messageIds
    const expectedGenerations = value.expectedGenerations
    const replacement = value.replacement as Record<string, unknown> | undefined
    const hasValidExplicitGroup =
      kind === 'delete' &&
      Array.isArray(messageIds) &&
      messageIds.length > 0 &&
      messageIds.every(
        (candidate): candidate is string =>
          typeof candidate === 'string' && candidate.length > 0,
      ) &&
      new Set(messageIds).size === messageIds.length &&
      typeof expectedGenerations === 'object' &&
      expectedGenerations !== null &&
      !Array.isArray(expectedGenerations) &&
      messageIds.every(
        (candidate) =>
          Number.isInteger(
            (expectedGenerations as Record<string, unknown>)[candidate],
          ) &&
          ((expectedGenerations as Record<string, number>)[candidate] ?? -1) >=
            0,
      )
    const hasValidAnchor =
      typeof messageId === 'string' &&
      messageId.length > 0 &&
      Number.isInteger(expectedGeneration) &&
      expectedGeneration >= 0
    if (
      typeof conversationId !== 'string' ||
      conversationId.length === 0 ||
      !Number.isInteger(expectedRevision) ||
      expectedRevision < 0 ||
      (kind === 'delete'
        ? !hasValidAnchor && !hasValidExplicitGroup
        : !hasValidAnchor) ||
      (kind === 'edit' &&
        (!replacement ||
          replacement.role !== 'user' ||
          replacement.id !== messageId ||
          !Array.isArray(replacement.mentionables)))
    ) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'Invalid historical mutation input'),
      )
      return
    }
    const existing = await context.findById(conversationId)
    if (!existing || !canAccessConversation(existing, binding.binding)) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }
    const mutation =
      kind === 'edit'
        ? context.editHistoricalTurn
        : kind === 'delete'
          ? context.deleteHistoricalGroup
          : context.claimHistoricalRetry
    if (!mutation) {
      writeJson(
        res,
        501,
        apiError('unsupported', 'Historical mutation is unavailable'),
      )
      return
    }
    try {
      const updated = await mutation(
        (kind === 'delete' && hasValidExplicitGroup
          ? {
              conversationId,
              expectedRevision,
              messageIds,
              expectedGenerations,
            }
          : {
              conversationId,
              expectedRevision,
              messageId,
              expectedGeneration,
              ...(kind === 'edit' ? { replacement } : {}),
            }) as never,
      )
      if (!updated) {
        writeJson(
          res,
          409,
          apiError('conflict', 'Conversation changed — refresh and retry'),
        )
        return
      }
      writeJson(res, 200, updated)
    } catch (error) {
      if (isConversationConflictError(error)) {
        writeJson(
          res,
          409,
          apiError('conflict', 'Conversation changed — refresh and retry'),
        )
        return
      }
      throw error
    }
  }

  router.post('/api/chat/edit-history', (req, res) =>
    handleHistoricalMutation(req, res, 'edit'),
  )
  router.post('/api/chat/delete-history', (req, res) =>
    handleHistoricalMutation(req, res, 'delete'),
  )
  router.post('/api/chat/claim-retry', (req, res) =>
    handleHistoricalMutation(req, res, 'retry'),
  )

  router.post('/api/chat/update-title', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }

    const binding = requireChatBinding(
      req.headers,
      undefined,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const id = body.value.id
    if (typeof id !== 'string' || id.length === 0) {
      writeJson(res, 400, apiError('invalid_request', 'id is required'))
      return
    }
    const title = body.value.title
    if (typeof title !== 'string' || title.length === 0) {
      writeJson(res, 400, apiError('invalid_request', 'title is required'))
      return
    }
    const touchUpdatedAt = parseOptionalBoolean(body.value.touchUpdatedAt)
    if (touchUpdatedAt === INVALID_BOOLEAN) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'touchUpdatedAt is invalid'),
      )
      return
    }

    const existing = await context.findById(id)
    if (!existing || !canAccessConversation(existing, binding.binding)) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    const updated = await context.updateChat(
      id,
      { title },
      touchUpdatedAt === undefined ? undefined : { touchUpdatedAt },
    )
    if (!updated) {
      writeJson(
        res,
        409,
        apiError('conflict', 'Conversation changed — refresh and retry'),
      )
      return
    }
    writeJson(res, 200, updated)
  })

  router.post('/api/chat/toggle-pinned', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }

    const binding = requireChatBinding(
      req.headers,
      undefined,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const id = body.value.id
    if (typeof id !== 'string' || id.length === 0) {
      writeJson(res, 400, apiError('invalid_request', 'id is required'))
      return
    }

    const existing = await context.findById(id)
    if (!existing || !canAccessConversation(existing, binding.binding)) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    const nextPinned = !(existing.isPinned ?? false)
    const updated = await context.updateChat(id, {
      isPinned: nextPinned,
      pinnedAt: nextPinned ? Date.now() : undefined,
    })
    if (!updated) {
      writeJson(
        res,
        409,
        apiError('conflict', 'Conversation changed — refresh and retry'),
      )
      return
    }
    writeJson(res, 200, updated)
  })

  router.post('/api/chat/patch-metadata', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }

    const binding = requireChatBinding(
      req.headers,
      undefined,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const id = body.value.id
    if (typeof id !== 'string' || id.length === 0) {
      writeJson(res, 400, apiError('invalid_request', 'id is required'))
      return
    }
    const rawPatch = body.value.patch
    if (!rawPatch || typeof rawPatch !== 'object' || Array.isArray(rawPatch)) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'patch object is required'),
      )
      return
    }
    const patch: Record<string, unknown> = {}
    for (const key of Object.keys(rawPatch)) {
      if (!CONVERSATION_METADATA_PATCH_KEYS.has(key)) {
        writeJson(
          res,
          400,
          apiError('invalid_request', `unsupported metadata key: ${key}`),
        )
        return
      }
      patch[key] = (rawPatch as Record<string, unknown>)[key]
    }

    const existing = await context.findById(id)
    if (!existing || !canAccessConversation(existing, binding.binding)) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    const updated = await context.updateChat(id, patch, {
      touchUpdatedAt: true,
    })
    if (!updated) {
      writeJson(
        res,
        409,
        apiError('conflict', 'Conversation changed — refresh and retry'),
      )
      return
    }
    writeJson(res, 200, updated)
  })

  router.post('/api/chat/generate-title', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }

    const binding = requireChatBinding(
      req.headers,
      undefined,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const conversationId = body.value.conversationId
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'conversationId is required'),
      )
      return
    }
    if (!Array.isArray(body.value.messages)) {
      writeJson(res, 400, apiError('invalid_request', 'messages is required'))
      return
    }
    const force = parseOptionalBoolean(body.value.force)
    if (force === INVALID_BOOLEAN) {
      writeJson(res, 400, apiError('invalid_request', 'force is invalid'))
      return
    }

    const existing = await context.findById(conversationId)
    if (!existing || !canAccessConversation(existing, binding.binding)) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    try {
      await context.generateTitle({
        conversationId,
        messages: body.value.messages as ChatConversation['messages'],
        force,
      })
    } catch (error) {
      if (isConversationConflictError(error)) {
        writeJson(
          res,
          409,
          apiError('conflict', 'Conversation changed — refresh and retry'),
        )
        return
      }
      throw error
    }
    const updated = await context.findById(conversationId)
    writeJson(res, 200, { title: updated?.title ?? null })
  })

  router.post('/api/chat/export', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }

    const binding = requireChatBinding(
      req.headers,
      undefined,
      context,
      body.value,
    )
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const conversationId = body.value.conversationId
    if (typeof conversationId !== 'string' || conversationId.length === 0) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'conversationId is required'),
      )
      return
    }

    const existing = await context.findById(conversationId)
    if (!existing || !canAccessConversation(existing, binding.binding)) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(res, 200, await context.exportToVault(conversationId))
  })
}

const INVALID_BOOLEAN = Symbol('invalid_boolean')

function parseOptionalBoolean(
  value: unknown,
): boolean | undefined | typeof INVALID_BOOLEAN {
  if (value === undefined) return undefined
  return typeof value === 'boolean' ? value : INVALID_BOOLEAN
}

function parseSaveChatRequest(
  value: Record<string, unknown>,
):
  | { ok: true; value: Omit<SaveChatRequest, 'webBinding'> }
  | { ok: false; message: string } {
  if (typeof value.id !== 'string' || value.id.length === 0) {
    return { ok: false, message: 'id is required' }
  }
  if (!Array.isArray(value.messages)) {
    return { ok: false, message: 'messages is required' }
  }
  const touchUpdatedAt = parseOptionalBoolean(value.touchUpdatedAt)
  if (touchUpdatedAt === INVALID_BOOLEAN) {
    return { ok: false, message: 'touchUpdatedAt is invalid' }
  }
  if (
    value.workingDirectory !== undefined &&
    typeof value.workingDirectory !== 'string'
  ) {
    return { ok: false, message: 'workingDirectory must be a string' }
  }
  return {
    ok: true,
    value: {
      id: value.id,
      messages: value.messages as ChatConversation['messages'],
      overrides: value.overrides as ChatConversation['overrides'],
      conversationModelId:
        value.conversationModelId as ChatConversation['conversationModelId'],
      messageModelMap:
        value.messageModelMap as ChatConversation['messageModelMap'],
      activeBranchByUserMessageId:
        value.activeBranchByUserMessageId as ChatConversation['activeBranchByUserMessageId'],
      assistantGroupBoundaryMessageIds:
        value.assistantGroupBoundaryMessageIds as ChatConversation['assistantGroupBoundaryMessageIds'],
      reasoningLevel:
        value.reasoningLevel as ChatConversation['reasoningLevel'],
      compaction: value.compaction as ChatConversation['compaction'],
      ...(typeof value.workingDirectory === 'string'
        ? { workingDirectory: value.workingDirectory }
        : {}),
      touchUpdatedAt,
    },
  }
}

/** metadata-only patch 允许下发的字段（与 ConversationMetadataPatch 对齐，
 *  白名单防止客户端往投影 metadata 里注入任意键）。 */
const CONVERSATION_METADATA_PATCH_KEYS = new Set([
  'assistantId',
  'conversationModelId',
  'overrides',
  'messageModelMap',
  'activeBranchByUserMessageId',
  'assistantGroupBoundaryMessageIds',
  'reasoningLevel',
  'compaction',
  'workingDirectory',
  'fileScopeLocked',
  'workspaceId',
  'agentInstanceId',
  'webBinding',
  'isPinned',
  'pinnedAt',
])

function validateWorkingDirectoryForSave(input: {
  requested: string | undefined
  existing: ChatConversation | null
  binding: ChatRouteBinding
  isVaultFolder: (path: string) => boolean
}):
  | { ok: true; value: string | undefined }
  | {
      ok: false
      statusCode: 400 | 409
      code: 'invalid_request' | 'conflict'
      message: string
    } {
  if (input.requested === undefined) {
    return { ok: true, value: undefined }
  }

  let workingDirectory: string
  try {
    workingDirectory = normalizeConversationWorkingDirectory(input.requested)
  } catch {
    return {
      ok: false,
      statusCode: 400,
      code: 'invalid_request',
      message: 'workingDirectory is invalid',
    }
  }

  if (
    input.existing &&
    isConversationFileScopeLocked(
      input.existing.messages,
      input.existing.fileScopeLocked,
    ) &&
    workingDirectory !== input.existing.workingDirectory
  ) {
    return {
      ok: false,
      statusCode: 409,
      code: 'conflict',
      message: WORKING_DIRECTORY_LOCKED_MESSAGE,
    }
  }

  if (!input.isVaultFolder(workingDirectory)) {
    return {
      ok: false,
      statusCode: 400,
      code: 'invalid_request',
      message: 'workingDirectory must be an existing Vault folder',
    }
  }

  const compatibility = isAgentCompatibleWithDirectory(
    input.binding.workspaceAccessPolicy,
    workingDirectory,
  )
  if (!compatibility.ok) {
    return {
      ok: false,
      statusCode: 400,
      code: 'invalid_request',
      message: 'workingDirectory is outside the active Agent file policy',
    }
  }

  return { ok: true, value: compatibility.directory }
}

async function withConversationSaveLock<T>(
  queue: Map<string, Promise<void>>,
  conversationId: string,
  task: () => Promise<T>,
): Promise<T> {
  const previous = queue.get(conversationId) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.then(() => current)
  queue.set(conversationId, tail)

  await previous
  try {
    return await task()
  } finally {
    release()
    if (queue.get(conversationId) === tail) {
      queue.delete(conversationId)
    }
  }
}

function isWorkingDirectoryLockError(error: unknown): boolean {
  return (
    error instanceof Error && error.message === WORKING_DIRECTORY_LOCKED_MESSAGE
  )
}

function getSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) {
    return value[0] ?? null
  }
  return typeof value === 'string' && value.length > 0 ? value : null
}

function requireChatBinding(
  headers: Record<string, string | string[] | undefined>,
  requestUrl: string | undefined,
  context: ChatRoutesContext,
  body?: Record<string, unknown>,
):
  | { ok: true; binding: ChatRouteBinding }
  | { ok: false; statusCode: number; body: ApiError } {
  const selectorError = findProtectedSelectorError(requestUrl, body)
  if (selectorError) {
    return selectorError
  }
  return context.resolveChatBinding(getSessionId(headers))
}

function findProtectedSelectorError(
  requestUrl: string | undefined,
  body?: Record<string, unknown>,
): { ok: false; statusCode: number; body: ApiError } | null {
  const url = new URL(requestUrl ?? '/', 'http://localhost')
  for (const field of PROTECTED_SELECTOR_FIELDS) {
    if (url.searchParams.has(field)) {
      return {
        ok: false,
        statusCode: 400,
        body: apiError('invalid_request', PROTECTED_SELECTOR_MESSAGE),
      }
    }
  }
  if (body) {
    for (const field of PROTECTED_SELECTOR_FIELDS) {
      if (field in body) {
        return {
          ok: false,
          statusCode: 400,
          body: apiError('invalid_request', PROTECTED_SELECTOR_MESSAGE),
        }
      }
    }
  }
  return null
}

function toConversationMetadata(
  conversation: WebChatConversation,
): WebChatConversationMetadata {
  return {
    id: conversation.id,
    title: conversation.title,
    updatedAt: conversation.updatedAt,
    schemaVersion: conversation.schemaVersion,
    isPinned: conversation.isPinned,
    pinnedAt: conversation.pinnedAt,
    workspaceId: conversation.workspaceId,
    agentInstanceId: conversation.agentInstanceId,
    webBinding: conversation.webBinding,
  }
}

function canAccessConversation(
  conversation:
    | Pick<WebChatConversation, 'webBinding'>
    | Pick<WebChatConversationMetadata, 'webBinding'>,
  binding: ChatRouteBinding,
): boolean {
  return (
    conversation.webBinding?.rootHash === binding.rootHash &&
    conversation.webBinding?.accessState !== 'orphaned' &&
    binding.allowedAgentIds.includes(conversation.webBinding.activeAgentId)
  )
}
