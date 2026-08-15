import { YoloSettings } from '../../settings/schema/setting.types'
import type {
  RerankModelClient,
  RerankRequestOptions,
  RerankResponse,
  RerankResult,
} from '../../types/rerank'
import { getProviderClient } from '../llm/manager'

export const getRerankModelClient = ({
  settings,
  rerankModelId,
}: {
  settings: YoloSettings
  rerankModelId: string
}): RerankModelClient | null => {
  const rerankModel = settings.rerankModels?.find(
    (model) => model.id === rerankModelId,
  )
  if (!rerankModel) {
    return null
  }

  const provider = settings.providers.find(
    (candidate) => candidate.id === rerankModel.providerId,
  )
  if (!provider) return null

  let providerClient: {
    rerank: (
      model: string,
      query: string,
      documents: string[],
      options: { topN?: number; signal?: AbortSignal },
    ) => Promise<Array<{ index: number; relevanceScore: number }>>
  }
  try {
    providerClient = getProviderClient({
      settings,
      providerId: rerankModel.providerId,
    })
  } catch {
    return null
  }

  return {
    id: rerankModel.id,
    providerId: provider.id,
    maxDocuments: rerankModel.maxDocuments,
    maxInputChars: rerankModel.maxInputChars,
    rerank: async (
      query: string,
      documents: string[],
      options: RerankRequestOptions,
    ): Promise<RerankResponse> => ({
      kind: 'scores',
      results: await providerClient.rerank(
        rerankModel.model,
        query,
        documents,
        {
          topN: options.topN,
          signal: options.signal,
        },
      ),
    }),
  }
}

export function applyLegacyRerankResponse<T extends { similarity: number }>(
  rows: readonly T[],
  response: RerankResponse | readonly RerankResult[],
): T[] {
  if (!('kind' in response)) {
    return applyLegacyScores(rows, response)
  }
  if (response.kind === 'ordering') {
    const order = new Map<number, number>()
    for (const index of response.indices) {
      if (
        Number.isSafeInteger(index) &&
        index >= 0 &&
        index < rows.length &&
        !order.has(index)
      ) {
        order.set(index, order.size)
      }
    }
    return rows
      .map((row, index) => ({ row, index }))
      .sort(
        (left, right) =>
          (order.get(left.index) ?? Number.MAX_SAFE_INTEGER) -
            (order.get(right.index) ?? Number.MAX_SAFE_INTEGER) ||
          left.index - right.index,
      )
      .map((item) => item.row)
  }
  return applyLegacyScores(rows, response.results)
}

function applyLegacyScores<T extends { similarity: number }>(
  rows: readonly T[],
  results: readonly RerankResult[],
): T[] {
  const scoreByIndex = new Map<number, number>()
  for (const item of results) {
    if (
      Number.isSafeInteger(item.index) &&
      item.index >= 0 &&
      item.index < rows.length &&
      Number.isFinite(item.relevanceScore)
    ) {
      scoreByIndex.set(item.index, item.relevanceScore)
    }
  }
  return rows
    .map((row, index) => ({
      row: { ...row, similarity: scoreByIndex.get(index) ?? row.similarity },
      index,
    }))
    .sort(
      (left, right) =>
        right.row.similarity - left.row.similarity || left.index - right.index,
    )
    .map((item) => item.row)
}
