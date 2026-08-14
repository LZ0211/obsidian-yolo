import { type App, FileSystemAdapter, Platform } from 'obsidian'

import { CLI_RUNTIME_IDS } from './types'
import type { ChatRuntimeId, CliRuntimeId } from './types'

export type CliRuntimeAvailability = Readonly<Record<CliRuntimeId, boolean>>

const NO_CLI_RUNTIME_AVAILABLE: CliRuntimeAvailability = {
  'claude-code': false,
  codex: false,
  hermes: false,
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
    return NO_CLI_RUNTIME_AVAILABLE
  }

  try {
    const [
      { getCliPathOverride },
      { loadLoginShellEnvironment },
      { resolveClaudeProcessSupport },
      { resolveCodexLaunch },
      { resolveHermesCommand },
    ] = await Promise.all([
      import('./cli-path-override'),
      import('./login-shell-env'),
      import('./claude/process'),
      import('./codex/launch'),
      import('./hermes/resolve-command'),
    ])
    const vaultPath = app.vault.adapter.getBasePath()
    const environment = await loadLoginShellEnvironment()
    const [claudeResult, codexResult, hermesResult] = await Promise.allSettled([
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
    ])
    return {
      'claude-code': claudeResult.status === 'fulfilled',
      codex:
        codexResult.status === 'fulfilled' &&
        typeof codexResult.value.command === 'string' &&
        codexResult.value.command.length > 0,
      hermes:
        hermesResult.status === 'fulfilled' && hermesResult.value !== null,
    }
  } catch {
    return NO_CLI_RUNTIME_AVAILABLE
  }
}

export const assertCliRuntimeAvailable = (runtimeId: CliRuntimeId): void => {
  if (!isCliRuntimeAvailable()) {
    throw new Error(`${runtimeId} CLI runtime is only available on desktop.`)
  }
}
