import {
  WorkspaceAccessPolicy,
} from '../../types/assistant.types'
import { getProtectedVaultPathRules } from '../paths/protectedPaths'

import {
  collectToolCallPaths,
  collectToolCallPathsWithModes,
  describePathDenial,
  isAncestorOfIncludePath,
  isReadablePath,
  isVisibleForTraversal,
  isWritablePath,
  normalizeWorkspacePath,
  normalizeWorkspacePolicy,
  resolvePathVisibility,
  resolveReadablePath,
  resolveWritablePath,
} from './workspaceScope'

const policy = (override: {
  enabled?: boolean
  workspaceRoot?: string
  readExtraIncludes?: string[]
  readExcludes?: string[]
  writeExcludes?: string[]
  protectedPaths?: WorkspaceAccessPolicy['protectedPaths']
}): WorkspaceAccessPolicy => ({
  enabled: true,
  workspaceRoot: 'Work',
  readExtraIncludes: [],
  readExcludes: [],
  writeExcludes: [],
  ...override,
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
    const access = policy({
      workspaceRoot: 'Work',
      readExcludes: ['Work/Private'],
    })
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

describe('WorkspaceAccessPolicy helpers', () => {
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

describe('normalizeWorkspacePolicy', () => {
  it('maps a legacy scope-shaped config into the policy at init time', () => {
    const scope = { enabled: true, include: ['Notes'], exclude: ['Notes/Private'] }
    expect(normalizeWorkspacePolicy(scope, undefined)).toEqual({
      enabled: true,
      workspaceRoot: '',
      readExtraIncludes: ['Notes'],
      readExcludes: ['Notes/Private'],
      writeExcludes: ['Notes/Private'],
    })
  })

  it('lets an explicit policy win over the legacy scope', () => {
    const scope = { enabled: true, include: ['Notes'], exclude: [] }
    const access = policy({ workspaceRoot: 'Work' })
    expect(normalizeWorkspacePolicy(scope, access)).toEqual(access)
  })

  it('returns undefined when nothing is enabled', () => {
    expect(normalizeWorkspacePolicy(undefined, undefined)).toBeUndefined()
    expect(
      normalizeWorkspacePolicy({ enabled: false, include: [], exclude: [] }, undefined),
    ).toBeUndefined()
  })
})

describe('resolvePathVisibility', () => {
  const settings = { yolo: { baseDir: 'YOLO' } }

  it('is visible when no policy or settings constrain the path', () => {
    expect(resolvePathVisibility('Notes/a.md', {})).toBe('visible')
  })

  it('is hidden for a path inside the YOLO user-data root, regardless of policy', () => {
    expect(
      resolvePathVisibility('YOLO/data/chats/v1_abc.json', { settings }),
    ).toBe('hidden')
    // Hidden wins even when the policy would otherwise allow the path.
    expect(
      resolvePathVisibility('YOLO/data/chats/v1_abc.json', {
        settings,
        policy: policy({ workspaceRoot: '/' }),
      }),
    ).toBe('hidden')
    // ...and even when the policy is disabled entirely.
    expect(
      resolvePathVisibility('YOLO/data/chats/v1_abc.json', {
        settings,
        policy: policy({ enabled: false, workspaceRoot: '/' }),
      }),
    ).toBe('hidden')
  })

  it('is out-of-scope for a real path excluded by the workspace policy', () => {
    expect(
      resolvePathVisibility('Private/secret.md', {
        policy: policy({ workspaceRoot: 'Notes' }),
      }),
    ).toBe('out-of-scope')
  })

  it('is visible for a path allowed by the policy', () => {
    expect(
      resolvePathVisibility('Notes/a.md', {
        policy: policy({ workspaceRoot: 'Notes' }),
      }),
    ).toBe('visible')
  })

  it('is visible when the policy excludes the path but a skill exemption covers it', () => {
    const exemptPaths = new Set(['Skills/pkg/SKILL.md'])
    expect(
      resolvePathVisibility('Skills/pkg/reference.md', {
        policy: policy({ workspaceRoot: 'Notes' }),
        exemptPaths,
      }),
    ).toBe('visible')
  })

  it('does not let a skill exemption override the hidden check', () => {
    const exemptPaths = new Set(['YOLO/data/SKILL.md'])
    expect(
      resolvePathVisibility('YOLO/data/chats/v1_abc.json', {
        settings,
        policy: policy({ workspaceRoot: 'Notes' }),
        exemptPaths,
      }),
    ).toBe('hidden')
  })
})

describe('isVisibleForTraversal', () => {
  it('allows everything when the policy is missing or disabled', () => {
    expect(isVisibleForTraversal('Anything', undefined)).toBe(true)
    expect(isVisibleForTraversal('Anything', policy({ enabled: false }))).toBe(
      true,
    )
  })

  it('allows in-scope paths and ancestors of include rules, denies everything else', () => {
    const access = policy({
      workspaceRoot: 'Projects/Client',
      readExtraIncludes: ['Shared'],
    })
    expect(isVisibleForTraversal('Projects/Client', access)).toBe(true)
    expect(isVisibleForTraversal('Projects', access)).toBe(true)
    expect(isVisibleForTraversal('', access)).toBe(true)
    expect(isVisibleForTraversal('Shared', access)).toBe(true)
    expect(isVisibleForTraversal('Other', access)).toBe(false)
    expect(isVisibleForTraversal('Projects/Client/x.md', access)).toBe(true)
  })

  it('keeps the ancestor carve-out even when the ancestor is also excluded', () => {
    // Traversal must be able to descend toward an include rule; the strict
    // content read of the excluded ancestor is still denied by
    // `resolvePathVisibility` (out-of-scope) — this only affects listing.
    const access = policy({
      workspaceRoot: 'Projects/Client',
      readExcludes: ['Projects'],
    })
    expect(isVisibleForTraversal('Projects', access)).toBe(true)
    expect(resolvePathVisibility('Projects/Other/file.md', { policy: access })).toBe(
      'out-of-scope',
    )
  })
})

describe('isAncestorOfIncludePath', () => {
  it('is false without an enabled policy or includes', () => {
    expect(isAncestorOfIncludePath('Projects', undefined)).toBe(false)
    expect(
      isAncestorOfIncludePath('Projects', policy({ enabled: false })),
    ).toBe(false)
    expect(
      isAncestorOfIncludePath('Projects', policy({ workspaceRoot: '' })),
    ).toBe(false)
  })

  it('matches equal and ancestor paths of the include rules', () => {
    const access = policy({ workspaceRoot: 'Projects/Client' })
    expect(isAncestorOfIncludePath('Projects', access)).toBe(true)
    expect(isAncestorOfIncludePath('Projects/Client', access)).toBe(true)
    expect(isAncestorOfIncludePath('Projects/Other', access)).toBe(false)
    expect(isAncestorOfIncludePath('ProjectsX', access)).toBe(false)
  })
})

describe('describePathDenial', () => {
  it('disguises a hidden path as a genuine miss, defaulting to "file"', () => {
    expect(describePathDenial('hidden', 'YOLO/data/chats/v1_abc.json')).toBe(
      'File not found: YOLO/data/chats/v1_abc.json',
    )
  })

  it('disguises a hidden folder using the folder wording when asked', () => {
    expect(describePathDenial('hidden', 'YOLO/data', 'folder')).toBe(
      'Folder not found: YOLO/data',
    )
  })

  it('explicitly denies an out-of-scope path rather than disguising it as missing', () => {
    expect(describePathDenial('out-of-scope', 'Private/secret.md')).toBe(
      'Path "Private/secret.md" is outside this agent\'s workspace scope.',
    )
  })

  it('echoes exactly the string it was given, never a resolved path (issue #577)', () => {
    // The caller is responsible for passing the agent's raw, unresolved
    // input (e.g. a wikilink) rather than whatever it resolved to — this
    // just pins that the function itself performs no substitution.
    expect(describePathDenial('out-of-scope', '[[Secret]]')).toBe(
      'Path "[[Secret]]" is outside this agent\'s workspace scope.',
    )
    expect(describePathDenial('hidden', '[[Secret]]')).toBe(
      'File not found: [[Secret]]',
    )
  })
})
