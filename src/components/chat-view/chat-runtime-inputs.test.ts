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

  it('returns undefined policy when assistant is missing or has none', () => {
    expect(resolveWorkspaceAccessPolicyForRuntimeInput(null)).toBeUndefined()
    expect(
      resolveWorkspaceAccessPolicyForRuntimeInput({
        id: 'a',
        name: 'A',
        systemPrompt: '',
      } as Assistant),
    ).toBeUndefined()
  })
})
