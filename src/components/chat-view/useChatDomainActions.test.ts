import type { Assistant } from '../../types/assistant.types'
import { createCompleteToolCallArguments } from '../../types/tool-call.types'

import { resolveRecoveryExecutionWorkspaceAccessPolicy } from './useChatDomainActions'

const snapshotPolicy = {
  enabled: true,
  workspaceRoot: '04-专利',
  readExtraIncludes: [],
  readExcludes: [],
  writeExcludes: ['04-专利/archive'],
}

const otherPolicy = {
  enabled: true,
  workspaceRoot: '00-Email',
  readExtraIncludes: [],
  readExcludes: [],
  writeExcludes: [],
}

const makeRequest = (metadata?: Record<string, unknown>) => ({
  id: 'tool-1',
  name: 'yolo_local__bash',
  arguments: createCompleteToolCallArguments({ value: { command: 'ls' } }),
  metadata,
})

const selectedAssistant = {
  id: 'wa-2',
  workspaceAccessPolicy: otherPolicy,
} as unknown as Assistant

describe('resolveRecoveryExecutionWorkspaceAccessPolicy', () => {
  it('runs the approval with the policy snapshot from tool-call creation, not the current assistant', () => {
    // The call was emitted under agent A (snapshotPolicy); the user switched
    // to agent B (otherPolicy) before approving.
    const policy = resolveRecoveryExecutionWorkspaceAccessPolicy({
      chatMode: 'agent',
      request: makeRequest({ workspaceAccessPolicy: snapshotPolicy }),
      selectedAssistant,
    })

    expect(policy).toEqual(snapshotPolicy)
  })

  it('falls back to the live policy composition for historical calls without a snapshot', () => {
    const policy = resolveRecoveryExecutionWorkspaceAccessPolicy({
      chatMode: 'agent',
      request: makeRequest({}),
      selectedAssistant,
    })

    expect(policy).toEqual(otherPolicy)
  })

  it('returns undefined for non-agent chat modes', () => {
    const policy = resolveRecoveryExecutionWorkspaceAccessPolicy({
      chatMode: 'ask',
      request: makeRequest({ workspaceAccessPolicy: snapshotPolicy }),
      selectedAssistant,
    })

    expect(policy).toBeUndefined()
  })
})
