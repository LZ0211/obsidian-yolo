/**
 * Parent-side (main-thread) deadline + breaker container for pending subagent
 * tool calls.
 *
 * Task 2/3 provided the pure value transforms (`pending-timeout.ts`). This
 * module is the wiring container Task 4 adds: it keys registered deadlines on
 * the parent `delegate_subagent` tool call id, renews them from the child's
 * intermediate `liveTaskStreamBus` events (the heartbeat source), and trips a
 * per-deadline `setTimeout` at `deadlineAt` — no polling loop.
 *
 * The deadline and breaker live on the main thread (never inside the
 * stringified worker decision functions). The parent runtime registers a
 * deadline when a `delegate_subagent` call enters `Running` and provides an
 * `onExpire` hook that aborts the child, marks the tool call `timeout`,
 * injects a synthetic timeout result, and increments the breaker.
 *
 * All wall-clock reads happen once per operation (`Date.now()` captured at
 * registration/renewal) and feed the pure transforms; the `setTimeout` delay is
 * the only place a fresh clock read is used, so deadline arithmetic never
 * re-reads a drifting clock mid-computation.
 */

import { LIVE_TASK_STATUS } from '../../state/statuses'
import { liveTaskStreamBus } from '../live-stream/taskStreamBus'

import {
  type PendingSubagentDeadline,
  type SubagentTimeoutBreakerState,
  createBreaker,
  isBreakerBlocked,
  recordSuccess,
  recordTimeout,
  registerSubagentDeadline,
  renewSubagentDeadline,
} from './pending-timeout'

import {
  PARENT_SUBAGENT_DEFAULT_COOLDOWN_MS,
  PARENT_SUBAGENT_DEFAULT_MAX_CONSECUTIVE_TIMEOUTS,
  PARENT_SUBAGENT_DEFAULT_TIMEOUT_MS,
  type ParentSubagentTimeoutConfig,
} from './subagent-timeout-config'

// Re-exported for callers/tests that imported the defaults from this module
// before the settings-getter mechanism existed.
export { PARENT_SUBAGENT_DEFAULT_COOLDOWN_MS }
export { PARENT_SUBAGENT_DEFAULT_MAX_CONSECUTIVE_TIMEOUTS }
export { PARENT_SUBAGENT_DEFAULT_TIMEOUT_MS }

/**
 * Human-readable reason returned by `delegate_subagent` while the per-conversation
 * consecutive-timeout breaker is open. The dispatch result payload marks
 * `blocked: true` and `accepted: false` so callers can distinguish it from an
 * accepted dispatch. Lives here (not `constants.ts`) because `constants.ts`
 * imports `localFileTools` for the tool server name, which would form a cycle
 * with the `delegate_subagent` dispatch gate in `localFileTools`.
 */
export const SUBAGENT_DELEGATION_BLOCKED_REASON =
  'delegation blocked (too many timeouts)'

export type ParentSubagentDeadlineExpireInput = {
  toolCallId: string
  conversationId: string
}

export type ParentSubagentDeadlineOptions = {
  toolCallId: string
  runKey: string
  conversationId: string
  onExpire: (input: ParentSubagentDeadlineExpireInput) => void
}

type ParentSubagentDeadlineEntry = {
  deadline: PendingSubagentDeadline
  conversationId: string
  timeoutHandle: ReturnType<typeof setTimeout>
  unsubscribeHeartbeat: () => void
  expired: boolean
  onExpire: ParentSubagentDeadlineOptions['onExpire']
}

const deadlineEntries = new Map<string, ParentSubagentDeadlineEntry>()
const breakerStates = new Map<string, SubagentTimeoutBreakerState>()

/**
 * Tool-call ids that were settled as `timeout`. This set deliberately SURVIVES
 * `clearParentSubagentDeadline`: the service clears the deadline entry
 * synchronously when it injects the synthetic timeout result, but the parent
 * runtime still needs to know the call was settled as timeout so it can
 * re-assert the `timeout` response after the tool gateway overwrites it with
 * the late executor result, and so the service can discard the child's own
 * (abort) completion that races in afterwards (no double result injection).
 */
const settledTimeoutToolCallIds = new Set<string>()

/**
 * Error marker on the synthetic timeout completion record. The service uses it
 * to distinguish the synthetic timeout result from the child's own completion.
 */
export const PARENT_SUBAGENT_TIMEOUT_ERROR = 'subagent_timeout'

let timeoutMs = PARENT_SUBAGENT_DEFAULT_TIMEOUT_MS
let maxConsecutiveTimeouts = PARENT_SUBAGENT_DEFAULT_MAX_CONSECUTIVE_TIMEOUTS
let cooldownMs = PARENT_SUBAGENT_DEFAULT_COOLDOWN_MS

/**
 * Optional live read of the configured timeout + breaker settings. The host
 * wires this once at startup to the current run settings (via a getter that
 * re-reads the settings object each call), so changing `timeoutMs` /
 * `maxConsecutiveTimeouts` / `cooldownMs` in settings takes effect without a
 * restart. `undefined` values fall back to the module override, then defaults.
 */
type ParentSubagentTimeoutSettingsGetter = () =>
  | Partial<ParentSubagentTimeoutConfig>
  | undefined

let settingsGetter: ParentSubagentTimeoutSettingsGetter | undefined

export function setParentSubagentTimeoutSettingsGetter(
  getter: ParentSubagentTimeoutSettingsGetter,
): void {
  settingsGetter = getter
}

export function resetParentSubagentTimeoutSettingsGetter(): void {
  settingsGetter = undefined
}

const resolveConfig = (): ParentSubagentTimeoutConfig => {
  const fromSettings = settingsGetter?.()
  return {
    timeoutMs: fromSettings?.timeoutMs ?? timeoutMs,
    maxConsecutiveTimeouts:
      fromSettings?.maxConsecutiveTimeouts ?? maxConsecutiveTimeouts,
    cooldownMs: fromSettings?.cooldownMs ?? cooldownMs,
  }
}

/**
 * The effective timeout + breaker config: settings-getter fields win over the
 * module override (test hook), which wins over the built-in defaults.
 */
export function getParentSubagentTimeoutConfig(): ParentSubagentTimeoutConfig {
  return resolveConfig()
}

const scheduleExpiry = (
  entry: ParentSubagentDeadlineEntry,
): ReturnType<typeof setTimeout> => {
  const delay = Math.max(0, entry.deadline.deadlineAt - Date.now())
  return setTimeout(() => {
    expireParentSubagentDeadline(entry.deadline.toolCallId)
  }, delay)
}

const isTerminalStatusEvent = (
  event: Parameters<Parameters<typeof liveTaskStreamBus.subscribe>[1]>[0],
): boolean => event.type === 'status' && event.status === LIVE_TASK_STATUS.DONE

/**
 * Register a deadline for a parent `delegate_subagent` tool call that just
 * entered `Running`. Subscribes to the child's live task stream (the heartbeat
 * source: `state: RUNNING` / `tool` events projected through
 * `projectSubagentEvent`) and schedules a single `setTimeout` at `deadlineAt`.
 * Idempotent per tool call id.
 */
export function registerParentSubagentDeadline(
  options: ParentSubagentDeadlineOptions,
): void {
  if (deadlineEntries.has(options.toolCallId)) return
  const now = Date.now()
  const deadline = registerSubagentDeadline({
    toolCallId: options.toolCallId,
    runKey: options.runKey,
    now,
    timeoutMs: resolveConfig().timeoutMs,
  })
  const entry: ParentSubagentDeadlineEntry = {
    deadline,
    conversationId: options.conversationId,
    timeoutHandle: undefined as unknown as ReturnType<typeof setTimeout>,
    unsubscribeHeartbeat: () => undefined,
    expired: false,
    onExpire: options.onExpire,
  }
  entry.timeoutHandle = scheduleExpiry(entry)
  entry.unsubscribeHeartbeat = liveTaskStreamBus.subscribe(
    options.toolCallId,
    (event) => {
      // A `DONE` status marks the child run as settled; the completion is then
      // delivered through the background completion bus (which clears the
      // deadline). Renewing on it would be meaningless and could race a clear.
      if (isTerminalStatusEvent(event)) return
      renewParentSubagentDeadline(options.toolCallId)
    },
  )
  deadlineEntries.set(options.toolCallId, entry)
}

/**
 * Renew a deadline on observable child progress. Re-schedules the expiry timer
 * at the new `deadlineAt`; a slow-but-alive subagent that heartbeats at any
 * cadence below `timeoutMs` is never expired.
 */
export function renewParentSubagentDeadline(toolCallId: string): void {
  const entry = deadlineEntries.get(toolCallId)
  if (!entry || entry.expired) return
  const now = Date.now()
  entry.deadline = renewSubagentDeadline(entry.deadline, now)
  clearTimeout(entry.timeoutHandle)
  entry.timeoutHandle = scheduleExpiry(entry)
}

/**
 * Clear a deadline (the subagent result landed, or the tool call settled
 * without a live child). Unsubscribes the heartbeat and cancels the timer.
 */
export function clearParentSubagentDeadline(toolCallId: string): void {
  const entry = deadlineEntries.get(toolCallId)
  if (!entry) return
  clearTimeout(entry.timeoutHandle)
  entry.unsubscribeHeartbeat()
  deadlineEntries.delete(toolCallId)
}

export function hasParentSubagentDeadline(toolCallId: string): boolean {
  return deadlineEntries.has(toolCallId)
}

/**
 * True once the deadline passed with no renewal (the expiry handler already
 * ran). Checks the timeout-settled set in addition to the live entry so the
 * answer survives the service's synchronous `clearParentSubagentDeadline`.
 * Used by the parent runtime to re-assert the `timeout` tool-call response
 * after a late executor result.
 */
export function isParentSubagentDeadlineExpired(toolCallId: string): boolean {
  return (
    settledTimeoutToolCallIds.has(toolCallId) ||
    deadlineEntries.get(toolCallId)?.expired === true
  )
}

/**
 * Record that a `delegate_subagent` call was settled as `timeout`. Kept in a
 * set independent of the deadline entry so it survives the service clear and
 * can drive both the re-assert path and the double-injection guard.
 */
export function markParentSubagentTimeoutSettled(toolCallId: string): void {
  settledTimeoutToolCallIds.add(toolCallId)
}

/** Drop the timeout-settled marker once it is no longer needed. */
export function clearParentSubagentTimeoutSettled(toolCallId: string): void {
  settledTimeoutToolCallIds.delete(toolCallId)
}

/** True when the tool call was settled as `timeout` by the expiry handler. */
export function isParentSubagentToolCallTimedOut(toolCallId: string): boolean {
  return settledTimeoutToolCallIds.has(toolCallId)
}

/** Test/teardown hook: drop every live deadline entry and unsubscribe. */
export function resetParentSubagentDeadlines(): void {
  for (const toolCallId of [...deadlineEntries.keys()]) {
    clearParentSubagentDeadline(toolCallId)
  }
  settledTimeoutToolCallIds.clear()
}

/**
 * Per-conversation consecutive-timeout breaker. `recordParentSubagentTimeout`
 * advances the streak; `recordParentSubagentSuccess` resets it. The actual
 * delegation gate (`isParentSubagentDelegationBlocked`) is consumed by Task 5.
 */
export function recordParentSubagentTimeout(conversationId: string): void {
  const state =
    breakerStates.get(conversationId) ?? createBreaker(conversationId)
  const config = resolveConfig()
  breakerStates.set(
    conversationId,
    recordTimeout(
      state,
      Date.now(),
      config.maxConsecutiveTimeouts,
      config.cooldownMs,
    ),
  )
}

export function recordParentSubagentSuccess(conversationId: string): void {
  const state =
    breakerStates.get(conversationId) ?? createBreaker(conversationId)
  breakerStates.set(conversationId, recordSuccess(state))
}

export function isParentSubagentDelegationBlocked(
  conversationId: string,
): boolean {
  const state =
    breakerStates.get(conversationId) ?? createBreaker(conversationId)
  return isBreakerBlocked(state, Date.now())
}

export function getParentSubagentBreakerState(
  conversationId: string,
): SubagentTimeoutBreakerState | undefined {
  return breakerStates.get(conversationId)
}

export function resetParentSubagentBreakers(): void {
  breakerStates.clear()
}

/** Test hook: shrink/restore the timeout + breaker config without a code change. */
export function setParentSubagentTimeoutConfig(partial: {
  timeoutMs?: number
  maxConsecutiveTimeouts?: number
  cooldownMs?: number
}): void {
  if (partial.timeoutMs !== undefined) timeoutMs = partial.timeoutMs
  if (partial.maxConsecutiveTimeouts !== undefined) {
    maxConsecutiveTimeouts = partial.maxConsecutiveTimeouts
  }
  if (partial.cooldownMs !== undefined) cooldownMs = partial.cooldownMs
}

export function resetParentSubagentTimeoutConfig(): void {
  timeoutMs = PARENT_SUBAGENT_DEFAULT_TIMEOUT_MS
  maxConsecutiveTimeouts = PARENT_SUBAGENT_DEFAULT_MAX_CONSECUTIVE_TIMEOUTS
  cooldownMs = PARENT_SUBAGENT_DEFAULT_COOLDOWN_MS
}

// Kept for the expiry internals (the callback needs the deadline entry).
function expireParentSubagentDeadline(toolCallId: string): void {
  const entry = deadlineEntries.get(toolCallId)
  if (!entry || entry.expired) return
  entry.expired = true
  clearTimeout(entry.timeoutHandle)
  entry.unsubscribeHeartbeat()
  entry.onExpire({ toolCallId, conversationId: entry.conversationId })
}
