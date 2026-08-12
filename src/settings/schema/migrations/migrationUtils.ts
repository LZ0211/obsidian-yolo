import { deepMerge } from '../../../features/config-transfer/merge-utils'

import { SettingMigration } from '../setting.types'

export type ExistingSettingsData = Parameters<SettingMigration['migrate']>[0]
export type DefaultProviders = readonly {
  type: string
  id: string
}[]

export const getMigratedProviders = (
  existingData: ExistingSettingsData,
  defaultProvidersForVersion: DefaultProviders,
) => {
  if (!('providers' in existingData && Array.isArray(existingData.providers))) {
    return defaultProvidersForVersion
  }

  const defaultProviders = defaultProvidersForVersion.map((provider) => {
    const existingProvider = (existingData.providers as unknown[]).find(
      (p: unknown) =>
        (p as { type: string }).type === provider.type &&
        (p as { id: string }).id === provider.id,
    )
    // Deep merge: 用户已有子字段（如 thinking/web_search_options 内的自定义项）
    // 逐字段保留，默认值只填补用户未设置的字段，冲突标量以默认值为准。
    return existingProvider
      ? (deepMerge(
          existingProvider as Record<string, unknown>,
          provider as unknown as Record<string, unknown>,
        ) as DefaultProviders[number])
      : provider
  })
  const customProviders = (existingData.providers as unknown[]).filter(
    (p: unknown) =>
      !defaultProviders.some(
        (dp: unknown) => (dp as { id: string }).id === (p as { id: string }).id,
      ),
  )

  return [...defaultProviders, ...customProviders]
}

export type DefaultChatModels = {
  id: string
  providerType: string
  providerId: string
  model: string
  reasoning_effort?: string
  thinking?: {
    budget_tokens: number
  }
  web_search_options?: {
    search_context_size?: string
  }
  enable?: boolean
}[]

export const getMigratedChatModels = (
  existingData: ExistingSettingsData,
  defaultChatModelsForVersion: DefaultChatModels,
) => {
  if (
    !('chatModels' in existingData && Array.isArray(existingData.chatModels))
  ) {
    return defaultChatModelsForVersion
  }

  const defaultChatModels = defaultChatModelsForVersion.map((model) => {
    const existingModel = (existingData.chatModels as unknown[]).find(
      (m: unknown) => {
        return (m as { id: string }).id === model.id
      },
    )
    if (existingModel) {
      // Deep merge：用户已有的 thinking/web_search_options 子字段不被默认值
      // 整块覆盖，冲突标量以默认值为准，用户独有子字段保留。
      return deepMerge(
        existingModel as Record<string, unknown>,
        model as unknown as Record<string, unknown>,
      ) as DefaultChatModels[number]
    }
    return model
  })
  const customChatModels = (existingData.chatModels as unknown[]).filter(
    (m: unknown) => {
      return !defaultChatModels.some(
        (dm: unknown) => (dm as { id: string }).id === (m as { id: string }).id,
      )
    },
  )

  return [...defaultChatModels, ...customChatModels]
}

export type DefaultEmbeddingModels = {
  id: string
  providerType: string
  providerId: string
  model: string
  dimension: number
}[]

export const getMigratedEmbeddingModels = (
  existingData: ExistingSettingsData,
  defaultEmbeddingModelsForVersion: DefaultEmbeddingModels,
) => {
  if (
    !(
      'embeddingModels' in existingData &&
      Array.isArray(existingData.embeddingModels)
    )
  ) {
    return defaultEmbeddingModelsForVersion
  }

  const defaultEmbeddingModels = defaultEmbeddingModelsForVersion.map(
    (model) => {
      const existingModel = (existingData.embeddingModels as unknown[]).find(
        (m: unknown) => {
          return (m as { id: string }).id === model.id
        },
      )
      if (existingModel) {
        // 与 providers/chatModels 同规则深合并（当前 embedding 无嵌套字段，
        // 行为与浅合并一致，但防止未来引入嵌套字段时重蹈覆盖 bug）。
        return deepMerge(
          existingModel as Record<string, unknown>,
          model as unknown as Record<string, unknown>,
        ) as DefaultEmbeddingModels[number]
      }
      return model
    },
  )
  const customEmbeddingModels = (
    existingData.embeddingModels as unknown[]
  ).filter((m: unknown) => {
    return !defaultEmbeddingModels.some(
      (dm: unknown) => (dm as { id: string }).id === (m as { id: string }).id,
    )
  })

  return [...defaultEmbeddingModels, ...customEmbeddingModels]
}
