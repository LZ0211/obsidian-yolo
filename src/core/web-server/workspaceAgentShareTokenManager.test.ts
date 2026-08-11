import type { YoloSettings } from '../../settings/schema/setting.types'

import { verifyShareToken } from './shareTokenCrypto'
import {
  createWorkspaceAgentShareToken,
  revokeWorkspaceAgentShareToken,
  updateWorkspaceAgentShareToken,
} from './workspaceAgentShareTokenManager'

describe('workspaceAgentShareTokenManager', () => {
  it('creates a hashed workspace-root share token and stores plaintext for later copy', () => {
    const settings = makeSettings()

    const result = createWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      pepper: Buffer.alloc(32, 1).toString('base64url'),
      vaultIdentity: 'vault-1',
      label: 'Team',
      scopeKind: 'workspaceRoot',
      now: 123,
    })

    const token = settings.workspaceAgents[0]?.shareTokens?.[0]
    expect(result.plaintext).toMatch(/^yolo_share_v1_/)
    expect(token).toMatchObject({
      id: result.publicTokenId,
      tokenHashVersion: 'hmac-sha256-v1',
      label: 'Team',
      createdAt: 123,
      scope: {
        kind: 'workspaceRoot',
        issuedForAgentId: 'agent-1',
      },
    })
    // Plaintext is stored alongside the hash so the management UI can show /
    // copy it later. The hash is still the source of truth for verification.
    expect(token?.plaintext).toBe(result.plaintext)
    expect(
      verifyShareToken(
        result.plaintext,
        token?.tokenHash ?? '',
        Buffer.alloc(32, 1).toString('base64url'),
      ),
    ).toBe(true)
  })

  it('revokes a token by id', () => {
    const settings = makeSettings()
    const created = createWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      pepper: Buffer.alloc(32, 2).toString('base64url'),
      vaultIdentity: 'vault-1',
      scopeKind: 'agent',
      now: 100,
    })

    revokeWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      tokenId: created.publicTokenId,
      now: 200,
    })

    expect(settings.workspaceAgents[0]?.shareTokens?.[0]?.revokedAt).toBe(200)
  })

  it('persists an expiresAt timestamp when one is provided at creation', () => {
    const settings = makeSettings()
    createWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      pepper: Buffer.alloc(32, 3).toString('base64url'),
      vaultIdentity: 'vault-1',
      scopeKind: 'agent',
      expiresAt: 9_999,
      now: 100,
    })
    expect(settings.workspaceAgents[0]?.shareTokens?.[0]?.expiresAt).toBe(9_999)
  })

  it('updates expiresAt / disabled / label in place via updateWorkspaceAgentShareToken', () => {
    const settings = makeSettings()
    const created = createWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      pepper: Buffer.alloc(32, 4).toString('base64url'),
      vaultIdentity: 'vault-1',
      label: 'Initial',
      scopeKind: 'agent',
      expiresAt: 5_000,
      now: 100,
    })

    updateWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      tokenId: created.publicTokenId,
      expiresAt: 12_345,
      disabled: true,
      label: 'Renamed',
      now: 200,
    })

    const updated = settings.workspaceAgents[0]?.shareTokens?.[0]
    expect(updated?.expiresAt).toBe(12_345)
    expect(updated?.disabled).toBe(true)
    expect(updated?.label).toBe('Renamed')
    // The hash and id must be preserved — edits change metadata only,
    // existing clients keep working.
    expect(updated?.id).toBe(created.publicTokenId)
    expect(updated?.tokenHash).toBeTruthy()
    expect(settings.workspaceAgents[0]?.updatedAt).toBe(200)
  })

  it('clears expiresAt and disabled when an empty/false update is passed', () => {
    const settings = makeSettings()
    const created = createWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      pepper: Buffer.alloc(32, 5).toString('base64url'),
      vaultIdentity: 'vault-1',
      scopeKind: 'agent',
      expiresAt: 5_000,
      now: 100,
    })
    // First flip disabled on so we can confirm the off-path works too.
    updateWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      tokenId: created.publicTokenId,
      disabled: true,
      now: 110,
    })
    expect(settings.workspaceAgents[0]?.shareTokens?.[0]?.disabled).toBe(true)

    updateWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      tokenId: created.publicTokenId,
      expiresAt: null,
      disabled: false,
      now: 120,
    })
    const cleared = settings.workspaceAgents[0]?.shareTokens?.[0]
    // `null` expiresAt → "no expiry" → field removed entirely.
    expect(cleared?.expiresAt).toBeUndefined()
    expect(cleared?.disabled).toBeUndefined()
  })

  it('throws when updating a token that does not exist', () => {
    const settings = makeSettings()
    createWorkspaceAgentShareToken({
      settings,
      agentId: 'agent-1',
      pepper: Buffer.alloc(32, 6).toString('base64url'),
      vaultIdentity: 'vault-1',
      scopeKind: 'agent',
      now: 100,
    })
    expect(() =>
      updateWorkspaceAgentShareToken({
        settings,
        agentId: 'agent-1',
        tokenId: 'nonexistent-token-id',
        disabled: true,
        now: 200,
      }),
    ).toThrow(/Share token .* is unavailable/)
  })
})

function makeSettings(): YoloSettings {
  return {
    version: 74,
    assistants: [],
    workspaceAgents: [
      {
        id: 'agent-1',
        name: 'Agent',
        templateId: 'template-1',
        behaviorOverrides: {},
        workspacePolicy: {
          workspaceRoot: '/Project',
          readAllowlist: [],
          readDenylist: [],
          writeDenylist: [],
        },
        shareTokens: [],
        createdAt: 1,
        updatedAt: 1,
      },
    ],
  } as unknown as YoloSettings
}
