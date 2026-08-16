import { parseYoloSettings } from '../settings'
import { migrateYoloSettingsData } from '../settings'
import {
  getAssistantToolApprovalMode,
  isAssistantToolEnabled,
} from '../../../core/agent/tool-preferences'

/**
 * End-to-end migration-chain test: drives the full v79 -> v82 chain over the
 * real legacy shapes (the 2026-08-11 release's split tools, the v79->v80
 * consolidation into group FQNs, and the v80->v81/v81->v82 capability
 * conversion) the way `parseYoloSettings` would, without the zod layer.
 *
 * This is the regression net for the F1-class bug: a vault that granted
 * memory / context through the consolidated group FQNs
 * (`yolo_local__memory_ops` / `yolo_local__context_manage`) must keep those
 * grants after the whole chain runs — the per-assistant capability state at
 * the end has to match what the user actually enabled.
 */

type ChainData = {
  version: number
  mcp?: Record<string, unknown>
  assistants?: Array<Record<string, unknown>>
}

const runChain = (data: Record<string, unknown>): ChainData =>
  migrateYoloSettingsData(data) as unknown as ChainData

type CapabilityPreference = { enabled: boolean; approvalMode: string }

describe('settings migration chain (v79 -> v82), e2e', () => {
  it('keeps memory/context grants for an assistant whose v79 split-tool state was folded into group FQNs', () => {
    // v79 data: split tools with per-tool grants; memory enabled, context
    // compaction enabled with prune explicitly disabled.
    const v79 = {
      version: 79,
      mcp: {
        builtinToolOptions: {
          web_ops: { disabled: false },
          delegate_subagent: {
            allowedModelIds: ['DeepSeek/deepseek-v4-flash'],
          },
        },
      },
      assistants: [
        {
          id: 'agent-1',
          toolPreferences: {
            yolo_local__memory_add: {
              enabled: true,
              approvalMode: 'full_access',
            },
            yolo_local__memory_update: {
              enabled: true,
              approvalMode: 'full_access',
            },
            yolo_local__memory_delete: {
              enabled: true,
              approvalMode: 'full_access',
            },
            yolo_local__context_compact: {
              enabled: true,
              approvalMode: 'full_access',
            },
            yolo_local__context_prune_tool_results: {
              enabled: false,
              approvalMode: 'full_access',
            },
            yolo_local__fs_read: { enabled: true, approvalMode: 'full_access' },
          },
          enabledToolNames: ['yolo_local__memory_add'],
        },
      ],
    }

    const result = runChain(v79)

    expect(result.version).toBe(82)
    const assistant = result.assistants?.[0] as unknown as {
      builtinCapabilityPreferences: Record<string, CapabilityPreference>
      toolPreferences: Record<string, unknown>
    }

    expect(assistant.builtinCapabilityPreferences.memory).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(assistant.builtinCapabilityPreferences.context_compaction).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(assistant.builtinCapabilityPreferences.context_pruning).toEqual({
      enabled: false,
      approvalMode: 'full_access',
    })
    // Every legacy built-in FQN (member and group forms alike) is gone.
    expect(
      Object.keys(assistant.toolPreferences).some((key) =>
        key.startsWith('yolo_local__'),
      ),
    ).toBe(false)
    expect(assistant.toolPreferences).toEqual({})
  })

  it('carries the global delegate_subagent model restriction through both collapses', () => {
    const v79 = {
      version: 79,
      mcp: {
        builtinToolOptions: {
          delegate_subagent: {
            allowedModelIds: ['DeepSeek/deepseek-v4-flash'],
            preferredModelId: 'DeepSeek/deepseek-v4-flash',
          },
        },
      },
    }

    const result = runChain(v79)
    const mcp = result.mcp as unknown as {
      builtinCapabilityOptions: Record<string, Record<string, unknown>>
      builtinToolOptions?: unknown
    }

    expect(mcp.builtinToolOptions).toBeUndefined()
    expect(mcp.builtinCapabilityOptions.subagent_delegation).toEqual({
      disabled: false,
      allowedModelIds: ['DeepSeek/deepseek-v4-flash'],
      preferredModelId: 'DeepSeek/deepseek-v4-flash',
    })
  })

  it('migrates a vault already stranded at v81 legacy shape (the 08-11 backup shape) straight to v82', () => {
    const v81 = {
      version: 81,
      mcp: {
        builtinToolOptions: {
          web_ops: { disabled: false },
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
                prune: { enabled: true, approvalMode: 'full_access' },
              },
            },
          },
        },
      ],
    }

    const result = runChain(v81)

    expect(result.version).toBe(82)
    const assistant = result.assistants?.[0] as unknown as {
      builtinCapabilityPreferences: Record<string, CapabilityPreference>
    }
    expect(assistant.builtinCapabilityPreferences.memory).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    expect(assistant.builtinCapabilityPreferences.context_pruning).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
  })

  it('is a no-op for a vault already at v82 in the capability shape', () => {
    const v82 = {
      version: 82,
      mcp: {
        builtinCapabilityOptions: {
          memory: { disabled: true },
        },
      },
      assistants: [
        {
          id: 'agent-1',
          builtinCapabilityPreferences: {
            memory: { enabled: false, approvalMode: 'full_access' },
          },
          toolPreferences: {
            server__tool_b: { enabled: true, approvalMode: 'require_approval' },
          },
        },
      ],
    }

    const result = runChain(JSON.parse(JSON.stringify(v82)))

    expect(result.version).toBe(82)
    expect(result).toEqual(v82)
  })
})

// Runtime seam: what the migrated-on-disk settings actually mean at runtime.
// This is the exact seam the migration bugs lived on — a legacy vault shape
// that migrated "fine" but silently lost per-assistant capability state.
describe('migration chain -> runtime resolution, e2e', () => {
  const V81_LEGACY_VAULT = {
    version: 81,
    providers: [
      {
        id: 'DeepSeek',
        presetType: 'openai',
        apiType: 'openai-compatible',
        apiKey: 'token',
      },
    ],
    chatModels: [
      {
        providerId: 'DeepSeek',
        id: 'DeepSeek/deepseek-v4-flash',
        model: 'deepseek-v4-flash',
        enable: true,
      },
    ],
    chatModelId: 'DeepSeek/deepseek-v4-flash',
    mcp: {
      builtinToolOptions: {
        delegate_subagent: {
          allowedModelIds: ['DeepSeek/deepseek-v4-flash'],
          preferredModelId: 'DeepSeek/deepseek-v4-flash',
        },
      },
    },
    assistants: [
      {
        id: 'agent-1',
        name: '全能工作助手',
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
          yolo_local__fs_read: { enabled: true, approvalMode: 'full_access' },
          yolo_local__fs_write: {
            enabled: true,
            approvalMode: 'require_approval',
          },
        },
      },
    ],
  }

  it("resolves the user's legacy per-assistant grants after parseYoloSettings", () => {
    const settings = parseYoloSettings(
      JSON.parse(JSON.stringify(V81_LEGACY_VAULT)),
    )

    expect(settings.version).toBe(82)
    const assistant = settings.assistants[0]

    // Memory was granted through the group FQN -> the capability is on in
    // the parsed assistant (memory tools are host-driven/internal, so their
    // capability state lives on the assistant itself rather than passing
    // through the user-facing isAssistantToolEnabled gate).
    expect(assistant.builtinCapabilityPreferences?.memory).toEqual({
      enabled: true,
      approvalMode: 'full_access',
    })
    // Context compaction granted, pruning explicitly disabled — both via the
    // user-facing runtime resolution.
    expect(
      isAssistantToolEnabled(assistant, 'yolo_local__context_compact'),
    ).toBe(true)
    expect(
      isAssistantToolEnabled(
        assistant,
        'yolo_local__context_prune_tool_results',
      ),
    ).toBe(false)
    // Regular member grants still resolve.
    expect(isAssistantToolEnabled(assistant, 'yolo_local__fs_read')).toBe(true)
    // Approval tier carried over (strictest member wins).
    expect(
      getAssistantToolApprovalMode(assistant, 'yolo_local__fs_write'),
    ).toBe('require_approval')
    // Global delegate model restriction survives into the parsed settings.
    expect(
      settings.mcp.builtinCapabilityOptions.subagent_delegation
        ?.allowedModelIds,
    ).toEqual(['DeepSeek/deepseek-v4-flash'])
  })
})
