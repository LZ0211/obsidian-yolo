import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'
import type { LiteSkillEntry } from '../skills/liteSkills'

import { resolveCliAssistantBinding } from './assistant-binding'

const app = {} as App

const assistant = (overrides: Partial<Assistant> = {}): Assistant =>
  ({
    id: 'assistant-1',
    name: 'Test Assistant',
    systemPrompt: 'You are a test assistant.',
    ...overrides,
  }) as Assistant

const settings = (overrides: Partial<YoloSettings> = {}): YoloSettings =>
  ({
    assistants: [assistant()],
    skills: { disabledSkillIds: [] },
    ...overrides,
  }) as YoloSettings

const skill = (overrides: Partial<LiteSkillEntry> = {}): LiteSkillEntry => ({
  name: 'skill-a',
  description: 'Skill A',
  mode: 'lazy',
  path: 'vault/skill-a',
  isReadOnly: false,
  ...overrides,
})

const listSkillEntries = async (): Promise<LiteSkillEntry[]> => [
  skill(),
  skill({ name: 'skill-b', mode: 'always' }),
  skill({ name: 'disabled-skill' }),
]

describe('resolveCliAssistantBinding', () => {
  it('resolves the template assistant persona and enabled skills', async () => {
    const binding = await resolveCliAssistantBinding({
      app,
      settings: settings({ skills: { disabledSkillIds: ['disabled-skill'] } }),
      assistantId: 'assistant-1',
      listSkillEntries,
    })
    expect(binding).toEqual({
      assistantId: 'assistant-1',
      systemPrompt: 'You are a test assistant.',
      enabledSkillNames: ['skill-a', 'skill-b'],
    })
  })

  it('resolves workspace agents through the unified agent list', async () => {
    const workspaceAgent = {
      id: 'workspace-agent-1',
      name: 'Workspace Agent',
      createdAt: 0,
      updatedAt: 0,
      templateId: 'assistant-1',
      workspacePolicy: {
        workspaceRoot: 'vault/workspace-1',
        readAllowlist: [],
        readDenylist: [],
        writeDenylist: [],
      },
      behaviorOverrides: { systemPromptOverride: 'Workspace persona.' },
    } as YoloSettings['workspaceAgents'][number]
    const binding = await resolveCliAssistantBinding({
      app,
      settings: settings({
        workspaceAgents: [workspaceAgent],
      }),
      assistantId: 'workspace-agent-1',
      listSkillEntries,
    })
    expect(binding.assistantId).toBe('workspace-agent-1')
    expect(binding.systemPrompt).toBe('Workspace persona.')
  })

  it('throws fail-fast when the assistant does not exist', async () => {
    await expect(
      resolveCliAssistantBinding({
        app,
        settings: settings(),
        assistantId: 'missing-assistant',
        listSkillEntries,
      }),
    ).rejects.toThrow('Assistant is unavailable: missing-assistant')
  })

  it('excludes globally disabled skills even when enabled per-assistant', async () => {
    const binding = await resolveCliAssistantBinding({
      app,
      settings: settings({ skills: { disabledSkillIds: ['disabled-skill'] } }),
      assistantId: 'assistant-1',
      listSkillEntries,
    })
    expect(binding.enabledSkillNames).toEqual(['skill-a', 'skill-b'])
  })
})
