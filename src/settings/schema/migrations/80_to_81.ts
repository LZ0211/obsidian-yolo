import { DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG } from '../../../core/agent/subagent/subagent-timeout-config'
import type { SettingMigration } from '../setting.types'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * v80→v81: seed the explicit `/moa` chat settings under `chatOptions.moa`, the
 * configurable parent subagent timeout + breaker settings, the web runtime
 * (`webRuntime`) settings, and the scheduled tasks (`scheduledTasks`) settings.
 *
 * Additive and defensive: existing chat options and `subagentTimeout` fields
 * are preserved untouched. `moa` is seeded only when absent or not a record
 * (no default reference-model pool — references come from explicit `@`-mentions
 * and the aggregator is the current conversation model). `subagentTimeout` is
 * seeded with the defaults (preserving any user-supplied field) so the
 * registry's settings getter starts with concrete values. `webRuntime` and
 * `scheduledTasks` are seeded only when present as a record, coercing each
 * field to its typed value with safe defaults so pre-rollback settings keep
 * working.
 */
export const migrateFrom80To81: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 81 }

  const chatOptions = isRecord(next.chatOptions) ? next.chatOptions : {}
  next.chatOptions = {
    ...chatOptions,
    moa: isRecord(chatOptions.moa)
      ? chatOptions.moa
      : {
          enabled: true,
          timeoutMs: 45_000,
          maxOutputTokens: 2_048,
        },
  }

  next.subagentTimeout = isRecord(next.subagentTimeout)
    ? { ...DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG, ...next.subagentTimeout }
    : { ...DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG }

  if (isRecord(data.webRuntime)) {
    next.webRuntime = {
      enabled: Boolean(data.webRuntime.enabled),
      port: Number(data.webRuntime.port) || 18900,
      host: String(data.webRuntime.host ?? '127.0.0.1'),
      token: String(data.webRuntime.token ?? ''),
      maxConcurrentAgentRuns:
        Number(data.webRuntime.maxConcurrentAgentRuns) || 12,
    }
  }

  if (isRecord(data.scheduledTasks)) {
    next.scheduledTasks = {
      enabled: data.scheduledTasks.enabled === true,
      enableScriptExecution: data.scheduledTasks.enableScriptExecution === true,
      allowedScriptDirectories: Array.isArray(
        data.scheduledTasks.allowedScriptDirectories,
      )
        ? data.scheduledTasks.allowedScriptDirectories
        : [],
    }
  }

  return next
}
