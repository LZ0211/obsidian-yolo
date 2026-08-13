import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatSubagentResultMessage } from '../../../types/chat'
import {
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'

import {
  buildSubagentCompletionSummary,
  parseAcceptedSubagentResponse,
  resolveSubagentPendingApprovals,
} from './subagentCardUtils'
import { SubagentCardView } from './SubagentCardView'

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('clsx', () => ({
  __esModule: true,
  default: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

jest.mock('./SubagentDetailModal', () => ({
  SubagentDetailModal: () => null,
}))

describe('resolveSubagentPendingApprovals (F6 status guard)', () => {
  const pendingTranscript = [
    {
      role: 'tool',
      id: 'tool-msg',
      toolCalls: [
        {
          request: { id: 'pending-call', name: 'fs_edit' },
          response: { status: ToolCallResponseStatus.PendingApproval },
        },
      ],
    },
  ] as Parameters<typeof resolveSubagentPendingApprovals>[0]['transcript']

  it('collects PendingApproval calls while the live task record is running', () => {
    const approvals = resolveSubagentPendingApprovals({
      recordStatus: 'running',
      transcript: pendingTranscript,
    })
    expect(approvals).toEqual([
      expect.objectContaining({ toolCallId: 'pending-call' }),
    ])
  })

  it('returns an empty list for an aborted record even when the transcript still holds pending calls', () => {
    const approvals = resolveSubagentPendingApprovals({
      recordStatus: 'aborted',
      transcript: pendingTranscript,
    })
    expect(approvals).toEqual([])
  })

  it('returns an empty list for completed/failed records and when the record is unknown', () => {
    for (const recordStatus of [
      'completed',
      'failed',
      undefined,
    ] as const) {
      expect(
        resolveSubagentPendingApprovals({
          recordStatus,
          transcript: pendingTranscript,
        }),
      ).toEqual([])
    }
  })

  it('returns an empty list for a running record with no pending calls', () => {
    expect(
      resolveSubagentPendingApprovals({
        recordStatus: 'running',
        transcript: [
          {
            role: 'tool',
            id: 'tool-msg',
            toolCalls: [
              {
                request: { id: 'done-call', name: 'fs_edit' },
                response: {
                  status: ToolCallResponseStatus.Success,
                  data: { type: 'text', text: 'ok' },
                },
              },
            ],
          },
        ] as Parameters<typeof resolveSubagentPendingApprovals>[0]['transcript'],
      }),
    ).toEqual([])
  })
})

describe('parseAcceptedSubagentResponse blocked payload (F10)', () => {
  const successResponse = (text: string) =>
    ({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text },
    }) as const

  it('flags the breaker-blocked payload and keeps the reason', () => {
    const parsed = parseAcceptedSubagentResponse(
      successResponse(
        JSON.stringify({
          accepted: false,
          status: 'blocked',
          blocked: true,
          reason: 'delegation blocked (too many timeouts)',
        }),
      ),
    )
    expect(parsed).toEqual({
      blocked: true,
      blockedReason: 'delegation blocked (too many timeouts)',
    })
  })

  it('recognizes a blocked payload that only carries the blocked flag', () => {
    const parsed = parseAcceptedSubagentResponse(
      successResponse(JSON.stringify({ accepted: false, blocked: true })),
    )
    expect(parsed.blocked).toBe(true)
  })

  it('does not flag an ordinary accepted dispatch', () => {
    const parsed = parseAcceptedSubagentResponse(
      successResponse(
        JSON.stringify({
          accepted: true,
          taskId: 'sub_abc123',
          title: 'Count files',
          modelName: 'child-model',
        }),
      ),
    )
    expect(parsed).toEqual({
      taskId: 'sub_abc123',
      title: 'Count files',
      modelName: 'child-model',
    })
    expect(parsed.blocked).toBeUndefined()
  })

  it('returns an empty shape for non-success responses', () => {
    expect(
      parseAcceptedSubagentResponse({
        status: ToolCallResponseStatus.Error,
        error: 'boom',
      }),
    ).toEqual({})
  })
})

describe('buildSubagentCompletionSummary delegated role (F2/F11)', () => {
  const makeResult = (
    overrides: Partial<ChatSubagentResultMessage> = {},
  ): ChatSubagentResultMessage =>
    ({
      role: 'subagent_result',
      id: 'r1',
      taskId: 'sub_abc',
      source: {
        type: 'llm_tool_call',
        toolCallId: 'tc',
        assistantMessageId: 'm',
      },
      title: 'Review',
      status: 'completed',
      content: 'done',
      durationMs: 0,
      toolUseCount: 0,
      delegateAssistantMessageId: 'm',
      delegateToolCallId: 'tc',
      ...overrides,
    }) as ChatSubagentResultMessage

  it('prefixes the summary with the delegated role name when present', () => {
    const summary = buildSubagentCompletionSummary({
      subagentResult: makeResult({
        delegatedRoleName: 'Code Reviewer',
        status: 'completed',
        toolUseCount: 3,
      }),
      t: (key: string, fallback?: string) => fallback ?? key,
    })
    expect(summary).toContain('Code Reviewer')
    expect(summary).toContain('Delegated role:')
    expect(summary).toContain('Completed')
  })

  it('omits the role when the child was a generic subagent', () => {
    const summary = buildSubagentCompletionSummary({
      subagentResult: makeResult({ status: 'completed' }),
      t: (key: string, fallback?: string) => fallback ?? key,
    })
    expect(summary).not.toContain('Delegated role')
  })
})

describe('SubagentCardView blocked status (F10)', () => {
  it('renders the blocked card state with the shield icon', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubagentCardView, {
        title: 'Count files',
        subtitle: 'Delegation blocked · cooldown',
        status: 'blocked',
      }),
    )
    expect(markup).toContain('yolo-subagent-card--blocked')
    expect(markup).toContain('lucide-shield-alert')
  })
})

describe('SubagentCardView awaiting-approval status (A3 最小实现)', () => {
  it('renders the awaiting-approval label when awaitingApproval is true', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubagentCardView, {
        title: 'Count files',
        subtitle: 'Planning next moves',
        status: 'running',
        awaitingApproval: true,
      }),
    )
    expect(markup).toContain('yolo-subagent-card__awaiting')
    expect(markup).toContain('Awaiting approval')
  })

  it('renders no awaiting-approval label when awaitingApproval is falsy', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubagentCardView, {
        title: 'Count files',
        subtitle: 'No activity yet.',
        status: 'dispatched',
      }),
    )
    expect(markup).not.toContain('yolo-subagent-card__awaiting')
    expect(markup).not.toContain('Awaiting approval')
  })
})
