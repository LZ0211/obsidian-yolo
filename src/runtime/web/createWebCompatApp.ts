import type { YoloFileRef, YoloFileStat, YoloVaultIndexEntry } from '../yoloRuntime.types'

import { App, TFile, TFolder, normalizePath } from './obsidianCompat'
import type { WebApiClient, WebLiteSkillEntry } from './WebApiClient'

type WorkspaceListener = (...args: unknown[]) => void

type FileSystemState = {
  root: TFolder
  files: Map<string, TFile>
  folders: Map<string, TFolder>
}

type AdapterListing = {
  files: string[]
  folders: string[]
}

type AdapterStat = YoloFileStat & {
  type: 'file' | 'folder'
}

function createEnoentError(path: string): Error & { code: 'ENOENT' } {
  const error = new Error(`ENOENT: no such file or directory, open '${path}'`) as Error & {
    code: 'ENOENT'
  }
  error.code = 'ENOENT'
  return error
}

function createFolderStat(): AdapterStat {
  return {
    type: 'folder',
    ctime: 0,
    mtime: 0,
    size: 0,
  }
}

function createFileStat(size = 0, now = Date.now()): AdapterStat {
  return {
    type: 'file',
    ctime: now,
    mtime: now,
    size,
  }
}

function applyFileStat(file: TFile, stat?: YoloFileStat | null): void {
  file.stat = stat
    ? {
        type: 'file',
        ctime: stat.ctime,
        mtime: stat.mtime,
        size: stat.size,
      }
    : createFileStat()
}

export function createWebCompatApp({
  api,
  vaultName,
  initialIndex,
  initialActiveFile,
}: {
  api: WebApiClient
  vaultName: string
  initialIndex: YoloVaultIndexEntry[]
  initialActiveFile?: YoloFileRef | null
  getAssistantId?: () => string | null
}): App & {
  __yoloRefreshIndex?: (nextIndex: YoloVaultIndexEntry[]) => void
  __yoloSetActiveFile?: (file: YoloFileRef | null) => void
  __yoloListLiteSkillEntries?: () => Promise<WebLiteSkillEntry[]>
} {
  const workspaceListeners = new Map<string, Set<WorkspaceListener>>()
  let fileSystem = buildFileSystem(initialIndex)
  let activeFilePath = initialActiveFile?.path
    ? normalizePath(initialActiveFile.path)
    : null

  const trigger = (event: string, ...args: unknown[]) => {
    const listeners = workspaceListeners.get(event)
    listeners?.forEach((listener) => listener(...args))
  }

  const on = (event: string, listener: WorkspaceListener) => {
    const listeners = workspaceListeners.get(event) ?? new Set<WorkspaceListener>()
    listeners.add(listener)
    workspaceListeners.set(event, listeners)
    return listener
  }

  const off = (event: string, listener: WorkspaceListener) => {
    workspaceListeners.get(event)?.delete(listener)
  }

  const setActiveFilePath = (nextPath: string | null) => {
    const normalized = nextPath ? normalizePath(nextPath) : null
    if (activeFilePath === normalized) return
    activeFilePath = normalized
    trigger('active-leaf-change')
    trigger('file-open')
    trigger('layout-change')
  }

  const addFolderEntry = (path: string): TFolder => {
    const normalizedPath = normalizePath(path)
    const existing = fileSystem.folders.get(normalizedPath)
    if (existing) return existing

    const folder = new TFolder(vault, normalizedPath)
    ;(folder as TFolder & { stat?: AdapterStat }).stat = createFolderStat()
    fileSystem.folders.set(normalizedPath, folder)
    if (normalizedPath !== '/') {
      const parent = ensureParentFolder(normalizedPath)
      folder.parent = parent
      if (!parent.children.some((child) => child.path === folder.path)) {
        parent.children.push(folder)
      }
    }
    return folder
  }

  const addFileEntry = (fileRef: YoloFileRef): TFile => {
    const normalizedPath = normalizePath(fileRef.path)
    const existing = fileSystem.files.get(normalizedPath)
    if (existing) {
      applyFileStat(existing, fileRef.stat)
      return existing
    }

    const file = new TFile(vault, normalizedPath)
    applyFileStat(file, fileRef.stat)
    fileSystem.files.set(normalizedPath, file)
    const parent = ensureParentFolder(normalizedPath)
    file.parent = parent
    if (!parent.children.some((child) => child.path === file.path)) {
      parent.children.push(file)
    }
    return file
  }

  const removeEntry = (path: string) => {
    const normalizedPath = normalizePath(path)
    const file = fileSystem.files.get(normalizedPath)
    if (file) {
      fileSystem.files.delete(normalizedPath)
      file.parent?.children.splice(
        file.parent.children.findIndex((child) => child.path === normalizedPath),
        1,
      )
      if (activeFilePath === normalizedPath) setActiveFilePath(null)
      return
    }

    const folder = fileSystem.folders.get(normalizedPath)
    if (!folder || normalizedPath === '/') return

    for (const child of [...folder.children]) removeEntry(child.path)
    folder.parent?.children.splice(
      folder.parent.children.findIndex((child) => child.path === normalizedPath),
      1,
    )
    fileSystem.folders.delete(normalizedPath)
  }

  const ensureParentFolder = (path: string): TFolder => {
    const normalizedPath = normalizePath(path)
    const lastSlash = normalizedPath.lastIndexOf('/')
    if (lastSlash < 0) return fileSystem.root
    const parentPath = normalizedPath.slice(0, lastSlash) || '/'
    return addFolderEntry(parentPath)
  }

  const resolveFile = (path: string | TFile | null | undefined): TFile | null => {
    if (!path) return null
    if (path instanceof TFile) return path
    return fileSystem.files.get(normalizePath(path)) ?? null
  }

  const resolveFolder = (
    path: string | TFolder | null | undefined,
  ): TFolder | null => {
    if (!path) return null
    if (path instanceof TFolder) return path
    return fileSystem.folders.get(normalizePath(path)) ?? null
  }

  const resolveLinkpath = (linkpath: string): TFile | null => {
    const normalized = normalizePath(linkpath.split('#')[0] ?? linkpath)
    return (
      fileSystem.files.get(normalized) ??
      fileSystem.files.get(`${normalized}.md`) ??
      null
    )
  }

  const readPath = async (path: string): Promise<string> =>
    api.readVaultText(normalizePath(path))

  const listFolderPaths = (path: string): AdapterListing => {
    const folder = resolveFolder(path)
    if (!folder) throw createEnoentError(path)
    return {
      files: folder.children
        .filter((child): child is TFile => child instanceof TFile)
        .map((child) => child.path)
        .sort((a, b) => a.localeCompare(b)),
      folders: folder.children
        .filter((child): child is TFolder => child instanceof TFolder)
        .map((child) => child.path)
        .sort((a, b) => a.localeCompare(b)),
    }
  }

  const statPath = (path: string): AdapterStat | null => {
    const file = resolveFile(path)
    if (file) return file.stat as AdapterStat
    const folder = resolveFolder(path)
    if (folder) {
      return (folder as TFolder & { stat?: AdapterStat }).stat ?? createFolderStat()
    }
    return null
  }

  const upsertTextFile = (
    path: string,
    content: string,
    preserveCreatedAt = false,
  ): TFile => {
    const normalizedPath = normalizePath(path)
    const existing = resolveFile(normalizedPath)
    const now = Date.now()
    const nextStat: AdapterStat = {
      type: 'file',
      ctime: preserveCreatedAt
        ? ((existing?.stat as AdapterStat | undefined)?.ctime ?? now)
        : now,
      mtime: now,
      size: new TextEncoder().encode(content).byteLength,
    }
    const file = addFileEntry({
      path: normalizedPath,
      name: normalizedPath.split('/').pop() || '',
      basename: normalizedPath.split('/').pop()?.replace(/\.[^.]+$/, '') || '',
      extension: normalizedPath.includes('.')
        ? normalizedPath.split('.').pop() || ''
        : '',
      stat: nextStat,
    })
    applyFileStat(file, nextStat)
    return file
  }

  const upsertBinaryFile = (
    path: string,
    content: ArrayBuffer,
    preserveCreatedAt = false,
  ): TFile => {
    const normalizedPath = normalizePath(path)
    const existing = resolveFile(normalizedPath)
    const now = Date.now()
    const nextStat: AdapterStat = {
      type: 'file',
      ctime: preserveCreatedAt
        ? ((existing?.stat as AdapterStat | undefined)?.ctime ?? now)
        : now,
      mtime: now,
      size: content.byteLength,
    }
    const file = addFileEntry({
      path: normalizedPath,
      name: normalizedPath.split('/').pop() || '',
      basename: normalizedPath.split('/').pop()?.replace(/\.[^.]+$/, '') || '',
      extension: normalizedPath.includes('.')
        ? normalizedPath.split('.').pop() || ''
        : '',
      stat: nextStat,
    })
    applyFileStat(file, nextStat)
    return file
  }

  const workspace = {
    on,
    off,
    trigger,
    getActiveFile: () =>
      activeFilePath ? fileSystem.files.get(activeFilePath) ?? null : null,
    getActiveViewOfType: <T>(_type: new (...args: never[]) => T): T | null =>
      null,
    getMostRecentLeaf: () => null,
    getLeavesOfType: (_type: string) => [],
    getLeaf: (_split: boolean | string) => ({
      view: null,
      openFile: async (file: TFile) => {
        setActiveFilePath(file.path)
        window.dispatchEvent(
          new CustomEvent('yolo:web-open-file', {
            detail: { path: file.path },
          }),
        )
      },
    }),
    openLinkText: async (
      linktext: string,
      sourcePath: string,
      newLeaf: boolean | string,
    ) => {
      const file = resolveLinkpath(linktext)
      if (file) setActiveFilePath(file.path)
      window.dispatchEvent(
        new CustomEvent('yolo:web-open-link', {
          detail: {
            linktext,
            sourcePath,
            newLeaf,
            resolvedPath: file?.path ?? null,
          },
        }),
      )
    },
    setActiveLeaf: (_leaf: unknown, _options?: unknown) => {},
  }

  const vault = {
    adapter: {
      exists: async (path: string) => {
        const normalizedPath = normalizePath(path)
        return (
          fileSystem.files.has(normalizedPath) ||
          fileSystem.folders.has(normalizedPath)
        )
      },
      read: async (path: string) => readPath(path),
      readBinary: async (path: string) =>
        (await api.readVaultBinary(normalizePath(path))).arrayBuffer(),
      write: async (path: string, content: string) => {
        const normalizedPath = normalizePath(path)
        await api.writeVaultText(normalizedPath, content, true)
        upsertTextFile(normalizedPath, content, true)
      },
      writeBinary: async (path: string, content: ArrayBuffer) => {
        const normalizedPath = normalizePath(path)
        await api.writeVaultBinary(normalizedPath, content, true)
        upsertBinaryFile(normalizedPath, content, true)
      },
      list: async (path: string) => listFolderPaths(normalizePath(path)),
      stat: async (path: string) => statPath(normalizePath(path)),
      rmdir: async (path: string, recursive: boolean) => {
        const normalizedPath = normalizePath(path)
        await api.deleteVaultFolder(normalizedPath, recursive)
        removeEntry(normalizedPath)
      },
      mkdir: async (path: string) => {
        const normalizedPath = normalizePath(path)
        await api.createVaultFolder(normalizedPath, true)
        addFolderEntry(normalizedPath)
      },
      remove: async (path: string) => {
        const normalizedPath = normalizePath(path)
        await api.deleteVaultFile(normalizedPath)
        removeEntry(normalizedPath)
      },
      rename: async (path: string, newPath: string) => {
        const normalizedPath = normalizePath(path)
        const normalizedNewPath = normalizePath(newPath)
        await api.renameVaultPath(normalizedPath, normalizedNewPath, true)
        const file = resolveFile(normalizedPath)
        const folder = resolveFolder(normalizedPath)
        removeEntry(normalizedPath)
        if (file) {
          addFileEntry({
            path: normalizedNewPath,
            name: normalizedNewPath.split('/').pop() || '',
            basename: normalizedNewPath.split('/').pop()?.replace(/\.[^.]+$/, '') || '',
            extension: normalizedNewPath.includes('.')
              ? normalizedNewPath.split('.').pop() || ''
              : '',
            stat: file.stat,
          })
        } else if (folder) {
          addFolderEntry(normalizedNewPath)
        }
      },
    },
    cachedRead: async (file: TFile | string) =>
      readPath(typeof file === 'string' ? file : file.path),
    read: async (file: TFile | string) =>
      readPath(typeof file === 'string' ? file : file.path),
    readBinary: async (file: TFile | string) =>
      (await api.readVaultBinary(
        typeof file === 'string' ? file : file.path,
      )).arrayBuffer(),
    modify: async (file: TFile, content: string) => {
      await api.writeVaultText(file.path, content, true)
      upsertTextFile(file.path, content, true)
    },
    create: async (path: string, content: string) => {
      const normalizedPath = normalizePath(path)
      await api.createVaultFile(normalizedPath, content, false)
      return upsertTextFile(normalizedPath, content)
    },
    createFolder: async (path: string) => {
      const normalizedPath = normalizePath(path)
      await api.createVaultFolder(normalizedPath, false)
      return addFolderEntry(normalizedPath)
    },
    delete: async (file: TFile | TFolder, force?: boolean) => {
      if (file instanceof TFolder) {
        await api.deleteVaultFolder(file.path, force ?? false)
      } else {
        await api.deleteVaultFile(file.path)
      }
      removeEntry(file.path)
    },
    trash: async (file: TFile | TFolder, _system: boolean) => {
      if (file instanceof TFolder) {
        await api.deleteVaultFolder(file.path, true)
      } else {
        await api.deleteVaultFile(file.path)
      }
      removeEntry(file.path)
    },
    rename: async (file: TFile | TFolder, newPath: string) => {
      await vault.adapter.rename(file.path, newPath)
    },
    getAbstractFileByPath: (path: string) => {
      const normalizedPath = normalizePath(path)
      return (
        fileSystem.files.get(normalizedPath) ??
        fileSystem.folders.get(normalizedPath) ??
        null
      )
    },
    getRoot: () => fileSystem.root,
    getFileByPath: (path: string) => resolveFile(path),
    getFolderByPath: (path: string) => resolveFolder(path),
    getFiles: () => Array.from(fileSystem.files.values()),
    getAllFolders: (includeRoot?: boolean) =>
      Array.from(fileSystem.folders.values()).filter(
        (folder) => includeRoot || folder.path !== '/',
      ),
    getMarkdownFiles: () =>
      Array.from(fileSystem.files.values()).filter(
        (file) => file.extension === 'md',
      ),
    getAllLoadedFiles: () => [
      ...Array.from(fileSystem.folders.values()),
      ...Array.from(fileSystem.files.values()),
    ],
    getName: () => vaultName,
    on: (_name: string, _callback: (...args: unknown[]) => void) => () => {},
    off: (_name: string, _callback: (...args: unknown[]) => void) => {},
    offref: (_callback: (...args: unknown[]) => void) => {},
    trigger: (_name: string, ..._args: unknown[]) => {},
  }

  const metadataCache = {
    getFileCache: (_file: TFile) => null,
    getFirstLinkpathDest: (linkpath: string, _sourcePath: string) =>
      resolveLinkpath(linkpath),
  }

  const fileManager = {
    trashFile: async (file: TFile | TFolder) => {
      await vault.trash(file, true)
    },
  }

  const setting = {
    open: () => {
      window.dispatchEvent(new CustomEvent('yolo:web-open-settings'))
    },
    openTabById: (tabId: string) => {
      window.dispatchEvent(
        new CustomEvent('yolo:web-open-settings', {
          detail: { tabId },
        }),
      )
    },
  }

  return Object.assign(new App(), {
    vault,
    workspace,
    metadataCache,
    fileManager,
    setting,
    __yoloWebVaultIndex: initialIndex,
    __yoloSetActiveFile: (file: YoloFileRef | null) => {
      if (file) addFileEntry(file)
      setActiveFilePath(file?.path ?? null)
    },
    __yoloRefreshIndex: (nextIndex: YoloVaultIndexEntry[]) => {
      fileSystem = buildFileSystem(nextIndex)
    },
    __yoloListLiteSkillEntries: () => api.getSkills(),
  })
}

function buildFileSystem(index: YoloVaultIndexEntry[]): FileSystemState {
  const root = new TFolder(null, '/')
  ;(root as TFolder & { stat?: AdapterStat }).stat = createFolderStat()
  const folders = new Map<string, TFolder>([['/', root]])
  const files = new Map<string, TFile>()
  const sortedEntries = [...index].sort((a, b) => a.path.localeCompare(b.path))

  const ensureFolder = (path: string): TFolder => {
    const normalizedPath = normalizePath(path)
    const existing = folders.get(normalizedPath)
    if (existing) return existing

    const folder = new TFolder(null, normalizedPath)
    ;(folder as TFolder & { stat?: AdapterStat }).stat = createFolderStat()
    folders.set(normalizedPath, folder)
    if (normalizedPath !== '/') {
      const lastSlash = normalizedPath.lastIndexOf('/')
      const parentPath = lastSlash < 0 ? '/' : normalizedPath.slice(0, lastSlash) || '/'
      const parent = ensureFolder(parentPath)
      folder.parent = parent
      if (!parent.children.some((child) => child.path === folder.path)) {
        parent.children.push(folder)
      }
    }
    return folder
  }

  for (const entry of sortedEntries) {
    if (entry.kind === 'folder') ensureFolder(entry.path)
  }

  for (const entry of sortedEntries) {
    if (entry.kind !== 'file') continue

    const normalizedPath = normalizePath(entry.path)
    const file = new TFile(null, normalizedPath)
    applyFileStat(file, entry.stat)
    files.set(normalizedPath, file)
    const lastSlash = normalizedPath.lastIndexOf('/')
    const parentPath = lastSlash < 0 ? '/' : normalizedPath.slice(0, lastSlash) || '/'
    const parent = ensureFolder(parentPath)
    file.parent = parent
    if (!parent.children.some((child) => child.path === file.path)) {
      parent.children.push(file)
    }
  }

  return { root, files, folders }
}
