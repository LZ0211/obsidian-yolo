export type EmbeddingProbeClient = {
  getEmbedding(text: string): Promise<number[]>
}

export type EmbeddingProbeSample =
  | {
      index: number
      ok: true
      durationMs: number
      vectorLength: number
      text: string
    }
  | {
      index: number
      ok: false
      durationMs: number
      error: string
      text: string
    }

export type EmbeddingProbeSummary = {
  total: number
  successes: number
  failures: number
  minMs: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  avgMs: number
  errorCounts: Record<string, number>
}

export async function runEmbeddingConcurrencyProbe({
  client,
  texts,
  requests,
  concurrency,
}: {
  client: EmbeddingProbeClient
  texts: string[]
  requests: number
  concurrency: number
}): Promise<{
  samples: EmbeddingProbeSample[]
  summary: EmbeddingProbeSummary
}> {
  if (!Number.isInteger(requests) || requests <= 0) {
    throw new Error('requests must be a positive integer')
  }
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error('concurrency must be a positive integer')
  }
  const normalizedTexts = texts.map((text) => text.trim()).filter(Boolean)
  if (normalizedTexts.length === 0) {
    throw new Error('at least one non-empty text is required')
  }

  const samples = new Array<EmbeddingProbeSample>(requests)
  let nextIndex = 0
  const workerCount = Math.min(concurrency, requests)

  const runOne = async (index: number): Promise<void> => {
    const text = normalizedTexts[index % normalizedTexts.length]
    const startedAt = Date.now()
    try {
      const vector = await client.getEmbedding(text)
      samples[index] = {
        index,
        ok: true,
        durationMs: Date.now() - startedAt,
        vectorLength: vector.length,
        text,
      }
    } catch (error) {
      samples[index] = {
        index,
        ok: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        text,
      }
    }
  }

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const current = nextIndex
      nextIndex += 1
      if (current >= requests) {
        return
      }
      await runOne(current)
    }
  })

  await Promise.all(workers)

  return {
    samples,
    summary: calculateEmbeddingProbeSummary(samples),
  }
}

export function calculateEmbeddingProbeSummary(
  samples: EmbeddingProbeSample[],
): EmbeddingProbeSummary {
  if (samples.length === 0) {
    throw new Error('samples must not be empty')
  }
  const durations = samples
    .map((sample) => sample.durationMs)
    .sort((a, b) => a - b)
  const successes = samples.filter((sample) => sample.ok).length
  const failures = samples.length - successes
  const errorCounts: Record<string, number> = {}
  for (const sample of samples) {
    if (!sample.ok) {
      errorCounts[sample.error] = (errorCounts[sample.error] ?? 0) + 1
    }
  }

  return {
    total: samples.length,
    successes,
    failures,
    minMs: durations[0] ?? 0,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: durations[durations.length - 1] ?? 0,
    avgMs:
      durations.reduce((sum, value) => sum + value, 0) /
      Math.max(1, durations.length),
    errorCounts,
  }
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * ratio) - 1),
  )
  return sortedValues[index] ?? 0
}
