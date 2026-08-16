import { migrateFrom79To80 } from './79_to_80'

import { SETTINGS_SCHEMA_VERSION, SETTING_MIGRATIONS } from './index'

const firstAssistant = (
  result: Record<string, unknown>,
): Record<string, unknown> =>
  (result.assistants as Array<Record<string, unknown>>)[0]

describe('migrateFrom79To80', () => {
  it('is registered in the migration chain ahead of the current schema version', () => {
    const step = SETTING_MIGRATIONS.find(
      (migration) => migration.fromVersion === 79,
    )
    expect(step?.toVersion).toBe(80)
    expect(step?.migrate).toBe(migrateFrom79To80)
    expect(SETTINGS_SCHEMA_VERSION).toBe(82)
    expect(
      SETTING_MIGRATIONS.some((migration) => migration.toVersion > 82),
    ).toBe(false)
  })

  it('advances the schema version without changing unrelated fields', () => {
    expect(migrateFrom79To80({ version: 79, chatModelId: 'chat-1' })).toEqual(
      expect.objectContaining({
        version: 80,
        chatModelId: 'chat-1',
      }),
    )
  })

  it('defaults the upstream update notice without overwriting an explicit choice', () => {
    expect(migrateFrom79To80({ version: 79 }).pluginUpdateNoticeEnabled).toBe(
      true,
    )
    expect(
      migrateFrom79To80({
        version: 79,
        pluginUpdateNoticeEnabled: false,
      }).pluginUpdateNoticeEnabled,
    ).toBe(false)
  })

  it('no longer normalizes the removed conversation-history search setting', () => {
    const migrated = migrateFrom79To80({
      version: 79,
      conversationHistorySearch: {
        enabled: true,
        defaultMode: 'keyword',
      },
    })
    expect(migrated.version).toBe(80)
    expect(migrated.conversationHistorySearch).toEqual({
      enabled: true,
      defaultMode: 'keyword',
    })
  })

  it('seeds missing media registries and selected IDs with empty values', () => {
    expect(migrateFrom79To80({ version: 79 })).toEqual(
      expect.objectContaining({
        version: 80,
        ttsModels: [],
        sttModels: [],
        imageModels: [],
        ttsModelId: '',
        sttModelId: '',
        imageModelId: '',
      }),
    )
  })

  it('preserves existing media fields and replaces malformed ones safely', () => {
    const data = {
      version: 79,
      ttsModels: [{ providerId: 'p1', id: 'tts-1', model: 'voice-1' }],
      imageModelId: 'image-1',
      unrelated: { preserve: true },
    }
    expect(migrateFrom79To80(data)).toEqual(
      expect.objectContaining({
        version: 80,
        ttsModels: data.ttsModels,
        imageModelId: 'image-1',
        unrelated: { preserve: true },
        sttModels: [],
        ttsModelId: '',
        sttModelId: '',
        imageModels: [],
      }),
    )
    expect(
      migrateFrom79To80({
        version: 79,
        ttsModels: 'invalid',
        sttModels: null,
        ttsModelId: 1,
        imageModelId: false,
      }),
    ).toEqual(
      expect.objectContaining({
        version: 80,
        ttsModels: [],
        sttModels: [],
        ttsModelId: '',
        sttModelId: '',
        imageModelId: '',
      }),
    )
  })

  it('seeds memory index and reflection flags while preserving boolean values', () => {
    expect(
      migrateFrom79To80({
        version: 79,
        advancedMemoryIndexEnabled: true,
      }),
    ).toEqual(
      expect.objectContaining({
        version: 80,
        advancedMemoryIndexEnabled: true,
        memoryReflectionEnabled: false,
      }),
    )
    expect(
      migrateFrom79To80({
        version: 79,
        advancedMemoryIndexEnabled: 'true',
        memoryReflectionEnabled: null,
      }),
    ).toEqual(
      expect.objectContaining({
        version: 80,
        advancedMemoryIndexEnabled: false,
        memoryReflectionEnabled: false,
      }),
    )
  })

  it('migrates FQN legacy tool preferences into per-action consolidated entries', () => {
    const result = migrateFrom79To80({
      version: 79,
      assistants: [
        {
          id: 'a1',
          toolPreferences: {
            yolo_local__fs_delete: {
              enabled: true,
              approvalMode: 'require_approval',
              disclosureMode: 'always',
            },
            yolo_local__memory_add: {
              enabled: true,
              approvalMode: 'full_access',
            },
            yolo_local__context_compact: {
              enabled: true,
              approvalMode: 'require_approval',
            },
          },
          enabledToolNames: [
            'yolo_local__fs_delete',
            'yolo_local__memory_add',
            'yolo_local__context_compact',
          ],
        },
      ],
    })
    const assistant = firstAssistant(result)
    const preferences = assistant.toolPreferences as Record<string, unknown>
    expect(preferences.yolo_local__fs_file_ops).toEqual(
      expect.objectContaining({
        enabled: true,
        actions: expect.objectContaining({
          delete: expect.objectContaining({
            enabled: true,
            approvalMode: 'require_approval',
          }),
        }),
      }),
    )
    expect(preferences.yolo_local__memory_ops).toEqual(
      expect.objectContaining({
        enabled: true,
        actions: expect.objectContaining({
          add: expect.objectContaining({
            enabled: true,
            approvalMode: 'full_access',
          }),
        }),
      }),
    )
    expect(assistant.enabledToolNames).toEqual([
      'yolo_local__fs_file_ops',
      'yolo_local__memory_ops',
      'yolo_local__context_manage',
    ])
  })

  it('preserves every historical split-tool action when consolidating preferences', () => {
    const legacyToolNames = [
      'context_compact',
      'context_prune_tool_results',
      'fs_delete',
      'fs_create_dir',
      'fs_move',
      'memory_add',
      'memory_update',
      'memory_delete',
      'scheduled_task_create',
      'scheduled_task_update',
      'scheduled_task_delete',
      'scheduled_task_list',
      'scheduled_task_get',
      'scheduled_task_run_now',
    ]
    const result = migrateFrom79To80({
      version: 79,
      assistants: [
        {
          id: 'a1',
          toolPreferences: Object.fromEntries(
            legacyToolNames.map((name) => [
              `yolo_local__${name}`,
              { enabled: true },
            ]),
          ),
        },
      ],
    })
    const preferences = firstAssistant(result).toolPreferences as Record<
      string,
      { actions?: Record<string, unknown> }
    >

    expect(
      Object.keys(preferences.yolo_local__context_manage.actions ?? {}),
    ).toEqual(['compact', 'prune'])
    expect(
      Object.keys(preferences.yolo_local__fs_file_ops.actions ?? {}),
    ).toEqual(['delete', 'create_dir', 'move'])
    expect(
      Object.keys(preferences.yolo_local__memory_ops.actions ?? {}),
    ).toEqual(['add', 'update', 'delete'])
    expect(
      Object.keys(preferences.yolo_local__scheduled_task_ops.actions ?? {}),
    ).toEqual(['create', 'update', 'delete', 'list', 'get', 'run_now'])
  })

  it('remaps legacy builtinToolOptions into actionOptions', () => {
    const result = migrateFrom79To80({
      version: 79,
      mcp: {
        builtinToolOptions: {
          yolo_local__memory_add: { disabled: true },
        },
      },
    })
    const options = (result.mcp as Record<string, unknown>)
      .builtinToolOptions as Record<string, unknown>
    expect(options.memory_ops).toEqual(
      expect.objectContaining({
        actionOptions: expect.objectContaining({
          add: expect.objectContaining({ disabled: true }),
        }),
      }),
    )
  })

  it('leaves unknown tool names and non-tool settings untouched', () => {
    const result = migrateFrom79To80({
      version: 79,
      assistants: [
        {
          id: 'a1',
          toolPreferences: { custom_tool: { enabled: true } },
          enabledToolNames: ['custom_tool'],
        },
      ],
    })
    expect(firstAssistant(result).toolPreferences).toEqual({
      custom_tool: { enabled: true },
    })
    expect(firstAssistant(result).enabledToolNames).toEqual(['custom_tool'])
  })
})
