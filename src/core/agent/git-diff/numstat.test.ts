import { parseGitNumstat } from './numstat'

describe('parseGitNumstat', () => {
  it('parses text and binary file statistics', () => {
    expect(parseGitNumstat('12\t3\tNotes/a.md\0-\t-\tAssets/a.png\0')).toEqual([
      {
        path: 'Notes/a.md',
        additions: 12,
        deletions: 3,
        binary: false,
      },
      {
        path: 'Assets/a.png',
        additions: 0,
        deletions: 0,
        binary: true,
      },
    ])
  })

  it('parses rename statistics with old and new paths', () => {
    expect(parseGitNumstat('4\t1\t\0Notes/old.md\0Notes/new.md\0')).toEqual([
      {
        oldPath: 'Notes/old.md',
        path: 'Notes/new.md',
        additions: 4,
        deletions: 1,
        binary: false,
      },
    ])
  })

  it('preserves tabs in a normal file path', () => {
    expect(parseGitNumstat('7\t2\tNotes/with\ttab.md\0')).toEqual([
      {
        path: 'Notes/with\ttab.md',
        additions: 7,
        deletions: 2,
        binary: false,
      },
    ])
  })

  it('preserves tabs in rename paths', () => {
    expect(
      parseGitNumstat('4\t1\t\0Notes/old\tname.md\0Notes/new\tname.md\0'),
    ).toEqual([
      {
        oldPath: 'Notes/old\tname.md',
        path: 'Notes/new\tname.md',
        additions: 4,
        deletions: 1,
        binary: false,
      },
    ])
  })

  it('ignores an incomplete record without throwing', () => {
    expect(parseGitNumstat('4\t1')).toEqual([])
  })
})
