import type { App } from 'obsidian'

import { deserializeChatMessage } from '../../../hooks/useChatHistory'
import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { Assistant } from '../../../types/assistant.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { isAssistantToolEnabled } from '../../agent/tool-preferences'
import type { McpManager } from '../../mcp/mcpManager'
import { listLiteSkillEntries } from '../../skills/liteSkills'
import { isSkillEnabledForAssistant } from '../../skills/skillPolicy'
import type { ResolvedWebAgentContext } from '../webAgentTypes'
import { workspaceAgentPolicyToRuntimeAccessPolicy } from '../WebChatRuntimeAdapter'
import { writeJson } from '../WebHttpServer'
import { type WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import { apiError, readJsonBody } from './routeUtils'

export type McpRoutesContext = {
  app: App
  getSettings: () => YoloSettings
  getMcpManager: () => Promise<McpManager>
  resolveMcpAccess: (
    sessionId: string | null,
  ) =>
    | { ok: true; context: ResolvedWebAgentContext }
    | { ok: false; statusCode: number; body: ReturnType<typeof apiError> }
  canAccessConversation: (
    conversationId: string,
    context: ResolvedWebAgentContext,
  ) => Promise<boolean> | boolean
}

export function registerMcpRoutes(
  router: WebRouter,
  context: McpRoutesContext,
): void {
  router.post('/api/mcp/list-tools', async (req, res) => {
    const access = context.resolveMcpAccess(getSessionId(req.headers))
    if (!access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const manager = await context.getMcpManager()
    writeJson(
      res,
      200,
      await manager.listAvailableTools({
        includeBuiltinTools:
          typeof body.value.includeBuiltinTools === 'boolean'
            ? body.value.includeBuiltinTools
            : false,
        chatModelModalities: Array.isArray(body.value.chatModelModalities)
          ? (body.value.chatModelModalities as never)
          : undefined,
      }),
    )
  })

  router.post('/api/mcp/call-tool', async (req, res) => {
    const access = context.resolveMcpAccess(getSessionId(req.headers))
    if (!access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const parsed = parseCallToolRequest(body.value, context.app)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    if (
      !(await context.canAccessConversation(
        parsed.value.conversationId,
        access.context,
      ))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }
    const manager = await context.getMcpManager()

    if (
      access.context.activeAgent.enableTools === false ||
      !isAssistantToolEnabled(
        access.context.activeAgent,
        parsed.value.name,
      )
    ) {
      writeJson(res, 200, {
        status: ToolCallResponseStatus.Rejected,
        reason: `Tool "${parsed.value.name}" is not enabled for the active agent.`,
      })
      return
    }

    // The route must not trust the client's self-reported "approved" state.
    // Re-verify the conversation-level allowance with the same gate the
    // AgentToolGateway consults before dispatch (see
    // `AgentToolGateway.shouldAutoExecuteTool` → `McpManager.isToolExecutionAllowed`).
    // This endpoint is only a persisted-call recovery path, so auto-execution
    // is never implied. The allowance must have been granted by the real
    // AgentService approval flow; browsers cannot create one directly.
    const allowed = manager.isToolExecutionAllowed({
      requestToolName: parsed.value.name,
      conversationId: parsed.value.conversationId,
      requestArgs: parsed.value.args,
      requireAutoExecution: false,
    })
    if (!allowed) {
      // 拒绝响应协议与 tool-gateway 的 refusal shape 保持一致：
      // ToolCallResponse Rejected + reason（200 透传，客户端按既有
      // ToolCallResponse 契约消费）。
      writeJson(res, 200, {
        status: ToolCallResponseStatus.Rejected,
        reason: `Tool "${parsed.value.name}" has not been approved for this conversation. Approve it in the chat first.`,
      })
      return
    }

    writeJson(
      res,
      200,
      await manager.callTool({
        ...parsed.value,
        workspaceAccessPolicy: workspaceAgentPolicyToRuntimeAccessPolicy(
          access.context.activeAgent.workspacePolicy,
          context.getSettings(),
        ),
        allowedSkillPaths: await resolveAssistantSkillPaths({
          app: context.app,
          settings: context.getSettings(),
          assistant: access.context.activeAgent,
        }),
      }),
    )
  })

  router.post('/api/mcp/abort-tool-call', async (req, res) => {
    const access = context.resolveMcpAccess(getSessionId(req.headers))
    if (!access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const id = body.value.id
    const conversationId = body.value.conversationId
    if (typeof id !== 'string' || id.length === 0) {
      writeJson(res, 400, apiError('invalid_request', 'id is required'))
      return
    }
    if (
      typeof conversationId !== 'string' ||
      conversationId.length === 0
    ) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'conversationId is required'),
      )
      return
    }
    if (
      !(await context.canAccessConversation(conversationId, access.context))
    ) {
      writeJson(res, 404, apiError('not_found', 'Not found'))
      return
    }
    const manager = await context.getMcpManager()
    writeJson(res, 200, { aborted: manager.abortToolCall(id) })
  })
}

type WebMcpCallToolInput = Omit<
  Parameters<McpManager['callTool']>[0],
  'conversationId'
> & {
  conversationId: string
}

function parseCallToolRequest(
  value: Record<string, unknown>,
  app: App,
):
  | { ok: true; value: WebMcpCallToolInput }
  | { ok: false; message: string } {
  if (typeof value.name !== 'string' || value.name.length === 0) {
    return { ok: false, message: 'name is required' }
  }
  if (
    typeof value.conversationId !== 'string' ||
    value.conversationId.length === 0
  ) {
    return { ok: false, message: 'conversationId is required' }
  }
  if (
    value.args !== undefined &&
    (!value.args || typeof value.args !== 'object' || Array.isArray(value.args))
  ) {
    return { ok: false, message: 'args must be an object' }
  }
  const rawMessages = value.conversationMessages
  const conversationMessages = Array.isArray(rawMessages)
    ? rawMessages.map((message) =>
        deserializeChatMessage(message as never, app),
      )
    : undefined
  return {
    ok: true,
    value: {
      name: value.name,
      args: value.args as Record<string, unknown> | undefined,
      id: typeof value.id === 'string' ? value.id : undefined,
      conversationId: value.conversationId,
      roundId: typeof value.roundId === 'string' ? value.roundId : undefined,
      conversationMessages: conversationMessages,
      requireReview:
        typeof value.requireReview === 'boolean'
          ? value.requireReview
          : undefined,
      chatModelId:
        typeof value.chatModelId === 'string' ? value.chatModelId : undefined,
      subagentParentContext: value.subagentParentContext as never,
    },
  }
}

function getSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}

// backup 的 src/core/skills/assistantSkillPaths.ts 在 master 不存在；此内联
// 实现保持其逻辑（listLiteSkillEntries + isSkillEnabledForAssistant 过滤）。
async function resolveAssistantSkillPaths({
  app,
  settings,
  assistant,
}: {
  app: App
  settings: YoloSettings
  assistant: Assistant | null
}): Promise<string[]> {
  if (!assistant) {
    return []
  }

  const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
  const entries = await listLiteSkillEntries(app, { settings })

  return entries
    .filter((entry) =>
      isSkillEnabledForAssistant({
        assistant,
        skillName: entry.name,
        disabledSkillNames,
        defaultLoadMode: entry.mode,
      }),
    )
    .map((entry) => entry.path)
}
