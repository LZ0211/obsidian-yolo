/**
 * Bot Platform — Agent Integration (Phase 5).
 *
 * Runs one bot turn through the shared `AgentService` runtime and streams the
 * result back out through the originating `PlatformAdapter`. Reuses the
 * existing subscribe-before-run + event-translation orchestration already
 * built for `agent-api.ts` (`streamResolvedAgentRunEvents`) instead of
 * reimplementing it — see the Phase 5 section of
 * `docs/superpowers/specs/2026-07-06-bot-platform-implementation-plan.md`
 * for background, and the final report for why this deviates from that
 * doc's `BotOutputDispatcher` pseudocode.
 */
import type {
  SerializedEditorState,
  SerializedElementNode,
  SerializedTextNode,
} from 'lexical'
import type { App } from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

// 上游 agent-api 没有这个 helper（bot 消息用纯文本 editor state 提交）。
function createPlainTextEditorState(text: string): SerializedEditorState {
  const textNode: SerializedTextNode = {
    detail: 0,
    format: 0,
    mode: 'normal',
    style: '',
    text,
    type: 'text',
    version: 1,
  }
  const paragraph = {
    children: [textNode],
    direction: 'ltr',
    format: '',
    indent: 0,
    type: 'paragraph',
    version: 1,
    textFormat: 0,
    textStyle: '',
  } as SerializedElementNode<SerializedTextNode>

  return {
    root: {
      children: [paragraph],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  }
}

import { getMemoryIndexRuntimeHandle } from '../memory/memoryIndexRuntime'
import { resolveChatModeRuntime } from '../../components/chat-view/chat-runtime-profiles'
import { findUnifiedAgentById } from '../agent/workspaceAgentResolver'
import type {
  BotPlatformConfig,
  YoloSettings,
} from '../../settings/schema/setting.types'
import type { ChatMessage, ChatToolMessage } from '../../types/chat'
import type { Mentionable } from '../../types/mentionable'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import {
  buildAgentApiUserMessage,
  streamResolvedAgentRunEvents,
} from '../agent/agent-api'
import { DEFAULT_ASSISTANT_ID } from '../agent/default-assistant'
import type { AgentService } from '../agent/service'
import { getEnabledAssistantToolNames } from '../agent/tool-preferences'
import type { AgentRuntimeRunInput } from '../agent/types'
import { getChatModelClient } from '../llm/manager'
import { getLocalFileToolServerName } from '../mcp/localFileTools'
import type { McpManager } from '../mcp/mcpManager'
import { getToolName } from '../mcp/tool-name-utils'
import { listLiteSkillEntries } from '../skills/liteSkills'
import { isSkillEnabledForAssistant } from '../skills/skillPolicy'

import { BotSentMessageRegistry } from './bot-sent-registry'
import {
  SEND_ATTACHMENT_TOOL_NAME,
  convertAttachmentsToReply,
  scanForSendAttachment,
} from './message-converter'
import type { PlatformAdapter, ReplyContent, SentMessageRef } from './types'

export type RunBotAgentTurnParams = {
  app: App
  settings: YoloSettings
  agentService: AgentService
  mcpManager: McpManager
  loadConversation: (
    conversationId: string,
  ) => Promise<readonly ChatMessage[] | null>
  abortSignal?: AbortSignal
  adapter: PlatformAdapter
  sentMessageRegistry: BotSentMessageRegistry
  conversationId: string
  sessionKey: string
  chatType: 'private' | 'group'
  platformConfig: BotPlatformConfig
  promptContent: string
  mentionables: Mentionable[]
}

/**
 * Resolves the vault paths of every skill currently enabled for `assistant`.
 * Mirrors the private `resolveAllowedSkillPaths` in `agent-api.ts` (not
 * exported there, so duplicated here rather than reaching across module
 * boundaries for a private helper).
 */
async function resolveAllowedSkillPathsForBot({
  app,
  settings,
  assistant,
}: {
  app: App
  settings: YoloSettings
  assistant: ReturnType<typeof findUnifiedAgentById>
}): Promise<string[]> {
  if (!assistant) {
    return []
  }
  const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
  const skillEntries = await listLiteSkillEntries(app, { settings })
  return skillEntries
    .filter((skill) =>
      isSkillEnabledForAssistant({
        assistant,
        skillName: skill.name,
        disabledSkillNames,
      }),
    )
    .map((skill) => skill.path)
}

/**
 * Runs one bot conversation turn end-to-end: resolves the bound assistant +
 * tool policy, loads conversation history, appends the new incoming message,
 * runs it through `AgentService` with `persistState: true` (so the shared
 * `persistConversationMessages` hook wired in `main.ts` writes the turn back
 * to the same journal conversation `getOrCreateConversationId` created),
 * and streams the reply back out through `adapter`.
 */
export async function runBotAgentTurn(
  params: RunBotAgentTurnParams,
): Promise<void> {
  const {
    app,
    settings,
    agentService,
    mcpManager,
    loadConversation,
    abortSignal,
    adapter,
    sentMessageRegistry,
    conversationId,
    sessionKey,
    platformConfig,
    promptContent,
    mentionables,
  } = params

  const assistantId =
    platformConfig.assistantId ??
    settings.currentAssistantId ??
    DEFAULT_ASSISTANT_ID
  const assistant = findUnifiedAgentById(settings, assistantId)
  const requestedModelId = assistant?.modelId || settings.chatModelId
  const resolvedClient = getChatModelClient({
    settings,
    modelId: requestedModelId,
  })
  const provider = settings.providers.find(
    (candidate) => candidate.id === resolvedClient.model.providerId,
  )
  const assistantEnabledToolNames = getEnabledAssistantToolNames(assistant)
  const chatModeRuntime = resolveChatModeRuntime({
    mode: 'agent',
    yoloEnabled: true,
    assistant,
    assistantEnabledToolNames,
  })

  // Tool access follows the bound Agent's own permissions — no separate
  // bot-level tool-policy narrowing. `chatModeRuntime.allowedToolNames` is
  // already derived from `assistantEnabledToolNames` above.
  let allowedToolNames = chatModeRuntime.allowedToolNames

  // `send_attachment` is a bot-runtime-only capability (Bot Platform Phase
  // 6.5): it is deliberately excluded from `USER_FACING_LOCAL_TOOL_SHORT_NAMES`
  // so it can never reach `toolPreferences`/`assistantEnabledToolNames` (and
  // thus `chatModeRuntime.allowedToolNames`) through the normal Agent
  // settings surface. Bot runs are the only place that offers it, so it's
  // appended here unconditionally — the real security gate is the bound
  // assistant's `workspaceAccessPolicy`, enforced inside the tool's own
  // dispatch handler (`callLocalFileTool`), not a tool-name allowlist.
  const sendAttachmentToolName = getToolName(
    getLocalFileToolServerName(),
    SEND_ATTACHMENT_TOOL_NAME,
  )
  if (allowedToolNames && !allowedToolNames.includes(sendAttachmentToolName)) {
    allowedToolNames = [...allowedToolNames, sendAttachmentToolName]
  }

  const allowedSkillPaths = await resolveAllowedSkillPathsForBot({
    app,
    settings,
    assistant,
  })

  const requestSettings = {
    ...settings,
    currentAssistantId: assistant?.id,
  }
  const requestContextBuilder = new RequestContextBuilder(
    app,
    requestSettings,
    {
      includeSkills: true,
      systemPromptSnapshotStore: agentService.getSystemPromptSnapshotStore(),
      getPromptSourceRevision: () =>
        agentService.getPromptSourceWatcher().getRevision(),
      promptSourcePathsCallback: (paths) =>
        agentService.getPromptSourceWatcher().setWatchedPaths(paths),
      memoryIndexRuntime: getMemoryIndexRuntimeHandle(app, () => requestSettings),
    },
  )

  const historyMessages = [...((await loadConversation(conversationId)) ?? [])]
  const sourceUserMessageId = uuidv4()
  const userMessage = buildAgentApiUserMessage({
    id: sourceUserMessageId,
    content: createPlainTextEditorState(promptContent),
    promptContent,
    mentionables,
  })
  const messages = [...historyMessages, userMessage]

  const ownedAbortController = abortSignal ? null : new AbortController()
  const runAbortSignal = abortSignal ?? ownedAbortController!.signal
  const input: AgentRuntimeRunInput = {
    providerClient: resolvedClient.providerClient,
    model: resolvedClient.model,
    apiType: provider?.apiType ?? null,
    messages,
    conversationId,
    assistantId: assistant?.id,
    sourceUserMessageId,
    requestContextBuilder,
    mcpManager,
    abortSignal: runAbortSignal,
    allowedToolNames,
    enableToolDisclosure: settings.mcp.enableToolDisclosure,
    toolPreferences: chatModeRuntime.toolPreferences,
    toolServerPreferences: chatModeRuntime.toolServerPreferences,
    toolCapabilityMode: chatModeRuntime.toolCapabilityMode,
    bypassToolApproval: chatModeRuntime.bypassToolApproval,
    workspaceAccessPolicy:
      assistant?.workspaceAccessPolicy,
    allowedSkillPaths,
    requestParams: {
      deliveryMode: 'incremental',
      primaryRequestTimeoutMs:
        settings.continuationOptions.primaryRequestTimeoutMs,
      streamFallbackRecoveryEnabled:
        settings.continuationOptions.streamFallbackRecoveryEnabled,
    },
  }

  const useStreaming = adapter.capabilities.supportsStreaming
  let streamHandle:
    | ReturnType<PlatformAdapter['sendStreamingMessage']>
    | undefined

  const registerSent = (refs: SentMessageRef[]) => {
    sentMessageRegistry.registerAll(
      refs.map((ref) => ref.platformMessageId),
      sessionKey,
    )
  }

  try {
    for await (const event of streamResolvedAgentRunEvents({
      conversationId,
      sourceUserMessageId,
      loopConfig: chatModeRuntime.loopConfig,
      input,
      persistState: true,
      agentService,
    })) {
      switch (event.type) {
        case 'text':
          if (useStreaming) {
            streamHandle ??= adapter.sendStreamingMessage(sessionKey)
            await streamHandle.update(event.text)
          }
          break

        case 'completed': {
          const replyContent = buildReplyContentForCompletedTurn({
            agentService,
            conversationId,
            sourceUserMessageId,
            text: event.text,
          })
          const refs =
            useStreaming && streamHandle
              ? await streamHandle.finish(replyContent)
              : await adapter.sendMessage(sessionKey, replyContent)
          registerSent(refs)
          break
        }

        case 'error': {
          if (runAbortSignal.aborted) break
          console.error('[YOLO Bot] Agent run error:', event.message)
          const refs = await adapter.sendMessage(sessionKey, {
            text: `Sorry, something went wrong: ${event.message.split('\n')[0]}`,
          })
          registerSent(refs)
          break
        }

        case 'tool':
        case 'state':
          // MVP: no user-visible "using tool X..." indicator, and no
          // action needed on bare state transitions (see Phase 5 plan).
          break
      }
    }
  } catch (error) {
    if (runAbortSignal.aborted) return
    const message = error instanceof Error ? error.message : String(error)
    console.error('[YOLO Bot] Agent turn failed before completion:', error)
    if (streamHandle) {
      await streamHandle.abort().catch((abortError) => {
        console.error('[YOLO Bot] Failed to abort streaming reply:', abortError)
      })
    }
    try {
      const refs = await adapter.sendMessage(sessionKey, {
        text: `Sorry, something went wrong: ${message}`,
      })
      registerSent(refs)
    } catch (sendError) {
      console.error('[YOLO Bot] Failed to send agent error reply:', sendError)
    }
  } finally {
    ownedAbortController?.abort()
  }
}

/**
 * Builds the `ReplyContent` sent out for a completed turn: plain `{ text }`
 * when the turn made no `send_attachment` calls (preserving exact backward
 * compatibility with existing text-only sends), or `{ text, images, files }`
 * when it did. Looks up the full turn via `AgentService.getState` (rather
 * than threading `state.messages` through the `completed` event) because
 * `YoloAgentEvent`'s `completed` variant only carries `text`, not `messages` —
 * see `conversationStateToEvents` in `agent-api.ts`.
 */
function buildReplyContentForCompletedTurn({
  agentService,
  conversationId,
  sourceUserMessageId,
  text,
}: {
  agentService: AgentService
  conversationId: string
  sourceUserMessageId: string
  text: string
}): ReplyContent {
  const state = agentService.getState(conversationId)
  const turnToolMessages = state.messages.filter(
    (message): message is ChatToolMessage =>
      message.role === 'tool' &&
      message.metadata?.sourceUserMessageId === sourceUserMessageId,
  )
  const sendAttachmentCalls = scanForSendAttachment(turnToolMessages)
  if (sendAttachmentCalls.length === 0) {
    return { text }
  }

  const { images, files } = convertAttachmentsToReply(sendAttachmentCalls)
  return {
    text,
    ...(images.length > 0 ? { images } : {}),
    ...(files.length > 0 ? { files } : {}),
  }
}
