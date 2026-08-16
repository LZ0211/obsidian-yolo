import { getCliPathOverride } from '../cli-path-override'
import {
  buildCodexSessionOverrides,
  resolveCliSessionInjection,
} from '../llm-injection'
import { loadLoginShellEnvironment } from '../login-shell-env'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'
import { resolveCliRuntimeWorkingPath } from '../working-directory'

import { CodexAppServerHost } from './host'
import { type ResolvedCodexLaunch, resolveCodexLaunch } from './launch'
import type { CodexProcessOptions } from './process'
import type { CodexCliRuntimeOptions } from './runtime'

export type CodexRuntimeOptions = Omit<
  CodexCliRuntimeOptions,
  'cwd' | 'resolveHost'
> & {
  cwd?: string
}

export type CodexRuntimeFactoryDeps = CliRuntimeFactoryDeps &
  Readonly<{
    getCodexRuntimeOptions?: () => CodexRuntimeOptions
  }>

/**
 * Builds session-owned Codex app-server runtimes. Falls back to resolving the launch command from the login-shell PATH
 * (auto-detect) when the caller does not supply its own options; the
 * fallback re-resolves on every host respawn so an install or path override
 * picked up after startup takes effect on the next attempt.
 */
export const createCodexRuntimeFactory = async (
  deps: CodexRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { CodexCliRuntime } = await import('./runtime')

  let getCodexRuntimeOptions = deps.getCodexRuntimeOptions
  let resolveProcessOptions: (() => Promise<CodexProcessOptions>) | undefined

  if (!getCodexRuntimeOptions) {
    const resolveLaunch = async (): Promise<ResolvedCodexLaunch> =>
      resolveCodexLaunch(
        deps.vaultPath,
        (await loadLoginShellEnvironment()) as NodeJS.ProcessEnv,
        process.platform,
        getCliPathOverride(deps.app, 'codex'),
      )
    let launchSnapshot = await resolveLaunch()
    getCodexRuntimeOptions = (): CodexRuntimeOptions => ({
      command: launchSnapshot.command,
      cwd: launchSnapshot.runtimeCwd,
      spawnCwd: launchSnapshot.spawnCwd,
      launchArgs: launchSnapshot.launchArgs,
      mapRuntimePathToHost: launchSnapshot.mapRuntimePathToHost,
    })
    resolveProcessOptions = async (): Promise<CodexProcessOptions> => {
      launchSnapshot = await resolveLaunch()
      return {
        command: launchSnapshot.command,
        cwd: launchSnapshot.runtimeCwd,
        spawnCwd: launchSnapshot.spawnCwd,
        launchArgs: launchSnapshot.launchArgs,
      }
    }
  }

  return {
    create: (createDeps) => {
      const options = getCodexRuntimeOptions()
      const cwd = resolveCliRuntimeWorkingPath(
        options.cwd ?? createDeps.vaultPath,
        createDeps.workingDirectory,
      )
      const getSessionInjection = () =>
        resolveCliSessionInjection(
          () => deps.getSettings?.() ?? null,
          'codex',
        )
      return new CodexCliRuntime({
        ...options,
        cwd,
        resolveHost: async () => {
          const overrides = buildCodexSessionOverrides(getSessionInjection())
          return new CodexAppServerHost({
            ...options,
            cwd,
            launchArgs: [...(options.launchArgs ?? []), ...overrides.launchArgs],
            env: { ...(options.env ?? {}), ...overrides.env },
            resolveProcessOptions: resolveProcessOptions
              ? async () => {
                  const current = await resolveProcessOptions!()
                  return {
                    ...current,
                    cwd,
                    launchArgs: [
                      ...(current.launchArgs ?? []),
                      ...overrides.launchArgs,
                    ],
                    env: { ...(current.env ?? {}), ...overrides.env },
                  }
                }
              : undefined,
          })
        },
      })
    },
  }
}
