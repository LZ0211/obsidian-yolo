import {
  hasParentSubagentDeadline,
  isParentSubagentDelegationBlocked,
  recordParentSubagentTimeout,
  registerParentSubagentDeadline,
  resetParentSubagentBreakers,
  resetParentSubagentDeadlines,
  resetParentSubagentTimeoutConfig,
  resetParentSubagentTimeoutSettingsGetter,
  setParentSubagentTimeoutSettingsGetter,
} from './pending-timeout-registry'

describe('parent subagent timeout config (settings getter)', () => {
  beforeEach(() => {
    resetParentSubagentTimeoutSettingsGetter()
    resetParentSubagentTimeoutConfig()
    resetParentSubagentBreakers()
  })

  afterEach(() => {
    resetParentSubagentDeadlines()
    resetParentSubagentBreakers()
    resetParentSubagentTimeoutConfig()
    resetParentSubagentTimeoutSettingsGetter()
    jest.useRealTimers()
  })

  it('registers a deadline at the timeout read from the settings getter (no restart)', () => {
    jest.useFakeTimers().setSystemTime(0)
    const onExpire = jest.fn()
    setParentSubagentTimeoutSettingsGetter(() => ({ timeoutMs: 4_000 }))

    registerParentSubagentDeadline({
      toolCallId: 'tc-config',
      conversationId: 'conv',
      onExpire,
    })
    expect(hasParentSubagentDeadline('tc-config')).toBe(true)

    // t=3999 < deadlineAt (0 + 4000): not yet expired.
    jest.advanceTimersByTime(3_999)
    expect(onExpire).not.toHaveBeenCalled()

    // t=4000: the getter-driven deadline trips.
    jest.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    expect(onExpire).toHaveBeenCalledWith({
      toolCallId: 'tc-config',
      conversationId: 'conv',
    })
  })

  it('records timeouts against the breaker using the settings-getter maxConsecutive', () => {
    setParentSubagentTimeoutSettingsGetter(() => ({
      maxConsecutiveTimeouts: 3,
      cooldownMs: 5_000,
    }))

    // Default maxConsecutive is 2; the getter raises it to 3.
    recordParentSubagentTimeout('conv')
    recordParentSubagentTimeout('conv')
    expect(isParentSubagentDelegationBlocked('conv')).toBe(false)

    recordParentSubagentTimeout('conv')
    expect(isParentSubagentDelegationBlocked('conv')).toBe(true)
  })
})
