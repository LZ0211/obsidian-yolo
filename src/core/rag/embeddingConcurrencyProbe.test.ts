import {
  calculateEmbeddingProbeSummary,
  runEmbeddingConcurrencyProbe,
} from './embeddingConcurrencyProbe'

describe('embeddingConcurrencyProbe', () => {
  it('runs requests up to the configured concurrency and summarizes results', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const client = {
      getEmbedding: jest.fn(async (text: string) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) =>
          setTimeout(resolve, text === 'slow' ? 20 : 5),
        )
        inFlight -= 1
        return [0.1, 0.2, 0.3]
      }),
    }

    const result = await runEmbeddingConcurrencyProbe({
      client,
      texts: ['fast', 'slow'],
      requests: 5,
      concurrency: 2,
    })

    expect(client.getEmbedding).toHaveBeenCalledTimes(5)
    expect(maxInFlight).toBeLessThanOrEqual(2)
    expect(result.samples).toHaveLength(5)
    expect(result.summary.total).toBe(5)
    expect(result.summary.successes).toBe(5)
    expect(result.summary.failures).toBe(0)
    expect(result.summary.p95Ms).toBeGreaterThanOrEqual(result.summary.p50Ms)
  })

  it('records failures in the summary', () => {
    const summary = calculateEmbeddingProbeSummary([
      { index: 0, ok: true, durationMs: 50, vectorLength: 3, text: 'a' },
      { index: 1, ok: false, durationMs: 120, error: 'timeout', text: 'b' },
      { index: 2, ok: true, durationMs: 80, vectorLength: 3, text: 'c' },
    ])

    expect(summary).toMatchObject({
      total: 3,
      successes: 2,
      failures: 1,
      minMs: 50,
      maxMs: 120,
    })
    expect(summary.errorCounts).toEqual({ timeout: 1 })
  })
})
