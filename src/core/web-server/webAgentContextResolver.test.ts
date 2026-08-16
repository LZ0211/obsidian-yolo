/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import { createHash } from 'node:crypto'

import { SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT } from '../../core/agent/subagent/constants'
import { SUBAGENT_RESULT_MAX_CHARS } from '../../core/agent/subagent/result-limit'
import { SETTINGS_SCHEMA_VERSION } from '../../settings/schema/migrations'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'

import {
  createWebAgentContextResolver,
  resolveEffectiveAgent,
} from './webAgentContextResolver'
import type { WebSession } from './webAgentTypes'

const hashRoot = (workspaceRoot: string, vaultIdentity: string) =>
  createHash('sha256')
    .update(`${vaultIdentity}:${workspaceRoot}`)
    .digest('base64url')

const template: Assistant = {
  id: 'template-1',
  name: 'Template',
  systemPrompt: 'template prompt',
  enableTools: true,
  includeBuiltinTools: false,
  enabledToolNames: ['read_file'],
  toolPreferences: {
    read_file: {
      enabled: true,
      approvalMode: 'full_access',
      disclosureMode: 'always',
    },
  },
  enabledSkills: ['search'],
  skillPreferences: {
    search: {
      enabled: true,
      loadMode: 'always',
    },
  },
}

const makeAgent = (
  overrides: Partial<YoloSettings['workspaceAgents'][number]> = {},
): YoloSettings['workspaceAgents'][number] => ({
  id: 'agent-1',
  name: 'Agent',
  templateId: 'template-1',
  behaviorOverrides: {
    disabledToolNames: [],
    disabledSkillIds: [],
  },
  workspacePolicy: {
    workspaceRoot: '/',
    readAllowlist: [],
    readDenylist: [],
    writeDenylist: [],
  },
  shareTokens: [],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
})

const makeSettings = (overrides: Partial<YoloSettings> = {}): YoloSettings => {
  const parsed = {
    version: SETTINGS_SCHEMA_VERSION,
    providers: [],
    chatModels: [],
    embeddingModels: [],
    rerankModels: [],
    ttsModels: [],
    sttModels: [],
    imageModels: [],
    chatModelId: '',
    chatTitleModelId: '',
    advancedMemoryIndexEnabled: false,
    memoryReflectionEnabled: false,
    embeddingModelId: '',
    rerankModelId: '',
    ttsModelId: '',
    sttModelId: '',
    imageModelId: '',
    systemPrompt: '',
    timeContextEnabled: true,
    softDismissedUpdateVersion: '',
    mutedUpdateVersion: '',
    mutedModuleUpdateVersions: {},
    pluginUpdateAutoDownloadEnabled: true,
    ragOptions: {
      enabled: true,
      chunkSize: 1000,
      chunkOverlap: 50,
      minSimilarity: 0,
      limit: 10,
      rerankEnabled: true,
      embeddingConcurrency: 10,
      excludePatterns: [],
      excludeYoloBaseDir: true,
      includePatterns: [],
      indexPdf: true,
      autoUpdateEnabled: true,
      autoUpdateIntervalHours: 0,
      lastAutoUpdateAt: 0,
      diagnosticsEnabled: true,
      showRagLogRibbonIcon: true,
    },
    ragBackendSettings: {
      rebuildRequired: false,
    },
    webRuntime: {
      enabled: false,
      port: 18900,
      host: '127.0.0.1',
      token: '',
      maxConcurrentAgentRuns: 12,
    },
    mcp: {
      servers: [],
      builtinCapabilityOptions: {},
      enableToolDisclosure: false,
      localServer: { enabled: false, port: 27124, token: '' },
    },
    jsSandbox: {},
    webSearch: {
      providers: [],
      common: {
        resultSize: 10,
        searchTimeoutMs: 120000,
        scrapeTimeoutMs: 20000,
      },
    },
    skills: {
      disabledSkillIds: [],
    },
    yolo: {
      baseDir: 'YOLO',
    },
    debug: {
      captureRawRequestDebug: false,
    },
    mineru: {
      enabled: false,
      baseUrl: '',
      apiKey: '',
    },
    chatOptions: {
      includeCurrentFileContent: true,
      moa: { enabled: true, timeoutMs: 45_000, maxOutputTokens: 2_048 },
    },
    notificationOptions: {
      enabled: false,
      channel: 'sound',
      timing: 'when-unfocused',
      notifyOnApprovalRequired: true,
      notifyOnTaskCompleted: true,
    },
    continuationOptions: {
      enableTabCompletion: false,
      tabCompletionOptions: {
        multipleCandidatesEnabled: false,
        idleTriggerEnabled: false,
        autoTriggerDelayMs: 3000,
        autoTriggerCooldownMs: 15000,
        triggerDelayMs: 3000,
        minContextLength: 20,
        contextRange: 4000,
        maxSuggestionLength: 2000,
        maxRetries: 1,
        temperature: 0.5,
        requestTimeoutMs: 12000,
        reasoningLevel: 'off',
      },
      tabCompletionTriggers: [],
    },
    assistants: [template],
    currentAssistantId: undefined,
    quickAskAssistantId: undefined,
    workspaceAgents: [makeAgent()],
    currentWorkspaceAgentId: 'agent-1',
    bots: {
      enabled: false,
      whitelistEnabled: true,
      groupChatEnabled: false,
      adminUsers: [],
      platforms: [],
      sessionMappings: [],
    },
    subagentResultMaxChars: SUBAGENT_RESULT_MAX_CHARS,
    forkContextTurns: SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT,
    learningOptions: {
      modelId: '',
      betaNoticeAcknowledged: false,
    },
    scheduledTasks: {
      enabled: false,
      enableScriptExecution: false,
      allowedScriptDirectories: [],
    },
    pluginUpdateNoticeEnabled: true,
    ...overrides,
  } satisfies YoloSettings

  return parsed
}

const makeSession = (overrides: Partial<WebSession> = {}): WebSession => ({
  id: 'session-1',
  tokenRecordId: 'token-1',
  tokenScope: {
    kind: 'workspaceRoot',
    rootHash: hashRoot('/', 'vault-a'),
    issuedForAgentId: 'agent-1',
  },
  activeAgentId: 'agent-1',
  rootHash: hashRoot('/', 'vault-a'),
  createdAt: 1,
  lastUsedAt: 1,
  expiresAt: 2,
  ...overrides,
})

describe('resolveEffectiveAgent', () => {
  it('propagates narrowed built-in capabilities into the web runtime agent', () => {
    const result = resolveEffectiveAgent(
      makeAgent({
        behaviorOverrides: {
          disabledBuiltinCapabilityIds: ['file_editing'],
          builtinCapabilityConfigOverrides: {
            vault_shell: { approvalMode: 'require_approval' },
          },
        },
      }),
      {
        ...template,
        builtinCapabilityPreferences: {
          file_editing: { enabled: true, approvalMode: 'full_access' },
          vault_shell: { enabled: true, approvalMode: 'full_access' },
        },
      },
    )

    expect(result).toMatchObject({
      ok: true,
      agent: {
        builtinCapabilityPreferences: {
          file_editing: { enabled: false, approvalMode: 'full_access' },
          vault_shell: { enabled: true, approvalMode: 'require_approval' },
        },
      },
    })
  })

  it('keeps tools enabled when the template only enables built-in capabilities', () => {
    const result = resolveEffectiveAgent(makeAgent(), {
      ...template,
      includeBuiltinTools: true,
      enabledToolNames: [],
      toolPreferences: {},
      builtinCapabilityPreferences: {
        file_reading: { enabled: true, approvalMode: 'full_access' },
      },
    })

    expect(result).toMatchObject({
      ok: true,
      agent: {
        enableTools: true,
        enabledToolNames: [],
        toolPreferences: {},
      },
    })
  })

  it('clamps stale tool and skill overrides to the current template ceiling', () => {
    const result = resolveEffectiveAgent(
      makeAgent({
        behaviorOverrides: {
          disabledToolNames: [],
          disabledSkillIds: [],
          toolConfigOverrides: {
            read_file: {},
            write_file: {},
          },
          skillConfigOverrides: {
            search: {},
            browse: {},
          },
        },
      }),
      template,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.agent.enabledToolNames).toEqual(['read_file'])
    expect(result.agent.toolPreferences?.write_file?.enabled).toBe(false)
    expect(result.agent.enabledSkills).toEqual(['search'])
    expect(result.agent.skillPreferences?.browse?.enabled).toBe(false)
  })

  it('applies promptOverride as the effective system prompt fallback', () => {
    const result = resolveEffectiveAgent(
      makeAgent({
        behaviorOverrides: {
          disabledToolNames: [],
          disabledSkillIds: [],
          promptOverride: 'agent prompt override',
        },
      }),
      template,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.agent.systemPrompt).toBe('agent prompt override')
  })

  it('clamps tool overrides to the template ceiling while allowing safe narrowing', () => {
    const restrictedTemplate: Assistant = {
      ...template,
      toolPreferences: {
        read_file: {
          enabled: true,
          approvalMode: 'require_approval',
          disclosureMode: 'always',
        },
      },
    }
    const result = resolveEffectiveAgent(
      makeAgent({
        behaviorOverrides: {
          disabledToolNames: [],
          disabledSkillIds: [],
          toolConfigOverrides: {
            read_file: {
              approvalMode: 'full_access',
              disclosureMode: 'on_demand',
            },
          },
        },
      }),
      restrictedTemplate,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.agent.toolPreferences?.read_file).toEqual({
      enabled: true,
      approvalMode: 'require_approval',
      disclosureMode: 'on_demand',
    })
  })

  it('applies narrowing disclosure and skill load overrides when they stay within the template ceiling', () => {
    const result = resolveEffectiveAgent(
      makeAgent({
        behaviorOverrides: {
          disabledToolNames: [],
          disabledSkillIds: [],
          toolConfigOverrides: {
            read_file: {
              disclosureMode: 'on_demand',
            },
          },
          skillConfigOverrides: {
            search: {
              loadMode: 'lazy',
            },
          },
        },
      }),
      template,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.agent.toolPreferences?.read_file).toEqual({
      enabled: true,
      approvalMode: 'full_access',
      disclosureMode: 'on_demand',
    })
    expect(result.agent.skillPreferences?.search).toEqual({
      enabled: true,
      loadMode: 'lazy',
    })
  })

  it('ignores unknown tool and skill override keys that could widen behavior', () => {
    const result = resolveEffectiveAgent(
      makeAgent({
        behaviorOverrides: {
          disabledToolNames: [],
          disabledSkillIds: [],
          toolConfigOverrides: {
            unsafe_tool: {
              approvalMode: 'full_access',
              disclosureMode: 'on_demand',
            },
          },
          skillConfigOverrides: {
            unsafe_skill: {
              loadMode: 'always',
            },
          },
        },
      }),
      template,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.agent.toolPreferences?.unsafe_tool?.enabled).toBe(false)
    expect(
      result.agent.toolPreferences?.unsafe_tool?.approvalMode,
    ).toBeUndefined()
    expect(result.agent.skillPreferences?.unsafe_skill?.enabled).toBe(false)
    expect(
      result.agent.skillPreferences?.unsafe_skill?.loadMode,
    ).toBeUndefined()
  })

  it('ignores skill config overrides without an explicit narrowing rule', () => {
    const result = resolveEffectiveAgent(
      makeAgent({
        behaviorOverrides: {
          disabledToolNames: [],
          disabledSkillIds: [],
          skillConfigOverrides: {
            search: {
              loadMode: 'always',
            },
          },
        },
      }),
      {
        ...template,
        skillPreferences: {
          search: {
            enabled: true,
            loadMode: 'lazy',
          },
        },
      },
    )

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.agent.skillPreferences?.search).toEqual({
      enabled: true,
      loadMode: 'lazy',
    })
  })

  it('restores template capabilities after template re-expands unless the Agent diff disabled them', () => {
    const narrowedTemplate: Assistant = {
      ...template,
      enabledToolNames: [],
      toolPreferences: {},
      enabledSkills: [],
      skillPreferences: {},
    }
    const agent = makeAgent({
      behaviorOverrides: {
        disabledToolNames: ['read_file'],
        disabledSkillIds: [],
      },
    })

    const narrowed = resolveEffectiveAgent(agent, narrowedTemplate)
    expect(narrowed.ok).toBe(true)
    if (!narrowed.ok) {
      return
    }
    expect(narrowed.agent.enabledToolNames).toEqual([])

    const restored = resolveEffectiveAgent(agent, template)
    expect(restored.ok).toBe(true)
    if (!restored.ok) {
      return
    }
    expect(restored.agent.enabledToolNames).toEqual([])
    expect(restored.agent.toolPreferences?.read_file?.enabled).toBe(false)
    expect(restored.agent.enabledSkills).toEqual(['search'])
  })

  it('computes agentModeAllowed from behaviorOverrides', () => {
    const withDefaults = resolveEffectiveAgent(
      makeAgent({
        behaviorOverrides: {
          disabledToolNames: [],
          disabledSkillIds: [],
        },
      }),
      template,
    )

    expect(withDefaults.ok).toBe(true)
    if (!withDefaults.ok) return
    expect(withDefaults.agent.agentModeAllowed).toBe(true)

    const restricted = resolveEffectiveAgent(
      makeAgent({
        behaviorOverrides: {
          disabledToolNames: [],
          disabledSkillIds: [],
          agentModeAllowed: false,
        },
      }),
      template,
    )

    expect(restricted.ok).toBe(true)
    if (!restricted.ok) return
    expect(restricted.agent.agentModeAllowed).toBe(false)
  })
})

describe('createWebAgentContextResolver', () => {
  it('resolves active session agent and template', () => {
    const settings = makeSettings()
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () => makeSession(),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }
    expect(result.context.activeAgent.id).toBe('agent-1')
    expect(result.context.template.id).toBe('template-1')
    expect(result.context.allowedAgents.map((agent) => agent.id)).toEqual([
      'agent-1',
    ])
  })

  it('rejects blank workspace roots instead of treating them as vault root', () => {
    const settings = makeSettings({
      workspaceAgents: [
        makeAgent({
          workspacePolicy: {
            workspaceRoot: '',
            readAllowlist: [],
            readDenylist: [],
            writeDenylist: [],
          },
        }),
      ],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () => makeSession(),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result).toEqual({
      ok: false,
      code: 'agent_unavailable',
      message: expect.stringContaining('workspace root'),
    })
  })

  it('rejects unknown active agent', () => {
    const resolver = createWebAgentContextResolver({
      getSettings: () =>
        makeSettings({
          workspaceAgents: [],
          currentWorkspaceAgentId: undefined,
        }),
      getSession: () => makeSession(),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result).toEqual({
      ok: false,
      code: 'agent_unavailable',
      message: expect.stringContaining('agent'),
    })
  })

  it('rejects disabled active agents and omits disabled same-root switch targets', () => {
    const settings = makeSettings({
      workspaceAgents: [
        makeAgent({
          disabled: true,
        }),
        makeAgent({
          id: 'agent-2',
          name: 'Agent Two',
        }),
      ],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () => makeSession(),
      vaultIdentity: 'vault-a',
    })

    const active = resolver.resolve({ sessionId: 'session-1' })
    expect(active).toEqual({
      ok: false,
      code: 'agent_unavailable',
      message: expect.stringContaining('disabled'),
    })

    const sameRoot = resolver.canSwitch(
      makeSession({
        activeAgentId: 'agent-2',
        tokenScope: {
          kind: 'workspaceRoot',
          rootHash: hashRoot('/', 'vault-a'),
          issuedForAgentId: 'agent-1',
        },
      }),
      'agent-2',
    )
    expect(sameRoot.ok).toBe(true)
    if (!sameRoot.ok) {
      return
    }
    expect(sameRoot.context.allowedAgents.map((agent) => agent.id)).toEqual([
      'agent-2',
    ])
  })

  it('rejects a tampered activeAgentId for an agent-scoped session', () => {
    const settings = makeSettings({
      workspaceAgents: [
        makeAgent(),
        makeAgent({
          id: 'agent-2',
          name: 'Agent Two',
        }),
      ],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () =>
        makeSession({
          activeAgentId: 'agent-2',
          tokenScope: {
            kind: 'agent',
            agentId: 'agent-1',
          },
        }),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result).toEqual({
      ok: false,
      code: 'forbidden',
      message: expect.stringContaining('scope'),
    })
  })

  it('rejects a tampered activeAgentId outside the workspace-root session scope', () => {
    const settings = makeSettings({
      workspaceAgents: [
        makeAgent(),
        makeAgent({
          id: 'agent-3',
          name: 'Other Root',
          workspacePolicy: {
            workspaceRoot: '/elsewhere',
            readAllowlist: [],
            readDenylist: [],
            writeDenylist: [],
          },
        }),
      ],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () =>
        makeSession({
          activeAgentId: 'agent-3',
        }),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result).toEqual({
      ok: false,
      code: 'forbidden',
      message: expect.stringContaining('scope'),
    })
  })

  it('allows workspaceRoot token to switch only to same root agents', () => {
    const settings = makeSettings({
      assistants: [
        template,
        {
          ...template,
          id: 'template-standalone',
          name: 'Standalone Template',
        },
      ],
      workspaceAgents: [
        makeAgent(),
        makeAgent({
          id: 'agent-2',
          name: 'Agent Two',
          workspacePolicy: {
            workspaceRoot: './',
            readAllowlist: [],
            readDenylist: [],
            writeDenylist: [],
          },
        }),
        makeAgent({
          id: 'agent-3',
          name: 'Other Root',
          workspacePolicy: {
            workspaceRoot: '/elsewhere',
            readAllowlist: [],
            readDenylist: [],
            writeDenylist: [],
          },
        }),
      ],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () => makeSession(),
      vaultIdentity: 'vault-a',
    })

    const sameRoot = resolver.canSwitch(makeSession(), 'agent-2')
    expect(sameRoot.ok).toBe(true)
    if (sameRoot.ok) {
      expect(sameRoot.context.activeAgent.id).toBe('agent-2')
      expect(sameRoot.context.allowedAgents.map((agent) => agent.id)).toEqual([
        'agent-1',
        'agent-2',
      ])
    }

    const otherRoot = resolver.canSwitch(makeSession(), 'agent-3')
    expect(otherRoot).toEqual({
      ok: false,
      code: 'forbidden',
      message: expect.stringContaining('root'),
    })
  })

  it('does not surface standalone assistant templates in allowedAgents for web sessions', () => {
    const settings = makeSettings({
      assistants: [
        template,
        {
          ...template,
          id: 'template-standalone',
          name: 'Standalone Template',
        },
      ],
      workspaceAgents: [makeAgent()],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () => makeSession(),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.context.allowedAgents).toEqual([
      {
        id: 'agent-1',
        name: 'Agent',
        agentModeAllowed: true,
      },
    ])
  })

  it('normalizes trailing slashes and backslashes when comparing same-root agents', () => {
    const settings = makeSettings({
      workspaceAgents: [
        makeAgent(),
        makeAgent({
          id: 'agent-2',
          name: 'Agent Two',
          workspacePolicy: {
            workspaceRoot: '\\folder\\child\\',
            readAllowlist: [],
            readDenylist: [],
            writeDenylist: [],
          },
        }),
      ],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () =>
        makeSession({
          activeAgentId: 'agent-2',
          rootHash: hashRoot('/folder/child', 'vault-a'),
          tokenScope: {
            kind: 'workspaceRoot',
            rootHash: hashRoot('/folder/child', 'vault-a'),
            issuedForAgentId: 'agent-2',
          },
        }),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.context.rootHash).toBe(hashRoot('/folder/child', 'vault-a'))
    expect(result.context.allowedAgents.map((agent) => agent.id)).toEqual([
      'agent-2',
    ])
  })

  it('marks same-root agents unavailable in summaries when their template or effective config is broken', () => {
    const settings = makeSettings({
      assistants: [
        template,
        {
          ...template,
          id: 'template-2',
        },
      ],
      workspaceAgents: [
        makeAgent(),
        makeAgent({
          id: 'agent-2',
          name: 'Missing Template',
          templateId: 'missing-template',
        }),
        makeAgent({
          id: 'agent-3',
          name: 'Restricted Modes',
          templateId: 'template-2',
          behaviorOverrides: {
            disabledToolNames: [],
            disabledSkillIds: [],
            agentModeAllowed: false,
          },
        }),
      ],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () => makeSession(),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      return
    }

    expect(result.context.allowedAgents).toEqual([
      {
        id: 'agent-1',
        name: 'Agent',
        agentModeAllowed: true,
      },
      {
        id: 'agent-3',
        name: 'Restricted Modes',
        agentModeAllowed: false,
      },
    ])
  })

  it('rejects a missing-template active agent while still surfacing it as unavailable in same-root summaries', () => {
    const settings = makeSettings({
      workspaceAgents: [
        makeAgent(),
        makeAgent({
          id: 'agent-2',
          name: 'Missing Template',
          templateId: 'missing-template',
        }),
      ],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () =>
        makeSession({
          activeAgentId: 'agent-2',
          rootHash: hashRoot('/', 'vault-a'),
          tokenScope: {
            kind: 'workspaceRoot',
            rootHash: hashRoot('/', 'vault-a'),
            issuedForAgentId: 'agent-2',
          },
        }),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result).toEqual({
      ok: false,
      code: 'agent_unavailable',
      message: expect.stringContaining('Template missing-template'),
    })

    const sameRoot = resolver.canSwitch(makeSession(), 'agent-1')
    expect(sameRoot.ok).toBe(true)
    if (!sameRoot.ok) {
      return
    }

    expect(sameRoot.context.allowedAgents).toEqual([
      {
        id: 'agent-1',
        name: 'Agent',
        agentModeAllowed: true,
      },
    ])
  })

  it('rejects agent scoped token switch to another agent', () => {
    const settings = makeSettings({
      workspaceAgents: [
        makeAgent(),
        makeAgent({
          id: 'agent-2',
          name: 'Agent Two',
        }),
      ],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () =>
        makeSession({
          rootHash: hashRoot('/', 'vault-a'),
          tokenScope: {
            kind: 'agent',
            agentId: 'agent-1',
          },
        }),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.canSwitch(
      makeSession({
        rootHash: hashRoot('/', 'vault-a'),
        tokenScope: {
          kind: 'agent',
          agentId: 'agent-1',
        },
      }),
      'agent-2',
    )

    expect(result).toEqual({
      ok: false,
      code: 'forbidden',
      message: expect.stringContaining('scope'),
    })
  })

  it('forbids switching to a template from a workspaceRoot-scoped session', () => {
    const settings = makeSettings({
      assistants: [
        template,
        {
          ...template,
          id: 'template-standalone',
          name: 'Standalone Template',
        },
      ],
      workspaceAgents: [makeAgent()],
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () => makeSession(),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.canSwitch(makeSession(), 'template-standalone')

    expect(result).toEqual({
      ok: false,
      code: 'forbidden',
      message: expect.stringContaining('workspace agents'),
    })
  })

  it('forbids a session whose active agent resolves only to a template', () => {
    const settings = makeSettings({
      workspaceAgents: [],
      currentWorkspaceAgentId: undefined,
    })
    const resolver = createWebAgentContextResolver({
      getSettings: () => settings,
      getSession: () =>
        makeSession({
          activeAgentId: 'template-1',
        }),
      vaultIdentity: 'vault-a',
    })

    const result = resolver.resolve({ sessionId: 'session-1' })

    expect(result).toEqual({
      ok: false,
      code: 'forbidden',
      message: expect.stringContaining('workspace agents'),
    })
  })
})
