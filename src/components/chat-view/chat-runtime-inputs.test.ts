import type { Assistant } from '../../types/assistant.types'

import { resolveWorkspaceAccessPolicyForRuntimeInput } from './chat-runtime-inputs'

describe('chat-runtime-inputs', () => {
  it('passes through the assistant workspace access policy when present', () => {
    const accessPolicy = {
      enabled: true,
      workspaceRoot: 'notes/',
      readExtraIncludes: [],
      readExcludes: [],
      writeExcludes: [],
    }
    const assistant = {
      workspaceAccessPolicy: accessPolicy,
    } as unknown as Assistant

    const resolved = resolveWorkspaceAccessPolicyForRuntimeInput(assistant)
    expect(resolved).toMatchObject({
      enabled: true,
      workspaceRoot: 'notes/',
    })
  })

  it('still injects the host-protected-path baseline when the assistant has no policy', () => {
    // Host-managed protected paths (baseDir minus skills) are always present:
    // fs/bash/git-diff must never touch plugin-private data, even for an
    // assistant without an explicit workspace policy.
    const resolved = resolveWorkspaceAccessPolicyForRuntimeInput(null)
    expect(resolved).toMatchObject({
      enabled: false,
      workspaceRoot: '',
    })
    expect((resolved?.protectedPaths ?? []).length).toBeGreaterThan(0)

    const assistantResolved = resolveWorkspaceAccessPolicyForRuntimeInput({
      id: 'a',
      name: 'A',
      systemPrompt: '',
    } as Assistant)
    expect(assistantResolved).toMatchObject({ enabled: false })
  })
})
