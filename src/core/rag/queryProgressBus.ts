import type { QueryProgressState } from '../../components/chat-view/QueryProgress'

type QueryProgressListener = (state: QueryProgressState) => void

/**
 * Shared bus for retrieval progress emitted outside the single-turn submit
 * path (agent bash `search` command, sandbox dbQuery). Chat surfaces subscribe
 * so the "Querying the vault" banner appears while the agent runs retrieval.
 * Module-level singleton like `liveTaskStreamBus` / `backgroundTaskCompletionBus`.
 */
const listeners = new Set<QueryProgressListener>()

export function subscribeQueryProgress(
  listener: QueryProgressListener,
): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function publishQueryProgress(state: QueryProgressState): void {
  for (const listener of listeners) {
    listener(state)
  }
}
