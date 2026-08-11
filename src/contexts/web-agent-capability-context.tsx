import * as React from 'react'

/**
 * Whether the active workspace agent allows Agent mode in the chat input.
 *
 * `null` = no provider in the tree (desktop Obsidian) → callers default to
 * "allowed" (matches the previous desktop behaviour).
 * `undefined` = legacy server didn't populate the flag → also "allowed".
 * `false` = the workspace agent's admin disabled Agent mode → hide it.
 *
 * Surfaced from `PublicWorkspaceAgentSummary.agentModeAllowed` via the bootstrap
 * payload and threaded through `renderChatIntoTarget` → React tree.
 */
const Ctx = React.createContext<boolean | null | undefined>(null)

export const AgentModeAllowedProvider = ({
  value,
  children,
}: {
  value: boolean | null | undefined
  children: React.ReactNode
}) => <Ctx.Provider value={value}>{children}</Ctx.Provider>

export function useAgentModeAllowed(): boolean | null | undefined {
  return React.useContext(Ctx)
}
