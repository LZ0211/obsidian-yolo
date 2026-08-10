import { QQOfficialAdapter } from './qqofficial-adapter'

describe('QQOfficialAdapter listener cleanup', () => {
  it('does not remove the last listener when an unsubscribe is called twice', () => {
    const adapter = new QQOfficialAdapter()
    const first = jest.fn()
    const second = jest.fn()
    const unsubscribeFirst = adapter.onMessage(first)
    adapter.onMessage(second)

    unsubscribeFirst()
    unsubscribeFirst()

    expect(
      (adapter as unknown as { messageHandlers: unknown[] }).messageHandlers,
    ).toHaveLength(1)
  })

  it('keeps error listeners intact after repeated cleanup', () => {
    const adapter = new QQOfficialAdapter()
    const first = jest.fn()
    const second = jest.fn()
    const unsubscribeFirst = adapter.onError(first)
    adapter.onError(second)

    unsubscribeFirst()
    unsubscribeFirst()

    expect(
      (adapter as unknown as { errorHandlers: unknown[] }).errorHandlers,
    ).toHaveLength(1)
  })
})
