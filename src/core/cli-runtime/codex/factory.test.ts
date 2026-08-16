import type { App } from 'obsidian'

import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'

import { createCodexRuntimeFactory } from './factory'
import { resolveCodexLaunch } from './launch'

jest.mock('../cli-path-override', () => ({
  getCliPathOverride: jest.fn(() => '/configured/codex'),
}))
jest.mock('../login-shell-env', () => ({
  loadLoginShellEnvironment: jest.fn(async () => ({ PATH: '/usr/bin' })),
}))

let launchCallCount = 0
jest.mock('./launch', () => ({
  resolveCodexLaunch: jest.fn(async () => {
    launchCallCount += 1
    return {
      command: `/bin/codex-${launchCallCount}`,
      runtimeCwd: `/resolved/cwd-${launchCallCount}`,
      spawnCwd: `/resolved/spawn-${launchCallCount}`,
      mapRuntimePathToHost: undefined,
    }
  }),
}))

type HostInstance = {
  options: unknown
  acquire: jest.Mock
  warm: jest.Mock
  dispose: jest.Mock
}
const hostInstances: HostInstance[] = []
const CodexAppServerHostMock = jest.fn(function (
  this: HostInstance,
  options: unknown,
) {
  this.options = options
  this.acquire = jest.fn(async () => ({}))
  this.warm = jest.fn(async () => undefined)
  this.dispose = jest.fn(async () => undefined)
  hostInstances.push(this)
})
jest.mock('./host', () => ({
  get CodexAppServerHost() {
    return CodexAppServerHostMock
  },
}))

const CodexCliRuntimeMock = jest.fn(function (
  this: { options: unknown; runtimeId: string },
  options: unknown,
) {
  this.options = options
  this.runtimeId = 'codex'
})
jest.mock('./runtime', () => ({
  get CodexCliRuntime() {
    return CodexCliRuntimeMock
  },
}))

const mockedGetCliPathOverride = jest.mocked(getCliPathOverride)
const mockedLoadLoginShellEnvironment = jest.mocked(loadLoginShellEnvironment)
const mockedResolveCodexLaunch = jest.mocked(resolveCodexLaunch)

const app = {} as App

describe('createCodexRuntimeFactory', () => {
  beforeEach(() => {
    launchCallCount = 0
    hostInstances.length = 0
    CodexAppServerHostMock.mockClear()
    CodexCliRuntimeMock.mockClear()
    mockedGetCliPathOverride.mockClear()
    mockedLoadLoginShellEnvironment.mockClear()
    mockedResolveCodexLaunch.mockClear()
  })

  it('auto-detects the launch command via the login-shell PATH when no options are supplied', async () => {
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
    })

    expect(mockedLoadLoginShellEnvironment).toHaveBeenCalledTimes(1)
    expect(mockedGetCliPathOverride).toHaveBeenCalledWith(app, 'codex')
    expect(mockedResolveCodexLaunch).toHaveBeenCalledWith(
      '/vault',
      { PATH: '/usr/bin' },
      process.platform,
      '/configured/codex',
    )
    const runtime = factory.create({ app, vaultPath: '/vault/current' })
    expect(CodexCliRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/bin/codex-1',
        // Resolved cwd wins over the create-time vault path.
        cwd: '/resolved/cwd-1',
        resolveHost: expect.any(Function),
      }),
    )
    expect(runtime).toBeDefined()
  })

  it('uses caller-supplied options verbatim, falling back to the create-time vault path for cwd', async () => {
    const getCodexRuntimeOptions = jest.fn(() => ({ command: '/bin/codex' }))
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
      getCodexRuntimeOptions,
    })

    expect(mockedResolveCodexLaunch).not.toHaveBeenCalled()
    factory.create({ app, vaultPath: '/vault/current' })
    expect(CodexCliRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        command: '/bin/codex',
        cwd: '/vault/current',
      }),
    )
  })

  it('keeps an explicit cwd from caller-supplied options over the create-time vault path', async () => {
    const getCodexRuntimeOptions = jest.fn(() => ({
      command: '/bin/codex',
      cwd: '/explicit/cwd',
    }))
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
      getCodexRuntimeOptions,
    })

    factory.create({ app, vaultPath: '/vault/current' })
    expect(CodexCliRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/explicit/cwd' }),
    )
  })

  it('resolves the conversation working directory below the configured cwd', async () => {
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
      getCodexRuntimeOptions: () => ({
        command: '/bin/codex',
        cwd: '/runtime/vault',
      }),
    })

    factory.create({
      app,
      vaultPath: '/vault/current',
      workingDirectory: '/Projects/foo',
    })

    expect(CodexCliRuntimeMock).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: '/runtime/vault/Projects/foo' }),
    )
  })

  it('does not expose shared warm or dispose hooks', async () => {
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
    })
    expect(factory.warm).toBeUndefined()
    expect(factory.dispose).toBeUndefined()
  })

  it('re-resolves the launch on every host respawn via resolveProcessOptions', async () => {
    const factory = await createCodexRuntimeFactory({ app, vaultPath: '/vault' })
    const runtime = factory.create({ app, vaultPath: '/vault' }) as { options: {
      resolveHost: () => Promise<unknown>
    } }
    await runtime.options.resolveHost()
    const resolveProcessOptions = (
      hostInstances[0]?.options as {
        resolveProcessOptions?: () => Promise<unknown>
      }
    ).resolveProcessOptions
    expect(resolveProcessOptions).toBeInstanceOf(Function)

    await expect(resolveProcessOptions?.()).resolves.toMatchObject({
      command: '/bin/codex-2',
      cwd: '/resolved/cwd-1',
    })
    expect(mockedResolveCodexLaunch).toHaveBeenCalledTimes(2)
  })

  it('has no resolveProcessOptions hook when the caller supplies its own options', async () => {
    const factory = await createCodexRuntimeFactory({
      app,
      vaultPath: '/vault',
      getCodexRuntimeOptions: () => ({ command: '/bin/codex' }),
    })

    const runtime = factory.create({ app, vaultPath: '/vault' }) as {
      options: { resolveHost: () => Promise<unknown> }
    }
    await runtime.options.resolveHost()
    expect(
      (hostInstances[0]?.options as {
        resolveProcessOptions?: () => Promise<unknown>
      }).resolveProcessOptions,
    ).toBeUndefined()
  })
})
