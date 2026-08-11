/**
 * Single source of truth for the configurable parent subagent timeout + breaker
 * defaults. Imported by:
 *
 *  - `pending-timeout-registry.ts` (the runtime container that enforces the
 *    deadline + breaker, and the settings getter that makes them configurable
 *    without a restart);
 *  - the run-settings schema + migrations (`src/settings/schema/`), which
 *    persist and migrate these values.
 *
 * Kept dependency-free so neither the registry nor the settings schema forms an
 * import cycle through this module.
 */

export const PARENT_SUBAGENT_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000
export const PARENT_SUBAGENT_DEFAULT_MAX_CONSECUTIVE_TIMEOUTS = 2
export const PARENT_SUBAGENT_DEFAULT_COOLDOWN_MS = 5 * 60 * 1000

export type ParentSubagentTimeoutConfig = {
  /** Wall-clock silence window (ms) before a pending subagent is killed. */
  timeoutMs: number
  /** Consecutive timeouts that trip the per-conversation delegation breaker. */
  maxConsecutiveTimeouts: number
  /** How long (ms) a tripped breaker stays open before delegation resumes. */
  cooldownMs: number
}

export const DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG: ParentSubagentTimeoutConfig =
  {
    timeoutMs: PARENT_SUBAGENT_DEFAULT_TIMEOUT_MS,
    maxConsecutiveTimeouts: PARENT_SUBAGENT_DEFAULT_MAX_CONSECUTIVE_TIMEOUTS,
    cooldownMs: PARENT_SUBAGENT_DEFAULT_COOLDOWN_MS,
  }
