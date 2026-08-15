import { type App, FileSystemAdapter, Platform } from 'obsidian'

jest.mock('./claude/process', () => ({
  resolveClaudeProcessSupport: jest.fn(),
}))
jest.mock('./codex/launch', () => ({
  resolveCodexLaunch: jest.fn(),
}))
jest.mock('./hermes/resolve-command', () => ({
  resolveHermesCommand: jest.fn(),
}))
jest.mock('./opencode/resolve-command', () => ({
  resolveOpenCodeCommand: jest.fn(),
}))
jest.mock('./pi/resolve-command', () => ({
  resolvePiCommand: jest.fn(),
}))
jest.mock('./login-shell-env', () => ({
  loadLoginShellEnvironment: jest.fn(async () => ({})),
}))
jest.mock('./cli-path-override', () => ({
  getCliPathOverride: jest.fn(),
}))

import { resolveClaudeProcessSupport } from './claude/process'
import { resolveCodexLaunch } from './codex/launch'
import {
  assertCliRuntimeAvailable,
  detectCliRuntimeAvailability,
  isCliRuntimeAvailable,
  resolveAvailableChatRuntimeIds,
} from './desktop'
import { resolveHermesCommand } from './hermes/resolve-command'
import { resolveOpenCodeCommand } from './opencode/resolve-command'
import { resolvePiCommand } from './pi/resolve-command'

const mockedResolveClaudeProcessSupport = jest.mocked(
  resolveClaudeProcessSupport,
)
const mockedResolveCodexLaunch = jest.mocked(resolveCodexLaunch)
const mockedResolveHermesCommand = jest.mocked(resolveHermesCommand)
const mockedResolveOpenCodeCommand = jest.mocked(resolveOpenCodeCommand)
const mockedResolvePiCommand = jest.mocked(resolvePiCommand)

class TestFileSystemAdapter extends FileSystemAdapter {
  getBasePath(): string {
    return '/vault'
  }
}

const desktopApp = {
  vault: { adapter: new TestFileSystemAdapter() },
} as unknown as App

describe('CLI runtime desktop gate', () => {
  const originalIsDesktop = Platform.isDesktop

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  it('rejects provider initialization on mobile', () => {
    Platform.isDesktop = false

    expect(isCliRuntimeAvailable()).toBe(false)
    expect(() => assertCliRuntimeAvailable('codex')).toThrow(
      /only available on desktop/,
    )
  })

  it('allows provider initialization on desktop', () => {
    Platform.isDesktop = true

    expect(isCliRuntimeAvailable()).toBe(true)
    expect(() => assertCliRuntimeAvailable('claude-code')).not.toThrow()
  })

  it('reports provider availability from the actual executable probes', async () => {
    Platform.isDesktop = true
    mockedResolveClaudeProcessSupport.mockResolvedValue({
      cliPath: '/bin/claude',
      env: {},
      createAbortController: () => new AbortController(),
      spawnClaudeCodeProcess: jest.fn(),
    })
    mockedResolveCodexLaunch.mockResolvedValue({
      command: undefined,
      runtimeCwd: '/vault',
      spawnCwd: '/vault',
    })
    mockedResolveHermesCommand.mockResolvedValue({
      command: '/bin/hermes',
      args: ['acp'],
    })
    mockedResolveOpenCodeCommand.mockResolvedValue({
      command: '/bin/opencode',
      args: ['acp'],
    })
    mockedResolvePiCommand.mockResolvedValue({ command: '/bin/pi' })

    await expect(detectCliRuntimeAvailability(desktopApp)).resolves.toEqual({
      'claude-code': true,
      codex: false,
      hermes: true,
      opencode: true,
      pi: true,
    })
  })

  it('filters the runtime selector to detected providers', () => {
    expect(
      resolveAvailableChatRuntimeIds({
        cliRuntimeAvailable: true,
        hasCliRuntimeScope: true,
        runtimeAvailability: {
          'claude-code': true,
          codex: false,
          hermes: true,
          opencode: true,
          pi: true,
        },
      }),
    ).toEqual(['yolo', 'claude-code', 'hermes', 'opencode', 'pi'])
  })
})
