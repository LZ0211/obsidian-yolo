import { normalizeSubagentModelOptions } from '../../core/agent/subagent/model-config'
import { normalizeWorkspacePolicy } from '../../core/agent/workspaceScope'

import { SETTINGS_SCHEMA_VERSION, SETTING_MIGRATIONS } from './migrations'
import { YoloSettings, yoloSettingsSchema } from './setting.types'

export function normalizeYoloSettingsReferences(
  settings: YoloSettings,
): YoloSettings {
  const validProviderIds = new Set(
    settings.providers.map((provider) => provider.id),
  )
  const chatModels = settings.chatModels.filter((model) =>
    validProviderIds.has(model.providerId),
  )
  const seenEmbeddingModelKeys = new Set<string>()
  const embeddingModels = settings.embeddingModels.filter((model) => {
    if (!validProviderIds.has(model.providerId)) {
      return false
    }

    const dedupeKey = `${model.providerId}::${model.model}`
    if (seenEmbeddingModelKeys.has(dedupeKey)) {
      return false
    }

    seenEmbeddingModelKeys.add(dedupeKey)
    return true
  })
  const validChatModelIds = new Set(chatModels.map((model) => model.id))
  const validEmbeddingModelIds = new Set(
    embeddingModels.map((model) => model.id),
  )
  const fallbackChatModelId =
    chatModels.find((model) => model.enable ?? true)?.id ?? ''
  const fallbackEmbeddingModelId = embeddingModels[0]?.id ?? ''
  const normalizeModelReference = (
    modelId: string | undefined,
    validModelIds: Set<string>,
    fallbackModelId: string,
  ): string | undefined => {
    if (!modelId) {
      return modelId
    }

    if (validModelIds.has(modelId)) {
      return modelId
    }

    return fallbackModelId
  }
  const assistants = settings.assistants.map((assistant) => {
    const normalized = {
      ...assistant,
      modelId:
        !assistant.modelId || validChatModelIds.has(assistant.modelId)
          ? assistant.modelId
          : undefined,
    }
    // 上游残留的 workspaceScope 字段仅用于兼容旧持久化：初始化时一次性翻译
    // 进 workspaceAccessPolicy（本地策略是其严格超集），运行时只读 policy。
    // 翻译只发生在 policy 缺失或未启用时——显式配置的 policy 永远优先。
    if (
      normalized.workspaceScope?.enabled &&
      !normalized.workspaceAccessPolicy?.enabled
    ) {
      normalized.workspaceAccessPolicy = normalizeWorkspacePolicy(
        normalized.workspaceScope,
        undefined,
      )
    }
    return normalized
  })
  const validAssistantIds = new Set(assistants.map((assistant) => assistant.id))
  const workspaceAgents = settings.workspaceAgents.filter((agent) =>
    validAssistantIds.has(agent.templateId),
  )
  const validAgentIds = new Set([
    ...validAssistantIds,
    ...workspaceAgents
      .filter((agent) => !agent.disabled)
      .map((agent) => agent.id),
  ])
  const normalizedChatModelId =
    normalizeModelReference(
      settings.chatModelId,
      validChatModelIds,
      fallbackChatModelId,
    ) ?? ''
  const normalized: YoloSettings = {
    ...settings,
    chatModels,
    embeddingModels,
    chatModelId: normalizedChatModelId,
    chatTitleModelId:
      normalizeModelReference(
        settings.chatTitleModelId,
        validChatModelIds,
        fallbackChatModelId,
      ) ?? '',
    embeddingModelId:
      normalizeModelReference(
        settings.embeddingModelId,
        validEmbeddingModelIds,
        fallbackEmbeddingModelId,
      ) ?? '',
    continuationOptions: {
      ...settings.continuationOptions,
      continuationModelId: normalizeModelReference(
        settings.continuationOptions.continuationModelId,
        validChatModelIds,
        fallbackChatModelId,
      ),
      tabCompletionModelId: normalizeModelReference(
        settings.continuationOptions.tabCompletionModelId,
        validChatModelIds,
        fallbackChatModelId,
      ),
    },
    assistants,
    workspaceAgents,
    currentAssistantId:
      settings.currentAssistantId &&
      validAgentIds.has(settings.currentAssistantId)
        ? settings.currentAssistantId
        : undefined,
    quickAskAssistantId:
      settings.quickAskAssistantId &&
      validAgentIds.has(settings.quickAskAssistantId)
        ? settings.quickAskAssistantId
        : undefined,
    currentWorkspaceAgentId:
      settings.currentWorkspaceAgentId &&
      workspaceAgents.some(
        (agent) =>
          !agent.disabled && agent.id === settings.currentWorkspaceAgentId,
      )
        ? settings.currentWorkspaceAgentId
        : undefined,
  }

  return normalizeSubagentModelOptions(normalized)
}

/** 只执行设置迁移链，不做 schema 解析、默认值填充或引用规范化。 */
export function migrateYoloSettingsData(
  data: Record<string, unknown>,
): Record<string, unknown> {
  let currentData = { ...data }
  let currentVersion = (currentData.version as number) ?? 0

  for (const migration of SETTING_MIGRATIONS) {
    if (
      currentVersion >= migration.fromVersion &&
      currentVersion < migration.toVersion &&
      migration.toVersion <= SETTINGS_SCHEMA_VERSION
    ) {
      console.debug(
        `Migrating settings from ${migration.fromVersion} to ${migration.toVersion}`,
      )
      currentData = migration.migrate(currentData)
      currentVersion = migration.toVersion
    }
  }

  return currentData
}

export function parseYoloSettings(data: unknown): YoloSettings {
  try {
    if (
      !data ||
      (typeof data === 'object' &&
        data !== null &&
        Object.keys(data as Record<string, unknown>).length === 0)
    ) {
      const parsed = yoloSettingsSchema.parse({})
      return { ...parsed, version: SETTINGS_SCHEMA_VERSION }
    }

    const migratedData = migrateYoloSettingsData(
      data as Record<string, unknown>,
    )
    const parsed = yoloSettingsSchema.parse(migratedData)
    const normalized = normalizeYoloSettingsReferences(parsed)
    return { ...normalized, version: SETTINGS_SCHEMA_VERSION }
  } catch (error) {
    console.warn('Invalid settings provided, using defaults:', error)
    const defaults = yoloSettingsSchema.parse({})
    return { ...defaults, version: SETTINGS_SCHEMA_VERSION }
  }
}
