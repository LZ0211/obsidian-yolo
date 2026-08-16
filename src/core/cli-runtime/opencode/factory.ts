import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'
import { resolveCliSessionInjection } from '../llm-injection'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'
import { resolveCliRuntimeWorkingPath } from '../working-directory'

import { openCodeAgentProfile } from './profile'

export type OpenCodeRuntimeFactoryDeps = CliRuntimeFactoryDeps

const NOT_FOUND_MESSAGE =
  'OpenCode CLI was not found on this device. Install OpenCode (https://opencode.ai), or set a custom CLI path in Settings → Agent, then retry.'

/** Builds session-owned OpenCode ACP runtimes. */
export const createOpenCodeRuntimeFactory = async (
  deps: OpenCodeRuntimeFactoryDeps,
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
          'opencode',
        )
      return new AcpCliRuntime('opencode', {
        cwd,
        getSessionInjection: () =>
          getSessionInjection(),
        resolveProcessOptions: async () => {
          const env = Object.fromEntries(
            Object.entries({
            ...((await loadLoginShellEnvironment()) as NodeJS.ProcessEnv),
            ...(getSessionInjection().llmEnv ?? {}),
            }).filter((entry): entry is [string, string] => entry[1] !== undefined),
          )
          const resolved = await openCodeAgentProfile.resolveCommand(
            env,
            getCliPathOverride(deps.app, 'opencode'),
          )
          if (!resolved) throw new Error(NOT_FOUND_MESSAGE)
          return { command: resolved.command, args: resolved.args, cwd, env }
        },
      })
    },
  }
}
