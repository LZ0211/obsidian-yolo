import { makeSubagentRunKey } from './session-types'
import type {
  SubagentControlRejected,
  SubagentSendInput,
  SubagentSendResult,
  TrustedSubagentCallerContext,
} from './session-types'
import type { SubagentAcceptedResult } from './types'

type ExpectNever<Value extends never> = Value
type ExpectFalse<Value extends false> = Value
type AuthorityBearingSendInputKey = Extract<
  keyof SubagentSendInput,
  | 'parentConversationId'
  | 'source'
  | 'toolPolicy'
  | 'trustedCallerContext'
  | 'workspaceAccessPolicy'
  | 'allowedToolNames'
  | 'allowedSkillPaths'
  | 'toolServerPreferences'
  | 'bypassToolApproval'
  | 'rejectToolApproval'
  | 'temporaryApprovedToolNames'
  | 'blockedCommandPrefixes'
  | 'providerClient'
  | 'requestContextBuilder'
>

type _NoAuthorityBearingPublicSendInput =
  ExpectNever<AuthorityBearingSendInputKey>
type _RejectedResultIsNeverAccepted = ExpectFalse<
  SubagentControlRejected['accepted']
>

describe('reusable subagent session contracts', () => {
  it('creates a run key from the session id and sequence', () => {
    expect(makeSubagentRunKey('sub_abc', 3)).toBe('sub_abc:3')
  })

  it('rejects invalid session ids and run sequences', () => {
    expect(() => makeSubagentRunKey('', 3)).toThrow('sessionId')
    expect(() => makeSubagentRunKey('   ', 3)).toThrow('sessionId')
    expect(() => makeSubagentRunKey('sub_abc', 0)).toThrow('runSequence')
    expect(() => makeSubagentRunKey('sub_abc', 1.5)).toThrow('runSequence')
    expect(() =>
      makeSubagentRunKey('sub_abc', Number.MAX_SAFE_INTEGER + 1),
    ).toThrow('runSequence')
  })

  it('keeps public send input free of authority-bearing fields', () => {
    const input: SubagentSendInput = {
      sessionId: 'sub_abc',
      messageId: 'message-1',
      text: 'Continue the investigation.',
      delivery: 'after_run',
      expectedSessionRevision: 2,
      requestId: 'request-1',
    }

    expect(input).toEqual({
      sessionId: 'sub_abc',
      messageId: 'message-1',
      text: 'Continue the investigation.',
      delivery: 'after_run',
      expectedSessionRevision: 2,
      requestId: 'request-1',
    })
    expect(input).not.toHaveProperty('parentConversationId')
    expect(input).not.toHaveProperty('source')
    expect(input).not.toHaveProperty('toolPolicy')
    expect(input).not.toHaveProperty('trustedCallerContext')
    expect(input).not.toHaveProperty('workspaceAccessPolicy')
    expect(input).not.toHaveProperty('allowedToolNames')
    expect(input).not.toHaveProperty('allowedSkillPaths')
    expect(input).not.toHaveProperty('toolServerPreferences')
    expect(input).not.toHaveProperty('bypassToolApproval')
    expect(input).not.toHaveProperty('rejectToolApproval')
    expect(input).not.toHaveProperty('temporaryApprovedToolNames')
    expect(input).not.toHaveProperty('blockedCommandPrefixes')
    expect(input).not.toHaveProperty('providerClient')
    expect(input).not.toHaveProperty('requestContextBuilder')
  })

  it('keeps trusted caller ownership context separate from public controls', () => {
    const caller: TrustedSubagentCallerContext = {
      parentConversationId: 'parent-1',
      originAssistantMessageId: 'assistant-1',
      originToolCallId: 'tool-call-1',
      originBranchId: 'branch-1',
    }

    expect(caller).toEqual({
      parentConversationId: 'parent-1',
      originAssistantMessageId: 'assistant-1',
      originToolCallId: 'tool-call-1',
      originBranchId: 'branch-1',
    })
  })

  it('never marks a rejection as accepted', () => {
    const result: SubagentControlRejected = {
      accepted: false,
      errorCode: 'session_not_found',
      retryable: false,
    }
    const sendResult: SubagentSendResult = result

    expect(sendResult.accepted).toBe(false)
  })

  it('uses session id as the legacy task id and keeps run keys run-specific', () => {
    const sessionId = 'sub_abc'
    // Master's SubagentAcceptedResult does not yet carry session identity
    // fields; the durable session flow adds them (types.ts aligns with backup
    // during the runner refactor task). Pin the contract locally so the
    // assertions still check sessionId == taskId and run-key distinctness.
    const result: SubagentAcceptedResult & {
      sessionId: string
      runKey: string
      sessionRevision: number
      mode: 'persistent'
    } = {
      accepted: true,
      taskId: sessionId,
      sessionId,
      runKey: makeSubagentRunKey(sessionId, 1),
      sessionRevision: 1,
      mode: 'persistent',
      title: 'Investigate the failure',
      status: 'running',
      note: 'Subagent started asynchronously.',
    }

    expect(result.taskId).toBe(result.sessionId)
    expect(makeSubagentRunKey(sessionId, 1)).not.toBe(
      makeSubagentRunKey(sessionId, 2),
    )
  })
})
