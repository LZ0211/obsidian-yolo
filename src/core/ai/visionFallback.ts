import { DEFAULT_MODEL_REQUEST_TIMEOUT_MS } from '../../settings/schema/setting.types'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatMessage } from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import { resolveVisionFallbackEngines } from '../../utils/llm/visionFallbackEngines'
import { getChatModelClient } from '../llm/manager'
import { asErrorMessage } from '../tools/tool-args'

import { executeSingleTurn } from './single-turn'

export { resolveVisionFallbackEngines }

/**
 * Vision-engine fallback for fs_read's plain-image branch: when the active
 * chat model cannot take images (e.g. a text-only DeepSeek), an already
 * configured vision-capable model describes the picture and the text comes
 * back to the text-only model. Modeled on ModLens's read-image tool
 * (reference/vision/modlens-main): multiple engines, first-success failover,
 * text evidence instead of raw pixels.
 */

export type VisionFallbackResult = {
  modelId: string
  description: string
}

const extractLastUserPrompt = (
  messages: ChatMessage[] | undefined,
): string | undefined => {
  if (!messages) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const promptContent = (message as { promptContent?: unknown }).promptContent
    if (typeof promptContent === 'string' && promptContent.trim().length > 0) {
      return promptContent.trim()
    }
    if (Array.isArray(promptContent)) {
      const text = (promptContent as ContentPart[])
        .filter(
          (p): p is Extract<ContentPart, { type: 'text' }> => p.type === 'text',
        )
        .map((p) => p.text)
        .join('\n')
        .trim()
      if (text.length > 0) return text
    }
  }
  return undefined
}

export function buildVisionFallbackPrompt(
  conversationMessages?: ChatMessage[],
): string {
  const question = extractLastUserPrompt(conversationMessages)
  if (question) {
    return `用户当前的问题/请求：${question}\n\n请针对上述问题描述这张图片，包括所有可见的文字、图表、布局细节，以便不支持图像输入的模型基于你的描述继续回答。`
  }
  return '请描述这张图片的内容，包括所有可见的文字、图表、布局细节，以便不支持图像输入的模型基于你的描述继续回答。'
}

export async function describeImageViaVisionEngine({
  settings,
  dataUrl,
  chatModelId,
  conversationMessages,
  signal,
}: {
  settings: YoloSettings
  dataUrl: string
  chatModelId?: string
  conversationMessages?: ChatMessage[]
  signal?: AbortSignal
}): Promise<VisionFallbackResult> {
  const engines = resolveVisionFallbackEngines(settings, {
    excludeModelId: chatModelId,
  })
  if (engines.length === 0) {
    throw new Error('没有可用的视觉引擎')
  }

  const prompt = buildVisionFallbackPrompt(conversationMessages)
  const failures: string[] = []

  for (const model of engines) {
    try {
      const { providerClient } = getChatModelClient({
        settings,
        modelId: model.id,
      })
      const result = await executeSingleTurn({
        providerClient,
        model,
        request: {
          model: model.model,
          messages: [
            {
              role: 'user',
              content: [
                { type: 'image_url', image_url: { url: dataUrl } },
                { type: 'text', text: prompt },
              ],
            },
          ],
        },
        signal,
        primaryRequestTimeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
      })
      const description = result.content.trim()
      if (description.length === 0) {
        failures.push(`${model.id}: 空响应`)
        continue
      }
      return { modelId: model.id, description }
    } catch (error) {
      failures.push(`${model.id}: ${asErrorMessage(error)}`)
    }
  }

  throw new Error(`所有视觉引擎均失败：${failures.join('；')}`)
}
