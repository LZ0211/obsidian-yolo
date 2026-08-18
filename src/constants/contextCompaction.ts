/**
 * Upper bound for `context_compact`'s `retainRecentTurns`. Lives here (a
 * dependency-free leaf) so both the tool definition (tools layer) and the
 * compaction state builder (agent layer) can import it without the tools →
 * agent → ... → tools import cycle.
 */
export const MAX_RETAIN_RECENT_TURNS = 20
