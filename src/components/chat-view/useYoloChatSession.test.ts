import { clearConversationLoadingIfCurrent } from './useYoloChatSession'

describe('conversation loading cleanup', () => {
  it('does not let an obsolete load clear the newer load indicator', () => {
    const setLoading = jest.fn()

    clearConversationLoadingIfCurrent(() => false, setLoading)

    expect(setLoading).not.toHaveBeenCalled()
  })

  it('clears the indicator for the current load', () => {
    const setLoading = jest.fn()

    clearConversationLoadingIfCurrent(() => true, setLoading)

    expect(setLoading).toHaveBeenCalledWith(false)
  })
})
