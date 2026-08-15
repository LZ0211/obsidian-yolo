import type { AcpAgentProfile } from '../acp/agent-profile'

import { resolveOpenCodeCommand } from './resolve-command'

/** OpenCode's ACP entry point: `opencode acp` over stdio. */
export const openCodeAgentProfile: AcpAgentProfile = {
  runtimeId: 'opencode',
  displayName: 'OpenCode',
  resolveCommand: (env, cliPathOverride) =>
    resolveOpenCodeCommand(env, process.platform, cliPathOverride),
}
