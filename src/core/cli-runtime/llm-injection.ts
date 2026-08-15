import type { ChatModel } from '../../types/chat-model.types'
import type { YoloSettingsLike } from '../../types/yoloSettingsLike'
import type { CliRuntimeId } from './types'

export type CliLlmInjectionSettings = {
  enabled: boolean
  providerId?: string
  modelId?: string
}

export type LlmInjectionProvider = {
  id: string
  name?: string
  baseUrl?: string
  apiKey?: string
}

export type LlmInjection = {
  provider: LlmInjectionProvider
  model: ChatModel
}

/**
 * 模型设置里的 CLI 注入开关：开启时 CLI runtime 使用 YOLO 配置的 provider
 * （baseUrl/apiKey/模型），关闭时 SDK 用自身配置（现状）。
 * 无效引用（provider/model 被删）视为关闭。
 */
export function resolveLlmInjection(input: {
  injection?: CliLlmInjectionSettings | null
  getSettings: () => YoloSettingsLike | null
}): LlmInjection | null {
  if (!input.injection?.enabled) return null
  const settings = input.getSettings()
  if (!settings) return null
  const providerId = input.injection.providerId?.trim()
  const modelId = input.injection.modelId?.trim()
  if (!providerId || !modelId) return null

  const providers = (settings as YoloSettingsLike & {
    providers?: Array<{
      id: string
      name?: string
      baseUrl?: string
      apiKey?: string
    }>
  }).providers
  const models = (settings as YoloSettingsLike & {
    chatModels?: ChatModel[]
  }).chatModels
  const provider = (providers ?? []).find(
    (candidate) => candidate.id === providerId,
  )
  const model = (models ?? []).find((candidate) => candidate.id === modelId)
  if (!provider || !model) return null
  return { provider, model }
}

/** cc-switch 默认 Claude 模型。 */
export const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-20250514'

/**
 * 从当前设置解析某 runtime 的注入 env；开关关闭或引用无效时返回 null
 * （调用方保持 SDK 自身配置）。
 */
export function resolveRuntimeLlmEnv(
  getSettings: () => YoloSettingsLike | null,
  runtimeId: CliRuntimeId,
): Record<string, string> | null {
  const settings = getSettings()
  if (!settings) return null
  const injection = (settings as YoloSettingsLike & {
    cliLlmInjection?: CliLlmInjectionSettings
  }).cliLlmInjection
  const resolved = resolveLlmInjection({
    injection,
    getSettings: () => settings,
  })
  return resolved ? buildLlmEnvForRuntime(runtimeId, resolved) : null
}

/**
 * 各 CLI runtime 的 LLM 环境变量（cc-switch 式）：
 * - claude-code / hermes / pi：Anthropic 兼容 env（pi 通过 Anthropic SDK 路径）
 * - codex：认证 env（baseUrl/model 走 config.toml，见 codex 配置同步）
 * - opencode：无 env（provider 段走 opencode.json，见 opencode 配置同步）
 */
export function buildLlmEnvForRuntime(
  runtimeId: CliRuntimeId,
  injection: LlmInjection,
): Record<string, string> {
  const { provider, model } = injection
  const modelName = model.model.trim() || DEFAULT_CLAUDE_MODEL

  if (runtimeId === 'codex') {
    const env: Record<string, string> = {}
    if (provider.apiKey) {
      env.CODEX_API_KEY = provider.apiKey
      env.OPENAI_API_KEY = provider.apiKey
    }
    return env
  }

  if (runtimeId === 'opencode') {
    return {}
  }

  // claude-code / hermes / pi
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: provider.baseUrl ?? '',
    ANTHROPIC_MODEL: modelName,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelName,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelName,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelName,
  }
  if (provider.apiKey) {
    env.ANTHROPIC_AUTH_TOKEN = provider.apiKey
  }
  return env
}
