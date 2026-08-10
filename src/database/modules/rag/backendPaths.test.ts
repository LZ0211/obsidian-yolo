import { getSqliteDbPath, getSqliteNamespaceDir } from './backendPaths'

describe('backendPaths', () => {
  const baseDir = 'C:\\vault\\.obsidian\\plugins\\smart-rag'
  const id = '0123456789abcdef0123456789abcdef'

  it('builds the sqlite namespace dir under rag/<namespace_id>', () => {
    expect(getSqliteNamespaceDir(baseDir, id)).toBe(
      'C:/vault/.obsidian/plugins/smart-rag/rag/0123456789abcdef0123456789abcdef',
    )
  })

  it('builds the sqlite path as <baseDir>/rag/<namespace_id>/rag.sqlite', () => {
    expect(getSqliteDbPath(baseDir, id)).toBe(
      'C:/vault/.obsidian/plugins/smart-rag/rag/0123456789abcdef0123456789abcdef/rag.sqlite',
    )
  })
})
