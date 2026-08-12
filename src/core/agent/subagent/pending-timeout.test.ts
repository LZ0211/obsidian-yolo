import {
  type PendingSubagentDeadline,
  type SubagentTimeoutBreakerState,
  createBreaker,
  isBreakerBlocked,
  isDeadlineExpired,
  recordSuccess,
  recordTimeout,
  registerSubagentDeadline,
  renewSubagentDeadline,
} from './pending-timeout'

describe('subagent deadline registry', () => {
  const TOOL_CALL_ID = 'tool_call_001'
  const RUN_KEY = 'run_key_abc123'
  const TIMEOUT_MS = 300_000

  const registerAt = (now: number): PendingSubagentDeadline =>
    registerSubagentDeadline({
      toolCallId: TOOL_CALL_ID,
      runKey: RUN_KEY,
      now,
      timeoutMs: TIMEOUT_MS,
    })

  it('registers deadlineAt = now + timeoutMs and lastHeartbeatAt = now', () => {
    const d = registerAt(1_000)

    expect(d).toEqual({
      toolCallId: TOOL_CALL_ID,
      runKey: RUN_KEY,
      deadlineAt: 301_000,
      timeoutMs: TIMEOUT_MS,
      lastHeartbeatAt: 1_000,
    })
  })

  it('renews by pushing deadlineAt and lastHeartbeatAt forward', () => {
    const d = registerAt(1_000)

    const renewed = renewSubagentDeadline(d, 200_000)

    expect(renewed).toEqual({
      toolCallId: TOOL_CALL_ID,
      runKey: RUN_KEY,
      deadlineAt: 500_000,
      timeoutMs: TIMEOUT_MS,
      lastHeartbeatAt: 200_000,
    })
  })

  it('renewSubagentDeadline is pure: returns a new object without mutating the input', () => {
    const d = registerAt(1_000)
    const snapshot = { ...d }

    const renewed = renewSubagentDeadline(d, 200_000)

    expect(renewed).not.toBe(d)
    expect(d).toEqual(snapshot)
  })

  it('is not expired before the deadline', () => {
    const d = registerAt(1_000)

    expect(isDeadlineExpired(d, 1_000)).toBe(false)
    expect(isDeadlineExpired(d, 300_999)).toBe(false)
  })

  it('is expired once the deadline passes with no renewal', () => {
    const d = registerAt(1_000)

    expect(isDeadlineExpired(d, 301_000)).toBe(true)
    expect(isDeadlineExpired(d, 999_999)).toBe(true)
  })

  it('a slow-but-alive subagent renewing just under timeoutMs is never expired', () => {
    // A subagent that heartbeats at any cadence below timeoutMs must never
    // trip. Each renewal pushes deadlineAt to now + timeoutMs, so at every
    // instant the most recent heartbeat is strictly closer than timeoutMs and
    // the deadline is in the future.
    const cadences = [TIMEOUT_MS - 1, TIMEOUT_MS - 5_000, TIMEOUT_MS * 0.9]

    for (const cadence of cadences) {
      let now = 1_000
      let d = registerAt(now)

      for (let heartbeat = 0; heartbeat < 50; heartbeat++) {
        now += cadence
        // Check just before the heartbeat fires: still alive.
        expect(isDeadlineExpired(d, now - 1)).toBe(false)
        d = renewSubagentDeadline(d, now)
        // Immediately after the heartbeat: still alive.
        expect(isDeadlineExpired(d, now)).toBe(false)
      }
    }
  })

  it('a late heartbeat revives an expired deadline (renewal resets the clock)', () => {
    const d = registerAt(1_000)
    expect(isDeadlineExpired(d, 301_000)).toBe(true)

    const revived = renewSubagentDeadline(d, 301_000)

    expect(revived.deadlineAt).toBe(601_000)
    expect(isDeadlineExpired(revived, 301_000)).toBe(false)
  })
})

describe('subagent timeout circuit breaker', () => {
  const CONVERSATION_ID = 'conv_breaker_001'
  const MAX_CONSECUTIVE = 3
  const COOLDOWN_MS = 60_000

  it('createBreaker starts clean and unblocked', () => {
    const s: SubagentTimeoutBreakerState = createBreaker(CONVERSATION_ID)

    expect(s).toEqual({
      conversationId: CONVERSATION_ID,
      consecutiveTimeouts: 0,
      blockedUntil: null,
      blocked: false,
    })
  })

  it('trips after N consecutive timeouts and stays blocked until the cooldown passes', () => {
    let s = createBreaker(CONVERSATION_ID)
    const t0 = 10_000

    // Below the threshold: no trip.
    s = recordTimeout(s, t0, MAX_CONSECUTIVE, COOLDOWN_MS)
    expect(s.consecutiveTimeouts).toBe(1)
    expect(s.blocked).toBe(false)
    expect(isBreakerBlocked(s, t0)).toBe(false)

    s = recordTimeout(s, t0 + 5_000, MAX_CONSECUTIVE, COOLDOWN_MS)
    expect(s.consecutiveTimeouts).toBe(2)
    expect(s.blocked).toBe(false)
    expect(isBreakerBlocked(s, t0 + 5_000)).toBe(false)

    // The Nth timeout trips the breaker with blockedUntil = now + cooldownMs.
    s = recordTimeout(s, t0 + 10_000, MAX_CONSECUTIVE, COOLDOWN_MS)
    expect(s.consecutiveTimeouts).toBe(3)
    expect(s.blocked).toBe(true)
    expect(s.blockedUntil).toBe(t0 + 10_000 + COOLDOWN_MS)

    // Blocked for the whole cooldown window...
    expect(isBreakerBlocked(s, t0 + 10_000)).toBe(true)
    expect(isBreakerBlocked(s, t0 + 10_000 + COOLDOWN_MS - 1)).toBe(true)
    // ...and unblocked the moment the cooldown passes.
    expect(isBreakerBlocked(s, t0 + 10_000 + COOLDOWN_MS)).toBe(false)
  })

  it('recordSuccess resets the counter and clears the block', () => {
    let s = createBreaker(CONVERSATION_ID)
    const now = 20_000

    for (let i = 0; i < MAX_CONSECUTIVE; i++) {
      s = recordTimeout(s, now, MAX_CONSECUTIVE, COOLDOWN_MS)
    }
    expect(s.blocked).toBe(true)
    expect(s.blockedUntil).toBe(now + COOLDOWN_MS)
    expect(isBreakerBlocked(s, now)).toBe(true)

    s = recordSuccess(s)

    expect(s.consecutiveTimeouts).toBe(0)
    expect(s.blocked).toBe(false)
    expect(s.blockedUntil).toBeNull()
    expect(isBreakerBlocked(s, now)).toBe(false)
  })

  it('a successful completion between timeouts resets the counter (no false trip)', () => {
    let s = createBreaker(CONVERSATION_ID)
    const now = 30_000

    // Two timeouts put the streak at 2 of 3...
    s = recordTimeout(s, now, MAX_CONSECUTIVE, COOLDOWN_MS)
    s = recordTimeout(s, now + 1_000, MAX_CONSECUTIVE, COOLDOWN_MS)
    expect(s.consecutiveTimeouts).toBe(2)

    // ...then a success resets the streak.
    s = recordSuccess(s)
    expect(s.consecutiveTimeouts).toBe(0)
    expect(s.blocked).toBe(false)

    // One more timeout must NOT trip: the streak restarts at 1.
    s = recordTimeout(s, now + 2_000, MAX_CONSECUTIVE, COOLDOWN_MS)
    expect(s.consecutiveTimeouts).toBe(1)
    expect(s.blocked).toBe(false)
    expect(isBreakerBlocked(s, now + 2_000)).toBe(false)
  })

  it('breaker helpers are pure: they return new state without mutating the input', () => {
    const s = createBreaker(CONVERSATION_ID)
    const snapshot = { ...s }

    const afterTimeout = recordTimeout(s, 1_000, MAX_CONSECUTIVE, COOLDOWN_MS)
    const afterSuccess = recordSuccess(s)

    expect(afterTimeout).not.toBe(s)
    expect(afterSuccess).not.toBe(s)
    expect(s).toEqual(snapshot)
  })

  it('re-anchors blockedUntil when a timeout lands while the breaker is already open', () => {
    let s = createBreaker(CONVERSATION_ID)
    const t0 = 40_000

    // Trip the breaker with the Nth consecutive timeout.
    for (let index = 0; index < MAX_CONSECUTIVE; index += 1) {
      s = recordTimeout(s, t0, MAX_CONSECUTIVE, COOLDOWN_MS)
    }
    expect(s.blocked).toBe(true)
    expect(s.blockedUntil).toBe(t0 + COOLDOWN_MS)

    // An in-flight deadline (e.g. a background child admitted before the trip)
    // fires while the breaker is already open. The cooldown must re-anchor at
    // the LATEST timeout so a run of failures cannot silently slip past the
    // earlier expiry window.
    const t1 = t0 + 10_000
    s = recordTimeout(s, t1, MAX_CONSECUTIVE, COOLDOWN_MS)

    expect(s.consecutiveTimeouts).toBe(MAX_CONSECUTIVE + 1)
    expect(s.blocked).toBe(true)
    expect(s.blockedUntil).toBe(t1 + COOLDOWN_MS)
    expect(isBreakerBlocked(s, t1 + COOLDOWN_MS - 1)).toBe(true)
    expect(isBreakerBlocked(s, t1 + COOLDOWN_MS)).toBe(false)
  })
})
