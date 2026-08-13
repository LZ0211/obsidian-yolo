import { editorStateToPlainText } from '../../components/chat-view/chat-input/utils/editor-state-to-plain-text'
import { DEFAULT_CHAT_TITLE_PROMPT } from '../../constants'
import { isRequestErrorNonRetryable } from '../../core/ai/requestRetry'
import { executeSingleTurn } from '../../core/ai/single-turn'
import {
  createLLMDebugTrace,
  isLLMDebugCaptureEnabled,
  registerLLMDebugTraceForTurn,
  updateLLMDebugTrace,
} from '../../core/llm/debugCapture'
import { LLMAPIKeyNotSetException } from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import type { AutoPromotedTransportMode } from '../../core/llm/requestTransport'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  ChatMessage,
  ChatSelectedSkill,
  ChatUserMessage,
} from '../../types/chat'

export const AUTO_TITLE_TIMEOUT_MS = 10000
export const AUTO_TITLE_MAX_RETRIES = 2
export const AUTO_TITLE_FAILURE_COOLDOWN_MS = 5 * 60 * 1000

/** API key 缺失兜底标题的截断长度。 */
const FALLBACK_TITLE_MAX_LENGTH = 40

const formatSelectedSkillsForTitleInput = (
  selectedSkills: ChatSelectedSkill[],
): string => {
  const skillNames = selectedSkills
    .map((skill) => skill.name.trim())
    .filter((name) => name.length > 0)

  if (skillNames.length === 0) {
    return '[User selected only skills without text.]'
  }

  return `[User selected skills: ${skillNames.join(', ')}]`
}

const extractTextFromPromptContent = (
  promptContent: ChatUserMessage['promptContent'],
): string => {
  if (!promptContent) return ''
  if (typeof promptContent === 'string') return promptContent.trim()
  return promptContent
    .filter((part) => part.type === 'text')
    .map((part) => part.text.trim())
    .filter((text) => text.length > 0)
    .join('\n\n')
}

export const buildConversationTitleInput = (
  firstUserMessage: ChatUserMessage,
): string | null => {
  const userText = firstUserMessage.content
    ? editorStateToPlainText(firstUserMessage.content)
    : ''
  const normalizedUserText = userText.trim()
  const userMentionables = firstUserMessage.mentionables ?? []
  const userSelectedSkills = firstUserMessage.selectedSkills ?? []
  // Reuse the same expanded prompt that gets sent to the chat model so
  // the title model sees referenced files / URLs / blocks / quotes
  // without re-running compilation or doing extra I/O here.
  const compiledText = extractTextFromPromptContent(
    firstUserMessage.promptContent,
  )
  const hasUserSignal =
    normalizedUserText.length > 0 ||
    compiledText.length > 0 ||
    userMentionables.length > 0 ||
    userSelectedSkills.length > 0

  if (!hasUserSignal) return null

  const userContext =
    compiledText.length > 0
      ? compiledText
      : normalizedUserText.length > 0
        ? normalizedUserText
        : userSelectedSkills.length > 0
          ? formatSelectedSkillsForTitleInput(userSelectedSkills)
          : '[User shared only attachments/mentions without text.]'

  return `User first message:\n${userContext}`
}

export type GenerateConversationTitleParams = {
  settings: YoloSettings
  language: string
  messages: ChatMessage[]
  onAutoPromoteTransportMode?: (
    providerId: string,
    mode: AutoPromotedTransportMode,
  ) => void
  debug?: {
    conversationId: string
    sourceUserMessageId: string
  }
}

export type GenerateConversationTitleResult =
  | { ok: true; title: string }
  | {
      ok: false
      reason: 'no_user_signal' | 'llm_generation_failed'
      error?: unknown
    }

export const generateConversationTitleText = async ({
  settings,
  language,
  messages,
  onAutoPromoteTransportMode,
  debug,
}: GenerateConversationTitleParams): Promise<GenerateConversationTitleResult> => {
  const firstUserMessage = messages.find((message) => message.role === 'user')
  if (!firstUserMessage) {
    return { ok: false, reason: 'no_user_signal' }
  }

  const titleInput = buildConversationTitleInput(firstUserMessage)
  if (!titleInput) {
    return { ok: false, reason: 'no_user_signal' }
  }

  let lastGenerationError: unknown = null

  const attemptGenerateTitle = async (
    retryCount: number = 0,
  ): Promise<string | null> => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), AUTO_TITLE_TIMEOUT_MS)

    try {
      const { providerClient, model } = getChatModelClient({
        settings,
        modelId: settings.chatTitleModelId,
        onAutoPromoteTransportMode,
      })

      const defaultTitlePrompt =
        DEFAULT_CHAT_TITLE_PROMPT[
          language as keyof typeof DEFAULT_CHAT_TITLE_PROMPT
        ] ?? DEFAULT_CHAT_TITLE_PROMPT.en
      const customizedPrompt = (
        settings.chatOptions.chatTitlePrompt ?? ''
      ).trim()
      const systemPrompt =
        customizedPrompt.length > 0 ? customizedPrompt : defaultTitlePrompt
      const debugTrace = isLLMDebugCaptureEnabled()
        ? createLLMDebugTrace({
            model,
            requestKind: 'title-generation',
          })
        : null
      if (debugTrace && debug) {
        registerLLMDebugTraceForTurn({
          conversationId: debug.conversationId,
          sourceUserMessageId: debug.sourceUserMessageId,
          traceId: debugTrace.id,
        })
      }

      const startedAt = Date.now()
      let response: Awaited<ReturnType<typeof executeSingleTurn>>
      try {
        response = await executeSingleTurn({
          providerClient,
          model,
          request: {
            model: model.model,
            messages: [
              { role: 'system', content: systemPrompt },
              { role: 'user', content: titleInput },
            ],
          },
          deliveryMode: 'buffered',
          purpose: 'lightweight',
          reasoningPolicy: 'omit',
          signal: controller.signal,
          debugTraceId: debugTrace?.id,
        })
      } catch (error) {
        updateLLMDebugTrace(debugTrace?.id, {
          completedAt: Date.now(),
          durationMs: Date.now() - startedAt,
          generationState: controller.signal.aborted ? 'aborted' : 'error',
          errorMessage: error instanceof Error ? error.message : String(error),
        })
        throw error
      }
      updateLLMDebugTrace(debugTrace?.id, {
        completedAt: Date.now(),
        durationMs: Date.now() - startedAt,
        generationState: 'completed',
        usage: response.usage,
        hasToolCalls: response.toolCalls.length > 0,
        toolCallNames: response.toolCalls.map((toolCall) => toolCall.name),
      })

      const nextTitle = (response.content || '')
        .trim()
        .replace(/^["']+|["']+$/g, '')
      return nextTitle || null
    } catch (error) {
      lastGenerationError = error
      if (
        retryCount < AUTO_TITLE_MAX_RETRIES &&
        !isRequestErrorNonRetryable(error) &&
        // API key 缺失（web 端脱敏 settings）在同一重试窗口内不会自愈，
        // 直接走 A4 截断兜底，省掉无意义的重试退避
        !(error instanceof LLMAPIKeyNotSetException)
      ) {
        const backoffMs = 300 * (retryCount + 1)
        await new Promise((resolve) => setTimeout(resolve, backoffMs))
        return attemptGenerateTitle(retryCount + 1)
      }
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const generatedTitle = await attemptGenerateTitle()
  if (!generatedTitle) {
    // A4 web 回归：浏览器运行的自动标题路径拿到的 settings 来自 /api/settings
    // 脱敏副本（providers apiKey 置空）——getChatModelClient 抛
    // LLMAPIKeyNotSetException，web 会话标题停在 "New chat"。服务端
    // /api/chat/generate-title 路由用完整 settings（registerWebServerRoutes
    // options.getSettings）不受影响；此处兜底让 key 缺失时降级为首条消息
    // 截断标题，而不是静默失败（桌面真配置缺失时同样受益，不再无标题）。
    if (lastGenerationError instanceof LLMAPIKeyNotSetException) {
      const fallbackTitle = buildFallbackTitle(firstUserMessage)
      if (fallbackTitle) {
        return { ok: true, title: fallbackTitle }
      }
    }
    return {
      ok: false,
      reason: 'llm_generation_failed',
      error: lastGenerationError,
    }
  }
  return { ok: true, title: generatedTitle }
}

/** API key 缺失时的兜底标题：首条用户消息文本截断（A4）。 */
export function buildFallbackTitle(
  firstUserMessage: ChatUserMessage,
): string | null {
  const userText = firstUserMessage.content
    ? editorStateToPlainText(firstUserMessage.content).trim()
    : ''
  const fallback = userText.trim() || extractTextFromPromptContent(
    firstUserMessage.promptContent,
  ).trim()
  if (fallback.length === 0) return null
  if (fallback.length <= FALLBACK_TITLE_MAX_LENGTH) return fallback
  return `${fallback.slice(0, FALLBACK_TITLE_MAX_LENGTH)}…`
}
