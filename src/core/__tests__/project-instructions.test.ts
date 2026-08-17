import { App, TFile, TFolder } from 'obsidian'

import { WorkspaceAccessPolicy } from '../../types/assistant.types'
import { getProjectInstructionsSection } from '../project-instructions'

type FileMap = Record<string, string>

/**
 * Build a minimal Obsidian App mock that knows about a flat map of files and
 * derives folders from their parent paths. Folders carry a real `parent`
 * pointer so cascade walks work as in the real Vault.
 */
function createApp(files: FileMap): App {
  // Collect every folder path implied by the file map.
  const folderPaths = new Set<string>([''])
  for (const filePath of Object.keys(files)) {
    const parts = filePath.split('/')
    parts.pop()
    let acc = ''
    for (const part of parts) {
      acc = acc === '' ? part : `${acc}/${part}`
      folderPaths.add(acc)
    }
  }

  const folderCache = new Map<string, TFolder>()
  function makeFolder(path: string): TFolder {
    const cached = folderCache.get(path)
    if (cached) return cached
    const folder = new (TFolder as unknown as new () => TFolder)()
    ;(folder as unknown as { path: string }).path = path
    folderCache.set(path, folder)
    return folder
  }
  // Wire up parents after the folder set is known.
  for (const path of folderPaths) {
    const folder = makeFolder(path)
    if (path === '') {
      ;(folder as unknown as { parent: TFolder | null }).parent = null
    } else {
      const parentPath = path.includes('/')
        ? path.slice(0, path.lastIndexOf('/'))
        : ''
      ;(folder as unknown as { parent: TFolder }).parent =
        makeFolder(parentPath)
    }
  }

  const getAbstractFileByPath = jest.fn((path: string) => {
    if (path in files) {
      const file = new (TFile as unknown as new () => TFile)()
      ;(file as unknown as { path: string }).path = path
      const parentPath = path.includes('/')
        ? path.slice(0, path.lastIndexOf('/'))
        : ''
      ;(file as unknown as { parent: TFolder }).parent = makeFolder(parentPath)
      return file
    }
    if (folderPaths.has(path)) return makeFolder(path)
    return null
  })

  const cachedRead = jest.fn(async (file: TFile) => {
    const path = (file as unknown as { path: string }).path
    return files[path] ?? ''
  })

  const getRoot = jest.fn(() => makeFolder(''))

  return {
    vault: { getAbstractFileByPath, cachedRead, getRoot },
  } as unknown as App
}

const scope = (
  overrides: Partial<WorkspaceAccessPolicy>,
): WorkspaceAccessPolicy => ({
  enabled: true,
  workspaceRoot: '',
  readExtraIncludes: [],
  readExcludes: [],
  writeExcludes: [],
  ...overrides,
})

describe('getProjectInstructionsSection', () => {
  it('returns empty string when disabled', async () => {
    const app = createApp({ 'CLAUDE.md': 'do the thing' })
    expect(await getProjectInstructionsSection(app, false)).toBe('')
  })

  it('returns empty string when no instruction files exist', async () => {
    const app = createApp({})
    expect(await getProjectInstructionsSection(app, true)).toBe('')
  })

  it('includes vault root CLAUDE.md when present', async () => {
    const app = createApp({ 'CLAUDE.md': 'use 2-space indent' })
    const result = await getProjectInstructionsSection(app, true)
    expect(result).toContain('## Project instructions: CLAUDE.md')
    expect(result).toContain('use 2-space indent')
  })

  it('includes vault root AGENTS.md when present', async () => {
    const app = createApp({ 'AGENTS.md': 'follow the contract' })
    const result = await getProjectInstructionsSection(app, true)
    expect(result).toContain('## Project instructions: AGENTS.md')
    expect(result).toContain('follow the contract')
  })

  it('concatenates root files with AGENTS.md first', async () => {
    const app = createApp({
      'AGENTS.md': 'rule A',
      'CLAUDE.md': 'rule C',
    })
    const result = await getProjectInstructionsSection(app, true)
    const agentsIdx = result.indexOf('## Project instructions: AGENTS.md')
    const claudeIdx = result.indexOf('## Project instructions: CLAUDE.md')
    expect(agentsIdx).toBeGreaterThan(-1)
    expect(claudeIdx).toBeGreaterThan(-1)
    expect(agentsIdx).toBeLessThan(claudeIdx)
  })

  it('skips empty files', async () => {
    const app = createApp({
      'AGENTS.md': '   \n  ',
      'CLAUDE.md': 'real content',
    })
    const result = await getProjectInstructionsSection(app, true)
    expect(result).not.toContain('## Project instructions: AGENTS.md')
    expect(result).toContain('## Project instructions: CLAUDE.md')
  })

  it('does not authorize override of system safety', async () => {
    const app = createApp({ 'CLAUDE.md': 'rule' })
    const result = await getProjectInstructionsSection(app, true)
    expect(result.toLowerCase()).not.toMatch(/override.*default/)
    expect(result.toLowerCase()).not.toMatch(/must follow.*exactly/)
  })

  it('ignores workspace scope when disabled', async () => {
    const app = createApp({
      'CLAUDE.md': 'root rule',
      'projects/web/CLAUDE.md': 'web rule',
    })
    const result = await getProjectInstructionsSection(
      app,
      true,
      scope({ enabled: false, readExtraIncludes: ['projects/web'] }),
    )
    expect(result).toContain('root rule')
    expect(result).not.toContain('web rule')
  })

  it('only loads vault root when scope enabled but include is empty', async () => {
    const app = createApp({
      'CLAUDE.md': 'root rule',
      'projects/web/CLAUDE.md': 'web rule',
    })
    const result = await getProjectInstructionsSection(
      app,
      true,
      scope({ enabled: true, readExcludes: ['secrets'] }),
    )
    expect(result).toContain('root rule')
    expect(result).not.toContain('web rule')
  })

  it('cascades from vault root through each ancestor of the include directory', async () => {
    const app = createApp({
      'AGENTS.md': 'root agents',
      'projects/AGENTS.md': 'projects agents',
      'projects/web/CLAUDE.md': 'web claude',
    })
    const result = await getProjectInstructionsSection(
      app,
      true,
      scope({ readExtraIncludes: ['projects/web'] }),
    )
    const rootIdx = result.indexOf('root agents')
    const midIdx = result.indexOf('projects agents')
    const leafIdx = result.indexOf('web claude')
    expect(rootIdx).toBeGreaterThan(-1)
    expect(midIdx).toBeGreaterThan(rootIdx)
    expect(leafIdx).toBeGreaterThan(midIdx)
    expect(result).toContain('## Project instructions: projects/AGENTS.md')
    expect(result).toContain('## Project instructions: projects/web/CLAUDE.md')
  })

  it('treats a file include by walking to its parent directory', async () => {
    const app = createApp({
      'projects/web/AGENTS.md': 'web agents',
      'projects/web/notes/topic.md': 'just data',
    })
    const result = await getProjectInstructionsSection(
      app,
      true,
      scope({ readExtraIncludes: ['projects/web/notes/topic.md'] }),
    )
    // 'topic.md' parent is 'projects/web/notes' — chain goes root -> projects -> projects/web -> projects/web/notes
    expect(result).toContain('## Project instructions: projects/web/AGENTS.md')
    expect(result).toContain('web agents')
  })

  it('dedupes shared ancestors across multiple includes', async () => {
    const app = createApp({
      'projects/AGENTS.md': 'shared parent rule',
      'projects/a/CLAUDE.md': 'a rule',
      'projects/b/CLAUDE.md': 'b rule',
    })
    const result = await getProjectInstructionsSection(
      app,
      true,
      scope({ readExtraIncludes: ['projects/a', 'projects/b'] }),
    )
    // shared parent should appear exactly once
    const parentMatches = result.match(/shared parent rule/g) ?? []
    expect(parentMatches.length).toBe(1)
    expect(result).toContain('a rule')
    expect(result).toContain('b rule')
    // include order is preserved: a before b
    expect(result.indexOf('a rule')).toBeLessThan(result.indexOf('b rule'))
  })

  it('skips an include shadowed by an exclude rule', async () => {
    const app = createApp({
      'CLAUDE.md': 'root rule',
      'secrets/CLAUDE.md': 'secret rule',
    })
    const result = await getProjectInstructionsSection(
      app,
      true,
      scope({ readExtraIncludes: ['secrets'], readExcludes: ['secrets'] }),
    )
    expect(result).toContain('root rule')
    expect(result).not.toContain('secret rule')
  })

  it('skips includes that do not exist in the vault', async () => {
    const app = createApp({ 'CLAUDE.md': 'root rule' })
    const result = await getProjectInstructionsSection(
      app,
      true,
      scope({ readExtraIncludes: ['ghost/folder'] }),
    )
    expect(result).toContain('root rule')
  })

  it('truncates and marks when total exceeds 32 KiB cap', async () => {
    const big = 'x'.repeat(20 * 1024)
    const app = createApp({
      'AGENTS.md': big,
      'CLAUDE.md': big, // together > 32 KiB
    })
    const result = await getProjectInstructionsSection(app, true)
    expect(result).toContain('Project instructions truncated')
    // First block fits; the second should be dropped entirely.
    expect(
      result.indexOf('## Project instructions: AGENTS.md'),
    ).toBeGreaterThan(-1)
    expect(result.indexOf('## Project instructions: CLAUDE.md')).toBe(-1)
    // Final output (including the truncation note) must stay within the cap.
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(
      32 * 1024,
    )
  })

  it('keeps final byte length under cap even when only one giant file exists', async () => {
    // A single 100 KiB file forces the head-truncation branch.
    const huge = 'y'.repeat(100 * 1024)
    const app = createApp({ 'AGENTS.md': huge })
    const result = await getProjectInstructionsSection(app, true)
    expect(result).toContain('Project instructions truncated')
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(
      32 * 1024,
    )
  })

  it('truncates a multi-byte first section without splitting characters', async () => {
    // '汉' is 3 bytes in UTF-8 → 30k of them is ~90 KiB on the wire.
    const multibyte = '汉'.repeat(30 * 1024)
    const app = createApp({ 'AGENTS.md': multibyte })
    const result = await getProjectInstructionsSection(app, true)
    expect(result).toContain('Project instructions truncated')
    const bytes = new TextEncoder().encode(result).length
    expect(bytes).toBeLessThanOrEqual(32 * 1024)
    // No replacement char or split surrogate should appear.
    expect(result).not.toContain('�')
  })

  it('treats an empty/root exclude rule as blocking every include', async () => {
    const app = createApp({
      'CLAUDE.md': 'root rule',
      'projects/web/CLAUDE.md': 'web rule',
    })
    const result = await getProjectInstructionsSection(
      app,
      true,
      scope({ readExtraIncludes: ['projects/web'], readExcludes: ['/'] }),
    )
    // vault root chain still loads (it's always added before exclude is checked)
    expect(result).toContain('root rule')
    // include shadowed by root-level exclude → skipped
    expect(result).not.toContain('web rule')
  })

  it('tolerates include entries with surrounding whitespace and slashes', async () => {
    const app = createApp({
      'projects/web/CLAUDE.md': 'web rule',
    })
    const result = await getProjectInstructionsSection(
      app,
      true,
      scope({ readExtraIncludes: ['  /projects/web/  '] }),
    )
    expect(result).toContain('## Project instructions: projects/web/CLAUDE.md')
    expect(result).toContain('web rule')
  })
})
