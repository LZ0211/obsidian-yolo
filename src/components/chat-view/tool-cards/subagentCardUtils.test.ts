import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ToolCallResponseStatus,
} from '../../../types/tool-call.types'

import {
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
