/* eslint-disable import/no-nodejs-modules -- test uses a temporary config directory */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import {
  createLlmProviderSync,
  createMcpSharingSync,
} from './llm-provider-sync'

jest.mock('obsidian', () => ({
  Platform: { isDesktop: true },
}))

function makeProviderSettings() {
  return {
    providers: [
      {
        id: 'provider-1',
        name: 'Provider One',
        baseUrl: 'https://api.example.com/v1',
        apiKey: 'key-one',
      },
    ],
    chatModels: [
      {
        id: 'model-1',
        providerId: 'provider-1',
        model: 'model-one',
      },
    ],
  }
}

describe('createLlmProviderSync', () => {
  let configDir: string

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'yolo-llm-sync-'))
  })

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true })
  })

  it('rewrites config when selected provider settings change', async () => {
    const settings = makeProviderSettings()
    const storage = new Map<string, unknown>()
    const sync = createLlmProviderSync({
      app: {
        loadLocalStorage: (key) => storage.get(key),
        saveLocalStorage: (key, value) => storage.set(key, value),
      },
      getSettings: () => settings as never,
      injection: () => ({
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      }),
      configDirOverride: configDir,
    })

    expect(await sync.apply()).toBe(true)
    settings.providers[0].baseUrl = 'https://api.example.com/v2'
    settings.providers[0].apiKey = 'key-two'
    settings.chatModels[0].model = 'model-two'

    expect(await sync.apply()).toBe(true)

    const opencode = JSON.parse(
      await readFile(path.join(configDir, 'opencode.json'), 'utf8'),
    ) as {
      provider: {
        yolo: {
          options: { apiKey: string; baseURL: string }
          models: Record<string, { name: string }>
        }
      }
    }
    expect(opencode.provider.yolo.options).toEqual({
      apiKey: 'key-two',
      baseURL: 'https://api.example.com/v2',
    })
    expect(opencode.provider.yolo.models).toEqual({
      'model-two': { name: 'model-two' },
    })
    expect(storage.get('yolo-cli-llm-injection-last-applied')).not.toContain(
      'key-two',
    )
  })

  it('restores Codex config when the selected provider stops supporting Responses', async () => {
    const originalCodexConfig = 'model = "user-model"\n'
    await writeFile(path.join(configDir, 'config.toml'), originalCodexConfig)
    const settings = makeProviderSettings() as {
      providers: Array<Record<string, string>>
      chatModels: Array<Record<string, string>>
    }
    settings.providers[0].apiType = 'openai-responses'
    const storage = new Map<string, unknown>()
    const sync = createLlmProviderSync({
      app: {
        loadLocalStorage: (key) => storage.get(key),
        saveLocalStorage: (key, value) => storage.set(key, value),
      },
      getSettings: () => settings as never,
      injection: () => ({
        enabled: true,
        providerId: 'provider-1',
        modelId: 'model-1',
      }),
      configDirOverride: configDir,
    })

    await expect(sync.apply()).resolves.toBe(true)
    expect(
      await readFile(path.join(configDir, 'config.toml'), 'utf8'),
    ).toContain('model_provider = "yolo"')

    settings.providers[0].apiType = 'anthropic'

    await expect(sync.apply()).resolves.toBe(true)
    await expect(
      readFile(path.join(configDir, 'config.toml'), 'utf8'),
    ).resolves.toBe(originalCodexConfig)
    await expect(
      readFile(path.join(configDir, 'config.toml.yolo-backup'), 'utf8'),
    ).rejects.toThrow()
  })

  it('preserves MCP sharing when LLM injection is disabled', async () => {
    const settings = makeProviderSettings() as {
      providers: Array<Record<string, string>>
      chatModels: Array<Record<string, string>>
    }
    settings.providers[0].apiType = 'openai-responses'
    const llmStorage = new Map<string, unknown>()
    let injectionEnabled = true
    const llmSync = createLlmProviderSync({
      app: {
        loadLocalStorage: (key) => llmStorage.get(key),
        saveLocalStorage: (key, value) => llmStorage.set(key, value),
      },
      getSettings: () => settings as never,
      injection: () => ({
        enabled: injectionEnabled,
        providerId: 'provider-1',
        modelId: 'model-1',
      }),
      configDirOverride: configDir,
    })
    await expect(llmSync.apply()).resolves.toBe(true)

    const mcpStorage = new Map<string, unknown>()
    const mcpSync = createMcpSharingSync({
      app: {
        loadLocalStorage: (key) => mcpStorage.get(key),
        saveLocalStorage: (key, value) => mcpStorage.set(key, value),
      },
      enabled: () => true,
      getServer: () => ({
        enabled: true,
        url: 'http://127.0.0.1:3210/mcp',
        token: 'token-one',
      }),
      configDirOverride: configDir,
    })
    await expect(mcpSync.apply()).resolves.toBe(true)

    injectionEnabled = false
    await expect(llmSync.apply()).resolves.toBe(true)

    const opencode = JSON.parse(
      await readFile(path.join(configDir, 'opencode.json'), 'utf8'),
    ) as {
      provider?: { yolo?: unknown }
      mcp?: { yolo?: { url: string } }
    }
    expect(opencode.provider?.yolo).toBeUndefined()
    expect(opencode.mcp?.yolo).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:3210/mcp',
      enabled: true,
      headers: { Authorization: 'Bearer token-one' },
    })
    await expect(
      readFile(path.join(configDir, 'opencode.json.yolo-backup'), 'utf8'),
    ).rejects.toThrow()
  })

  it('does not remove a user provider when injection was never applied', async () => {
    const userConfig = {
      provider: {
        yolo: {
          npm: '@user/provider',
          options: { apiKey: 'user-key' },
        },
      },
    }
    await writeFile(
      path.join(configDir, 'opencode.json'),
      `${JSON.stringify(userConfig)}\n`,
    )
    const storage = new Map<string, unknown>()
    const sync = createLlmProviderSync({
      app: {
        loadLocalStorage: (key) => storage.get(key),
        saveLocalStorage: (key, value) => storage.set(key, value),
      },
      getSettings: () => makeProviderSettings() as never,
      injection: () => ({ enabled: false }),
      configDirOverride: configDir,
    })

    await expect(sync.apply()).resolves.toBe(false)
    await expect(
      readFile(path.join(configDir, 'opencode.json'), 'utf8'),
    ).resolves.toBe(`${JSON.stringify(userConfig)}\n`)
  })
})

describe('createMcpSharingSync', () => {
  let configDir: string

  beforeEach(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), 'yolo-mcp-sharing-'))
  })

  afterEach(async () => {
    await rm(configDir, { recursive: true, force: true })
  })

  it('rewrites CLI config when the server token changes', async () => {
    const server = {
      enabled: true,
      url: 'http://127.0.0.1:3210/mcp',
      token: 'token-one',
    }
    const storage = new Map<string, unknown>()
    const sync = createMcpSharingSync({
      app: {
        loadLocalStorage: (key) => storage.get(key),
        saveLocalStorage: (key, value) => storage.set(key, value),
      },
      enabled: () => true,
      getServer: () => server,
      configDirOverride: configDir,
    })

    expect(await sync.apply()).toBe(true)
    server.token = 'token-two'

    expect(await sync.apply()).toBe(true)
    const claude = JSON.parse(
      await readFile(path.join(configDir, 'claude.json'), 'utf8'),
    ) as { mcpServers: { yolo: { headers: { Authorization: string } } } }
    const opencode = JSON.parse(
      await readFile(path.join(configDir, 'opencode.json'), 'utf8'),
    ) as { mcp: { yolo: { headers: { Authorization: string } } } }

    expect(claude.mcpServers.yolo.headers.Authorization).toBe(
      'Bearer token-two',
    )
    expect(opencode.mcp.yolo.headers.Authorization).toBe('Bearer token-two')
  })

  it('keeps the signature retryable when one target write fails', async () => {
    const server = {
      enabled: true,
      url: 'http://127.0.0.1:3210/mcp',
      token: 'token-one',
    }
    const storage = new Map<string, unknown>()
    const sync = createMcpSharingSync({
      app: {
        loadLocalStorage: (key) => storage.get(key),
        saveLocalStorage: (key, value) => storage.set(key, value),
      },
      enabled: () => true,
      getServer: () => server,
      configDirOverride: configDir,
    })
    await mkdir(path.join(configDir, 'opencode.json'))

    await expect(sync.apply()).rejects.toThrow()
    expect(storage.get('yolo-cli-mcp-sharing-last-applied')).toBeUndefined()

    await rm(path.join(configDir, 'opencode.json'), {
      recursive: true,
      force: true,
    })
    expect(await sync.apply()).toBe(true)
    expect(storage.get('yolo-cli-mcp-sharing-last-applied')).toEqual(
      expect.stringMatching(
        /^on:http:\/\/127\.0\.0\.1:3210\/mcp:[0-9a-f]{64}$/,
      ),
    )
  })
})
