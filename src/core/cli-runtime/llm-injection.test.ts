import type { ChatModel } from '../../types/chat-model.types'

import {
  buildLlmEnvForRuntime,
  buildCodexSessionOverrides,
  DEFAULT_CLAUDE_MODEL,
  resolveCliSessionInjection,
  resolveLlmInjection,
} from './llm-injection'

function makeSettings() {
  return {
    providers: [
      {
        id: 'provider-1',
        name: 'Provider One',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'sk-test-key',
      },
    ],
    chatModels: [
      {
        id: 'model-1',
        providerId: 'provider-1',
        model: 'claude-sonnet-4-20250514',
      },
    ] as ChatModel[],
  }
}

describe('resolveLlmInjection', () => {
  it('returns null when the switch is disabled', () => {
    expect(
      resolveLlmInjection({
        injection: { enabled: false, providerId: 'provider-1', modelId: 'model-1' },
        getSettings: () => makeSettings() as never,
      }),
    ).toBeNull()
  })

  it('resolves the selected provider and model', () => {
    const result = resolveLlmInjection({
      injection: { enabled: true, providerId: 'provider-1', modelId: 'model-1' },
      getSettings: () => makeSettings() as never,
    })
    expect(result?.provider.id).toBe('provider-1')
    expect(result?.model.id).toBe('model-1')
  })

  it('returns null for dangling provider or model references', () => {
    expect(
      resolveLlmInjection({
        injection: { enabled: true, providerId: 'missing', modelId: 'model-1' },
        getSettings: () => makeSettings() as never,
      }),
    ).toBeNull()
    expect(
      resolveLlmInjection({
        injection: { enabled: true, providerId: 'provider-1', modelId: 'missing' },
        getSettings: () => makeSettings() as never,
      }),
    ).toBeNull()
  })
})

describe('buildLlmEnvForRuntime', () => {
  const injection = resolveLlmInjection({
    injection: { enabled: true, providerId: 'provider-1', modelId: 'model-1' },
    getSettings: () => makeSettings() as never,
  })!

  it('builds Anthropic env for claude-code', () => {
    expect(buildLlmEnvForRuntime('claude-code', injection)).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.example.com/v1',
      ANTHROPIC_AUTH_TOKEN: 'sk-test-key',
      ANTHROPIC_MODEL: 'claude-sonnet-4-20250514',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-sonnet-4-20250514',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-4-20250514',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'claude-sonnet-4-20250514',
    })
  })

  it('builds the same Anthropic env for hermes and pi', () => {
    expect(buildLlmEnvForRuntime('hermes', injection)).toEqual(
      buildLlmEnvForRuntime('claude-code', injection),
    )
    expect(buildLlmEnvForRuntime('pi', injection)).toEqual(
      buildLlmEnvForRuntime('claude-code', injection),
    )
  })

  it('builds codex auth env only (baseUrl/model go through config.toml)', () => {
    expect(buildLlmEnvForRuntime('codex', injection)).toEqual({
      CODEX_API_KEY: 'sk-test-key',
      OPENAI_API_KEY: 'sk-test-key',
    })
  })

  it('builds a session-scoped OpenCode provider config', () => {
    const env = buildLlmEnvForRuntime('opencode', injection)

    expect(Object.keys(env)).toEqual(['OPENCODE_CONFIG_CONTENT'])
    expect(JSON.parse(env.OPENCODE_CONFIG_CONTENT)).toEqual({
      model: 'yolo/claude-sonnet-4-20250514',
      provider: {
        yolo: {
          npm: '@ai-sdk/openai-compatible',
          name: 'Provider One',
          options: {
            baseURL: 'https://api.example.com/v1',
            apiKey: 'sk-test-key',
          },
          models: {
            'claude-sonnet-4-20250514': {
              name: 'claude-sonnet-4-20250514',
            },
          },
        },
      },
    })
  })

  it('falls back to the cc-switch default model when the model name is empty', () => {
    const emptyModel = resolveLlmInjection({
      injection: { enabled: true, providerId: 'provider-1', modelId: 'model-1' },
      getSettings: () =>
        ({
          providers: [{ id: 'provider-1', baseUrl: 'https://x', apiKey: 'k' }],
          chatModels: [
            { id: 'model-1', providerId: 'provider-1', model: '  ' },
          ],
        }) as never,
    })!
    expect(buildLlmEnvForRuntime('claude-code', emptyModel).ANTHROPIC_MODEL).toBe(
      DEFAULT_CLAUDE_MODEL,
    )
  })
})

describe('resolveCliSessionInjection', () => {
  it('resolves the enabled provider and local MCP server from one settings snapshot', () => {
    const settings = {
      ...makeSettings(),
      cliLlmInjection: {
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      },
      cliMcpSharing: { enabled: true },
      mcp: { localServer: { port: 3210, token: 'local-token' } },
    }

    expect(resolveCliSessionInjection(() => settings as never, 'claude-code')).toEqual({
      llm: resolveLlmInjection({
        injection: settings.cliLlmInjection,
        getSettings: () => settings as never,
      }),
      llmEnv: buildLlmEnvForRuntime(
        'claude-code',
        resolveLlmInjection({
          injection: settings.cliLlmInjection,
          getSettings: () => settings as never,
        })!,
      ),
      mcp: { url: 'http://127.0.0.1:3210/mcp', token: 'local-token' },
    })
  })

  it('omits invalid or disabled session overlays', () => {
    const settings = {
      ...makeSettings(),
      cliLlmInjection: {
        enabled: true,
        providerId: 'missing',
        modelId: 'model-1',
      },
      cliMcpSharing: { enabled: false },
      mcp: { localServer: { port: 3210, token: 'local-token' } },
    }

    expect(resolveCliSessionInjection(() => settings as never, 'codex')).toEqual({
      llm: null,
      llmEnv: null,
      mcp: null,
    })
  })
})

describe('buildCodexSessionOverrides', () => {
  it('creates temporary provider and MCP overrides without a config file', () => {
    const injection = resolveCliSessionInjection(
      () => ({
        ...makeSettings(),
        cliLlmInjection: { enabled: true, providerId: 'provider-1', modelId: 'model-1' },
        cliMcpSharing: { enabled: true },
        mcp: { localServer: { port: 3210, token: 'local-token' } },
      }) as never,
      'codex',
    )

    expect(buildCodexSessionOverrides(injection)).toMatchObject({
      env: { CODEX_API_KEY: 'sk-test-key', YOLO_MCP_TOKEN: 'local-token' },
      launchArgs: expect.arrayContaining([
        'model_provider="yolo"',
        'mcp_servers.yolo.bearer_token_env_var="YOLO_MCP_TOKEN"',
      ]),
    })
  })
})
