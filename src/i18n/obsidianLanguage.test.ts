import { getLanguage } from 'obsidian'

import { resolveObsidianLanguage } from './obsidianLanguage'

describe('resolveObsidianLanguage', () => {
  afterEach(() => {
    ;(getLanguage as jest.Mock).mockReturnValue('en')
  })

  it('maps zh variants to zh', () => {
    ;(getLanguage as jest.Mock).mockReturnValue('zh-CN')
    expect(resolveObsidianLanguage()).toBe('zh')
    ;(getLanguage as jest.Mock).mockReturnValue('zh')
    expect(resolveObsidianLanguage()).toBe('zh')
  })

  it('maps it variants to it', () => {
    ;(getLanguage as jest.Mock).mockReturnValue('it-IT')
    expect(resolveObsidianLanguage()).toBe('it')
  })

  it('falls back to en for anything else', () => {
    ;(getLanguage as jest.Mock).mockReturnValue('fr')
    expect(resolveObsidianLanguage()).toBe('en')
    ;(getLanguage as jest.Mock).mockReturnValue('')
    expect(resolveObsidianLanguage()).toBe('en')
    ;(getLanguage as jest.Mock).mockReturnValue(null)
    expect(resolveObsidianLanguage()).toBe('en')
  })
})
