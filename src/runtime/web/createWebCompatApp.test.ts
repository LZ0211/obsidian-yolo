import { createWebCompatApp } from './createWebCompatApp'
import type { TAbstractFile, TFolder } from './obsidianCompat'

describe('createWebCompatApp active file state', () => {
  it('uses the current web-selected file for workspace.getActiveFile', () => {
    const app = createWebCompatApp({
      api: {
        previewVaultText: jest.fn(),
        downloadVaultFile: jest.fn(),
      } as never,
      vaultName: 'Vault',
      initialIndex: [],
      initialActiveFile: null,
    })

    expect(app.workspace.getActiveFile()).toBeNull()

    app.__yoloSetActiveFile?.({
      path: 'Project/Note.md',
      name: 'Note.md',
      basename: 'Note',
      extension: 'md',
      stat: { ctime: 1, mtime: 2, size: 3 },
    })

    const activeFile = app.workspace.getActiveFile()
    expect(activeFile?.path).toBe('Project/Note.md')
    expect(activeFile?.basename).toBe('Note')
    expect(activeFile?.extension).toBe('md')
    expect(app.vault.getFileByPath('Project/Note.md')?.path).toBe(
      'Project/Note.md',
    )

    app.__yoloSetActiveFile?.(null)
    expect(app.workspace.getActiveFile()).toBeNull()
  })

  it('exposes Obsidian-compatible vault helpers used by shared components', async () => {
    const app = createWebCompatApp({
      api: {
        previewVaultText: jest.fn(),
        downloadVaultFile: jest.fn(),
        createVaultFolder: jest.fn(),
      } as never,
      vaultName: 'Vault',
      initialIndex: [
        {
          kind: 'folder',
          path: 'Project',
          name: 'Project',
          basename: 'Project',
          extension: '',
        },
        {
          kind: 'file',
          path: 'Project/Note.md',
          name: 'Note.md',
          basename: 'Note',
          extension: 'md',
          stat: { ctime: 1, mtime: 2, size: 3 },
        },
      ],
      initialActiveFile: null,
    })

    expect(app.vault.getFiles().map((file: TAbstractFile) => file.path)).toEqual([
      'Project/Note.md',
    ])
    expect(app.vault.getMarkdownFiles().map((file: TAbstractFile) => file.path)).toEqual([
      'Project/Note.md',
    ])
    expect(app.vault.getAllLoadedFiles().map((file: TAbstractFile) => file.path)).toEqual([
      '/',
      'Project',
      'Project/Note.md',
    ])
    expect(app.vault.getAllFolders(true).map((folder: TFolder) => folder.path)).toEqual([
      '/',
      'Project',
    ])
    expect(app.vault.getRoot().isRoot()).toBe(true)

    const createdFolder = await app.vault.createFolder('Project/New')
    expect(createdFolder.path).toBe('Project/New')
    expect(app.vault.getFolderByPath('Project/New')?.path).toBe('Project/New')
  })
})
