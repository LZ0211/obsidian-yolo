import { enforceBuiltinToolSecurityBoundary } from './security-boundary'

const workspacePolicy = {
  enabled: true,
  workspaceRoot: '04-专利',
  readExtraIncludes: [] as string[],
  readExcludes: [] as string[],
  writeExcludes: [] as string[],
}

describe('enforceBuiltinToolSecurityBoundary', () => {
  it('rejects a write to a vault-absolute path outside the workspace root', () => {
    expect(() =>
      enforceBuiltinToolSecurityBoundary(
        'fs_write',
        { path: '/00-Email/x.md', content: 'x' },
        { workspaceAccessPolicy: workspacePolicy },
      ),
    ).toThrow('Path "/00-Email/x.md" is outside this agent\'s workspace scope.')
  })

  it('allows a write inside the workspace root', () => {
    expect(() =>
      enforceBuiltinToolSecurityBoundary(
        'fs_write',
        { path: '04-专利/ok.md', content: 'x' },
        { workspaceAccessPolicy: workspacePolicy },
      ),
    ).not.toThrow()
  })

  it('skips the workspace policy check for fs_read raw paths (checked per resolved file)', () => {
    expect(() =>
      enforceBuiltinToolSecurityBoundary(
        'fs_read',
        { paths: ['/00-Email/x.md'] },
        { workspaceAccessPolicy: workspacePolicy },
      ),
    ).not.toThrow()
  })

  it('exempts allowed skill paths from the workspace policy check', () => {
    expect(() =>
      enforceBuiltinToolSecurityBoundary(
        'fs_write',
        { path: 'YOLO/skills/demo/SKILL.md', content: 'x' },
        {
          workspaceAccessPolicy: workspacePolicy,
          allowedSkillPaths: ['YOLO/skills/demo/SKILL.md'],
        },
      ),
    ).not.toThrow()
  })

  it('rejects a write into the YOLO user-data root as a plain not-found', () => {
    expect(() =>
      enforceBuiltinToolSecurityBoundary(
        'fs_edit',
        { path: 'YOLO/data/chat.json', newText: 'x' },
        {},
      ),
    ).toThrow('File not found: YOLO/data/chat.json')
  })

  it('denies a literal fs_read path inside the user-data root at the boundary', () => {
    // The hidden check applies unconditionally to every tool, fs_read
    // included: literal paths are caught here with the same not-found
    // disguise; wikilink targets (not literal paths) fall through to the
    // per-resolved-file check inside fs_read itself.
    expect(() =>
      enforceBuiltinToolSecurityBoundary(
        'fs_read',
        { paths: ['YOLO/data/chat.json'] },
        {},
      ),
    ).toThrow('File not found: YOLO/data/chat.json')
  })

  it('does not reject tools that carry no path args', () => {
    expect(() =>
      enforceBuiltinToolSecurityBoundary(
        'memory_add',
        { content: 'hello' },
        { workspaceAccessPolicy: workspacePolicy },
      ),
    ).not.toThrow()
  })

  it('no-ops when no policy or settings are provided', () => {
    expect(() =>
      enforceBuiltinToolSecurityBoundary(
        'fs_write',
        { path: '/00-Email/x.md', content: 'x' },
        {},
      ),
    ).not.toThrow()
  })

  it('respects readExcludes for the read side of mineru_convert', () => {
    const policyWithReadExclude = {
      ...workspacePolicy,
      readExcludes: ['禁止阅读'],
    }
    expect(() =>
      enforceBuiltinToolSecurityBoundary(
        'mineru_convert',
        { inputPath: '/禁止阅读/a.pdf', outputDir: '04-专利/out' },
        { workspaceAccessPolicy: policyWithReadExclude },
      ),
    ).toThrow(
      'Path "/禁止阅读/a.pdf" is outside this agent\'s workspace scope.',
    )
  })
})
