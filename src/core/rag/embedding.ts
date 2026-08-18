import { YoloSettings } from '../../settings/schema/setting.types'
import { EmbeddingModelClient } from '../../types/embedding'
import { logFlightEvent } from '../../utils/debug/flightLog'
import { getProviderClient } from '../llm/manager'

/** Embedding calls are unbounded network requests; cap them so a hung
 * provider can never stall the request path or the memory index
 * operationChain. */
export const MEMORY_EMBEDDING_TIMEOUT_MS = 8_000

export const withEmbeddingTimeout = async (
  client: EmbeddingModelClient,
  text: string,
  timeoutMs = MEMORY_EMBEDDING_TIMEOUT_MS,
): Promise<number[]> => {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      client.getEmbedding(text),
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          logFlightEvent('llm', 'embedding-timeout', {
            id: client.id,
            detail: `${timeoutMs}ms without response`,
            consoleOutput: 'warn',
          })
          reject(new Error(`Embedding request timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export const getEmbeddingModelClient = ({
  settings,
  embeddingModelId,
}: {
  settings: YoloSettings
  embeddingModelId: string
}): EmbeddingModelClient => {
  const embeddingModel = settings.embeddingModels.find(
    (model) => model.id === embeddingModelId,
  )
  if (!embeddingModel) {
    throw new Error(`Embedding model ${embeddingModelId} not found`)
  }

  const providerClient = getProviderClient({
    settings,
    providerId: embeddingModel.providerId,
  })

  return {
    id: embeddingModel.id,
    dimension: embeddingModel.dimension,
    getEmbedding: async (text: string) => {
      const shouldSendDimensions =
        embeddingModel.nativeDimension != null &&
        embeddingModel.dimension !== embeddingModel.nativeDimension

      const vector = await providerClient.getEmbedding(
        embeddingModel.model,
        text,
        shouldSendDimensions
          ? { dimensions: embeddingModel.dimension }
          : undefined,
      )
      if (vector.length !== embeddingModel.dimension) {
        throw new Error(
          `Embedding model "${embeddingModel.id}" returned ${vector.length}-dimensional vector, but it is configured as ${embeddingModel.dimension}-dimensional. Update the model's dimension in settings or re-add the model.`,
        )
      }
      return vector
    },
  }
}
