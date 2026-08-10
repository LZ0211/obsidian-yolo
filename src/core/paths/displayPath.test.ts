import { fromDisplayPath, toDisplayPath } from './displayPath'

describe('toDisplayPath', () => {
  it('renders the home directory itself as ~', () => {
    expect(toDisplayPath('04-专利', '04-专利')).toBe('~')
  })

  it('renders paths inside home as home-relative with ~/ prefix', () => {
    expect(toDisplayPath('04-专利/a.md', '04-专利')).toBe('~/a.md')
    expect(toDisplayPath('04-专利/sub/deep.md', '04-专利')).toBe(
      '~/sub/deep.md',
    )
  })

  it('passes paths outside home through as absolute', () => {
    expect(toDisplayPath('00-Email/a.md', '04-专利')).toBe('00-Email/a.md')
  })

  it('passes paths through unchanged when home is empty', () => {
    expect(toDisplayPath('Notes/a.md', '')).toBe('Notes/a.md')
  })
})

describe('fromDisplayPath', () => {
  it('resolves ~ back to the home directory', () => {
    expect(fromDisplayPath('~', '04-专利')).toBe('04-专利')
  })

  it('resolves ~/ paths back to home-absolute form', () => {
    expect(fromDisplayPath('~/a.md', '04-专利')).toBe('04-专利/a.md')
    expect(fromDisplayPath('~/sub/deep.md', '04-专利')).toBe(
      '04-专利/sub/deep.md',
    )
  })

  it('passes non-~ paths through as-is', () => {
    expect(fromDisplayPath('00-Email/a.md', '04-专利')).toBe('00-Email/a.md')
    expect(fromDisplayPath('Notes/a.md', '')).toBe('Notes/a.md')
  })
})
