import type { AssistantToolApprovalMode } from '../../../types/assistant.types'
import { SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT } from '../../../core/agent/subagent/constants'
import { SUBAGENT_RESULT_MAX_CHARS } from '../../../core/agent/subagent/result-limit'
import { DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG } from '../../../core/agent/subagent/subagent-timeout-config'

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const APPROVAL_MODE_STRICTNESS: Readonly<
  Record<AssistantToolApprovalMode, number>
> = {
  full_access: 0,
  dangerous_only: 1,
  require_approval: 2,
}

const isApprovalMode = (value: unknown): value is AssistantToolApprovalMode =>
  typeof value === 'string' &&
  Object.prototype.hasOwnProperty.call(APPROVAL_MODE_STRICTNESS, value)

/**
 * Picks the strictest of the given approval modes: `require_approval` >
 * `dangerous_only` > `full_access`. `modes` is always non-empty at both call
 * sites below.
 *
 * This is the merge rule for a capability whose member tools carried
 * different legacy approval values — today only reachable for
 * `file_editing` (`fs_edit` defaulted `full_access`, `fs_write` defaulted
 * `require_approval`; see decision 17 / §1.4 of
 * docs/plans/2026-08-15-tool-registry/master.md). Picking the strictest
 * resolves that pre-existing contradiction toward what the settings page
 * already *displayed* (an aggregated "Require approval"), rather than the
 * looser value the runtime happened to read. For every other capability
 * this is an identity transform: member values there can never actually
 * diverge (docs/plans/2026-08-15-tool-registry/master.md §2.5 — the only
 * legacy write paths for both the global group switch and each assistant's
 * per-tool preferences always wrote every member the same value).
 */
const mostStrictApprovalMode = (
  modes: readonly AssistantToolApprovalMode[],
): AssistantToolApprovalMode =>
  modes.reduce((strictest, mode) =>
    APPROVAL_MODE_STRICTNESS[mode] > APPROVAL_MODE_STRICTNESS[strictest]
      ? mode
      : strictest,
  )

/**
 * The built-in server prefix every legacy `toolPreferences` /
 * `enabledToolNames` entry for a built-in tool carried, frozen at its v80
 * value (`LOCAL_FILE_TOOL_SERVER` + `McpManager.TOOL_NAME_DELIMITER`).
 * Frozen for the same reason as `LEGACY_CAPABILITY_MAP` below, plus one of
 * its own: importing `McpManager` here would drag the whole MCP runtime into
 * the settings-migration module graph.
 */
const LEGACY_BUILTIN_FQN_PREFIX = 'yolo_local__'

/**
 * The legacy (v80 shape) -> capability map, frozen as literal data.
 *
 * This deliberately does NOT read the live registry (`listCapabilities()`).
 * A historical migration must describe the two schema versions it bridges,
 * not whatever the product happens to look like when it runs — and here
 * that difference is a real bug, not hygiene.
 * `migrateAssistantBuiltinCapabilities` writes an entry for *every*
 * capability it iterates, and a capability with no legacy member entries
 * resolves to `enabled: false` (see that function's doc comment for why
 * absent must mean off). So if a future release adds a 13th capability and
 * a user upgrades to it straight from v80, reading the live registry here
 * would stamp an explicit `enabled: false` for that new capability into
 * every one of their assistants — silently shipping it disabled,
 * un-recoverably, for exactly the users who update least often. Tool
 * renames, capability splits and capability removals distort this
 * migration's inputs the same way.
 *
 * The shape it describes spans v80..v85: the v79->v80 migration collapsed
 * the split-action tools into consolidated group tools (`memory_ops`,
 * `context_manage`, ...) and schema versions 81-85 never touched
 * `toolPreferences` again (their migrations only added unrelated fields),
 * so a v81/v82/... vault's built-in tool state is byte-identical in shape
 * to a v80 vault's. The `80_to_81` migration converts v80 vaults; the
 * `81_to_82` migration converts vaults already past that version, using
 * this same map.
 *
 * `legacyGroupKey` is the synthetic "group" tool name the pre-capability
 * global toggle (`AgentToolsModal.tsx`'s `handleToggleBuiltinTool`) wrote
 * alongside every member's own short name; only the multi-tool capabilities
 * ever had one. Every other capability's sole legacy key is its one member
 * tool's short name. (Previously read from
 * `core/tools/legacy-persistence-keys.ts`, which is deleted as part of the
 * 80->81 migration landing.)
 *
 * `legacyMemberActions` maps a member tool short name to the action key the
 * v79->v80 collapse wrote under the group's `actions` child map. Only
 * members folded by that collapse have one — for `memory` and `context`
 * the action key is the split tool's bare name (`memory_add` -> `add`,
 * `context_compact` -> `compact`), which is *not* the member short name.
 * The v80 runtime granted/denied these members through those per-action
 * entries, so the per-assistant migration must read them to preserve the
 * user's state.
 *
 * Values are transcribed from `core/tools/capabilities/*.ts` as of v81;
 * `defaultEnabled` is deliberately absent because neither layer of the
 * migration consults it.
 */
const DEFAULT_ALLOWED_MODES: readonly AssistantToolApprovalMode[] = [
  'full_access',
  'require_approval',
]

export const LEGACY_CAPABILITY_MAP: readonly {
  id: string
  legacyGroupKey?: string
  legacyMemberActions?: Readonly<Record<string, string>>
  toolNames: readonly string[]
  defaultMode: AssistantToolApprovalMode
  allowedModes: readonly AssistantToolApprovalMode[]
}[] = [
  {
    id: 'file_reading',
    toolNames: ['fs_read'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'metadata_search',
    toolNames: ['meta_search'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'pdf_conversion',
    toolNames: ['mineru_convert'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'vault_shell',
    toolNames: ['bash'],
    defaultMode: 'dangerous_only',
    // The only built-in capability with a third tier.
    allowedModes: ['full_access', 'dangerous_only', 'require_approval'],
  },
  {
    id: 'file_editing',
    legacyGroupKey: 'fs_edit_ops',
    toolNames: ['fs_edit', 'fs_write'],
    defaultMode: 'require_approval',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'context_pruning',
    legacyGroupKey: 'context_manage',
    legacyMemberActions: { context_prune_tool_results: 'prune' },
    toolNames: ['context_prune_tool_results'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'context_compaction',
    legacyGroupKey: 'context_manage',
    legacyMemberActions: { context_compact: 'compact' },
    toolNames: ['context_compact'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'user_questions',
    toolNames: ['ask_user_question'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'todo_list',
    toolNames: ['todo_write'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'memory',
    legacyGroupKey: 'memory_ops',
    legacyMemberActions: {
      memory_add: 'add',
      memory_update: 'update',
      memory_delete: 'delete',
    },
    toolNames: ['memory_add', 'memory_update', 'memory_delete'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'web_access',
    legacyGroupKey: 'web_ops',
    toolNames: ['web_search', 'web_scrape'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'js_sandbox',
    toolNames: ['js_eval'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'terminal',
    toolNames: ['terminal_command'],
    defaultMode: 'require_approval',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'subagent_delegation',
    toolNames: ['delegate_subagent'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'scheduled_tasks',
    toolNames: ['scheduled_task_ops'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
  {
    id: 'projects',
    toolNames: ['project_ops'],
    defaultMode: 'full_access',
    allowedModes: DEFAULT_ALLOWED_MODES,
  },
]

const isLocalFqn = (name: string): boolean =>
  name.startsWith(LEGACY_BUILTIN_FQN_PREFIX)

/**
 * `settings.mcp.builtinToolOptions` (keyed by the old short tool/group
 * names) -> `settings.mcp.builtinCapabilityOptions` (keyed by capability
 * id). This is global *enablement* only — approval tiers have always been a
 * per-assistant concept (`toolPreferences[fqn].approvalMode`), never stored
 * here, so there is nothing to merge/carry for that field at this layer.
 *
 * Two capabilities carry tool-specific config the generic `disabled`
 * migration would otherwise drop (docs/plans/2026-08-15-tool-registry's D9
 * brief, "坑 1"): `subagent_delegation`'s `allowedModelIds` /
 * `preferredModelId` (read straight from the old `delegate_subagent` key)
 * and `terminal`'s `blockedPrefixes` (from the old `terminal_command` key).
 *
 * Idempotent: a vault that already carries a non-empty
 * `builtinCapabilityOptions` (e.g. it ran this conversion once) is left
 * untouched — only the now-dead `builtinToolOptions` key is stripped.
 */
const migrateBuiltinToolOptions = (
  data: Record<string, unknown>,
): Record<string, unknown> => {
  const mcp = isRecord(data.mcp) ? data.mcp : {}
  const legacyOptions = isRecord(mcp.builtinToolOptions)
    ? mcp.builtinToolOptions
    : {}
  const { builtinToolOptions: _legacy, ...restMcp } = mcp

  const alreadyConverted =
    isRecord(mcp.builtinCapabilityOptions) &&
    Object.keys(mcp.builtinCapabilityOptions).length > 0

  if (!alreadyConverted) {
    const nextOptions: Record<string, unknown> = {}
    for (const capability of LEGACY_CAPABILITY_MAP) {
      const legacyKeys: string[] = [
        capability.legacyGroupKey,
        ...capability.toolNames,
      ].filter((key): key is string => typeof key === 'string')

      // Matches the pre-D9 runtime aggregation exactly
      // (`builtinCapabilityRows.ts`'s `enabled` / `McpManager.
      // isLocalToolPersistedEnabled`'s per-group checks): disabled if *any*
      // legacy key (group key, if this capability had one, or any member) was
      // explicitly disabled.
      const anyDisabled = legacyKeys.some((key) => {
        const entry = legacyOptions[key]
        return isRecord(entry) && entry.disabled === true
      })

      const entry: Record<string, unknown> = { disabled: anyDisabled }

      if (capability.id === 'subagent_delegation') {
        const legacy = legacyOptions.delegate_subagent
        if (isRecord(legacy)) {
          if (Array.isArray(legacy.allowedModelIds)) {
            entry.allowedModelIds = legacy.allowedModelIds
          }
          if (typeof legacy.preferredModelId === 'string') {
            entry.preferredModelId = legacy.preferredModelId
          }
        }
      }

      if (capability.id === 'terminal') {
        const legacy = legacyOptions.terminal_command
        if (isRecord(legacy) && Array.isArray(legacy.blockedPrefixes)) {
          entry.blockedPrefixes = legacy.blockedPrefixes
        }
      }

      nextOptions[capability.id] = entry
    }

    return {
      ...data,
      mcp: {
        ...restMcp,
        builtinCapabilityOptions: nextOptions,
      },
    }
  }

  return {
    ...data,
    mcp: {
      ...restMcp,
      builtinCapabilityOptions: mcp.builtinCapabilityOptions,
    },
  }
}

/**
 * One assistant's `toolPreferences` (FQN-keyed, `yolo_local__<shortname>`)
 * -> `builtinCapabilityPreferences` (capability-id-keyed). Per capability:
 *
 *   - Collect every member tool's legacy entry that is actually present.
 *     "Present" mirrors `getAssistantToolPreferences` exactly — that helper
 *     resolves an assistant's effective preferences as
 *     `{ ...fromEnabledToolNames, ...toolPreferences }`, so a built-in tool
 *     listed only in the legacy `enabledToolNames` array is just as much a
 *     real, enabled grant as one with its own `toolPreferences` entry. A
 *     migration that read only `toolPreferences` would silently revoke those.
 *   - Members folded into a consolidated group by the v79->v80 migration
 *     (`memory` / `context`) are granted through the group FQN's per-action
 *     child entries (`yolo_local__memory_ops.actions.add`), keyed by the
 *     action name, not the member short name — see `legacyMemberActions`.
 *     An absent per-action entry means the member was never part of the
 *     user's explicit grant, which mirrors the pre-collapse split-tool
 *     semantics; an explicit whole-group disable (top-level
 *     `enabled: false`) wins over every action entry, exactly as the
 *     v79->v80 migration documented ("an explicit whole-group disable always
 *     wins over a derived top-level enable").
 *   - `enabled` = true only if every *present* member's `enabled !== false`.
 *   - `approvalMode` = the strictest of every present member's approval
 *     value (`mostStrictApprovalMode`), falling back per-member to that
 *     tool's own legacy default when a present entry's `approvalMode` is
 *     itself missing/invalid.
 *   - **No member present at all -> `enabled: false`**, NOT the capability's
 *     `defaultEnabled`. This is the one place the D9 plan text
 *     (phase2-migration.md: "若旧值缺失 → 用 capability 的 defaultEnabled")
 *     is wrong about runtime semantics, and getting it wrong turns
 *     capabilities *on* that were off. `getEnabledAssistantToolNames`'s own
 *     doc comment is explicit: it "returns the explicit `enabled: true`
 *     entries from `toolPreferences` — no fill-in, no implicit defaults", so
 *     an absent entry has always meant the tool is unavailable at runtime,
 *     whatever its capability's default says. This is not hypothetical: an
 *     assistant created before `bash` shipped (2026-08-08, schema v79) has no
 *     `yolo_local__bash` entry in either source, so Vault Shell is off for it
 *     today — and `vault_shell.defaultEnabled` is `true`, so the plan's rule
 *     would silently grant it a shell that can `rm`/`mv`. Verified against a
 *     real v81 data.json: 2 of its 3 assistants are in exactly that state.
 *
 *     `approvalMode` still falls back to `approval.defaultMode` here, which
 *     matches `getAssistantToolApprovalMode`'s own fallback to
 *     `getDefaultApprovalModeForTool` and is inert while `enabled` is false.
 *   - A resolved `approvalMode` outside the capability's own `allowedModes`
 *     (defensive only — not reachable from real data, since every legacy
 *     value is one of the three tiers and every capability but `vault_shell`
 *     allows exactly `full_access`/`require_approval`) falls back to
 *     `defaultMode`.
 *
 * Every `yolo_local__*` entry is then stripped from both `toolPreferences`
 * and `enabledToolNames` — including retired short names
 * (`fs_list`/`fs_search`/...) that don't belong to any capability and so
 * never contributed a source value above. Remote MCP entries in both are
 * left completely untouched.
 *
 * Idempotent: an assistant that already carries a non-empty
 * `builtinCapabilityPreferences` map is returned unchanged — it was already
 * converted (the migration always stamps every capability id, so non-empty
 * implies complete).
 */
const migrateAssistantBuiltinCapabilities = (
  assistant: Record<string, unknown>,
): Record<string, unknown> => {
  if (
    isRecord(assistant.builtinCapabilityPreferences) &&
    Object.keys(assistant.builtinCapabilityPreferences).length > 0
  ) {
    return assistant
  }

  const legacyPreferences = isRecord(assistant.toolPreferences)
    ? assistant.toolPreferences
    : {}
  // The second legacy grant source, exactly as `getAssistantToolPreferences`
  // reads it: `enabledToolNames` entries are folded in *under*
  // `toolPreferences`, so they grant a tool but never override an explicit
  // entry.
  const legacyEnabledToolNames = new Set(
    Array.isArray(assistant.enabledToolNames)
      ? assistant.enabledToolNames.filter(
          (name): name is string => typeof name === 'string',
        )
      : [],
  )

  const builtinCapabilityPreferences: Record<string, unknown> = {}

  for (const capability of LEGACY_CAPABILITY_MAP) {
    const presentMembers: {
      enabled: boolean
      approvalMode: AssistantToolApprovalMode
    }[] = []

    for (const toolName of capability.toolNames) {
      const sources: {
        enabled: boolean
        approvalMode: AssistantToolApprovalMode
      }[] = []

      const fqn = `${LEGACY_BUILTIN_FQN_PREFIX}${toolName}`
      const memberEntry = legacyPreferences[fqn]
      if (isRecord(memberEntry)) {
        sources.push({
          enabled: memberEntry.enabled !== false,
          approvalMode: isApprovalMode(memberEntry.approvalMode)
            ? memberEntry.approvalMode
            : capability.defaultMode,
        })
      }
      if (legacyEnabledToolNames.has(fqn)) {
        // `buildAssistantToolPreferencesFromEnabledToolNames` synthesizes
        // exactly this: enabled, at the tool's default approval mode.
        sources.push({
          enabled: true,
          approvalMode: capability.defaultMode,
        })
      }

      const groupKey = capability.legacyGroupKey
      if (groupKey) {
        const groupEntry =
          legacyPreferences[`${LEGACY_BUILTIN_FQN_PREFIX}${groupKey}`]
        if (isRecord(groupEntry)) {
          const actionKey =
            capability.legacyMemberActions?.[toolName] ?? toolName
          const actionEntry = isRecord(groupEntry.actions)
            ? groupEntry.actions[actionKey]
            : undefined
          if (isRecord(actionEntry)) {
            const groupApproval = isApprovalMode(groupEntry.approvalMode)
              ? groupEntry.approvalMode
              : undefined
            sources.push({
              // A whole-group disable always wins over its action children.
              enabled:
                groupEntry.enabled !== false && actionEntry.enabled !== false,
              approvalMode: isApprovalMode(actionEntry.approvalMode)
                ? actionEntry.approvalMode
                : (groupApproval ?? capability.defaultMode),
            })
          }
        }
      }

      if (sources.length > 0) {
        presentMembers.push({
          enabled: sources.every((source) => source.enabled),
          approvalMode: mostStrictApprovalMode(
            sources.map((source) => source.approvalMode),
          ),
        })
      }
    }

    const enabled =
      presentMembers.length > 0 &&
      presentMembers.every((member) => member.enabled)

    let approvalMode =
      presentMembers.length > 0
        ? mostStrictApprovalMode(presentMembers.map((m) => m.approvalMode))
        : capability.defaultMode

    if (
      !(capability.allowedModes as readonly string[]).includes(approvalMode)
    ) {
      approvalMode = capability.defaultMode
    }

    builtinCapabilityPreferences[capability.id] = { enabled, approvalMode }
  }

  const nextToolPreferences: Record<string, unknown> = {}
  for (const [fqn, value] of Object.entries(legacyPreferences)) {
    if (isLocalFqn(fqn)) continue
    nextToolPreferences[fqn] = value
  }

  const next: Record<string, unknown> = {
    ...assistant,
    builtinCapabilityPreferences,
    toolPreferences: nextToolPreferences,
  }

  if (Array.isArray(assistant.enabledToolNames)) {
    next.enabledToolNames = assistant.enabledToolNames.filter(
      (name) => typeof name === 'string' && !isLocalFqn(name),
    )
  }

  return next
}

/**
 * One workspace agent's `behaviorOverrides` legacy built-in tool keys
 * (`disabledToolNames` / `toolConfigOverrides` entries whose server name is
 * `yolo_local__`) -> the capability-keyed equivalents
 * (`disabledBuiltinCapabilityIds` / `builtinCapabilityConfigOverrides`).
 * Remote MCP entries in both are left untouched.
 *
 * Naturally idempotent: an agent with no `yolo_local__` override entries is
 * returned unchanged, so re-running this over an already-converted agent is
 * a no-op.
 */
const migrateWorkspaceAgentBuiltinCapabilities = (
  agent: Record<string, unknown>,
): Record<string, unknown> => {
  if (!isRecord(agent.behaviorOverrides)) return agent

  const overrides = agent.behaviorOverrides
  const disabledToolNames = Array.isArray(overrides.disabledToolNames)
    ? overrides.disabledToolNames.filter(
        (name): name is string => typeof name === 'string',
      )
    : []
  const toolConfigOverrides = isRecord(overrides.toolConfigOverrides)
    ? overrides.toolConfigOverrides
    : {}
  const hasLegacyBuiltinOverrides =
    disabledToolNames.some(isLocalFqn) ||
    Object.keys(toolConfigOverrides).some(isLocalFqn)

  if (!hasLegacyBuiltinOverrides) return agent

  const disabledBuiltinCapabilityIds = new Set(
    Array.isArray(overrides.disabledBuiltinCapabilityIds)
      ? overrides.disabledBuiltinCapabilityIds.filter(
          (id): id is string => typeof id === 'string',
        )
      : [],
  )
  const builtinCapabilityConfigOverrides = isRecord(
    overrides.builtinCapabilityConfigOverrides,
  )
    ? { ...overrides.builtinCapabilityConfigOverrides }
    : {}

  for (const capability of LEGACY_CAPABILITY_MAP) {
    const memberFqns = capability.toolNames.map(
      (toolName) => `${LEGACY_BUILTIN_FQN_PREFIX}${toolName}`,
    )
    if (memberFqns.some((name) => disabledToolNames.includes(name))) {
      disabledBuiltinCapabilityIds.add(capability.id)
    }

    const approvalModes = memberFqns
      .map((name) => toolConfigOverrides[name])
      .filter(isRecord)
      .map((entry) => entry.approvalMode)
      .filter(isApprovalMode)
    if (approvalModes.length === 0) continue

    const existing = builtinCapabilityConfigOverrides[capability.id]
    const existingApprovalMode = isRecord(existing)
      ? existing.approvalMode
      : undefined
    const mergedModes = isApprovalMode(existingApprovalMode)
      ? [existingApprovalMode, ...approvalModes]
      : approvalModes
    builtinCapabilityConfigOverrides[capability.id] = {
      ...(isRecord(existing) ? existing : {}),
      approvalMode: mostStrictApprovalMode(mergedModes),
    }
  }

  const nextDisabledToolNames = disabledToolNames.filter(
    (name) => !isLocalFqn(name),
  )
  const nextToolConfigOverrides = Object.fromEntries(
    Object.entries(toolConfigOverrides).filter(([name]) => !isLocalFqn(name)),
  )
  const {
    disabledToolNames: _disabledToolNames,
    toolConfigOverrides: _toolConfigOverrides,
    ...restOverrides
  } = overrides

  return {
    ...agent,
    behaviorOverrides: {
      ...restOverrides,
      ...(disabledBuiltinCapabilityIds.size > 0
        ? {
            disabledBuiltinCapabilityIds: [...disabledBuiltinCapabilityIds],
          }
        : {}),
      ...(Object.keys(builtinCapabilityConfigOverrides).length > 0
        ? { builtinCapabilityConfigOverrides }
        : {}),
      ...(nextDisabledToolNames.length > 0
        ? { disabledToolNames: nextDisabledToolNames }
        : {}),
      ...(Object.keys(nextToolConfigOverrides).length > 0
        ? { toolConfigOverrides: nextToolConfigOverrides }
        : {}),
    },
  }
}

/**
 * Applies the v81 field defaults that were folded into this migration batch
 * from the former 81..85 migrations (TTS/STT/image model lists, memory
 * flags, subagent limits, `mineru`, `webRuntime`, `scheduledTasks`,
 * `chatOptions.moa`, `subagentTimeout`). Every assignment is guarded by a
 * type check, so re-running over already-defaulted data is a no-op.
 */
const applyV81FieldDefaults = (
  next: Record<string, unknown>,
): Record<string, unknown> => {
  if (typeof next.subagentResultMaxChars !== 'number') {
    next.subagentResultMaxChars = SUBAGENT_RESULT_MAX_CHARS
  }
  if (typeof next.forkContextTurns !== 'number') {
    next.forkContextTurns = SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT
  }
  next.mineru ??= { enabled: false, baseUrl: '', apiKey: '' }

  const chatOptions = isRecord(next.chatOptions) ? next.chatOptions : {}
  next.chatOptions = {
    ...chatOptions,
    moa: isRecord(chatOptions.moa)
      ? chatOptions.moa
      : { enabled: true, timeoutMs: 45_000, maxOutputTokens: 2_048 },
  }
  next.subagentTimeout = isRecord(next.subagentTimeout)
    ? { ...DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG, ...next.subagentTimeout }
    : { ...DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG }

  if (isRecord(next.webRuntime)) {
    next.webRuntime = {
      enabled: next.webRuntime.enabled === true,
      port: Number(next.webRuntime.port) || 18900,
      host: String(next.webRuntime.host ?? '127.0.0.1'),
      token: String(next.webRuntime.token ?? ''),
      maxConcurrentAgentRuns:
        Number(next.webRuntime.maxConcurrentAgentRuns) || 12,
    }
  }
  if (isRecord(next.scheduledTasks)) {
    next.scheduledTasks = {
      enabled: next.scheduledTasks.enabled === true,
      enableScriptExecution: next.scheduledTasks.enableScriptExecution === true,
      allowedScriptDirectories: Array.isArray(
        next.scheduledTasks.allowedScriptDirectories,
      )
        ? next.scheduledTasks.allowedScriptDirectories
        : [],
    }
  }

  return next
}

/**
 * Collapse the pre-capability persistence shape (short tool/group names)
 * into the capability-keyed shape everywhere built-in tool
 * enablement/approval is stored (docs/plans/2026-08-15-tool-registry, D9).
 *
 * Three independent layers, all handled here:
 *   - Global: `settings.mcp.builtinToolOptions` -> `builtinCapabilityOptions`.
 *   - Per-assistant: each assistant's `toolPreferences` built-in entries ->
 *     its own new `builtinCapabilityPreferences`.
 *   - Per-workspace-agent: `behaviorOverrides` built-in tool keys ->
 *     capability-keyed overrides.
 *
 * Remote MCP data (`toolPreferences` entries for non-`yolo_local__` FQNs,
 * `toolServerPreferences`, each server's own `toolOptions`) is never touched
 * by either half.
 */
export const migrateLegacyBuiltinCapabilityState = (
  data: Record<string, unknown>,
): Record<string, unknown> => {
  let next = migrateBuiltinToolOptions(data)

  if (Array.isArray(next.assistants)) {
    next.assistants = next.assistants.map((assistant) =>
      isRecord(assistant)
        ? migrateAssistantBuiltinCapabilities(assistant)
        : assistant,
    )
  }

  if (Array.isArray(next.workspaceAgents)) {
    next.workspaceAgents = next.workspaceAgents.map((agent) =>
      isRecord(agent) ? migrateWorkspaceAgentBuiltinCapabilities(agent) : agent,
    )
  }

  return applyV81FieldDefaults(next)
}
