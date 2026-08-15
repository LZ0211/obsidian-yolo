import { resolveRuntimeLlmEnv } from '../llm-injection'
import type { CliRuntimeFactory, CliRuntimeFactoryDeps } from '../types'
import { resolveCliRuntimeWorkingPath } from '../working-directory'

export type PiRuntimeFactoryDeps = CliRuntimeFactoryDeps

/**
 * Builds the pi runtime factory. Unlike Claude/Codex/Hermes there is no
 * shared pooled host to warm or dispose here — pi binds a session to its
 * process at launch, so pooling across conversations isn't possible, and
 * each `PiCliRuntime` instance owns its own process(es) directly (see
 * `PiCliRuntime`'s class doc).
 */
export const createPiRuntimeFactory = async (
  deps: PiRuntimeFactoryDeps,
): Promise<CliRuntimeFactory> => {
  const { PiCliRuntime } = await import('./PiCliRuntime')
  return {
    create: (createDeps) =>
      new PiCliRuntime({
        app: createDeps.app,
        vaultPath: resolveCliRuntimeWorkingPath(
          createDeps.vaultPath,
          createDeps.workingDirectory,
        ),
        llmEnv:
          resolveRuntimeLlmEnv(() => deps.getSettings?.() ?? null, 'pi') ??
          undefined,
      }),
  }
}
