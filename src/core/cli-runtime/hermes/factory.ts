import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'
import { resolveCliSessionInjection } from '../llm-injection'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'
import { resolveCliRuntimeWorkingPath } from '../working-directory'

import { hermesAgentProfile } from './profile'

export type HermesRuntimeFactoryDeps = CliRuntimeFactoryDeps

const NOT_FOUND_MESSAGE =
  'Hermes CLI was not found on this device. Install Hermes (https://github.com/NousResearch/hermes-agent), or set a custom CLI path in Settings → Agent, then retry.'

/** Builds session-owned Hermes ACP runtimes. */
export const createHermesRuntimeFactory = async (
  deps: HermesRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { AcpCliRuntime } = await import('../acp/AcpCliRuntime')
  return {
    create: (createDeps) => {
      const cwd = resolveCliRuntimeWorkingPath(
          createDeps.vaultPath,
          createDeps.workingDirectory,
        )
      const getSessionInjection = () =>
        resolveCliSessionInjection(
          () => deps.getSettings?.() ?? null,
          'hermes',
        )
      return new AcpCliRuntime('hermes', {
        cwd,
        getSessionInjection,
        resolveProcessOptions: async () => {
          const env = Object.fromEntries(
            Object.entries({
              ...((await loadLoginShellEnvironment()) as NodeJS.ProcessEnv),
              ...(getSessionInjection().llmEnv ?? {}),
            }).filter((entry): entry is [string, string] => entry[1] !== undefined),
          )
          const resolved = await hermesAgentProfile.resolveCommand(
            env,
            getCliPathOverride(deps.app, 'hermes'),
          )
          if (!resolved) throw new Error(NOT_FOUND_MESSAGE)
          return { command: resolved.command, args: resolved.args, cwd, env }
        },
      })
    },
  }
}
