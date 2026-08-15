import { type App, FileSystemAdapter, Platform } from 'obsidian'

import { CLI_RUNTIME_IDS } from './types'
import type { ChatRuntimeId, CliRuntimeId } from './types'

export type CliRuntimeAvailability = Readonly<Record<CliRuntimeId, boolean>>

export const EMPTY_CLI_RUNTIME_AVAILABILITY: CliRuntimeAvailability = {
  'claude-code': false,
  codex: false,
  hermes: false,
  opencode: false,
  pi: false,
}

export const isCliRuntimeAvailable = (): boolean => Platform.isDesktop

export const resolveAvailableChatRuntimeIds = (options: {
  cliRuntimeAvailable: boolean
  hasCliRuntimeScope: boolean
  runtimeAvailability: CliRuntimeAvailability
}): ChatRuntimeId[] => {
  if (!options.cliRuntimeAvailable || !options.hasCliRuntimeScope) {
    return ['yolo']
  }
  return [
    'yolo',
    ...CLI_RUNTIME_IDS.filter(
      (runtimeId) => options.runtimeAvailability[runtimeId],
    ),
  ]
}

export const detectCliRuntimeAvailability = async (
  app: App,
): Promise<CliRuntimeAvailability> => {
  if (
    !isCliRuntimeAvailable() ||
    !(app.vault.adapter instanceof FileSystemAdapter)
  ) {
    return EMPTY_CLI_RUNTIME_AVAILABILITY
  }

  try {
    const [
      { getCliPathOverride },
      { loadLoginShellEnvironment },
      { resolveClaudeProcessSupport },
      { resolveCodexLaunch },
      { resolveHermesCommand },
      { resolveOpenCodeCommand },
      { resolvePiCommand },
    ] = await Promise.all([
      import('./cli-path-override'),
      import('./login-shell-env'),
      import('./claude/process'),
      import('./codex/launch'),
      import('./hermes/resolve-command'),
      import('./opencode/resolve-command'),
      import('./pi/resolve-command'),
    ])
    const vaultPath = app.vault.adapter.getBasePath()
    const environment = await loadLoginShellEnvironment()
    const [claudeResult, codexResult, hermesResult, opencodeResult, piResult] =
      await Promise.allSettled([
        resolveClaudeProcessSupport({
          configuredCliPath: getCliPathOverride(app, 'claude-code'),
        }),
        resolveCodexLaunch(
          vaultPath,
          environment as NodeJS.ProcessEnv,
          process.platform,
          getCliPathOverride(app, 'codex'),
        ),
        resolveHermesCommand(
          environment as NodeJS.ProcessEnv,
          process.platform,
          getCliPathOverride(app, 'hermes'),
        ),
        resolveOpenCodeCommand(
          environment as NodeJS.ProcessEnv,
          process.platform,
          getCliPathOverride(app, 'opencode'),
        ),
        resolvePiCommand(
          environment as NodeJS.ProcessEnv,
          process.platform,
          getCliPathOverride(app, 'pi'),
        ),
      ])
    return {
      'claude-code': claudeResult.status === 'fulfilled',
      codex:
        codexResult.status === 'fulfilled' &&
        typeof codexResult.value.command === 'string' &&
        codexResult.value.command.length > 0,
      hermes:
        hermesResult.status === 'fulfilled' && hermesResult.value !== null,
      opencode:
        opencodeResult.status === 'fulfilled' &&
        opencodeResult.value !== null,
      pi: piResult.status === 'fulfilled' && piResult.value !== null,
    }
  } catch {
    return EMPTY_CLI_RUNTIME_AVAILABILITY
  }
}

export const assertCliRuntimeAvailable = (runtimeId: CliRuntimeId): void => {
  if (!isCliRuntimeAvailable()) {
    throw new Error(`${runtimeId} CLI runtime is only available on desktop.`)
  }
}
