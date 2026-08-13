import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  formatQueuedIntentLine,
  mergeSubagentTranscript,
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

describe('formatQueuedIntentLine', () => {
  it('formats a queued intent line for the detail modal', () => {
    expect(formatQueuedIntentLine({ text: 'hello', state: 'pending' })).toBe(
      'pending · hello',
    )
  })

  it('keeps recovery-required state visible in the line', () => {
    expect(
      formatQueuedIntentLine({
        text: 'Count vault files',
        state: 'recovery_required',
      }),
    ).toBe('recovery_required · Count vault files')
  })
})

describe('mergeSubagentTranscript (A2 历史 run transcript 回看)', () => {
  const message = (id: string) =>
    ({
      id,
      role: 'assistant',
      content: `message ${id}`,
    }) as never

  it('merges history above the live transcript', () => {
    const sections = mergeSubagentTranscript(
      [message('h1'), message('h2')],
      [message('l1')],
    )
    expect(sections?.map((section) => section.kind)).toEqual([
      'previous',
      'live',
    ])
    expect(sections?.[0]?.messages.map((m) => m.id)).toEqual(['h1', 'h2'])
    expect(sections?.[1]?.messages.map((m) => m.id)).toEqual(['l1'])
  })

  it('drops history messages already present in the live transcript (settled round de-dup)', () => {
    // 已结算轮次：snapshot.transcriptPage 与结果消息 transcript 同源——
    // 与 live 重合的消息（l1）从 previous 段剔除，避免整段重复
    const sections = mergeSubagentTranscript(
      [message('h1'), message('l1')],
      [message('l1')],
    )
    expect(sections?.map((section) => section.kind)).toEqual([
      'previous',
      'live',
    ])
    expect(sections?.[0]?.messages.map((m) => m.id)).toEqual(['h1'])
    expect(sections?.[1]?.messages.map((m) => m.id)).toEqual(['l1'])
    // 全量重合（同一轮次）时 previous 段为空，只保留 live——行为与未接
    // snapshot 前一致
    const fullOverlap = mergeSubagentTranscript(
      [message('l1')],
      [message('l1')],
    )
    expect(fullOverlap?.map((section) => section.kind)).toEqual(['live'])
  })

  it('returns null when both transcript sources are empty', () => {
    expect(mergeSubagentTranscript(undefined, undefined)).toBeNull()
    expect(mergeSubagentTranscript([], [])).toBeNull()
  })

  it('keeps only the live transcript when there is no settled history', () => {
    const sections = mergeSubagentTranscript(undefined, [message('l1')])
    expect(sections?.map((section) => section.kind)).toEqual(['live'])
  })
})

describe('SubagentCardView session line smoke', () => {
  it('renders session status and queued count into the card markup', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubagentCardView, {
        title: 'Count files',
        subtitle: 'Planning next moves',
        status: 'running',
        sessionStatus: 'Needs resume',
        queuedCount: 2,
        needsResume: true,
        queuedMessages: [
          { messageId: 'msg-1', text: 'hello', state: 'pending' },
          {
            messageId: 'msg-2',
            text: 'Count vault files',
            state: 'recovery_required',
          },
        ],
        onRecover: () => {},
        onQueueResend: () => {},
        onQueueDrop: () => {},
      }),
    )
    expect(markup).toContain('yolo-subagent-card__session-status')
    expect(markup).toContain('Needs resume')
    expect(markup).toContain('yolo-subagent-card__session-queued')
    expect(markup).toContain('2 queued')
  })

  it('renders no session line when no session props are provided', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubagentCardView, {
        title: 'Count files',
        subtitle: 'No activity yet.',
        status: 'dispatched',
      }),
    )
    expect(markup).not.toContain('yolo-subagent-card__session')
  })

  it('shows the awaiting-approval status before the session status (A3)', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubagentCardView, {
        title: 'Count files',
        subtitle: 'Planning next moves',
        status: 'running',
        sessionStatus: 'Running',
        awaitingApproval: true,
        onRecover: () => {},
        onQueueResend: () => {},
        onQueueDrop: () => {},
      }),
    )
    expect(markup).toContain('Awaiting approval')
    expect(markup).not.toContain('>Running<')
  })
})
