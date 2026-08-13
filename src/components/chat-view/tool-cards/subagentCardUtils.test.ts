import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

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
