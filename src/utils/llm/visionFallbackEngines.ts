import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatModel } from '../../types/chat-model.types'

import { chatModelSupportsVision } from './model-modalities'

/**
 * Vision-engine resolution for the image-reading fallback (fs_read's
 * plain-image branch and the built-in Image Reader subagent).
 *
 * Lives in `utils/` rather than `core/ai/visionFallback.ts` so
 * `core/agent/subagent/delegatable-assistant.ts` can consume it without
 * pulling in `single-turn.ts` (which statically imports the local-file-tool
 * graph and would cycle).
 *
 * Selection: an explicit `chatOptions.imageReadingFallbackModelIds` list
 * (order = priority, non-vision/missing entries filtered out), else
 * auto-discovery of every enabled vision-capable model except `excludeModelId`.
 */
export function resolveVisionFallbackEngines(
  settings: YoloSettings,
  options: { excludeModelId?: string } = {},
): ChatModel[] {
  const explicit = settings.chatOptions?.imageReadingFallbackModelIds ?? []
  const visionModels = (settings.chatModels ?? []).filter(
    (model) => model.enable !== false && chatModelSupportsVision(model),
  )

  if (explicit.length > 0) {
    const byId = new Map(visionModels.map((model) => [model.id, model]))
    return explicit
      .map((id) => byId.get(id))
      .filter((model): model is ChatModel => model !== undefined)
  }

  return visionModels.filter((model) => model.id !== options.excludeModelId)
}
