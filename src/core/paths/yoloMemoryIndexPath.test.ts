jest.mock('obsidian')

import { FileSystemAdapter } from 'obsidian'

import { getAbsoluteYoloMemoryIndexPath } from './yoloPaths'

class TestFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }

  override getBasePath(): string {
    return this.basePath
  }
}

describe('getAbsoluteYoloMemoryIndexPath', () => {
  it('resolves an absolute path under the vault root on desktop', () => {
    const app = {
      vault: { adapter: new TestFileSystemAdapter('/vault') },
    } as never
    expect(
      getAbsoluteYoloMemoryIndexPath(app, { yolo: { baseDir: 'YOLO' } }),
    ).toBe('/vault/YOLO/memory/index.sqlite')
  })

  it('falls back to the vault-relative path when no FileSystemAdapter exists (mobile)', () => {
    const app = { vault: { adapter: {} } } as never
    expect(
      getAbsoluteYoloMemoryIndexPath(app, { yolo: { baseDir: 'YOLO' } }),
    ).toBe('YOLO/memory/index.sqlite')
    expect(
      getAbsoluteYoloMemoryIndexPath(app, { yolo: { baseDir: 'YOLO' } }),
    ).not.toBeNull()
  })
})
