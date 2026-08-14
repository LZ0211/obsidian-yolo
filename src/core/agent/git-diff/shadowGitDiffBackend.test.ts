import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  truncate,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'

import type { WorkspaceAccessPolicy } from '../../../types/assistant.types'
import type { AgentFileChange } from '../../../types/chat'
import { getProtectedVaultPathRules } from '../../paths/protectedPaths'
import { normalizeWorkspacePath } from '../workspaceScope'

import { type GitCommandRunner, runGitCommand } from './gitCommandRunner'
import { ShadowGitDiffBackend } from './shadowGitDiffBackend'

const execFileAsync = promisify(execFile)

const runGit = async (cwd: string, args: string[]): Promise<void> => {
  await execFileAsync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    },
  })
}

const runGitWithEnvironment = async (
  cwd: string,
  args: string[],
  gitEnvironment: NodeJS.ProcessEnv,
): Promise<void> => {
  const cleanEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.toUpperCase().startsWith('GIT_'),
    ),
  )
  await execFileAsync('git', args, {
    cwd,
    env: { ...cleanEnvironment, ...gitEnvironment },
    timeout: 10_000,
  })
}

const expectedShadowGitDir = async (
  repoRoot: string,
  vaultPath: string,
  snapshotRoot: string,
  accessPolicy: WorkspaceAccessPolicy | undefined,
): Promise<string> => {
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        repoRoot: await realpath(repoRoot),
        vaultPath: await realpath(vaultPath),
        workspaceRoot: normalizeWorkspacePath(
          accessPolicy?.workspaceRoot ?? '',
        ),
        writeExcludes: (accessPolicy?.writeExcludes ?? [])
          .map(normalizeWorkspacePath)
          .sort(),
      }),
    )
    .digest('hex')
  return join(snapshotRoot, 'obsidian-yolo-agent-git', fingerprint, 'git')
}

const policy = (
  overrides: Partial<WorkspaceAccessPolicy> = {},
): WorkspaceAccessPolicy => ({
  enabled: true,
  workspaceRoot: 'Allowed',
  readExtraIncludes: [],
  readExcludes: [],
  writeExcludes: [],
  ...overrides,
})

const change = (path: string, oldPath?: string): AgentFileChange => ({
  kind: oldPath ? 'renamed' : 'modified',
  path,
  ...(oldPath ? { oldPath } : {}),
})

async function createRepo(): Promise<{
  root: string
  vault: string
  cleanup: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'obsidian-yolo-shadow-git-'))
  const vault = join(root, 'Vault')
  await runGit(root, ['init', '--quiet'])
  await runGit(root, ['config', 'user.email', 'test@example.com'])
  await runGit(root, ['config', 'user.name', 'Shadow Git Test'])
  await mkdir(join(vault, 'Allowed'), { recursive: true })
  await mkdir(join(vault, 'Other'), { recursive: true })
  return {
    root,
    vault,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

async function commitAll(root: string, message: string): Promise<void> {
  await runGit(root, ['add', '-A'])
  await runGit(root, ['commit', '--quiet', '-m', message])
}

describe('ShadowGitDiffBackend', () => {
  jest.setTimeout(30_000)

  it('snapshots only the writable root and ignores read extras', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await writeFile(join(repo.vault, 'Other', 'b.md'), 'before\n')
      await commitAll(repo.root, 'initial')

      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(
        policy({ readExtraIncludes: ['Other'] }),
      )
      expect(baseline).not.toBeNull()

      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\nafter\n')
      await writeFile(join(repo.vault, 'Other', 'b.md'), 'before\nafter\n')

      await expect(
        backend.finish(baseline!, [
          change('Allowed/a.md'),
          change('Other/b.md'),
        ]),
      ).resolves.toEqual(
        new Map([['Allowed/a.md', { additions: 1, deletions: 0 }]]),
      )
    } finally {
      await repo.cleanup()
    }
  })

  it('does not enrich files under write exclusions', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await writeFile(join(repo.vault, 'Allowed', 'secret.md'), 'before\n')
      await commitAll(repo.root, 'initial')

      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(
        policy({ writeExcludes: ['Allowed/secret.md'] }),
      )
      expect(baseline).not.toBeNull()

      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\nafter\n')
      await writeFile(
        join(repo.vault, 'Allowed', 'secret.md'),
        'before\nafter\n',
      )

      await expect(
        backend.finish(baseline!, [
          change('Allowed/a.md'),
          change('Allowed/secret.md'),
        ]),
      ).resolves.toEqual(
        new Map([['Allowed/a.md', { additions: 1, deletions: 0 }]]),
      )
    } finally {
      await repo.cleanup()
    }
  })

  it('does not enrich files under read exclusions (W7)', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await mkdir(join(repo.vault, 'Allowed', 'Private'), { recursive: true })
      await writeFile(join(repo.vault, 'Allowed', 'Private', 'b.md'), 'before\n')
      await commitAll(repo.root, 'initial')

      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(
        policy({ readExcludes: ['Allowed/Private'] }),
      )
      expect(baseline).not.toBeNull()

      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\nafter\n')
      await writeFile(
        join(repo.vault, 'Allowed', 'Private', 'b.md'),
        'before\nafter\n',
      )

      await expect(
        backend.finish(baseline!, [
          change('Allowed/a.md'),
          change('Allowed/Private/b.md'),
        ]),
      ).resolves.toEqual(
        new Map([['Allowed/a.md', { additions: 1, deletions: 0 }]]),
      )
    } finally {
      await repo.cleanup()
    }
  })

  it('excludes host-managed protected paths from the diff even under a full-vault root', async () => {
    const repo = await createRepo()
    try {
      await mkdir(join(repo.vault, 'Projects'), { recursive: true })
      await writeFile(join(repo.vault, 'Projects', 'project.md'), 'before\n')
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')

      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(
        policy({
          workspaceRoot: '/',
          protectedPaths: getProtectedVaultPathRules({} as never),
        }),
      )
      expect(baseline).not.toBeNull()

      await writeFile(
        join(repo.vault, 'Projects', 'project.md'),
        'before\nafter\n',
      )
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\nafter\n')

      await expect(
        backend.finish(baseline!, [
          change('Projects/project.md'),
          change('Allowed/a.md'),
        ]),
      ).resolves.toEqual(
        new Map([['Allowed/a.md', { additions: 1, deletions: 0 }]]),
      )
    } finally {
      await repo.cleanup()
    }
  })

  it('does not re-root write exclusions from outside the writable root', async () => {
    const repo = await createRepo()
    try {
      await mkdir(join(repo.vault, 'Allowed', 'Other'), { recursive: true })
      await writeFile(join(repo.vault, 'Allowed', 'Other', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')

      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(policy({ writeExcludes: ['Other'] }))
      expect(baseline).not.toBeNull()

      await writeFile(
        join(repo.vault, 'Allowed', 'Other', 'a.md'),
        'before\nafter\n',
      )

      await expect(
        backend.finish(baseline!, [change('Allowed/Other/a.md')]),
      ).resolves.toEqual(
        new Map([['Allowed/Other/a.md', { additions: 1, deletions: 0 }]]),
      )
    } finally {
      await repo.cleanup()
    }
  })

  const windowsTest = process.platform === 'win32' ? it : it.skip

  windowsTest(
    'matches write exclusions case-insensitively on Windows',
    async () => {
      const repo = await createRepo()
      try {
        await writeFile(join(repo.vault, 'Allowed', 'secret.md'), 'before\n')
        await commitAll(repo.root, 'initial')
        const backend = new ShadowGitDiffBackend({
          vaultPath: repo.vault,
          snapshotRoot: join(repo.root, 'snapshots'),
        })
        const baseline = await backend.begin(
          policy({ writeExcludes: ['allowed/SECRET.md'] }),
        )
        expect(baseline).not.toBeNull()

        await writeFile(
          join(repo.vault, 'Allowed', 'secret.md'),
          'before\nafter\n',
        )

        await expect(
          backend.finish(baseline!, [change('Allowed/secret.md')]),
        ).resolves.toEqual(new Map())
      } finally {
        await repo.cleanup()
      }
    },
  )

  it('excludes namePrefix protected paths from the finish-stage candidates', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'secret.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(
        policy({
          protectedPaths: [
            { kind: 'namePrefix', dir: 'Allowed', name: 'secret' },
          ],
        }),
      )
      expect(baseline).not.toBeNull()

      await writeFile(
        join(repo.vault, 'Allowed', 'secret.md'),
        'before\nafter\n',
      )
      // 快照阶段按 glob 排除了该文件；finish 阶段候选过滤必须同样命中 glob
      //（此前只查 literal excludes，受保护文件会漏进最终 diff）。
      await expect(
        backend.finish(baseline!, [change('Allowed/secret.md')]),
      ).resolves.toEqual(new Map())
    } finally {
      await repo.cleanup()
    }
  })

  it('returns null for a vault outside Git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'obsidian-yolo-no-git-'))
    try {
      const backend = new ShadowGitDiffBackend({ vaultPath: root })
      await expect(backend.begin(undefined)).resolves.toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects snapshot roots that resolve inside the Vault before creating state', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const target = join(repo.vault, 'Snapshots')
      const snapshotRoot = join(repo.root, 'snapshot-link')
      await mkdir(target)
      await symlink(
        target,
        snapshotRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot,
      })

      await expect(backend.begin(policy())).resolves.toBeNull()
      await expect(readdir(target)).resolves.toEqual([])
    } finally {
      await repo.cleanup()
    }
  })

  it('rejects an existing fingerprint directory symlinked into the Vault', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const snapshotRoot = join(repo.root, 'snapshots')
      const accessPolicy = policy()
      const expectedGitDir = await expectedShadowGitDir(
        repo.root,
        repo.vault,
        snapshotRoot,
        accessPolicy,
      )
      const fingerprintRoot = dirname(expectedGitDir)
      await mkdir(dirname(fingerprintRoot), { recursive: true })
      await symlink(
        repo.vault,
        fingerprintRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot,
      })

      await expect(backend.begin(accessPolicy)).resolves.toBeNull()
      await expect(
        readFile(join(repo.vault, 'git', 'HEAD')),
      ).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await repo.cleanup()
    }
  })

  windowsTest(
    'rejects a managed objects junction into the Vault before Git writes',
    async () => {
      const repo = await createRepo()
      const accessPolicy = policy()
      const expectedGitDir = await expectedShadowGitDir(
        repo.root,
        repo.vault,
        tmpdir(),
        accessPolicy,
      )
      const fingerprintRoot = dirname(expectedGitDir)
      const objectsJunction = join(expectedGitDir, 'objects')
      const injectedObjects = join(repo.vault, 'InjectedObjects')
      const alternatesMarker = join(injectedObjects, 'info', 'alternates')
      try {
        const candidateFile = join(repo.vault, 'Allowed', 'a.md')
        await writeFile(candidateFile, 'before\n')
        await commitAll(repo.root, 'initial')
        await mkdir(expectedGitDir, { recursive: true })
        await mkdir(injectedObjects)
        await symlink(injectedObjects, objectsJunction, 'junction')
        await expect(readdir(injectedObjects)).resolves.toEqual([])
        const backend = new ShadowGitDiffBackend({ vaultPath: repo.vault })

        const baseline = await backend.begin(accessPolicy)
        if (baseline) {
          await appendFile(candidateFile, 'after\n')
          await backend.finish(baseline, [change('Allowed/a.md')])
        }

        await expect(readFile(alternatesMarker)).rejects.toMatchObject({
          code: 'ENOENT',
        })
        expect(baseline).toBeNull()
        await expect(readdir(injectedObjects)).resolves.toEqual([])
      } finally {
        await unlink(objectsJunction).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
        await rm(fingerprintRoot, { recursive: true, force: true })
        await repo.cleanup()
      }
    },
  )

  it('rejects oversized packed refs before running Git', async () => {
    const repo = await createRepo()
    try {
      const packedRefs = join(repo.root, '.git', 'packed-refs')
      await writeFile(packedRefs, '')
      await truncate(packedRefs, 1024 * 1024 + 1)
      const commandRunner = jest.fn(runGitCommand)
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
        commandRunner,
      })

      await expect(backend.begin(policy())).resolves.toBeNull()
      expect(commandRunner).not.toHaveBeenCalled()
    } finally {
      await repo.cleanup()
    }
  })

  it('rejects oversized source alternates instead of parsing them', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      await writeFile(
        join(repo.root, '.git', 'objects', 'info', 'alternates'),
        ' '.repeat(1024 * 1024 + 1),
      )
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })

      await expect(backend.begin(policy())).resolves.toBeNull()
    } finally {
      await repo.cleanup()
    }
  })

  it('rejects an oversized source info exclude before copying it', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const sourceExclude = join(repo.root, '.git', 'info', 'exclude')
      await writeFile(sourceExclude, 'x')
      await truncate(sourceExclude, 5 * 1024 * 1024)
      const snapshotRoot = join(repo.root, 'snapshots')
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot,
      })

      const baseline = await backend.begin(policy())
      const shadowExclude = join(
        await expectedShadowGitDir(
          repo.root,
          repo.vault,
          snapshotRoot,
          policy(),
        ),
        'info',
        'exclude',
      )
      const shadowExcludeContent = await readFile(shadowExclude).catch(
        () => null,
      )
      expect(
        shadowExcludeContent === null ||
          shadowExcludeContent.byteLength <= 1024 * 1024,
      ).toBe(true)
      expect(baseline).toBeNull()
    } finally {
      await repo.cleanup()
    }
  })

  it('copies a bounded source info exclude into the shadow repository', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const sourceExclude = join(repo.root, '.git', 'info', 'exclude')
      await writeFile(sourceExclude, '*.local\n')
      const snapshotRoot = join(repo.root, 'snapshots')
      const accessPolicy = policy()
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot,
      })

      const baseline = await backend.begin(accessPolicy)

      expect(baseline).not.toBeNull()
      await expect(
        readFile(
          join(
            await expectedShadowGitDir(
              repo.root,
              repo.vault,
              snapshotRoot,
              accessPolicy,
            ),
            'info',
            'exclude',
          ),
          'utf8',
        ),
      ).resolves.toBe('*.local\n')
      if (baseline) await backend.finish(baseline, [])
    } finally {
      await repo.cleanup()
    }
  })

  it('rejects object fan-out scans that exceed the entry budget', async () => {
    const repo = await createRepo()
    let readdirSpy: jest.SpyInstance | undefined
    let opendirSpy: jest.SpyInstance | undefined
    try {
      const objectsDir = await realpath(join(repo.root, '.git', 'objects'))
      const fanOutDir = join(objectsDir, 'aa')
      const fsPromises =
        jest.requireActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        )
      const actualReaddir = fsPromises.readdir
      const actualOpendir = fsPromises.opendir
      type FakeDirectoryEntry = {
        name: string
        isDirectory: () => boolean
      }
      const fanOutEntry: FakeDirectoryEntry = {
        name: 'aa',
        isDirectory: () => true,
      }
      const invalidEntries: FakeDirectoryEntry[] = Array.from(
        { length: 5_000 },
        (_, index) => ({
          name: `invalid-${index}`,
          isDirectory: () => false,
        }),
      )
      let yieldedEntries = 0
      const fakeDirectory = (entries: FakeDirectoryEntry[]) => ({
        [Symbol.asyncIterator]: async function* () {
          for (const entry of entries) {
            yieldedEntries += 1
            yield entry
          }
        },
      })
      readdirSpy = jest.spyOn(fsPromises, 'readdir').mockImplementation((async (
        path: unknown,
        ...args: unknown[]
      ) => {
        if (String(path) === objectsDir) return [fanOutEntry]
        if (String(path) === fanOutDir) {
          return invalidEntries.map((entry) => entry.name)
        }
        return Reflect.apply(actualReaddir, fsPromises, [path, ...args])
      }) as typeof actualReaddir)
      opendirSpy = jest.spyOn(fsPromises, 'opendir').mockImplementation((async (
        path: unknown,
        ...args: unknown[]
      ) => {
        if (String(path) === objectsDir) {
          return fakeDirectory([fanOutEntry])
        }
        if (String(path) === fanOutDir) {
          return fakeDirectory(invalidEntries)
        }
        return Reflect.apply(actualOpendir, fsPromises, [path, ...args])
      }) as typeof actualOpendir)
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })

      await expect(backend.begin(policy())).resolves.toBeNull()
      expect(yieldedEntries).toBeLessThan(invalidEntries.length)
    } finally {
      readdirSpy?.mockRestore()
      opendirSpy?.mockRestore()
      await repo.cleanup()
    }
  })

  it('initializes an empty run index when the source index is absent', async () => {
    const repo = await createRepo()
    try {
      const sourceIndex = join(repo.root, '.git', 'index')
      await expect(readFile(sourceIndex)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      const requests: Parameters<GitCommandRunner>[0][] = []
      const commandRunner: GitCommandRunner = async (request) => {
        requests.push(request)
        return runGitCommand(request)
      }
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
        commandRunner,
      })

      const baseline = await backend.begin(policy())

      expect(baseline).not.toBeNull()
      if (!baseline) throw new Error('Expected an empty-index baseline')
      const readTreeRequest = requests.find(
        (request) =>
          request.args.includes('read-tree') &&
          request.args.includes('--empty'),
      )
      expect(readTreeRequest?.env?.GIT_INDEX_FILE).toBe(baseline.indexFile)
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\nafter\n')
      await expect(
        backend.finish(baseline, [change('Allowed/a.md')]),
      ).resolves.toEqual(
        new Map([['Allowed/a.md', { additions: 1, deletions: 0 }]]),
      )
    } finally {
      await repo.cleanup()
    }
  })

  it('rejects a malformed nested Git marker instead of using an outer repository', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      await writeFile(join(repo.vault, '.git'), 'not-a-gitdir\n')
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })

      await expect(backend.begin(policy())).resolves.toBeNull()
    } finally {
      await repo.cleanup()
    }
  })

  it('rejects a dangling nested Git marker instead of using an outer repository', async () => {
    const repo = await createRepo()
    let accessSpy: jest.SpyInstance | undefined
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const missingGitDir = join(repo.root, 'missing-git-dir')
      await mkdir(missingGitDir)
      await symlink(
        missingGitDir,
        join(repo.vault, '.git'),
        process.platform === 'win32' ? 'junction' : 'dir',
      )
      await rm(missingGitDir, { recursive: true })
      const fsPromises =
        jest.requireActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        )
      const actualAccess = fsPromises.access
      const markerPath = join(repo.vault, '.git')
      accessSpy = jest
        .spyOn(fsPromises, 'access')
        .mockImplementation(
          async (...args: Parameters<typeof actualAccess>) => {
            if (String(args[0]) === markerPath) {
              throw Object.assign(new Error('dangling marker'), {
                code: 'ENOENT',
              })
            }
            return actualAccess(...args)
          },
        )
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })

      await expect(backend.begin(policy())).resolves.toBeNull()
    } finally {
      accessSpy?.mockRestore()
      await repo.cleanup()
    }
  })

  it('keys rename stats by the current Vault-relative path', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'old.md'), 'line\n')
      await commitAll(repo.root, 'initial')

      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(policy())
      expect(baseline).not.toBeNull()

      await rename(
        join(repo.vault, 'Allowed', 'old.md'),
        join(repo.vault, 'Allowed', 'new.md'),
      )
      await writeFile(join(repo.vault, 'Allowed', 'new.md'), 'line\nafter\n')

      await expect(
        backend.finish(baseline!, [change('Allowed/new.md', 'Allowed/old.md')]),
      ).resolves.toEqual(
        new Map([['Allowed/new.md', { additions: 1, deletions: 0 }]]),
      )
    } finally {
      await repo.cleanup()
    }
  })

  it('returns the public baseline contract with isolated concurrent indexes', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await writeFile(join(repo.vault, 'Other', 'b.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const snapshotRoot = join(repo.root, 'snapshots')
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot,
      })

      const [first, second] = await Promise.all([
        backend.begin(policy()),
        backend.begin(policy()),
      ])
      const otherScope = await backend.begin(policy({ workspaceRoot: 'Other' }))

      expect(first).not.toBeNull()
      expect(second).not.toBeNull()
      expect(otherScope).not.toBeNull()
      if (!first || !second || !otherScope) {
        throw new Error('Expected concurrent baselines')
      }
      expect(first).toMatchObject({
        repoRoot: expect.any(String),
        vaultPrefix: 'Vault',
        gitDir: expect.any(String),
        indexFile: expect.any(String),
        tree: expect.stringMatching(/^[0-9a-f]{40,64}$/),
      })
      expect(second.gitDir).toBe(first.gitDir)
      expect(second.indexFile).not.toBe(first.indexFile)
      expect(otherScope.gitDir).not.toBe(first.gitDir)
      expect(first.gitDir).toContain(snapshotRoot)
      expect(first.indexFile).toContain(join(first.gitDir, 'runs'))

      await Promise.all([
        backend.finish(first, []),
        backend.finish(second, []),
        backend.finish(otherScope, []),
      ])
      await Promise.all(
        [first.indexFile, second.indexFile, otherScope.indexFile].map(
          async (indexFile) =>
            expect(readFile(indexFile)).rejects.toMatchObject({
              code: 'ENOENT',
            }),
        ),
      )
    } finally {
      await repo.cleanup()
    }
  })

  it('discards only the matching active baseline and cleans run artifacts', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(policy())
      expect(baseline).not.toBeNull()
      if (!baseline) throw new Error('Expected a discardable baseline')
      const lockFile = baseline.indexFile.replace(/\.index$/, '.run')

      await expect(readFile(baseline.indexFile)).resolves.toEqual(
        expect.any(Buffer),
      )
      await expect(readFile(lockFile)).resolves.toEqual(expect.any(Buffer))

      await expect(backend.discard({ ...baseline })).resolves.toBeUndefined()
      await expect(readFile(baseline.indexFile)).resolves.toEqual(
        expect.any(Buffer),
      )

      await expect(backend.discard(baseline)).resolves.toBeUndefined()
      for (const artifact of [
        baseline.indexFile,
        `${baseline.indexFile}.lock`,
        lockFile,
      ]) {
        await expect(readFile(artifact)).rejects.toMatchObject({
          code: 'ENOENT',
        })
      }
    } finally {
      await repo.cleanup()
    }
  })

  it('fingerprints a nested Vault from normalized enabled policy inputs', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const snapshotRoot = join(repo.root, 'snapshots')
      const accessPolicy = policy({
        workspaceRoot: '/Allowed/',
        writeExcludes: ['Other/ignored.md', '/Allowed/z.md', 'Allowed/a.md'],
      })
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot,
      })

      const baseline = await backend.begin(accessPolicy)

      expect(baseline).not.toBeNull()
      if (!baseline) throw new Error('Expected an enabled-policy baseline')
      await expect(
        expectedShadowGitDir(repo.root, repo.vault, snapshotRoot, accessPolicy),
      ).resolves.toBe(baseline.gitDir)
      await backend.finish(baseline, [])
    } finally {
      await repo.cleanup()
    }
  })

  it('fingerprints disabled policy fields without clearing them', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const snapshotRoot = join(repo.root, 'snapshots')
      const accessPolicy = policy({
        enabled: false,
        workspaceRoot: '/Other/',
        writeExcludes: ['Other/z.md', '/Allowed/a.md'],
      })
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot,
      })

      const baseline = await backend.begin(accessPolicy)

      expect(baseline).not.toBeNull()
      if (!baseline) throw new Error('Expected a disabled-policy baseline')
      await expect(
        expectedShadowGitDir(repo.root, repo.vault, snapshotRoot, accessPolicy),
      ).resolves.toBe(baseline.gitDir)
      await backend.finish(baseline, [])
    } finally {
      await repo.cleanup()
    }
  })

  it('sanitizes every shadow Git command and inherited Git environment', async () => {
    const repo = await createRepo()
    const originalGitEnvironment = {
      count: process.env.GIT_CONFIG_COUNT,
      key: process.env.GIT_CONFIG_KEY_0,
      value: process.env.GIT_CONFIG_VALUE_0,
    }
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      process.env.GIT_CONFIG_COUNT = '1'
      process.env.GIT_CONFIG_KEY_0 = 'core.hooksPath'
      process.env.GIT_CONFIG_VALUE_0 = join(repo.root, 'hostile-hooks')
      const requests: Parameters<GitCommandRunner>[0][] = []
      const commandRunner: GitCommandRunner = async (request) => {
        requests.push(request)
        return runGitCommand(request)
      }
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
        commandRunner,
      })

      const baseline = await backend.begin(policy())

      expect(baseline).not.toBeNull()
      if (!baseline) throw new Error('Expected a baseline')
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\nafter\n')
      await expect(
        backend.finish(baseline, [change('Allowed/a.md')]),
      ).resolves.toEqual(
        new Map([['Allowed/a.md', { additions: 1, deletions: 0 }]]),
      )
      expect(requests.length).toBeGreaterThan(0)
      for (const request of requests) {
        expect(request.args.slice(0, 4)).toEqual([
          '-c',
          'core.hooksPath=',
          '-c',
          'core.fsmonitor=false',
        ])
        expect(request.env).toMatchObject({
          GIT_DIR: expect.any(String),
          GIT_WORK_TREE: expect.any(String),
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
          GIT_ATTR_NOSYSTEM: '1',
        })
        expect(request.env).not.toHaveProperty('GIT_CONFIG_COUNT')
        expect(request.env).not.toHaveProperty('GIT_CONFIG_KEY_0')
        expect(request.env).not.toHaveProperty('GIT_CONFIG_VALUE_0')
      }
      expect(
        requests.find((request) => request.args.includes('diff'))?.args,
      ).toContain('--no-ext-diff')
    } finally {
      const restore = (key: string, value: string | undefined): void => {
        if (value === undefined) {
          Reflect.deleteProperty(process.env, key)
        } else {
          process.env[key] = value
        }
      }
      restore('GIT_CONFIG_COUNT', originalGitEnvironment.count)
      restore('GIT_CONFIG_KEY_0', originalGitEnvironment.key)
      restore('GIT_CONFIG_VALUE_0', originalGitEnvironment.value)
      await repo.cleanup()
    }
  })

  it('does not execute a source post-index-change hook', async () => {
    const repo = await createRepo()
    const marker = join(repo.root, 'post-index-change-marker')
    const hook = join(repo.root, '.git', 'hooks', 'post-index-change')
    const isolatedGitEnvironment = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    }
    try {
      const candidateFile = join(repo.vault, 'Allowed', 'a.md')
      await writeFile(candidateFile, 'before\n')
      await commitAll(repo.root, 'initial')
      await writeFile(
        hook,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')\n`,
        { mode: 0o755 },
      )
      await appendFile(candidateFile, 'control\n')

      await runGitWithEnvironment(
        repo.root,
        ['add', '--', 'Vault/Allowed/a.md'],
        isolatedGitEnvironment,
      )

      await expect(readFile(marker, 'utf8')).resolves.toBe('ran')
      await rm(marker, { force: true })
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(policy())
      expect(baseline).not.toBeNull()
      if (!baseline) throw new Error('Expected a hook-isolation baseline')
      await appendFile(candidateFile, 'after\n')

      await expect(
        backend.finish(baseline, [change('Allowed/a.md')]),
      ).resolves.toEqual(
        new Map([['Allowed/a.md', { additions: 1, deletions: 0 }]]),
      )
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await repo.cleanup()
    }
  })

  it('cleans the run index when baseline tree creation times out', async () => {
    const repo = await createRepo()
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      let failedIndexFile: string | undefined
      const commandRunner: GitCommandRunner = async (request) => {
        if (request.args.includes('write-tree')) {
          failedIndexFile = request.env?.GIT_INDEX_FILE
          return {
            code: null,
            stdout: '',
            stderr: '',
            timedOut: true,
            outputExceeded: false,
          }
        }
        return runGitCommand(request)
      }
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
        commandRunner,
      })

      await expect(backend.begin(policy())).resolves.toBeNull()
      expect(failedIndexFile).toEqual(expect.any(String))
      await expect(readFile(failedIndexFile!)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(`${failedIndexFile!}.lock`)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      await repo.cleanup()
    }
  })

  windowsTest(
    'does not delete Vault run artifacts through a replaced runs junction',
    async () => {
      const repo = await createRepo()
      let runsJunction: string | undefined
      try {
        await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
        await commitAll(repo.root, 'initial')
        const snapshotRoot = join(repo.root, 'snapshots')
        const backend = new ShadowGitDiffBackend({
          vaultPath: repo.vault,
          snapshotRoot,
        })
        const baseline = await backend.begin(policy())
        expect(baseline).not.toBeNull()
        if (!baseline) throw new Error('Expected a cleanup baseline')

        const runId = basename(baseline.indexFile, '.index')
        const runsPath = dirname(baseline.indexFile)
        const injectedRuns = join(repo.vault, 'InjectedRuns')
        runsJunction = runsPath
        await rm(runsPath, { recursive: true, force: true })
        await mkdir(injectedRuns)
        await writeFile(join(injectedRuns, `${runId}.index`), 'index')
        await writeFile(join(injectedRuns, `${runId}.index.lock`), 'index-lock')
        await writeFile(join(injectedRuns, `${runId}.run`), 'run-lock')
        await symlink(injectedRuns, runsPath, 'junction')

        await expect(backend.finish(baseline, [])).resolves.toEqual(new Map())
        await expect(
          readFile(join(injectedRuns, `${runId}.index`), 'utf8'),
        ).resolves.toBe('index')
        await expect(
          readFile(join(injectedRuns, `${runId}.index.lock`), 'utf8'),
        ).resolves.toBe('index-lock')
        await expect(
          readFile(join(injectedRuns, `${runId}.run`), 'utf8'),
        ).resolves.toBe('run-lock')
      } finally {
        if (runsJunction) {
          await unlink(runsJunction).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
        await repo.cleanup()
      }
    },
  )

  it('cleans run artifacts when the lock handle close fails', async () => {
    const repo = await createRepo()
    let openSpy: jest.SpyInstance | undefined
    let failedLockFile: string | undefined
    try {
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      const fsPromises =
        jest.requireActual<typeof import('node:fs/promises')>(
          'node:fs/promises',
        )
      const actualOpen = fsPromises.open
      openSpy = jest
        .spyOn(fsPromises, 'open')
        .mockImplementation(async (...args: Parameters<typeof actualOpen>) => {
          const handle = await actualOpen(...args)
          if (!String(args[0]).endsWith('.run')) return handle
          failedLockFile = String(args[0])
          const actualClose = handle.close.bind(handle)
          let rejectClose = true
          return new Proxy(handle, {
            get(target, property) {
              if (property === 'close') {
                return async () => {
                  if (rejectClose) {
                    rejectClose = false
                    await actualClose()
                    throw new Error('injected close failure')
                  }
                  return actualClose()
                }
              }
              const value = Reflect.get(target, property, target)
              return typeof value === 'function' ? value.bind(target) : value
            },
          })
        })
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })

      await expect(backend.begin(policy())).resolves.toBeNull()
      expect(failedLockFile).toEqual(expect.any(String))
      const failedIndexFile = failedLockFile!.replace(/\.run$/, '.index')
      await expect(readFile(failedLockFile!)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(failedIndexFile)).rejects.toMatchObject({
        code: 'ENOENT',
      })
      await expect(readFile(`${failedIndexFile}.lock`)).rejects.toMatchObject({
        code: 'ENOENT',
      })
    } finally {
      openSpy?.mockRestore()
      await repo.cleanup()
    }
  })

  it('blocks hostile global, system, fsmonitor, and external diff helpers', async () => {
    const repo = await createRepo()
    const originalGitEnvironment = {
      global: process.env.GIT_CONFIG_GLOBAL,
      system: process.env.GIT_CONFIG_SYSTEM,
    }
    const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null'
    const globalConfig = join(repo.root, 'hostile-global.config')
    const systemConfig = join(repo.root, 'hostile-system.config')
    const globalMarker = join(repo.root, 'global-filter-marker')
    const systemMarker = join(repo.root, 'system-filter-marker')
    const fsmonitorMarker = join(repo.root, 'fsmonitor-marker')
    const externalDiffMarker = join(repo.root, 'external-diff-marker')
    const markers = [
      globalMarker,
      systemMarker,
      fsmonitorMarker,
      externalDiffMarker,
    ]
    const globalFilterScript = join(repo.root, 'global-filter.js')
    const systemFilterScript = join(repo.root, 'system-filter.js')
    const fsmonitorScript = join(repo.root, 'fsmonitor-helper')
    const gitFsmonitorScript = fsmonitorScript.split('\\').join('/')
    const externalDiffScript = join(repo.root, 'external-diff.js')
    const globalFile = join(repo.vault, 'Allowed', 'global.md')
    const systemFile = join(repo.vault, 'Allowed', 'system.md')
    const externalDiffFile = join(repo.vault, 'Allowed', 'external.md')
    const candidateFile = join(repo.vault, 'Allowed', 'candidate.md')
    const isolatedGitEnvironment = {
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: nullConfig,
    }
    const restore = (key: string, value: string | undefined): void => {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key)
      } else {
        process.env[key] = value
      }
    }
    try {
      await writeFile(
        globalFilterScript,
        `require('node:fs').writeFileSync(${JSON.stringify(globalMarker)}, 'ran'); process.stdin.pipe(process.stdout)\n`,
      )
      await writeFile(
        systemFilterScript,
        `require('node:fs').writeFileSync(${JSON.stringify(systemMarker)}, 'ran'); process.stdin.pipe(process.stdout)\n`,
      )
      await writeFile(
        fsmonitorScript,
        `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(fsmonitorMarker)}, 'ran')\nconst changed = 'Vault/Allowed/external.md\\0'\nprocess.stdout.write(process.argv[2] === '2' ? \`token\\0\${changed}\` : changed)\n`,
        { mode: 0o755 },
      )
      await writeFile(
        externalDiffScript,
        `require('node:fs').writeFileSync(${JSON.stringify(externalDiffMarker)}, 'ran')\n`,
      )
      await writeFile(globalFile, 'before\n')
      await writeFile(systemFile, 'before\n')
      await writeFile(externalDiffFile, 'before\n')
      await writeFile(candidateFile, 'before\n')
      await writeFile(
        join(repo.vault, 'Allowed', '.gitattributes'),
        'global.md filter=hostile-global\nsystem.md filter=hostile-system\n',
      )
      await commitAll(repo.root, 'initial')

      const globalFilterCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(globalFilterScript)}`
      const systemFilterCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(systemFilterScript)}`
      await runGitWithEnvironment(
        repo.root,
        [
          'config',
          '--file',
          globalConfig,
          'filter.hostile-global.clean',
          globalFilterCommand,
        ],
        isolatedGitEnvironment,
      )
      await runGitWithEnvironment(
        repo.root,
        [
          'config',
          '--file',
          globalConfig,
          'filter.hostile-global.required',
          'true',
        ],
        isolatedGitEnvironment,
      )
      await runGitWithEnvironment(
        repo.root,
        [
          'config',
          '--file',
          systemConfig,
          'filter.hostile-system.clean',
          systemFilterCommand,
        ],
        isolatedGitEnvironment,
      )
      await runGitWithEnvironment(
        repo.root,
        [
          'config',
          '--file',
          systemConfig,
          'filter.hostile-system.required',
          'true',
        ],
        isolatedGitEnvironment,
      )

      await appendFile(globalFile, 'global proof\n')
      await runGitWithEnvironment(
        repo.root,
        ['add', '--', 'Vault/Allowed/global.md'],
        {
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: globalConfig,
        },
      )
      await expect(readFile(globalMarker, 'utf8')).resolves.toBe('ran')

      await appendFile(systemFile, 'system proof\n')
      await runGitWithEnvironment(
        repo.root,
        ['add', '--', 'Vault/Allowed/system.md'],
        {
          GIT_CONFIG_SYSTEM: systemConfig,
          GIT_CONFIG_GLOBAL: nullConfig,
        },
      )
      await expect(readFile(systemMarker, 'utf8')).resolves.toBe('ran')

      await runGitWithEnvironment(
        repo.root,
        ['config', 'core.fsmonitor', gitFsmonitorScript],
        isolatedGitEnvironment,
      )
      await runGitWithEnvironment(
        repo.root,
        ['status', '--short'],
        isolatedGitEnvironment,
      )
      await expect(readFile(fsmonitorMarker, 'utf8')).resolves.toBe('ran')

      const externalDiffCommand = `${JSON.stringify(process.execPath)} ${JSON.stringify(externalDiffScript)}`
      await runGitWithEnvironment(
        repo.root,
        ['config', 'diff.external', externalDiffCommand],
        isolatedGitEnvironment,
      )
      await appendFile(externalDiffFile, 'external proof\n')
      await runGitWithEnvironment(
        repo.root,
        ['diff', '--', 'Vault/Allowed/external.md'],
        isolatedGitEnvironment,
      )
      await expect(readFile(externalDiffMarker, 'utf8')).resolves.toBe('ran')

      await Promise.all(markers.map((marker) => rm(marker, { force: true })))
      await appendFile(globalFile, 'backend proof\n')
      await appendFile(systemFile, 'backend proof\n')
      process.env.GIT_CONFIG_GLOBAL = globalConfig
      process.env.GIT_CONFIG_SYSTEM = systemConfig
      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })

      const baseline = await backend.begin(policy())

      expect(baseline).not.toBeNull()
      if (!baseline) throw new Error('Expected a hostile-config baseline')
      await appendFile(candidateFile, 'after\n')
      await expect(
        backend.finish(baseline, [change('Allowed/candidate.md')]),
      ).resolves.toEqual(
        new Map([['Allowed/candidate.md', { additions: 1, deletions: 0 }]]),
      )
      for (const marker of markers) {
        await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      restore('GIT_CONFIG_GLOBAL', originalGitEnvironment.global)
      restore('GIT_CONFIG_SYSTEM', originalGitEnvironment.system)
      await repo.cleanup()
    }
  })

  it('does not execute a clean filter configured in the source repository', async () => {
    const repo = await createRepo()
    try {
      const marker = join(repo.root, 'clean-filter-marker')
      const filterScript = join(repo.root, 'clean-filter.js')
      await writeFile(
        filterScript,
        "require('fs').writeFileSync(process.argv[2], 'ran'); process.stdin.pipe(process.stdout)\n",
      )
      await writeFile(join(repo.vault, 'Allowed', 'a.md'), 'before\n')
      await commitAll(repo.root, 'initial')
      await writeFile(
        join(repo.vault, 'Allowed', '.gitattributes'),
        'a.md filter=evil\n',
      )
      await runGit(repo.root, [
        'config',
        'filter.evil.clean',
        `${JSON.stringify(process.execPath)} ${JSON.stringify(filterScript)} ${JSON.stringify(marker)}`,
      ])
      await runGit(repo.root, ['config', 'filter.evil.required', 'true'])
      await appendFile(join(repo.root, '.git', 'config'), '\n[invalid-config\n')

      const backend = new ShadowGitDiffBackend({
        vaultPath: repo.vault,
        snapshotRoot: join(repo.root, 'snapshots'),
      })
      const baseline = await backend.begin(policy())

      expect(baseline).not.toBeNull()
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
      if (baseline) await backend.finish(baseline, [])
    } finally {
      await repo.cleanup()
    }
  })
})
