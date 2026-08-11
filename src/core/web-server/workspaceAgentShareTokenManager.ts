import type { YoloSettings } from '../../settings/schema/setting.types'

import {
  createShareToken,
  hashShareToken,
  hashWorkspaceRoot,
} from './shareTokenCrypto'

export type CreateWorkspaceAgentShareTokenInput = {
  settings: YoloSettings
  agentId: string
  pepper: string
  vaultIdentity: string
  label?: string
  scopeKind: 'agent' | 'workspaceRoot'
  /** Epoch ms after which the token stops accepting logins. Omitted = no
   *  expiry (legacy behaviour). */
  expiresAt?: number
  now?: number
}

export type CreateWorkspaceAgentShareTokenResult = {
  plaintext: string
  publicTokenId: string
}

export function createWorkspaceAgentShareToken(
  input: CreateWorkspaceAgentShareTokenInput,
): CreateWorkspaceAgentShareTokenResult {
  const agent = (input.settings.workspaceAgents ?? []).find(
    (item) => item.id === input.agentId,
  )
  if (!agent) {
    throw new Error(`Workspace Agent ${input.agentId} is unavailable.`)
  }

  const created = createShareToken()
  const now = input.now ?? Date.now()
  const scope =
    input.scopeKind === 'agent'
      ? { kind: 'agent' as const, agentId: agent.id }
      : {
          kind: 'workspaceRoot' as const,
          rootHash: hashWorkspaceRoot(
            agent.workspacePolicy.workspaceRoot,
            input.vaultIdentity,
          ),
          issuedForAgentId: agent.id,
        }

  agent.shareTokens = [
    ...(agent.shareTokens ?? []),
    {
      id: created.publicTokenId,
      tokenHash: hashShareToken(created.plaintext, input.pepper),
      tokenHashVersion: 'hmac-sha256-v1',
      scope,
      label: input.label,
      createdAt: now,
      // Store plaintext alongside the hash so the management UI can show /
      // copy it later. Documented as a deliberate trade-off in the schema.
      plaintext: created.plaintext,
      ...(input.expiresAt != null ? { expiresAt: input.expiresAt } : {}),
    },
  ]
  agent.updatedAt = now

  return created
}

/**
 * Recompute the current workspace-root hash for an agent, using the same
 * hashing routine as token creation/enforcement. Lets the settings UI detect
 * `workspaceRoot`-scoped tokens whose stored hash no longer matches the
 * agent's current root, without importing crypto into the React layer.
 */
export function getWorkspaceAgentRootHash(input: {
  settings: YoloSettings
  agentId: string
  vaultIdentity: string
}): string | null {
  const agent = (input.settings.workspaceAgents ?? []).find(
    (item) => item.id === input.agentId,
  )
  if (!agent) return null
  return hashWorkspaceRoot(
    agent.workspacePolicy.workspaceRoot,
    input.vaultIdentity,
  )
}

/**
 * Update an existing token's `expiresAt` / `disabled` / `label` in place.
 * Throws when the token is missing. Used by the management UI's edit flow
 * (which re-opens the create dialog pre-filled).
 */
export function updateWorkspaceAgentShareToken(input: {
  settings: YoloSettings
  agentId: string
  tokenId: string
  expiresAt?: number | null
  disabled?: boolean
  label?: string
  scopeKind?: 'agent' | 'workspaceRoot'
  vaultIdentity?: string
  now?: number
}): void {
  const agent = (input.settings.workspaceAgents ?? []).find(
    (item) => item.id === input.agentId,
  )
  if (!agent) {
    throw new Error(`Workspace Agent ${input.agentId} is unavailable.`)
  }
  const now = input.now ?? Date.now()
  let found = false
  agent.shareTokens = (agent.shareTokens ?? []).map((token) => {
    if (token.id !== input.tokenId) return token
    found = true
    const next = { ...token }
    if (input.expiresAt !== undefined) {
      if (input.expiresAt === null) delete next.expiresAt
      else next.expiresAt = input.expiresAt
    }
    if (input.disabled !== undefined) {
      if (input.disabled) next.disabled = true
      else delete next.disabled
    }
    if (input.label !== undefined) {
      next.label = input.label
    }
    if (input.scopeKind !== undefined) {
      next.scope =
        input.scopeKind === 'agent'
          ? { kind: 'agent' as const, agentId: agent.id }
          : {
              kind: 'workspaceRoot' as const,
              rootHash: hashWorkspaceRoot(
                agent.workspacePolicy.workspaceRoot,
                input.vaultIdentity ?? '',
              ),
              issuedForAgentId: agent.id,
            }
    }
    return next
  })
  if (!found) {
    throw new Error(`Share token ${input.tokenId} is unavailable.`)
  }
  agent.updatedAt = now
}

export function revokeWorkspaceAgentShareToken(input: {
  settings: YoloSettings
  agentId: string
  tokenId: string
  now?: number
}): void {
  const agent = (input.settings.workspaceAgents ?? []).find(
    (item) => item.id === input.agentId,
  )
  if (!agent) {
    throw new Error(`Workspace Agent ${input.agentId} is unavailable.`)
  }

  const now = input.now ?? Date.now()
  let found = false
  agent.shareTokens = (agent.shareTokens ?? []).map((token) => {
    if (token.id !== input.tokenId) return token
    found = true
    return token.revokedAt == null ? { ...token, revokedAt: now } : token
  })
  if (!found) {
    throw new Error(`Share token ${input.tokenId} is unavailable.`)
  }
  agent.updatedAt = now
}
