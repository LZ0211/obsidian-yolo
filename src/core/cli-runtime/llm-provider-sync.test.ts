/* eslint-disable import/no-nodejs-modules -- test uses a temporary config directory */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { createMcpSharingSync } from './llm-provider-sync'

jest.mock('obsidian', () => ({
  Platform: { isDesktop: true },
}))

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
