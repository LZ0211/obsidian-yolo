import * as fs from 'node:fs'

import OpenAI from 'openai'

import {
  type EmbeddingProbeSample,
  runEmbeddingConcurrencyProbe,
} from './embeddingConcurrencyProbe'

export async function runEmbeddingConcurrencyProbeFromSettingsFile({
  settingsPath,
  embeddingModelId,
  requests,
  concurrency,
  texts,
}: {
  settingsPath: string
  embeddingModelId?: string
  requests: number
  concurrency: number
  texts: string[]
}): Promise<{
  modelId: string
  providerId: string
  dimension: number
  samples: EmbeddingProbeSample[]
  summary: ReturnType<typeof buildSummary>
}> {
  const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8')) as {
    embeddingModelId?: string
    embeddingModels?: Array<{
      providerId?: string
      id?: string
      model?: string
      dimension?: number
      nativeDimension?: number
    }>
    providers?: Array<{
      id?: string
      apiType?: string
      baseUrl?: string
      apiKey?: string
    }>
  }
  const resolvedModelId = embeddingModelId ?? raw.embeddingModelId
  const model = (raw.embeddingModels ?? []).find(
    (item) => item.id === resolvedModelId,
  )
  if (!model) {
    throw new Error(`Embedding model ${resolvedModelId} not found in settings`)
  }
  const provider = (raw.providers ?? []).find(
    (item) => item.id === model.providerId,
  )
  if (!provider) {
    throw new Error(
      `Provider ${model.providerId ?? '(missing)'} not found in settings`,
    )
  }
  if (
    provider.apiType !== 'openai-compatible' &&
    provider.apiType !== 'openai-responses'
  ) {
    throw new Error(
      `Embedding probe currently supports openai-compatible/openai-responses providers only, received ${provider.apiType ?? '(missing)'}`,
    )
  }
  if (!provider.baseUrl?.trim()) {
    throw new Error(`Provider ${provider.id ?? '(missing)'} baseUrl is missing`)
  }
  if (!model.model?.trim()) {
    throw new Error(
      `Embedding model ${model.id ?? '(missing)'} model name is missing`,
    )
  }
  if (!Number.isInteger(model.dimension) || (model.dimension ?? 0) <= 0) {
    throw new Error(
      `Embedding model ${model.id ?? '(missing)'} dimension is invalid`,
    )
  }
  const resolvedModelName = model.model
  const resolvedDimension = model.dimension as number

  const sdk = new OpenAI({
    apiKey: provider.apiKey ?? '',
    baseURL: provider.baseUrl,
    dangerouslyAllowBrowser: false,
  })
  const shouldSendDimensions =
    Number.isInteger(model.nativeDimension) &&
    model.nativeDimension !== model.dimension

  const result = await runEmbeddingConcurrencyProbe({
    client: {
      getEmbedding: async (text) => {
        const response = await sdk.embeddings.create({
          model: resolvedModelName,
          input: text,
          ...(shouldSendDimensions ? { dimensions: resolvedDimension } : {}),
        })
        const vector = response.data?.[0]?.embedding
        if (!Array.isArray(vector)) {
          throw new Error('Embedding response is missing data[0].embedding')
        }
        if (vector.length !== resolvedDimension) {
          throw new Error(
            `Embedding dimension mismatch: expected ${resolvedDimension}, received ${vector.length}`,
          )
        }
        return vector
      },
    },
    texts,
    requests,
    concurrency,
  })

  return {
    modelId: model.id!,
    providerId: model.providerId!,
    dimension: resolvedDimension,
    samples: result.samples,
    summary: buildSummary(result.summary),
  }
}

function buildSummary(
  summary: Awaited<ReturnType<typeof runEmbeddingConcurrencyProbe>>['summary'],
) {
  return summary
}
