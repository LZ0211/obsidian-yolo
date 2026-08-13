/**
 * Wall-clock deadline registry for pending subagent tool calls.
 *
 * A deadline is registered when a `delegate_subagent` tool call enters Running.
 * Observable child progress renews it via `renewSubagentDeadline`. A deadline
 * only trips when it passes WITHOUT a renewal: every heartbeat pushes
 * `deadlineAt` to `now + timeoutMs`, so a slow-but-alive subagent that
 * heartbeats at any cadence below `timeoutMs` is never expired.
 *
 * All functions are pure with an injectable `now` for deterministic tests.
 */

export type PendingSubagentDeadline = {
  toolCallId: string
  /** Wall-clock time (ms) at which the call is considered hung if not renewed. */
  deadlineAt: number
  /** Renewal window: each heartbeat grants another `timeoutMs`. */
  timeoutMs: number
  /** Wall-clock time (ms) of the most recent heartbeat (or registration). */
  lastHeartbeatAt: number
}

export function registerSubagentDeadline(input: {
  toolCallId: string
  now: number
  timeoutMs: number
}): PendingSubagentDeadline {
  return {
    toolCallId: input.toolCallId,
    deadlineAt: input.now + input.timeoutMs,
    timeoutMs: input.timeoutMs,
    lastHeartbeatAt: input.now,
  }
}

export function renewSubagentDeadline(
  d: PendingSubagentDeadline,
  now: number,
): PendingSubagentDeadline {
  return {
    toolCallId: d.toolCallId,
    deadlineAt: now + d.timeoutMs,
    timeoutMs: d.timeoutMs,
    lastHeartbeatAt: now,
  }
}

export function isDeadlineExpired(
  d: PendingSubagentDeadline,
  now: number,
): boolean {
  return now >= d.deadlineAt
}

/**
 * Consecutive-timeout circuit breaker for a single conversation's subagent
 * delegation.
 *
 * Every completion without a successful result advances `consecutiveTimeouts`.
 * When it reaches `maxConsecutive`, the breaker trips: delegation is gated by
 * `isBreakerBlocked` until `blockedUntil` (now + cooldownMs) passes. Any
 * successful completion resets the streak, so isolated timeouts never trip.
 *
 * Like the deadline functions, all helpers are pure with an injectable `now`
 * for deterministic tests.
 */

export type SubagentTimeoutBreakerState = {
  conversationId: string
  consecutiveTimeouts: number
  blockedUntil: number | null
  blocked: boolean
}

export function createBreaker(
  conversationId: string,
): SubagentTimeoutBreakerState {
  return {
    conversationId,
    consecutiveTimeouts: 0,
    blockedUntil: null,
    blocked: false,
  }
}

export function recordTimeout(
  s: SubagentTimeoutBreakerState,
  now: number,
  maxConsecutive: number,
  cooldownMs: number,
): SubagentTimeoutBreakerState {
  const consecutiveTimeouts = s.consecutiveTimeouts + 1
  const blocked = consecutiveTimeouts >= maxConsecutive
  return {
    ...s,
    consecutiveTimeouts,
    blocked,
    // Re-tripping (or extending) always anchors the cooldown at the latest
    // timeout so a run of failures does not silently slip past an early expiry.
    blockedUntil: blocked ? now + cooldownMs : s.blockedUntil,
  }
}

export function recordSuccess(
  s: SubagentTimeoutBreakerState,
): SubagentTimeoutBreakerState {
  return {
    ...s,
    consecutiveTimeouts: 0,
    blocked: false,
    blockedUntil: null,
  }
}

export function isBreakerBlocked(
  s: SubagentTimeoutBreakerState,
  now: number,
): boolean {
  return s.blocked && s.blockedUntil !== null && now < s.blockedUntil
}
