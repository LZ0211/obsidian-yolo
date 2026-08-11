import type { WebVaultListItem } from '../runtime/web/WebApiClient'

import {
  applyPathMove,
  classifyPreviewKind,
  classifyPreviewKindByPath,
  clearDeletedPath,
  compareVaultItems,
  formatFileSize,
  getParentPath,
  isHiddenVaultPath,
  joinVaultPath,
  normalizeVaultPath,
  rewritePathSet,
  toApiFolderPath,
} from './webWorkspaceUtils'

const file = (
  path: string,
  stat?: { mtime: number; size: number },
): WebVaultListItem => ({
  kind: 'file',
  path,
  name: path.split('/').pop() ?? path,
  extension: path.includes('.') ? path.split('.').pop() : undefined,
  stat: stat
    ? { ctime: stat.mtime, mtime: stat.mtime, size: stat.size }
    : undefined,
})

const folder = (path: string): WebVaultListItem => ({
  kind: 'folder',
  path,
  name: path.split('/').pop() ?? path,
})

describe('web workspace path helpers', () => {
  it('normalizes shell root and rejects traversal-like paths', () => {
    expect(normalizeVaultPath('')).toBe('')
    expect(normalizeVaultPath('/')).toBe('')
    expect(normalizeVaultPath('notes/today.md')).toBe('notes/today.md')
    expect(() => normalizeVaultPath('/notes')).toThrow('absolute')
    expect(() => normalizeVaultPath('notes//today.md')).toThrow('empty segment')
    expect(() => normalizeVaultPath('notes\\today.md')).toThrow('backslash')
    expect(() => normalizeVaultPath('../secret.md')).toThrow('traversal')
    expect(() => normalizeVaultPath('a/../secret.md')).toThrow('traversal')
  })

  it('converts shell root to API root only at the boundary', () => {
    expect(toApiFolderPath('')).toBe('/')
    expect(toApiFolderPath('notes')).toBe('notes')
  })

  it('joins and parents vault paths without introducing slash root state', () => {
    expect(joinVaultPath('', 'note.md')).toBe('note.md')
    expect(joinVaultPath('folder', 'note.md')).toBe('folder/note.md')
    expect(getParentPath('folder/note.md')).toBe('folder')
    expect(getParentPath('note.md')).toBe('')
  })

  it('filters dot-prefixed hidden path segments defensively', () => {
    expect(isHiddenVaultPath('.env')).toBe(true)
    expect(isHiddenVaultPath('notes/.draft/today.md')).toBe(true)
    expect(isHiddenVaultPath('notes/today.md')).toBe(false)
  })
})

describe('web workspace item helpers', () => {
  it('keeps folders before files and sorts by requested key', () => {
    const items = [
      file('b.md', { mtime: 2, size: 20 }),
      folder('z'),
      file('a.txt', { mtime: 1, size: 10 }),
      folder('a'),
    ]
    expect(
      [...items]
        .sort((a, b) => compareVaultItems(a, b, 'name', 'asc'))
        .map((item) => item.path),
    ).toEqual(['a', 'z', 'a.txt', 'b.md'])
    expect(
      [...items]
        .sort((a, b) => compareVaultItems(a, b, 'size', 'desc'))
        .map((item) => item.path),
    ).toEqual(['z', 'a', 'b.md', 'a.txt'])
    expect(
      [...items]
        .sort((a, b) => compareVaultItems(a, b, 'name', 'desc'))
        .map((item) => item.path),
    ).toEqual(['z', 'a', 'b.md', 'a.txt'])
  })

  it('classifies svg as unsupported and html as text fallback previews', () => {
    expect(classifyPreviewKind(file('vector.svg'))).toBe('unsupported')
    expect(classifyPreviewKind(file('page.html'))).toBe('text')
    expect(classifyPreviewKind(file('notes/today.md'))).toBe('markdown')
    expect(classifyPreviewKind(file('notes/today.txt'))).toBe('text')
    expect(classifyPreviewKind(file('image.png'))).toBe('image')
    expect(classifyPreviewKind(file('paper.pdf'))).toBe('pdf')
  })

  it('rewrites descendant paths after folder moves', () => {
    expect(applyPathMove('folder/a.md', 'folder', 'archive')).toBe(
      'archive/a.md',
    )
    expect(applyPathMove('folder/nested/a.md', 'folder', 'archive')).toBe(
      'archive/nested/a.md',
    )
    expect(applyPathMove('other/a.md', 'folder', 'archive')).toBe('other/a.md')
  })

  it('formats file sizes compactly', () => {
    expect(formatFileSize(12)).toBe('12 B')
    expect(formatFileSize(1536)).toBe('1.5 KB')
    expect(formatFileSize(2 * 1024 * 1024)).toBe('2.0 MB')
  })

  it('classifyPreviewKindByPath returns text for new extensions and unsupported for svg', () => {
    expect(classifyPreviewKindByPath('foo.html')).toBe('text')
    expect(classifyPreviewKindByPath('foo.htm')).toBe('text')
    expect(classifyPreviewKindByPath('foo.py')).toBe('text')
    expect(classifyPreviewKindByPath('foo.scss')).toBe('text')
    expect(classifyPreviewKindByPath('foo.less')).toBe('text')
    expect(classifyPreviewKindByPath('foo.svg')).toBe('unsupported')
  })

  it('classifyPreviewKind returns text for html file items', () => {
    expect(
      classifyPreviewKind({
        kind: 'file',
        path: 'a.html',
        name: 'a.html',
        extension: 'html',
      }),
    ).toBe('text')
  })
})

describe('web workspace path state transitions', () => {
  it('rewrites sets when folder ancestors move', () => {
    expect(
      Array.from(
        rewritePathSet(
          new Set(['folder', 'folder/a', 'other']),
          'folder',
          'archive',
        ),
      ).sort(),
    ).toEqual(['archive', 'archive/a', 'other'])
  })

  it('clears targets deleted directly or by ancestor', () => {
    expect(clearDeletedPath('folder/a.md', 'folder')).toBeNull()
    expect(clearDeletedPath('folder/a.md', 'folder/a.md')).toBeNull()
    expect(clearDeletedPath('other/a.md', 'folder')).toBe('other/a.md')
  })
})
