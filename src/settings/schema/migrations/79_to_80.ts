import {
  CONSOLIDATED_TOOLS,
  LEGACY_TOOL_TO_CAPABILITY,
} from '../../../core/agent/consolidated-tools'
import type { SettingMigration } from '../setting.types'

/**
 * v79→v80: collapse the 14 legacy split-action built-in tools into the four
 * consolidated tools (`context_manage`, `fs_file_ops`, `memory_ops`,
 * `scheduled_task_ops`).
 *
 * The legacy names (`fs_delete`, `memory_add`, `scheduled_task_run_now`, …)
 * map one-to-one to a `toolName:action` capability via
 * `LEGACY_TOOL_TO_CAPABILITY`. Tool state lives in three places, each keyed by
 * the legacy tool name in either the bare form (`fs_delete`) or the
 * fully-qualified form (`yolo_local__fs_delete`). This migration remaps all
 * three, keeping the action-level policy per action:
 *
 *   1. `assistants[].toolPreferences` — each legacy tool's `enabled` /
 *      `approvalMode` becomes `toolPreferences[toolName].actions[action]`.
 *      The consolidated top-level `enabled` is `true` when at least one action
 *      is enabled; a disabled action stays denied by its child entry.
 *   2. `mcp.builtinToolOptions` — each legacy `{ disabled?,
 *      allowAutoExecution? }` becomes `builtinToolOptions[toolName]
 *      .actionOptions[action]`. The group entry's own tool-level fields are
 *      preserved.
 *   3. `assistants[].enabledToolNames` — legacy entries are rewritten to the
 *      consolidated bare/FQN group name when the group has at least one enabled
 *      action; entries whose group has no enabled action are dropped as stale;
 *      unknown tool names are preserved untouched.
 *
 * On collision (an existing group-alias entry and an explicit old-tool entry
 * targeting the same action), the most-restrictive valid policy wins — a
 * group-alias default may initialize a missing action entry but never loosens
 * an explicit old-tool setting — and a diagnostic is logged.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const preserveBooleanOrFalse = (value: unknown): boolean =>
  typeof value === 'boolean' ? value : false

const FQN_PREFIX = 'yolo_local__'

/** Split a key into its optional FQN prefix and the bare tool short name. */
const splitKey = (key: string): { prefix: string; shortName: string } => {
  if (key.startsWith(FQN_PREFIX)) {
    return { prefix: FQN_PREFIX, shortName: key.slice(FQN_PREFIX.length) }
  }
  return { prefix: '', shortName: key }
}

const isConsolidatedShortName = (shortName: string): boolean =>
  (CONSOLIDATED_TOOLS as readonly string[]).includes(shortName)

/** Resolve a legacy tool short name to its consolidated `toolName:action`. */
const resolveLegacyCapability = (
  shortName: string,
): { toolName: string; action: string } | undefined => {
  const capability = LEGACY_TOOL_TO_CAPABILITY[shortName]
  if (typeof capability !== 'string') return undefined
  const colon = capability.indexOf(':')
  if (colon <= 0 || colon >= capability.length - 1) return undefined
  return {
    toolName: capability.slice(0, colon),
    action: capability.slice(colon + 1),
  }
}

// --- toolPreferences ------------------------------------------------------

type ActionPreference = {
  enabled?: boolean
  approvalMode?: 'full_access' | 'require_approval'
}

type ToolPreference = {
  enabled?: boolean
  approvalMode?: 'full_access' | 'require_approval'
  disclosureMode?: 'always' | 'on_demand'
  actions?: Record<string, ActionPreference>
}

const asActionPreference = (value: unknown): ActionPreference =>
  isRecord(value) ? (value as unknown as ActionPreference) : {}

const asToolPreference = (value: unknown): ToolPreference =>
  isRecord(value) ? (value as unknown as ToolPreference) : {}

const hasActionPolicy = (preference: ActionPreference): boolean =>
  preference.enabled !== undefined || preference.approvalMode !== undefined

/**
 * Conservative, most-restrictive merge of two action preferences. When both
 * sides set a field, disabled / `require_approval` win; when only one side sets
 * a field, that explicit value is kept.
 */
const mergeActionPreference = (
  a: ActionPreference | undefined,
  b: ActionPreference | undefined,
): ActionPreference | undefined => {
  if (!a) return b
  if (!b) return a

  const result: ActionPreference = {}

  if (a.enabled !== undefined && b.enabled !== undefined) {
    result.enabled = a.enabled === false || b.enabled === false ? false : true
  } else if (a.enabled !== undefined) {
    result.enabled = a.enabled
  } else if (b.enabled !== undefined) {
    result.enabled = b.enabled
  }

  if (a.approvalMode !== undefined && b.approvalMode !== undefined) {
    result.approvalMode =
      a.approvalMode === 'require_approval' ||
      b.approvalMode === 'require_approval'
        ? 'require_approval'
        : 'full_access'
  } else if (a.approvalMode !== undefined) {
    result.approvalMode = a.approvalMode
  } else if (b.approvalMode !== undefined) {
    result.approvalMode = b.approvalMode
  }

  return result
}

type GroupPrefAccumulator = {
  existing: ToolPreference | undefined
  actions: Map<string, ActionPreference>
}

const getGroupPrefAccumulator = (
  buckets: Map<string, GroupPrefAccumulator>,
  groupKey: string,
): GroupPrefAccumulator => {
  let bucket = buckets.get(groupKey)
  if (!bucket) {
    bucket = { existing: undefined, actions: new Map() }
    buckets.set(groupKey, bucket)
  }
  return bucket
}

const setActionWithMerge = (
  bucket: GroupPrefAccumulator,
  groupKey: string,
  action: string,
  incoming: ActionPreference,
): void => {
  const existing = bucket.actions.get(action)
  if (existing !== undefined && hasActionPolicy(incoming)) {
    console.warn(
      `[settings] 79→80: toolPreferences action ${groupKey}:${action} has both a group-alias entry and a legacy old-tool entry; kept the most-restrictive valid policy`,
    )
  }
  bucket.actions.set(action, mergeActionPreference(existing, incoming) ?? {})
}

/**
 * Remap a `{ [toolKey]: ToolPreference }` record. Legacy split tool keys (in
 * whichever prefix form they appear) are folded into per-action entries on the
 * consolidated group key (same prefix form); existing group-alias entries are
 * preserved with their own top-level fields and per-action entries merged
 * conservatively. Unknown keys pass through untouched.
 */
const remapToolPreferences = (
  preferences: Record<string, unknown>,
): Record<string, unknown> => {
  const next: Record<string, unknown> = {}
  const buckets = new Map<string, GroupPrefAccumulator>()

  for (const [key, value] of Object.entries(preferences)) {
    const { prefix, shortName } = splitKey(key)
    const capability = resolveLegacyCapability(shortName)
    if (capability) {
      const groupKey = `${prefix}${capability.toolName}`
      const bucket = getGroupPrefAccumulator(buckets, groupKey)
      // Only `enabled`/`approvalMode` carry down to the action child; the
      // legacy `disclosureMode` is a tool-level concern with no action-level
      // equivalent (built-ins are forced to `always` at runtime).
      const legacyToolPreference = asToolPreference(value)
      const incomingAction: ActionPreference = {
        enabled: legacyToolPreference.enabled,
        approvalMode: legacyToolPreference.approvalMode,
      }
      setActionWithMerge(bucket, groupKey, capability.action, incomingAction)
      continue
    }
    if (isConsolidatedShortName(shortName)) {
      const bucket = getGroupPrefAccumulator(buckets, key)
      bucket.existing = asToolPreference(value)
      for (const [action, actionValue] of Object.entries(
        bucket.existing.actions ?? {},
      )) {
        setActionWithMerge(bucket, key, action, asActionPreference(actionValue))
      }
      continue
    }
    next[key] = value
  }

  for (const [groupKey, bucket] of buckets.entries()) {
    const preference: ToolPreference = {}
    if (bucket.existing) {
      if (bucket.existing.approvalMode !== undefined) {
        preference.approvalMode = bucket.existing.approvalMode
      }
      if (bucket.existing.disclosureMode !== undefined) {
        preference.disclosureMode = bucket.existing.disclosureMode
      }
    }
    const anyActionEnabled = [...bucket.actions.values()].some(
      (action) => action.enabled === true,
    )
    // An explicit whole-group disable always wins over a derived top-level
    // enable (most-restrictive rule); the legacy action still migrates into
    // `actions[action]` and stays denied by the disabled group gate.
    if (bucket.existing?.enabled === false) {
      preference.enabled = false
    } else if (anyActionEnabled) {
      preference.enabled = true
    } else if (bucket.existing?.enabled !== undefined) {
      preference.enabled = bucket.existing.enabled
    }
    if (bucket.actions.size > 0) {
      preference.actions = Object.fromEntries(bucket.actions)
    }
    next[groupKey] = preference
  }

  return next
}

// --- enabledToolNames -----------------------------------------------------

const groupHasEnabledAction = (
  preferences: Record<string, unknown>,
  groupKey: string,
): boolean => {
  const preference = preferences[groupKey]
  if (!isRecord(preference)) return false
  const actions = preference.actions
  if (!isRecord(actions)) return false
  return Object.values(actions).some(
    (action) => isRecord(action) && action.enabled === true,
  )
}

/**
 * Rewrite legacy split-tool entries in `enabledToolNames` to the consolidated
 * group name (preserving the bare/FQN form). An entry is rewritten only when
 * the target group has at least one enabled action; otherwise the snapshot
 * entry is stale and dropped. Group-alias names and unknown tool names pass
 * through, deduplicated in order.
 */
const remapEnabledToolNames = (
  preferences: Record<string, unknown>,
  names: unknown[],
): unknown[] => {
  const seen = new Set<string>()
  const next: unknown[] = []

  for (const name of names) {
    if (typeof name !== 'string') {
      next.push(name)
      continue
    }
    const { prefix, shortName } = splitKey(name)
    const capability = resolveLegacyCapability(shortName)
    if (!capability) {
      if (!seen.has(name)) {
        seen.add(name)
        next.push(name)
      }
      continue
    }
    const groupKey = `${prefix}${capability.toolName}`
    if (groupHasEnabledAction(preferences, groupKey) && !seen.has(groupKey)) {
      seen.add(groupKey)
      next.push(groupKey)
    }
  }

  return next
}

// --- builtinToolOptions ---------------------------------------------------

type BuiltinToolActionOption = {
  disabled?: boolean
  allowAutoExecution?: boolean
}

type BuiltinToolOption = {
  disabled?: boolean
  allowAutoExecution?: boolean
  blockedPrefixes?: string[]
  allowedModelIds?: string[]
  preferredModelId?: string
  actionOptions?: Record<string, BuiltinToolActionOption>
}

const asBuiltinToolOption = (value: unknown): BuiltinToolOption =>
  isRecord(value) ? (value as unknown as BuiltinToolOption) : {}

const asBuiltinActionOption = (value: unknown): BuiltinToolActionOption =>
  isRecord(value) ? (value as unknown as BuiltinToolActionOption) : {}

const hasBuiltinActionPolicy = (option: BuiltinToolActionOption): boolean =>
  option.disabled !== undefined || option.allowAutoExecution !== undefined

const mergeField = <T>(
  a: T | undefined,
  b: T | undefined,
  isMoreRestrictive: (value: T) => boolean,
): T | undefined => {
  if (a === undefined) return b
  if (b === undefined) return a
  return isMoreRestrictive(a) ? a : b
}

/**
 * Conservative, most-restrictive merge of two action options: `disabled: true`
 * wins for `disabled`, `allowAutoExecution: false` wins for
 * `allowAutoExecution`. A field set on only one side is kept as-is.
 */
const mergeBuiltinActionOption = (
  a: BuiltinToolActionOption | undefined,
  b: BuiltinToolActionOption | undefined,
): BuiltinToolActionOption | undefined => {
  if (!a) return b
  if (!b) return a

  const result: BuiltinToolActionOption = {}
  const disabled = mergeField(a.disabled, b.disabled, (value) => value === true)
  if (disabled !== undefined) result.disabled = disabled
  const allowAutoExecution = mergeField(
    a.allowAutoExecution,
    b.allowAutoExecution,
    (value) => value === false,
  )
  if (allowAutoExecution !== undefined) {
    result.allowAutoExecution = allowAutoExecution
  }
  return result
}

type GroupBuiltinAccumulator = {
  existing: BuiltinToolOption | undefined
  actions: Map<string, BuiltinToolActionOption>
}

const getGroupBuiltinAccumulator = (
  buckets: Map<string, GroupBuiltinAccumulator>,
  groupKey: string,
): GroupBuiltinAccumulator => {
  let bucket = buckets.get(groupKey)
  if (!bucket) {
    bucket = { existing: undefined, actions: new Map() }
    buckets.set(groupKey, bucket)
  }
  return bucket
}

/**
 * Remap a `{ [toolKey]: BuiltinToolOption }` record. Legacy split tool keys
 * (bare or FQN — the runtime only reads bare short names) are folded into
 * `actionOptions[action]` on the bare consolidated group key; the group's own
 * tool-level fields are preserved. Unknown keys pass through untouched.
 */
const remapBuiltinToolOptions = (
  options: Record<string, unknown>,
): Record<string, unknown> => {
  const next: Record<string, unknown> = {}
  const buckets = new Map<string, GroupBuiltinAccumulator>()

  for (const [key, value] of Object.entries(options)) {
    const { shortName } = splitKey(key)
    const capability = resolveLegacyCapability(shortName)
    if (capability) {
      const groupKey = capability.toolName
      const bucket = getGroupBuiltinAccumulator(buckets, groupKey)
      const legacy = asBuiltinToolOption(value)
      if (
        legacy.blockedPrefixes !== undefined ||
        legacy.allowedModelIds !== undefined ||
        legacy.preferredModelId !== undefined
      ) {
        console.warn(
          `[settings] 79→80: dropped tool-level fields from legacy builtinToolOptions.${key} that have no action-level equivalent (blockedPrefixes/allowedModelIds/preferredModelId)`,
        )
      }
      const actionOption: BuiltinToolActionOption = {
        disabled: legacy.disabled,
        allowAutoExecution: legacy.allowAutoExecution,
      }
      const existing = bucket.actions.get(capability.action)
      if (
        existing !== undefined &&
        hasBuiltinActionPolicy(existing) &&
        hasBuiltinActionPolicy(actionOption)
      ) {
        console.warn(
          `[settings] 79→80: builtinToolOptions action ${groupKey}:${capability.action} has both a group-alias entry and a legacy old-tool entry; kept the most-restrictive valid policy`,
        )
      }
      bucket.actions.set(
        capability.action,
        mergeBuiltinActionOption(existing, actionOption) ?? {},
      )
      continue
    }
    if (isConsolidatedShortName(shortName)) {
      const bucket = getGroupBuiltinAccumulator(buckets, shortName)
      bucket.existing = asBuiltinToolOption(value)
      for (const [action, actionOption] of Object.entries(
        bucket.existing.actionOptions ?? {},
      )) {
        const existing = bucket.actions.get(action)
        bucket.actions.set(
          action,
          mergeBuiltinActionOption(
            existing,
            asBuiltinActionOption(actionOption),
          ) ?? {},
        )
      }
      continue
    }
    next[key] = value
  }

  for (const [groupKey, bucket] of buckets.entries()) {
    const option: BuiltinToolOption = bucket.existing
      ? { ...bucket.existing }
      : {}
    delete option.actionOptions
    if (bucket.actions.size > 0) {
      option.actionOptions = Object.fromEntries(bucket.actions)
    }
    next[groupKey] = option
  }

  return next
}

export const migrateFrom79To80: SettingMigration['migrate'] = (data) => {
  const next: Record<string, unknown> = { ...data, version: 80 }

  // TTS/STT/image model defaults (folded from the former v80→v81 migration).
  next.ttsModels = Array.isArray(data.ttsModels) ? data.ttsModels : []
  next.sttModels = Array.isArray(data.sttModels) ? data.sttModels : []
  next.imageModels = Array.isArray(data.imageModels) ? data.imageModels : []
  next.ttsModelId = typeof data.ttsModelId === 'string' ? data.ttsModelId : ''
  next.sttModelId = typeof data.sttModelId === 'string' ? data.sttModelId : ''
  next.imageModelId =
    typeof data.imageModelId === 'string' ? data.imageModelId : ''

  // Memory partition/reflection flags (folded from the former v81→v82
  // migration).
  next.advancedMemoryIndexEnabled = preserveBooleanOrFalse(
    data.advancedMemoryIndexEnabled,
  )
  next.memoryReflectionEnabled = preserveBooleanOrFalse(
    data.memoryReflectionEnabled,
  )

  if (Array.isArray(next.assistants)) {
    next.assistants = next.assistants.map((assistant: unknown) => {
      if (!isRecord(assistant)) {
        return assistant
      }

      const assistantRecord: Record<string, unknown> = { ...assistant }

      if (isRecord(assistantRecord.toolPreferences)) {
        assistantRecord.toolPreferences = remapToolPreferences(
          assistantRecord.toolPreferences,
        )
      }

      if (Array.isArray(assistantRecord.enabledToolNames)) {
        assistantRecord.enabledToolNames = remapEnabledToolNames(
          isRecord(assistantRecord.toolPreferences)
            ? assistantRecord.toolPreferences
            : {},
          assistantRecord.enabledToolNames as unknown[],
        )
      }

      return assistantRecord
    })
  }

  if (isRecord(next.mcp)) {
    const mcpRecord = { ...next.mcp }
    if (isRecord(mcpRecord.builtinToolOptions)) {
      mcpRecord.builtinToolOptions = remapBuiltinToolOptions(
        mcpRecord.builtinToolOptions,
      )
    }
    next.mcp = mcpRecord
  }

  return next
}
