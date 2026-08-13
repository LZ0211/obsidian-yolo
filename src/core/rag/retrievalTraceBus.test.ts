import type { RetrievalTrace } from './retrievalTraceTypes'

import {
  publishRetrievalTraceArrival,
  subscribeRetrievalTraceArrival,
} from './retrievalTraceBus'

describe('retrievalTraceBus', () => {
  it('delivers persisted traces to subscribers and unsubscribes cleanly', () => {
    const trace: RetrievalTrace = {
      queryId: 'q1',
      queryText: 'hello',
      backend: 'sqlite',
      modelId: 'm1',
      namespaceId: 'n1',
      startedAt: 1,
      finishedAt: 2,
      timingsMs: {
        normalizeInput: 0,
        resolveScope: 0,
        assembleEvidence: 0,
        total: 1,
      },
      evidence: [],
      warningCodes: [],
    }
    const listener = jest.fn()
    const unsubscribe = subscribeRetrievalTraceArrival(listener)

    publishRetrievalTraceArrival(trace)
    expect(listener).toHaveBeenCalledWith(trace)

    unsubscribe()
    publishRetrievalTraceArrival(trace)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
