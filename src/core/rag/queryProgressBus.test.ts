import type { QueryProgressState } from '../../components/chat-view/QueryProgress'

import {
  publishQueryProgress,
  subscribeQueryProgress,
} from './queryProgressBus'

describe('queryProgressBus', () => {
  it('delivers published states to all subscribers', () => {
    const received: QueryProgressState[] = []
    const unsubscribe = subscribeQueryProgress((state) => {
      received.push(state)
    })

    publishQueryProgress({ type: 'querying' })
    publishQueryProgress({ type: 'idle' })

    expect(received).toEqual([{ type: 'querying' }, { type: 'idle' }])
    unsubscribe()
  })

  it('stops delivering after unsubscribe', () => {
    const listener = jest.fn()
    const unsubscribe = subscribeQueryProgress(listener)

    unsubscribe()
    publishQueryProgress({ type: 'querying' })

    expect(listener).not.toHaveBeenCalled()
  })
})
