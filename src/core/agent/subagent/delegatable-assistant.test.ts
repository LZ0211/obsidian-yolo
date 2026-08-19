import type { YoloSettings } from '../../../settings/schema/setting.types'
import { parseYoloSettings } from '../../../settings/schema/settings'
import type { Assistant } from '../../../types/assistant.types'

import {
  BUILTIN_SUBAGENT_ASSISTANTS,
  IMAGE_READER_SUBAGENT_ID,
  listDelegatableAssistantRoles,
  resolveDelegatableAssistant,
} from './delegatable-assistant'

const PRIVATE_SENTINELS = {
  description: 'PRIVATE_DESCRIPTION_SENTINEL',
  systemPrompt: 'PRIVATE_SYSTEM_PROMPT_SENTINEL',
  modelId: 'PRIVATE_MODEL_ID_SENTINEL',
  toolName: 'PRIVATE_TOOL_PREFERENCE_SENTINEL',
  skillName: 'PRIVATE_SKILL_PREFERENCE_SENTINEL',
}

const assistants: Assistant[] = [
  {
    id: 'research-role',
    name: 'Research Role',
    description: 'Private research description',
    systemPrompt: 'PRIVATE_RESEARCH_PROMPT',
    modelId: 'private-research-model',
    enableTools: true,
    enabledToolNames: ['private_research_tool'],
    enabledSkills: ['private-research-skill'],
    delegatable: true,
  },
  {
    id: 'private-role',
    name: 'Private Role',
    description: PRIVATE_SENTINELS.description,
    systemPrompt: PRIVATE_SENTINELS.systemPrompt,
    modelId: PRIVATE_SENTINELS.modelId,
    enabledToolNames: [PRIVATE_SENTINELS.toolName],
    toolPreferences: {
      [PRIVATE_SENTINELS.toolName]: {
        enabled: true,
        approvalMode: 'full_access',
        disclosureMode: 'always',
      },
    },
    enabledSkills: [PRIVATE_SENTINELS.skillName],
    skillPreferences: {
      [PRIVATE_SENTINELS.skillName]: {
        enabled: true,
        loadMode: 'always',
      },
    },
  },
  {
    id: 'writer-role',
    name: 'Writer Role',
    systemPrompt: 'PRIVATE_WRITER_PROMPT',
    delegatable: true,
  },
  {
    id: 'explicit-private-role',
    name: 'Explicit Private Role',
    description: PRIVATE_SENTINELS.description,
    systemPrompt: PRIVATE_SENTINELS.systemPrompt,
    modelId: PRIVATE_SENTINELS.modelId,
    enabledToolNames: [PRIVATE_SENTINELS.toolName],
    toolPreferences: {
      [PRIVATE_SENTINELS.toolName]: { enabled: true },
    },
    enabledSkills: [PRIVATE_SENTINELS.skillName],
    skillPreferences: {
      [PRIVATE_SENTINELS.skillName]: { enabled: true },
    },
    delegatable: false,
  },
]

function makeSettings(): YoloSettings {
  return {
    ...parseYoloSettings({}),
    assistants,
    currentAssistantId: 'research-role',
    workspaceAgents: [
      {
        id: 'workspace-research',
        name: 'Workspace Research',
        templateId: 'research-role',
        behaviorOverrides: {
          systemPromptOverride: 'PRIVATE_WORKSPACE_PROMPT',
        },
        workspacePolicy: {
          workspaceRoot: '/Private',
          readAllowlist: [],
          readDenylist: ['Secrets'],
          writeDenylist: [],
        },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  }
}

function getThrownMessage(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }

  throw new Error('Expected action to throw')
}

describe('delegatable assistant roles', () => {
  it('lists only opted-in template ids and names in settings order', () => {
    expect(listDelegatableAssistantRoles(makeSettings())).toEqual([
      { id: 'research-role', name: 'Research Role' },
      { id: 'writer-role', name: 'Writer Role' },
      ...BUILTIN_SUBAGENT_ASSISTANTS.map(({ id, name }) => ({ id, name })),
    ])
  })

  it('trims an exact opted-in id and returns the actual template', () => {
    const settings = makeSettings()

    expect(resolveDelegatableAssistant(settings, '  research-role  ')).toBe(
      settings.assistants[0],
    )
  })

  it('uses the first template as canonical when assistant ids are duplicated', () => {
    const canonicalPrivate: Assistant = {
      id: 'duplicate-private',
      name: 'Canonical Private',
      systemPrompt: '',
    }
    const canonicalPublic: Assistant = {
      id: 'duplicate-public',
      name: 'Canonical Public',
      systemPrompt: '',
      delegatable: true,
    }
    const settings = makeSettings()
    settings.assistants = [
      canonicalPrivate,
      {
        id: 'duplicate-private',
        name: 'Later Public',
        systemPrompt: '',
        delegatable: true,
      },
      canonicalPublic,
      {
        id: 'duplicate-public',
        name: 'Later Duplicate',
        systemPrompt: '',
        delegatable: true,
      },
    ]

    expect(listDelegatableAssistantRoles(settings)).toEqual([
      { id: 'duplicate-public', name: 'Canonical Public' },
      ...BUILTIN_SUBAGENT_ASSISTANTS.map(({ id, name }) => ({ id, name })),
    ])
    expect(resolveDelegatableAssistant(settings, 'duplicate-public')).toBe(
      canonicalPublic,
    )
    expect(
      getThrownMessage(() =>
        resolveDelegatableAssistant(settings, 'duplicate-private'),
      ),
    ).toBe(
      'Assistant role "duplicate-private" is not available for delegation.',
    )
  })

  it.each(['private-role', 'explicit-private-role'])(
    'rejects non-delegatable template %s without exposing its configuration',
    (assistantId) => {
      const message = getThrownMessage(() =>
        resolveDelegatableAssistant(makeSettings(), assistantId),
      )

      expect(message).toBe(
        `Assistant role "${assistantId}" is not available for delegation.`,
      )
      for (const sentinel of Object.values(PRIVATE_SENTINELS)) {
        expect(message).not.toContain(sentinel)
      }
    },
  )

  it('rejects a Workspace Agent id that references a delegatable template', () => {
    expect(
      getThrownMessage(() =>
        resolveDelegatableAssistant(makeSettings(), 'workspace-research'),
      ),
    ).toBe('Assistant role "workspace-research" does not exist.')
  })

  it.each([
    ['role name', 'Research Role'],
    ['case variant', 'RESEARCH-ROLE'],
    ['partial id', 'research'],
  ])('rejects a %s as a non-existent role', (_variant, assistantId) => {
    expect(
      getThrownMessage(() =>
        resolveDelegatableAssistant(makeSettings(), assistantId),
      ),
    ).toBe(`Assistant role "${assistantId}" does not exist.`)
  })

  it('rejects a missing id without using the active or first assistant fallback', () => {
    const settings = makeSettings()

    expect(
      getThrownMessage(() =>
        resolveDelegatableAssistant(settings, 'missing-role'),
      ),
    ).toBe('Assistant role "missing-role" does not exist.')
  })

  it('resolves built-in subagent roles without persisting them into settings', () => {
    const settings = makeSettings()

    for (const builtIn of BUILTIN_SUBAGENT_ASSISTANTS) {
      expect(resolveDelegatableAssistant(settings, builtIn.id)).toBe(builtIn)
    }
    expect(settings.assistants).not.toEqual(
      expect.arrayContaining(BUILTIN_SUBAGENT_ASSISTANTS),
    )
  })

  it('keeps built-in role catalogue compact', () => {
    const catalogueText = JSON.stringify(
      listDelegatableAssistantRoles(makeSettings()),
    )

    for (const builtIn of BUILTIN_SUBAGENT_ASSISTANTS) {
      expect(catalogueText).toContain(builtIn.id)
      expect(catalogueText).toContain(builtIn.name)
      expect(catalogueText).not.toContain(builtIn.systemPrompt)
      expect(catalogueText).not.toContain(builtIn.modelId ?? 'unused-model-id')
      expect(catalogueText).not.toContain(
        JSON.stringify(builtIn.toolPreferences ?? {}),
      )
    }
  })
})

describe('built-in image reader subagent', () => {
  const withVisionModels = (): YoloSettings => {
    const settings = makeSettings()
    settings.chatModels = [
      {
        id: 'qwen-vl',
        providerId: 'p',
        model: 'qwen-vl',
        enable: true,
        modalities: ['text', 'vision'],
      },
      {
        id: 'gemini',
        providerId: 'p',
        model: 'gemini',
        enable: true,
        modalities: ['text', 'vision', 'pdf'],
      },
    ]
    return settings
  }

  it('injects the Image Reader role at the end of the catalogue when a vision engine is available', () => {
    const roles = listDelegatableAssistantRoles(withVisionModels())

    expect(roles.at(-1)).toEqual({
      id: IMAGE_READER_SUBAGENT_ID,
      name: 'Image Reader',
    })
  })

  it('omits the Image Reader role when no vision engine is available', () => {
    const roles = listDelegatableAssistantRoles(makeSettings())

    expect(roles.map((role) => role.id)).not.toContain(IMAGE_READER_SUBAGENT_ID)
  })

  it('resolves the Image Reader role with the first explicit vision engine as its model', () => {
    const settings = withVisionModels()
    settings.chatOptions = {
      ...settings.chatOptions,
      imageReadingFallbackModelIds: ['gemini', 'qwen-vl'],
    }

    const assistant = resolveDelegatableAssistant(
      settings,
      IMAGE_READER_SUBAGENT_ID,
    )

    expect(assistant.modelId).toBe('gemini')
  })

  it('auto-discovers the first vision engine model when no explicit list is configured', () => {
    const assistant = resolveDelegatableAssistant(
      withVisionModels(),
      IMAGE_READER_SUBAGENT_ID,
    )

    expect(assistant.modelId).toBe('qwen-vl')
  })

  it('throws when resolving the Image Reader role without any vision engine', () => {
    expect(
      getThrownMessage(() =>
        resolveDelegatableAssistant(makeSettings(), IMAGE_READER_SUBAGENT_ID),
      ),
    ).toMatch(/Image Reader.*vision engine/)
  })
})
