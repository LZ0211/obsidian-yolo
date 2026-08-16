import { SETTINGS_SCHEMA_VERSION, SETTING_MIGRATIONS } from './index'
import { migrateFrom81To82 } from './81_to_82'

type MigratedAssistant = {
  toolPreferences?: Record<string, unknown>
  enabledToolNames?: string[]
  builtinCapabilityPreferences?: Record<
    string,
    { enabled: boolean; approvalMode: string }
  >
}

type MigratedData = {
  version: number
  mcp?: {
    builtinCapabilityOptions?: Record<string, Record<string, unknown>>
    builtinToolOptions?: unknown
  }
  assistants?: MigratedAssistant[]
  subagentResultMaxChars?: number
  forkContextTurns?: number
  mineru?: { enabled: boolean; baseUrl: string; apiKey: string }
  chatOptions?: { moa?: { enabled: boolean; timeoutMs: number; maxOutputTokens: number } }
}

const runMigration = (data: Record<string, unknown>): MigratedData =>
  migrateFrom81To82(data) as MigratedData

// The real v81 legacy shape of this plugin's own vault (backed up
// 2026-08-11, before the capability migration): per-assistant group FQNs
// (`memory_ops`, `context_manage`) plus retired split names (`fs_search`,
// `fs_list`) in toolPreferences, and global `builtinToolOptions` keyed by
// short/group names.
const REAL_V81_SHAPE = {
  version: 81,
  mcp: {
    builtinToolOptions: {
      open_skill: { disabled: false },
      web_ops: { disabled: false },
      web_search: { disabled: false },
      web_scrape: { disabled: false },
      delegate_subagent: {
        allowedModelIds: ['DeepSeek/deepseek-v4-flash'],
        preferredModelId: 'DeepSeek/deepseek-v4-flash',
      },
      meta_search: { disabled: false },
    },
  },
  assistants: [
    {
      id: 'agent-1',
      toolPreferences: {
        yolo_local__memory_ops: {
          enabled: true,
          actions: {
            add: { enabled: true, approvalMode: 'full_access' },
            update: { enabled: true, approvalMode: 'full_access' },
            delete: { enabled: true, approvalMode: 'full_access' },
          },
        },
        yolo_local__context_manage: {
          enabled: true,
          actions: {
            compact: { enabled: true, approvalMode: 'full_access' },
            prune: { enabled: false, approvalMode: 'full_access' },
          },
        },
        yolo_local__fs_search: { enabled: true },
        yolo_local__fs_list: { enabled: true },
      },
      enabledToolNames: ['yolo_local__memory_ops', 'server__tool_a'],
    },
    {
      id: 'agent-2',
      toolPreferences: {
        yolo_local__fs_read: { enabled: true, approvalMode: 'full_access' },
        server__tool_b: { enabled: true, approvalMode: 'require_approval' },
      },
      enabledToolNames: ['yolo_local__fs_read', 'server__tool_b'],
    },
  ],
}

describe('migrateFrom81To82', () => {
  it('is registered in the migration chain ahead of the current schema version', () => {
    const step = SETTING_MIGRATIONS.find(
      (migration) => migration.fromVersion === 81,
    )
    expect(step?.toVersion).toBe(82)
    expect(step?.migrate).toBe(migrateFrom81To82)
    expect(SETTINGS_SCHEMA_VERSION).toBe(82)
  })

  it('converts a v81 legacy-shaped vault (the real backup shape) to capability keys', () => {
    const result = runMigration(REAL_V81_SHAPE)

    expect(result.version).toBe(82)

    // Global layer: builtinCapabilityOptions built from builtinToolOptions,
    // legacy key stripped, delegate model restriction preserved.
    expect(result.mcp?.builtinToolOptions).toBeUndefined()
    expect(result.mcp?.builtinCapabilityOptions?.web_access).toEqual({
      disabled: false,
    })
    expect(result.mcp?.builtinCapabilityOptions?.subagent_delegation).toEqual({
      disabled: false,
      allowedModelIds: ['DeepSeek/deepseek-v4-flash'],
      preferredModelId: 'DeepSeek/deepseek-v4-flash',
    })

    // Per-assistant: group FQNs folded into capabilities, retired names
    // stripped, remote entries untouched.
    const a1 = result.assistants?.[0]
    expect(a1?.builtinCapabilityPreferences?.memory).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(a1?.builtinCapabilityPreferences?.context_compaction).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(a1?.builtinCapabilityPreferences?.context_pruning).toEqual({
      enabled: false,
      approvalMode: 'full_access',
    })
    expect(a1?.toolPreferences).toEqual({})
    expect(a1?.enabledToolNames).toEqual(['server__tool_a'])

    const a2 = result.assistants?.[1]
    expect(a2?.builtinCapabilityPreferences?.file_reading).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(a2?.builtinCapabilityPreferences?.vault_shell).toEqual({
      enabled: false,
      approvalMode: 'dangerous_only',
    })
    expect(a2?.toolPreferences).toEqual({
      server__tool_b: { enabled: true, approvalMode: 'require_approval' },
    })
    expect(a2?.enabledToolNames).toEqual(['server__tool_b'])
  })

  it('converts a vault stranded at v85 (same legacy tool shape) the same way', () => {
    const result = runMigration({
      ...REAL_V81_SHAPE,
      version: 85,
    })

    expect(result.version).toBe(82)
    expect(result.mcp?.builtinCapabilityOptions?.subagent_delegation).toEqual({
      disabled: false,
      allowedModelIds: ['DeepSeek/deepseek-v4-flash'],
      preferredModelId: 'DeepSeek/deepseek-v4-flash',
    })
    expect(
      result.assistants?.[0]?.builtinCapabilityPreferences?.memory,
    ).toEqual({ enabled: true, approvalMode: 'full_access' })
  })

  it('leaves an already-converted assistant (non-empty builtinCapabilityPreferences) untouched', () => {
    const converted = {
      id: 'agent-1',
      builtinCapabilityPreferences: {
        memory: { enabled: false, approvalMode: 'full_access' },
      },
      toolPreferences: {
        server__tool_b: { enabled: true, approvalMode: 'require_approval' },
      },
      enabledToolNames: ['server__tool_b'],
    }

    const result = runMigration({
      version: 81,
      assistants: [converted],
    })

    expect(result.assistants?.[0]).toEqual(converted)
  })

  it('keeps an existing global builtinCapabilityOptions untouched while stripping builtinToolOptions', () => {
    const result = runMigration({
      version: 82,
      mcp: {
        builtinCapabilityOptions: {
          memory: { disabled: true },
        },
        builtinToolOptions: {
          memory_ops: { disabled: false },
        },
      },
    })

    expect(result.mcp?.builtinCapabilityOptions).toEqual({
      memory: { disabled: true },
    })
    expect(result.mcp?.builtinToolOptions).toBeUndefined()
  })

  it('stamps the full capability map when no legacy or capability data exists', () => {
    const result = runMigration({ version: 81 })

    expect(result.mcp?.builtinCapabilityOptions?.file_editing).toEqual({
      disabled: false,
    })
    expect(result.mcp?.builtinCapabilityOptions?.terminal).toEqual({
      disabled: false,
    })
  })

  it('is a no-op safe default for empty/malformed data — never throws', () => {
    expect(() =>
      runMigration({ version: 81, mcp: null, assistants: null }),
    ).not.toThrow()
    const result = runMigration({
      version: 81,
      mcp: 'not-an-object',
      assistants: [null, 'not-an-object', 42],
    })
    expect(result.assistants).toEqual([null, 'not-an-object', 42])
    expect(result.mcp?.builtinCapabilityOptions?.file_editing).toEqual({
      disabled: false,
    })
  })

  it('applies the v81 field defaults to a vault that skipped the 80_to_81 migration', () => {
    const result = runMigration({ version: 81 })

    expect(result.subagentResultMaxChars).toBeGreaterThan(0)
    expect(result.forkContextTurns).toBeGreaterThan(0)
    expect(result.mineru).toEqual({ enabled: false, baseUrl: '', apiKey: '' })
    expect(result.chatOptions?.moa).toEqual({
      enabled: true,
      timeoutMs: 45_000,
      maxOutputTokens: 2_048,
    })
  })
})
