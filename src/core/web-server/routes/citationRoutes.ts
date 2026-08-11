import type { WorkspaceAgentPolicy } from '../../../settings/schema/setting.types'
import type {
  SerializedChatAssistantMessage,
  SerializedChatMessage,
} from '../../../types/chat'
import type { CitationSource } from '../../agent/citationRegistry'
import { decideWorkspacePathAccess } from '../../workspace/workspacePermissionEngine'
import type { WebChatConversation } from '../webAgentTypes'
import { writeJson } from '../WebHttpServer'
import { type WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import { type ApiError, apiError } from './routeUtils'

export type CitationRoutesContext = {
  getChat: (conversationId: string) => Promise<WebChatConversation | null>
  resolveCitationBinding: (sessionId: string | null) =>
    | {
        ok: true
        binding: {
          activeAgentId: string
          allowedAgentIds: string[]
          rootHash: string
          policy: WorkspaceAgentPolicy
        }
      }
    | { ok: false; statusCode: number; body: ApiError }
}

export function registerCitationRoutes(
  router: WebRouter,
  context: CitationRoutesContext,
): void {
  router.get('/api/citation/:id', async (req, res, params) => {
    const selectorError = findProtectedSelectorError(req.url)
    if (selectorError) {
      writeJson(res, selectorError.statusCode, selectorError.body)
      return
    }

    const binding = context.resolveCitationBinding(getSessionId(req.headers))
    if (!binding.ok) {
      writeJson(res, binding.statusCode, binding.body)
      return
    }

    const url = new URL(req.url ?? '/', 'http://localhost')
    const conversationId = url.searchParams.get('conversationId')
    if (!conversationId) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'conversationId is required'),
      )
      return
    }

    const chat = await context.getChat(conversationId)
    if (
      !chat ||
      chat.webBinding?.rootHash !== binding.binding.rootHash ||
      chat.webBinding?.accessState === 'orphaned' ||
      !binding.binding.allowedAgentIds.includes(chat.webBinding.activeAgentId)
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    const source = findCitationSource(chat.messages, params.id)
    if (!source) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    if (
      typeof source.path === 'string' &&
      !decideWorkspacePathAccess({
        policy: binding.binding.policy,
        operation: 'read',
        path: source.path,
      }).ok
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }

    writeJson(res, 200, source)
  })
}

function findCitationSource(
  messages: SerializedChatMessage[],
  id: string,
): CitationSource | null {
  const ordinal = Number.parseInt(id, 10)
  if (!Number.isSafeInteger(ordinal) || `${ordinal}` !== id || ordinal < 1) {
    return null
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isAssistantMessage(message)) {
      continue
    }
    const source = message.metadata?.sources?.find(
      (item) => item.ordinal === ordinal,
    )
    if (source) {
      return source
    }
  }

  return null
}

function isAssistantMessage(
  message: SerializedChatMessage,
): message is SerializedChatAssistantMessage {
  return message.role === 'assistant'
}

function findProtectedSelectorError(
  requestUrl: string | undefined,
): { statusCode: number; body: ApiError } | null {
  const url = new URL(requestUrl ?? '/', 'http://localhost')
  for (const field of [
    'agentId',
    'assistantId',
    'activeAgentId',
    'rootHash',
    'workspaceId',
    'workspaceRoot',
    'workspacePolicy',
    'policy',
  ]) {
    if (url.searchParams.has(field)) {
      return {
        statusCode: 400,
        body: apiError(
          'invalid_request',
          'agentId, assistantId, activeAgentId, rootHash, workspaceId, workspaceRoot, and client policy fields are not allowed on protected citation routes',
        ),
      }
    }
  }
  return null
}

function getSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}
