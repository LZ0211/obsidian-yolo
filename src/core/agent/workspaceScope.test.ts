import {
  AssistantWorkspaceScope,
  WorkspaceAccessPolicy,
} from '../../types/assistant.types'
import { getProtectedVaultPathRules } from '../paths/protectedPaths'

import {
  collectToolCallPaths,
  collectToolCallPathsWithModes,
  findPathOutsideScope,
  isPathAllowedByScope,
  isReadablePath,
  isWorkspaceScopeActive,
  isWritablePath,
  normalizeWorkspacePath,
  resolveReadablePath,
  resolveWritablePath,
} from './workspaceScope'

const scope = (
  override: Partial<AssistantWorkspaceScope>,
): AssistantWorkspaceScope => ({
  enabled: true,
  include: [],
  exclude: [],
  ...override,
})

describe('isPathAllowedByScope', () => {
  it('allows everything when scope is undefined or disabled', () => {
    expect(isPathAllowedByScope('foo/bar.md', undefined)).toBe(true)
    expect(
      isPathAllowedByScope(
        'foo/bar.md',
        scope({ enabled: false, include: ['allowed/'] }),
      ),
    ).toBe(true)
  })

  it('whitelists only include paths (exact + prefix) when enabled', () => {
    const s = scope({ include: ['Projects'] })
    expect(isPathAllowedByScope('Projects', s)).toBe(true)
    expect(isPathAllowedByScope('Projects/a.md', s)).toBe(true)
    expect(isPathAllowedByScope('ProjectsX/a.md', s)).toBe(false)
    expect(isPathAllowedByScope('Notes/a.md', s)).toBe(false)
  })

  it('treats empty include as "allow everything not excluded" (blacklist mode)', () => {
    const s = scope({ exclude: ['Private'] })
    expect(isPathAllowedByScope('Notes/a.md', s)).toBe(true)
    expect(isPathAllowedByScope('Private/a.md', s)).toBe(false)
  })

  it('applies exclude with higher priority than include', () => {
    const s = scope({
      include: ['Projects'],
      exclude: ['Projects/Private'],
    })
    expect(isPathAllowedByScope('Projects/public.md', s)).toBe(true)
    expect(isPathAllowedByScope('Projects/Private/secret.md', s)).toBe(false)
  })

  it('normalizes leading and trailing slashes on both path and rule', () => {
    const s = scope({ include: ['/Projects/'] })
    expect(isPathAllowedByScope('/Projects/a.md', s)).toBe(true)
    expect(isPathAllowedByScope('Projects', s)).toBe(true)
  })
})

describe('isWorkspaceScopeActive', () => {
  it('returns false when disabled or empty', () => {
    expect(isWorkspaceScopeActive(undefined)).toBe(false)
    expect(isWorkspaceScopeActive(scope({ enabled: false }))).toBe(false)
    expect(isWorkspaceScopeActive(scope({}))).toBe(false)
  })

  it('returns true when enabled with any rule', () => {
    expect(isWorkspaceScopeActive(scope({ include: ['a'] }))).toBe(true)
    expect(isWorkspaceScopeActive(scope({ exclude: ['b'] }))).toBe(true)
  })
})

describe('collectToolCallPaths', () => {
  it('returns empty array for unknown tools', () => {
    expect(collectToolCallPaths('unknown', { path: 'x' })).toEqual([])
  })

  it('extracts single path from top-level string args', () => {
    expect(collectToolCallPaths('fs_edit', { path: 'a/b.md' })).toEqual([
      'a/b.md',
    ])
    expect(collectToolCallPaths('fs_write', { path: 'a/b' })).toEqual(['a/b'])
  })

  it('extracts array path from fs_read.paths', () => {
    expect(
      collectToolCallPaths('fs_read', { paths: ['a.md', 'b.md'] }),
    ).toEqual(['a.md', 'b.md'])
  })

  it('extracts inputPath + outputDir for mineru_convert', () => {
    expect(
      collectToolCallPaths('mineru_convert', {
        inputPath: 'a.pdf',
        outputDir: 'b',
      }),
    ).toEqual(['a.pdf', 'b'])
  })

  it('ignores empty strings and non-string values', () => {
    expect(collectToolCallPaths('fs_edit', { path: '  ' })).toEqual([])
    expect(
      collectToolCallPaths('fs_read', { paths: ['a.md', 42, null] }),
    ).toEqual(['a.md'])
  })

  it('returns empty for retired built-in tool names (no live tool owns them)', () => {
    expect(collectToolCallPaths('fs_delete', { path: 'a.md' })).toEqual([])
    expect(
      collectToolCallPaths('fs_file_ops', {
        action: 'move',
        oldPath: 'a.md',
        newPath: 'b.md',
      }),
    ).toEqual([])
    expect(collectToolCallPaths('fs_list', { path: 'a/b' })).toEqual([])
  })
})

describe('collectToolCallPathsWithModes', () => {
  it('marks every key read for a non-write tool', () => {
    expect(
      collectToolCallPathsWithModes(
        'fs_read',
        { paths: ['a.md', 'b.md'] },
        false,
      ),
    ).toEqual([
      { path: 'a.md', mode: 'read' },
      { path: 'b.md', mode: 'read' },
    ])
  })

  it('marks every key write for a write tool without read keys', () => {
    expect(
      collectToolCallPathsWithModes('fs_write', { path: 'a.md' }, true),
    ).toEqual([{ path: 'a.md', mode: 'write' }])
  })

  it('marks mineru_convert inputPath read and outputDir write (read+write hybrid)', () => {
    expect(
      collectToolCallPathsWithModes(
        'mineru_convert',
        { inputPath: 'secret/plan.pdf', outputDir: 'out' },
        true,
      ),
    ).toEqual([
      { path: 'secret/plan.pdf', mode: 'read' },
      { path: 'out', mode: 'write' },
    ])
    // The mode-less view keeps the plain path list contract.
    expect(
      collectToolCallPaths('mineru_convert', {
        inputPath: 'secret/plan.pdf',
        outputDir: 'out',
      }),
    ).toEqual(['secret/plan.pdf', 'out'])
  })

  it('resolves the hybrid input with the read policy and outputDir with the write policy', () => {
    const access = {
      enabled: true,
      workspaceRoot: 'Work',
      readExtraIncludes: [],
      readExcludes: ['Work/Private'],
      writeExcludes: [],
    }
    // inputPath honors readExcludes (read-denied → rejected).
    expect(() => resolveReadablePath('Work/Private/plan.pdf', access)).toThrow(
      /outside/i,
    )
    // outputDir is not read-gated; only the write policy applies to it.
    expect(resolveWritablePath('Work/out', access)).toBe('Work/out')
    // A readable input passes the read resolution.
    expect(resolveReadablePath('Work/plan.pdf', access)).toBe('Work/plan.pdf')
  })
})

describe('findPathOutsideScope', () => {
  it('returns null when scope is disabled', () => {
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['secret/a.md'] },
        scope({ enabled: false, include: ['allowed'] }),
      ),
    ).toBeNull()
  })

  it('returns the first offending path for array args', () => {
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['allowed/a.md', 'secret/b.md', 'allowed/c.md'] },
        scope({ include: ['allowed'] }),
      ),
    ).toBe('secret/b.md')
  })

  it('returns the first offending path for fs_write', () => {
    expect(
      findPathOutsideScope(
        'fs_write',
        { path: 'secret/b.md', content: 'x' },
        scope({ include: ['allowed'] }),
      ),
    ).toBe('secret/b.md')
  })

  it('returns null when all paths are allowed', () => {
    expect(
      findPathOutsideScope(
        'fs_edit',
        { path: 'allowed/a.md', newText: 'x' },
        scope({ include: ['allowed'] }),
      ),
    ).toBeNull()
  })

  it('returns null for retired built-in tool names (no path keys are collected)', () => {
    expect(
      findPathOutsideScope(
        'fs_file_ops',
        { action: 'move', oldPath: 'secret/a.md', newPath: 'secret/b.md' },
        scope({ include: ['allowed'] }),
      ),
    ).toBeNull()
  })

  it('exempts listed skill paths from workspace scope', () => {
    const exemptPaths = new Set(['YOLO/skills/demo/SKILL.md'])
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['YOLO/skills/demo/SKILL.md'] },
        scope({ include: ['Notes'] }),
        { exemptPaths },
      ),
    ).toBeNull()
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['YOLO/skills/demo/references/guide.md'] },
        scope({ include: ['Notes'] }),
        { exemptPaths },
      ),
    ).toBeNull()
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['YOLO/skills/other/SKILL.md'] },
        scope({ include: ['Notes'] }),
        { exemptPaths },
      ),
    ).toBe('YOLO/skills/other/SKILL.md')
  })

  it('exempts builtin skill paths from workspace scope', () => {
    const exemptPaths = new Set(['builtin://skills/skill-creator.md'])
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['builtin://skills/skill-creator.md'] },
        scope({ include: ['Notes'] }),
        { exemptPaths },
      ),
    ).toBeNull()
  })

  it('exempts browser:// paths from workspace scope', () => {
    expect(
      findPathOutsideScope(
        'fs_read',
        { paths: ['browser://page_ab12cd34_ef56gh78'] },
        scope({ include: ['Notes'] }),
      ),
    ).toBeNull()
  })
})

describe('WorkspaceAccessPolicy helpers', () => {
  const policy = (override: {
    enabled?: boolean
    workspaceRoot?: string
    readExtraIncludes?: string[]
    readExcludes?: string[]
    writeExcludes?: string[]
  }) => ({
    enabled: true,
    workspaceRoot: 'Work',
    readExtraIncludes: [],
    readExcludes: [],
    writeExcludes: [],
    ...override,
  })

  it('normalizes valid workspace paths and rejects traversal/OS-absolute paths', () => {
    expect(normalizeWorkspacePath(' Work//Notes/ ')).toBe('Work/Notes')
    expect(normalizeWorkspacePath('')).toBe('')
    expect(() => normalizeWorkspacePath('C:/Work')).toThrow(/invalid/i)
    expect(() => normalizeWorkspacePath('Work\\Notes')).toThrow(/invalid/i)
    expect(() => normalizeWorkspacePath('Work/../Notes')).toThrow(/invalid/i)
    expect(() => normalizeWorkspacePath('Work/./Notes')).toThrow(/invalid/i)
  })

  it('treats "/" as the whole-vault sentinel, same as an empty root', () => {
    // AssistantsSection's workspace agent creation defaults workspaceRoot to
    // '/' when the user leaves it blank; that literal '/' must resolve to
    // vault-root (not throw), otherwise every file under a workspace agent
    // fails isReadablePath and @-mention lists render empty.
    expect(normalizeWorkspacePath('/')).toBe('')
    expect(normalizeWorkspacePath(' / ')).toBe('')

    const rootAccess = policy({ workspaceRoot: '/' })
    expect(isReadablePath('Anything/a.md', rootAccess)).toBe(true)
    expect(isReadablePath('Notes/a.md', rootAccess)).toBe(true)
  })

  it('strips the leading slash from a picked-folder workspaceRoot instead of rejecting it', () => {
    // AgentWorkspaceScopeEditor's folder picker always stores a chosen root as
    // `/<folder>` (see setWorkspaceRoot), e.g. real user data has
    // workspaceRoot: '/04-专利'. This must normalize to 'Notes/Sub', not throw
    // — a real production data.json had this exact shape and got an empty
    // @-mention list before this fix.
    expect(normalizeWorkspacePath('/Notes/Sub')).toBe('Notes/Sub')

    const scopedAccess = policy({ workspaceRoot: '/Notes/Sub' })
    expect(isReadablePath('Notes/Sub/a.md', scopedAccess)).toBe(true)
    expect(isReadablePath('Notes/Sub', scopedAccess)).toBe(true)
    expect(isReadablePath('Other/a.md', scopedAccess)).toBe(false)
  })

  it('allows reads under workspace root and extra includes but excludes denied paths', () => {
    const access = policy({
      workspaceRoot: 'Work',
      readExtraIncludes: ['Shared'],
      readExcludes: ['Work/Private'],
    })

    expect(isReadablePath('Work/a.md', access)).toBe(true)
    expect(isReadablePath('Shared/a.md', access)).toBe(true)
    expect(isReadablePath('Work/Private/a.md', access)).toBe(false)
    expect(isReadablePath('Other/a.md', access)).toBe(false)
    expect(isReadablePath('Work2/a.md', access)).toBe(false)
  })

  it('resolves reads relative to workspace root unless input uses vault-root absolute addressing', () => {
    const access = policy({
      workspaceRoot: 'Work',
      readExtraIncludes: ['Shared'],
    })

    expect(resolveReadablePath('a.md', access)).toBe('Work/a.md')
    expect(resolveReadablePath('Work/a.md', access)).toBe('Work/a.md')
    expect(resolveReadablePath('/Shared/a.md', access)).toBe('Shared/a.md')
    expect(() => resolveReadablePath('/Private/a.md', access)).toThrow(
      /outside/i,
    )
  })

  it('allows global reads and writes when policy is missing or disabled', () => {
    expect(isReadablePath('Anything/a.md', undefined)).toBe(true)
    expect(isWritablePath('Anything/a.md', undefined)).toBe(true)
    expect(isReadablePath('Anything/a.md', policy({ enabled: false }))).toBe(
      true,
    )
    expect(isWritablePath('Anything/a.md', policy({ enabled: false }))).toBe(
      true,
    )
  })

  it('resolves writes under workspaceRoot and rejects paths outside the write root', () => {
    const access = policy({
      workspaceRoot: 'Work',
      readExtraIncludes: ['Shared'],
      writeExcludes: ['Work/Locked'],
    })

    expect(resolveWritablePath('draft.md', access)).toBe('Work/draft.md')
    expect(resolveWritablePath('Work/draft.md', access)).toBe('Work/draft.md')
    expect(resolveWritablePath('Shared/x.md', access)).toBe('Work/Shared/x.md')
    expect(isWritablePath('Work/draft.md', access)).toBe(true)
    expect(() => resolveWritablePath('Locked/x.md', access)).toThrow(/denied/i)
  })

  it('distinguishes relative writes from vault-root absolute writes', () => {
    const access = policy({ workspaceRoot: 'Work' })

    expect(resolveWritablePath('Outside/a.md', access)).toBe(
      'Work/Outside/a.md',
    )
    expect(resolveWritablePath('/Work/a.md', access)).toBe('Work/a.md')
    expect(() => resolveWritablePath('/Outside/a.md', access)).toThrow(
      /outside the workspace write root/i,
    )
  })
})

describe('host-managed protected-path deny', () => {
  const protectedRules = getProtectedVaultPathRules({} as never)

  const denyPolicy = (
    override: Partial<{
      enabled?: boolean
      workspaceRoot?: string
      readExtraIncludes?: string[]
      readExcludes?: string[]
      writeExcludes?: string[]
    }> = {},
  ): WorkspaceAccessPolicy => ({
    enabled: true,
    workspaceRoot: 'Work',
    readExtraIncludes: [],
    readExcludes: [],
    writeExcludes: [],
    ...override,
    protectedPaths: protectedRules,
  })

  it('denies protected paths even when no workspace policy is enabled', () => {
    const plainDisabled: WorkspaceAccessPolicy = {
      enabled: false,
      workspaceRoot: '',
      readExtraIncludes: [],
      readExcludes: [],
      writeExcludes: [],
    }

    expect(isReadablePath('YOLO/sessions.sqlite', plainDisabled)).toBe(true)
    expect(
      isReadablePath('YOLO/sessions.sqlite', denyPolicy({ enabled: false })),
    ).toBe(false)
    expect(() =>
      resolveWritablePath(
        'YOLO/Projects/proj-x/project.md',
        denyPolicy({ enabled: false }),
      ),
    ).toThrow(/host-managed protected zone/i)
    expect(() =>
      resolveReadablePath(
        'YOLO/.yolo_data.json',
        denyPolicy({ enabled: false }),
      ),
    ).toThrow(/host-managed protected zone/i)
  })

  it('denies protected paths regardless of workspaceRoot or policy allowlists', () => {
    const rootAccess = denyPolicy({ workspaceRoot: '/' })
    const projectsAccess = denyPolicy({ workspaceRoot: 'YOLO/Projects' })

    for (const access of [rootAccess, projectsAccess]) {
      expect(
        isReadablePath('YOLO/Projects/proj-x/project.md', access),
      ).toBe(false)
      expect(
        isWritablePath('YOLO/Projects/proj-x/project.md', access),
      ).toBe(false)
      expect(() =>
        resolveReadablePath('YOLO/Projects/proj-x/project.md', access),
      ).toThrow(/host-managed protected zone/i)
      expect(() =>
        resolveWritablePath('YOLO/Projects/proj-x/project.md', access),
      ).toThrow(/host-managed protected zone/i)
    }
  })

  it('denies relative writes that resolve into a protected zone', () => {
    const access = denyPolicy({ workspaceRoot: 'YOLO/Projects' })
    expect(() => resolveWritablePath('proj-x/project.md', access)).toThrow(
      /host-managed protected zone/i,
    )
  })

  it('still allows ordinary user content under a full-vault root', () => {
    const access = denyPolicy({ workspaceRoot: '/' })
    expect(isReadablePath('notes/plain.md', access)).toBe(true)
    expect(resolveWritablePath('notes/draft.md', access)).toBe('notes/draft.md')
    expect(isReadablePath('YOLO/skills/review/SKILL.md', access)).toBe(true)
  })
})
