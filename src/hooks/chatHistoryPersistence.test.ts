import { shouldSkipCreatingEmptyConversation } from './chatHistoryPersistence'

describe('empty conversation persistence', () => {
  it('keeps a metadata-only empty conversation when overrides are meaningful', () => {
    expect(
      shouldSkipCreatingEmptyConversation(0, false, {
        workingDirectory: '/Projects/demo',
      }),
    ).toBe(false)
  })

  it('skips an untouched empty conversation', () => {
    expect(shouldSkipCreatingEmptyConversation(0, false, null)).toBe(true)
  })
})
