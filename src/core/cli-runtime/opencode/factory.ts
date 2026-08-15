import { getCliPathOverride } from '../cli-path-override'
import { loadLoginShellEnvironment } from '../login-shell-env'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'
import { resolveCliRuntimeWorkingPath } from '../working-directory'

import { openCodeAgentProfile } from './profile'

export type OpenCodeRuntimeFactoryDeps = CliRuntimeFactoryDeps

const NOT_FOUND_MESSAGE =
  'OpenCode CLI was not found on this device. Install OpenCode (https://opencode.ai), or set a custom CLI path in Settings → Agent, then retry.'

/** Builds the shared ACP host used by OpenCode conversation runtimes. */
export const createOpenCodeRuntimeFactory = async (
  deps: OpenCodeRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { AcpCliRuntime } = await import('../acp/AcpCliRuntime')
  const { AcpHostPool } = await import('../acp/host')

  const resolveProcessOptions = async () => {
    const env = (await loadLoginShellEnvironment()) as NodeJS.ProcessEnv
    const cliPathOverride = getCliPathOverride(deps.app, 'opencode')
    const resolved = await openCodeAgentProfile.resolveCommand(
      env,
      cliPathOverride,
    )
    if (!resolved) throw new Error(NOT_FOUND_MESSAGE)
    return {
      command: resolved.command,
      args: resolved.args,
      cwd: deps.vaultPath,
    }
  }

  const hostPool = new AcpHostPool({
    runtimeId: 'opencode',
    clientName: 'obsidian-yolo',
    resolveProcessOptions,
  })

  return {
    create: (createDeps) =>
      new AcpCliRuntime('opencode', {
        cwd: resolveCliRuntimeWorkingPath(
          createDeps.vaultPath,
          createDeps.workingDirectory,
        ),
        resolveHost: hostPool.acquire,
      }),
    warm: () => hostPool.warm(),
    dispose: () => hostPool.dispose(),
  }
}
