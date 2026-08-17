import { App, TFile, TFolder } from 'obsidian'

import type { WorkspaceAccessPolicy } from '../../../types/assistant.types'
import {
  createVaultFolder,
  ensureFolderPathExists,
  getParentFolderPath,
  moveVaultPath,
  trashVaultPath,
} from '../../mcp/vaultFileOps'
import {
  type YoloSettingsLike,
  isWithinYoloUserDataRoot,
} from '../../paths/yoloPaths'
import type {
  BashFsCallbacks,
  BashFsDirentEntry,
  BashFsRmResult,
  BashFsStat,
} from '../../runtime-components/contracts'
import {
  type PathVisibility,
  isVisibleForTraversal,
  resolvePathVisibility,
} from '../workspaceScope'

const SCOPE_ERROR_PREFIX = 'EACCES: path is outside the allowed workspace scope'

const stripSlashes = (raw: string): string =>
  raw.replace(/^\/+/, '').replace(/\/+$/, '')

/**
 * `fs_list`/`fs_search`/`fs_read`/etc. enforced workspace scope by rejecting
 * out-of-scope path *arguments* before dispatch. The bash tool has no
 * discrete path arguments — `command` is an opaque shell string — so scope
 * has to be enforced at the filesystem boundary instead, exactly where
 * `rm`/`mv`/content writes already are (see CLAUDE.md's "fs 层 = 硬边界"
 * principle carried over from the plan). An include-list scope still needs
 * its ancestor directories visible so `ls`/`find` can descend into them —
 * that carve-out is `isVisibleForTraversal` (workspaceScope.ts), used below
 * for `readdir`/`exists`; every other operation here means genuine
 * read/write access to `vaultPath` itself, so it goes through the stricter
 * `resolvePathVisibility` (hidden always wins; scope is the exact-match
 * check, no ancestor allowance).
 */
function throwForDeniedVisibility(
  vaultPath: string,
  verb: string,
  visibility: Exclude<PathVisibility, 'visible'>,
): never {
  if (visibility === 'hidden') {
    throw new Error(`ENOENT: no such file or directory, ${verb} '${vaultPath}'`)
  }
  throw new Error(`${SCOPE_ERROR_PREFIX}: '${vaultPath}'`)
}

function assertPathAccessible(
  vaultPath: string,
  verb: string,
  policy: WorkspaceAccessPolicy | undefined,
  settings: YoloSettingsLike | null | undefined,
): void {
  const visibility = resolvePathVisibility(vaultPath, { policy, settings })
  if (visibility !== 'visible') {
    throwForDeniedVisibility(vaultPath, verb, visibility)
  }
}

/**
 * Bridges the bash-engine runtime component's minimal filesystem contract
 * (`BashFsCallbacks`) to the Obsidian Vault. Every method here receives a
 * vault-relative path with no leading slash (`''` means the vault root) —
 * the `/vault` mount point and root-directory synthesis live entirely in the
 * runtime component (see `runtime-components/bash-engine/src/entry.ts`), so
 * this adapter never has to think about path namespacing.
 *
 * Reads go through `cachedRead`/`readBinary` (no upfront full-vault load).
 * The three writes this exposes (`mkdir`/`rm`/`mv`) delegate to the same
 * service functions the retired `fs_create_dir`/`fs_delete`/`fs_move` tools
 * used (`src/core/mcp/vaultFileOps.ts`), so trash/backlink-rewrite behavior
 * is identical. Content mutation has no callback here at all — the bash tool
 * never writes file content; that stays on `fs_edit`/`fs_write`.
 *
 * `scope` mirrors the workspace-scope confinement other local tools already
 * respect (used to sandbox subagents to a folder subtree); when set, every
 * operation here is denied for paths outside it.
 *
 * `settings` (when supplied) hides the visible `<baseDir>/data` user-data
 * root from every operation below, treating it exactly like a path that
 * doesn't exist. That root holds chat history, module settings, and other
 * internal storage that must live outside a hidden dot-directory so vault
 * sync tools replicate it (see `ensureUserDataRootDir`) — but it was never
 * meant to be agent-readable content. Before that migration the equivalent
 * `.yolo_json_db` root got this same invisibility for free, because Obsidian
 * never indexes dot-prefixed paths into the `TFile` tree this adapter reads
 * from; this is that protection's explicit replacement for the now-visible
 * root.
 */
export function createVaultBashFileSystem(
  app: App,
  policy?: WorkspaceAccessPolicy,
  settings?: YoloSettingsLike | null,
): BashFsCallbacks {
  const isHiddenUserDataPath = (vaultPath: string): boolean =>
    vaultPath !== '' && isWithinYoloUserDataRoot(vaultPath, settings)
  // Local addition over the upstream baseline: `rm`/`mv` on an ancestor
  // folder must not be able to reach excluded descendants (e.g. `rm -rf`
  // on a folder that contains an excluded subtree). `resolvePathVisibility`
  // only checks the target path itself, so the excluded prefixes
  // (`readExcludes` + protected paths) are checked here explicitly.
  const excludedPathPrefixes: string[] = (() => {
    if (!policy?.enabled) return []
    const protectedPaths = (policy.protectedPaths ?? []).map((rule) =>
      rule.kind === 'namePrefix'
        ? `${rule.dir}/${rule.name}`.replace(/\/+$/, '')
        : rule.path,
    )
    return [...(policy.readExcludes ?? []), ...protectedPaths]
      .filter(Boolean)
      .map(stripSlashes)
  })()
  const assertNoExcludedDescendants = (vaultPath: string): void => {
    const normalizedPath = stripSlashes(vaultPath)
    const descendantPrefix = normalizedPath ? `${normalizedPath}/` : ''
    const excludedDescendant = excludedPathPrefixes.find((rule) =>
      rule.startsWith(descendantPrefix),
    )
    if (excludedDescendant !== undefined) {
      throw new Error(`Path contains an excluded path: ${excludedDescendant}`)
    }
  }
  const getFileOrThrow = (vaultPath: string): TFile => {
    const abstractFile = app.vault.getAbstractFileByPath(vaultPath)
    if (!abstractFile) {
      throw new Error(`ENOENT: no such file or directory, open '${vaultPath}'`)
    }
    if (!(abstractFile instanceof TFile)) {
      throw new Error(
        `EISDIR: illegal operation on a directory, read '${vaultPath}'`,
      )
    }
    return abstractFile
  }

  return {
    async readFile(vaultPath) {
      assertPathAccessible(vaultPath, 'open', policy, settings)
      return app.vault.cachedRead(getFileOrThrow(vaultPath))
    },

    async readFileBuffer(vaultPath) {
      assertPathAccessible(vaultPath, 'open', policy, settings)
      const buffer = await app.vault.readBinary(getFileOrThrow(vaultPath))
      return new Uint8Array(buffer)
    },

    async exists(vaultPath) {
      if (vaultPath === '') return true
      if (isHiddenUserDataPath(vaultPath)) return false
      if (policy?.enabled && !isVisibleForTraversal(vaultPath, policy)) {
        return false
      }
      return app.vault.getAbstractFileByPath(vaultPath) !== null
    },

    async stat(vaultPath): Promise<BashFsStat> {
      if (vaultPath === '') {
        return { isFile: false, isDirectory: true, mtimeMs: 0, size: 0 }
      }
      assertPathAccessible(vaultPath, 'stat', policy, settings)
      const abstractFile = app.vault.getAbstractFileByPath(vaultPath)
      if (!abstractFile) {
        throw new Error(
          `ENOENT: no such file or directory, stat '${vaultPath}'`,
        )
      }
      if (abstractFile instanceof TFile) {
        return {
          isFile: true,
          isDirectory: false,
          mtimeMs: abstractFile.stat.mtime,
          size: abstractFile.stat.size,
        }
      }
      return { isFile: false, isDirectory: true, mtimeMs: 0, size: 0 }
    },

    async mkdir(vaultPath, options) {
      assertPathAccessible(vaultPath, 'mkdir', policy, settings)
      const existing =
        vaultPath === ''
          ? undefined
          : app.vault.getAbstractFileByPath(vaultPath)
      if (existing) {
        if (options?.recursive && existing instanceof TFolder) {
          // `mkdir -p` on an already-existing directory is a success, not an
          // error — mirrors POSIX and Node's `fs.mkdir(..., {recursive})`.
          return
        }
        throw new Error(`EEXIST: file already exists, mkdir '${vaultPath}'`)
      }
      if (options?.recursive) {
        await ensureFolderPathExists(app, vaultPath)
        return
      }
      const parent = getParentFolderPath(vaultPath)
      if (parent && !app.vault.getAbstractFileByPath(parent)) {
        throw new Error(
          `ENOENT: no such file or directory, mkdir '${vaultPath}'`,
        )
      }
      await createVaultFolder(app, vaultPath)
    },

    async readdir(vaultPath): Promise<BashFsDirentEntry[]> {
      // Traversal (not `assertPathAccessible`'s exact-match scope check):
      // an ancestor of an include rule must stay listable so `ls`/`find`
      // can descend into it, even though it fails the strict check.
      if (isHiddenUserDataPath(vaultPath)) {
        throw new Error(
          `ENOENT: no such file or directory, scandir '${vaultPath}'`,
        )
      }
      if (policy?.enabled && !isVisibleForTraversal(vaultPath, policy)) {
        throw new Error(`${SCOPE_ERROR_PREFIX}: '${vaultPath}'`)
      }
      const folder =
        vaultPath === ''
          ? app.vault.getRoot()
          : app.vault.getAbstractFileByPath(vaultPath)
      if (!folder) {
        throw new Error(
          `ENOENT: no such file or directory, scandir '${vaultPath}'`,
        )
      }
      if (!(folder instanceof TFolder)) {
        throw new Error(`ENOTDIR: not a directory, scandir '${vaultPath}'`)
      }
      const children = folder.children
        .filter((child) => !isHiddenUserDataPath(child.path))
        .filter((child) =>
          policy?.enabled ? isVisibleForTraversal(child.path, policy) : true,
        )
      return children.map((child) => ({
        name: child.name,
        isFile: child instanceof TFile,
        isDirectory: child instanceof TFolder,
      }))
    },

    async rm(vaultPath, options): Promise<BashFsRmResult> {
      assertPathAccessible(vaultPath, 'unlink', policy, settings)
      assertNoExcludedDescendants(vaultPath)
      return trashVaultPath(app, vaultPath, options)
    },

    async mv(oldVaultPath, newVaultPath) {
      assertPathAccessible(oldVaultPath, 'rename', policy, settings)
      assertPathAccessible(newVaultPath, 'rename', policy, settings)
      assertNoExcludedDescendants(oldVaultPath)
      await moveVaultPath(app, oldVaultPath, newVaultPath)
    },

    getAllPaths(): string[] {
      const paths = app.vault
        .getAllLoadedFiles()
        .map((file) => file.path)
        .filter((filePath) => filePath !== '' && filePath !== '/')
        .filter((filePath) => !isHiddenUserDataPath(filePath))
      return policy?.enabled
        ? paths.filter(
            (filePath) =>
              resolvePathVisibility(filePath, { policy }) === 'visible',
          )
        : paths
    },
  }
}
