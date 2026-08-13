import type { RetrievalTrace } from './retrievalTraceTypes'

type RetrievalTraceArrivalListener = (trace: RetrievalTrace) => void

/**
 * Shared bus announcing persisted retrieval traces. RAGLogModal subscribes to
 * auto-refresh when a new trace arrives (instead of requiring a manual pull).
 * Module-level singleton like `queryProgressBus`.
 */
const listeners = new Set<RetrievalTraceArrivalListener>()

export function subscribeRetrievalTraceArrival(
  listener: RetrievalTraceArrivalListener,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishRetrievalTraceArrival(trace: RetrievalTrace): void {
  for (const listener of listeners) {
    listener(trace)
  }
}
