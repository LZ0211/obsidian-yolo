import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  decideWorkspacePathAccess,
  isHiddenSharedWebPath,
  isPathWithinSegmentAware,
  normalizeVaultRootPath,
} from './workspacePermissionEngine'

const policy = {
  workspaceRoot: '/Projects/A',
  readAllowlist: ['/Shared'],
  readDenylist: ['/Projects/A/private'],
  writeDenylist: ['/Projects/A/locked'],
}

describe('workspacePermissionEngine', () => {
  it('keeps the browser-loaded permission engine free of Node path imports', () => {
    const source = readFileSync(
      join(__dirname, 'workspacePermissionEngine.ts'),
      'utf8',
    )

    expect(source).not.toMatch(
      /from ['"]node:path['"]|require\(['"]node:path['"]\)/,
    )
  })

  it('normalizes root paths consistently', () => {
    expect(normalizeVaultRootPath('/')).toBe('/')
    expect(normalizeVaultRootPath('Projects/A/')).toBe('/Projects/A')
    expect(normalizeVaultRootPath('/Projects//A/./Docs')).toBe(
      '/Projects/A/Docs',
    )
    expect(normalizeVaultRootPath('Projects/A%20B')).toBe('/Projects/A B')
  })

  it('resolves relative paths under workspaceRoot', () => {
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'read',
        path: 'notes/today.md',
      }),
    ).toEqual({ ok: true, path: '/Projects/A/notes/today.md' })
  })

  it('rejects drive letters, UNC paths, and encoded traversal', () => {
    for (const path of [
      'C:/vault/file.md',
      '\\\\server\\share\\x.md',
      '..%2fsecret.md',
    ]) {
      expect(
        decideWorkspacePathAccess({ policy, operation: 'read', path }),
      ).toMatchObject({ ok: false, code: 'invalid_path' })
    }
  })

  it('applies denylist before allowlist with segment-aware matching', () => {
    expect(isPathWithinSegmentAware('/foo', '/foo/bar.md')).toBe(true)
    expect(isPathWithinSegmentAware('/foo', '/foobar/bar.md')).toBe(false)
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'read',
        path: '/Projects/A/private/secret.md',
      }),
    ).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('allows readAllowlist outside root but not writes outside root', () => {
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'read',
        path: '/Shared/ref.md',
      }),
    ).toEqual({ ok: true, path: '/Shared/ref.md' })

    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'write',
        path: '/Shared/ref.md',
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('hides dotfiles and .obsidian for shared web sessions', () => {
    expect(isHiddenSharedWebPath('/Projects/A/.env')).toBe(true)
    expect(isHiddenSharedWebPath('/Projects/A/folder/.secret/file.md')).toBe(
      true,
    )
    expect(isHiddenSharedWebPath('/.obsidian/app.json')).toBe(true)
    expect(isHiddenSharedWebPath('/Projects/A/visible.md')).toBe(false)
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'read',
        path: '.env',
      }),
    ).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('requires writable source and destination for move', () => {
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'move',
        path: 'notes/a.md',
        targetPath: 'notes/b.md',
      }),
    ).toEqual({ ok: true, path: '/Projects/A/notes/b.md' })

    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'move',
        path: 'locked/a.md',
        targetPath: 'notes/b.md',
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('rejects recursive delete when a child is denied or hidden', () => {
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'delete',
        path: 'notes',
        recursiveDelete: true,
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' })

    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'delete',
        path: 'notes',
        recursiveDelete: true,
        childPaths: ['/Projects/A/notes/ok.md', '/Projects/A/notes/.hidden'],
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' })

    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'delete',
        path: 'private',
        recursiveDelete: true,
        childPaths: ['/Projects/A/private/secret.md'],
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('allows non-recursive delete of a writable file without child enumeration', () => {
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'delete',
        path: 'notes/old.md',
      }),
    ).toEqual({ ok: true, path: '/Projects/A/notes/old.md' })
  })

  it('denies symlink or junction traversal when realpath resolution fails', () => {
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'read',
        path: 'link/file.md',
        realpath: () => null,
      }),
    ).toMatchObject({ ok: false, code: 'not_found' })
  })

  it('checks resolved target and parent paths for write operations', () => {
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'write',
        path: 'link/file.md',
        realpath: (path) =>
          path === '/Projects/A/link/file.md' ? '/Outside/file.md' : path,
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' })

    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'write',
        path: 'notes/new.md',
        realpath: (path) =>
          path === '/Projects/A/notes' ? '/Outside/notes' : path,
      }),
    ).toMatchObject({ ok: false, code: 'forbidden' })
  })

  it('allows move to a new filename when destination parent resolves writable', () => {
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'move',
        path: 'notes/a.md',
        targetPath: 'notes/new.md',
        realpath: (path) => (path === '/Projects/A/notes/new.md' ? null : path),
      }),
    ).toEqual({ ok: true, path: '/Projects/A/notes/new.md' })
  })

  it('does not apply shared-web hidden rules to skill operations', () => {
    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'skill_read',
        path: '.skill-cache/data.json',
      }),
    ).toEqual({ ok: true, path: '/Projects/A/.skill-cache/data.json' })

    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'skill_write',
        path: '.skill-cache/data.json',
      }),
    ).toEqual({ ok: true, path: '/Projects/A/.skill-cache/data.json' })

    expect(
      decideWorkspacePathAccess({
        policy,
        operation: 'skill_write',
        path: '.skill-cache/data.json',
        realpath: (path) => path,
      }),
    ).toEqual({ ok: true, path: '/Projects/A/.skill-cache/data.json' })
  })

  it('denies protected paths for read, list, and write regardless of the workspace root', () => {
    const protectedPolicy = {
      ...policy,
      workspaceRoot: '/',
      protectedPaths: [
        { kind: 'prefix' as const, path: 'YOLO/data' },
        { kind: 'exact' as const, path: 'YOLO/data.json' },
        { kind: 'namePrefix' as const, dir: 'YOLO', name: '.journal' },
      ],
    }

    expect(
      decideWorkspacePathAccess({
        policy: protectedPolicy,
        operation: 'read',
        path: 'YOLO/data/chats/c.json',
      }),
    ).toMatchObject({ ok: false })

    expect(
      decideWorkspacePathAccess({
        policy: protectedPolicy,
        operation: 'list',
        path: 'YOLO/data',
      }),
    ).toMatchObject({ ok: false })

    expect(
      decideWorkspacePathAccess({
        policy: protectedPolicy,
        operation: 'write',
        path: 'YOLO/data/chats/c.json',
      }),
    ).toMatchObject({ ok: false })

    expect(
      decideWorkspacePathAccess({
        policy: protectedPolicy,
        operation: 'read',
        path: 'YOLO/data.json',
      }),
    ).toMatchObject({ ok: false })

    expect(
      decideWorkspacePathAccess({
        policy: protectedPolicy,
        operation: 'read',
        path: 'YOLO/.journal-session.sqlite',
      }),
    ).toMatchObject({ ok: false })

    // 未被清单覆盖的路径不受影响
    expect(
      decideWorkspacePathAccess({
        policy: protectedPolicy,
        operation: 'read',
        path: 'YOLO/notes.md',
      }),
    ).toEqual({ ok: true, path: '/YOLO/notes.md' })
  })

  it('denies move/rename into or out of protected paths', () => {
    const protectedPolicy = {
      ...policy,
      protectedPaths: [{ kind: 'prefix' as const, path: 'Projects/A/YOLO' }],
    }

    expect(
      decideWorkspacePathAccess({
        policy: protectedPolicy,
        operation: 'move',
        path: 'YOLO/a.md',
        targetPath: 'notes/b.md',
      }),
    ).toMatchObject({ ok: false })

    expect(
      decideWorkspacePathAccess({
        policy: protectedPolicy,
        operation: 'move',
        path: 'notes/a.md',
        targetPath: 'YOLO/b.md',
      }),
    ).toMatchObject({ ok: false })
  })
})
