/**
 * @jest-environment jsdom
 */

jest.mock('react', () => {
  const actual = jest.requireActual('react')
  const react = actual.default ?? actual
  return {
    ...react,
    __esModule: true,
    default: react,
    useLayoutEffect: react.useEffect,
  }
})
jest.mock('react-dom/client', () => ({
  createRoot: jest.fn((container: HTMLElement) => ({
    render: (element: { props?: { content?: string } }) => {
      if (element?.props?.content) {
        container.setText(element.props.content)
      }
    },
    unmount: jest.fn(),
  })),
}))
jest.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  oneLight: {},
}))
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: jest.fn(),
  defaultUrlTransform: (url: string) => url,
}))
jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('./preview/remark-obsidian-wikilink', () => ({
  remarkObsidianWikilink: () => () => (tree: unknown) => tree,
}))
jest.mock('./preview/remark-obsidian-embed', () => ({
  remarkObsidianEmbed: () => () => (tree: unknown) => tree,
}))
jest.mock('./preview/remark-obsidian-callout', () => ({
  remarkObsidianCallout: () => () => (tree: unknown) => tree,
}))

import { installDomCompat } from '../runtime/web/obsidianDomCompat'
import type {
  WebApiClient,
  WebVaultListItem,
} from '../runtime/web/WebApiClient'

import { createObsidianFileTree } from './obsidianFileTreeDom'
import { createObsidianPreviewPane } from './obsidianPreviewDom'
import {
  classifyPreviewType,
  isSafeTextPreviewExtension,
} from './webWorkspaceUtils'

describe('WebObsidianFileExplorer preview safety', () => {
  it('classifies html files as text previews', () => {
    expect(
      classifyPreviewType({
        kind: 'file',
        path: 'docs/page.html',
        name: 'page.html',
        extension: 'html',
      }),
    ).toBe('text')
    expect(isSafeTextPreviewExtension('html')).toBe(true)
  })

  it('treats svg files as binary download-only previews', () => {
    expect(
      classifyPreviewType({
        kind: 'file',
        path: 'img/vector.svg',
        name: 'vector.svg',
        extension: 'svg',
      }),
    ).toBe('binary')
    expect(isSafeTextPreviewExtension('svg')).toBe(false)
  })

  it('keeps markdown and plain text in safe text preview mode', () => {
    expect(
      classifyPreviewType({
        kind: 'file',
        path: 'notes/test.md',
        name: 'test.md',
        extension: 'md',
      }),
    ).toBe('text')
    expect(isSafeTextPreviewExtension('md')).toBe(true)
    expect(isSafeTextPreviewExtension('txt')).toBe(true)
  })
})

describe('createObsidianPreviewPane stale-request guard', () => {
  beforeEach(() => {
    installDomCompat()
  })

  it('ignores stale preview responses after a newer file is opened', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const resolvers: Array<(value: string) => void> = []
    const client = {
      previewVaultText: jest.fn(
        () => new Promise<string>((resolve) => resolvers.push(resolve)),
      ),
      readVaultBinary: jest.fn(),
      downloadVaultFile: jest.fn(),
    }

    const preview = createObsidianPreviewPane(
      parent,
      client as unknown as WebApiClient,
    )
    void preview.openPreview({ path: 'older.md', source: 'file-tree' } as never)
    void preview.openPreview({ path: 'newer.md', source: 'file-tree' } as never)

    resolvers[1]('newer')
    resolvers[0]('older')

    await Promise.resolve()
    await Promise.resolve()

    expect(parent.textContent).toContain('newer')
    expect(parent.textContent).not.toContain('older')

    preview.destroy()
    parent.remove()
  })
})

function makeVaultClient(initial: WebVaultListItem[] = []): {
  client: WebApiClient
  vault: Set<string>
  folders: Set<string>
  listVaultFolder: jest.Mock
  createVaultFolder: jest.Mock
  uploadVaultFiles: jest.Mock
} {
  const vault = new Set<string>(initial.map((i) => i.path))
  const folders = new Set<string>(
    initial.filter((i) => i.kind === 'folder').map((i) => i.path),
  )
  const listVaultFolder = jest.fn(async (path: string) => {
    const prefix = path === '/' ? '' : path + '/'
    const items: WebVaultListItem[] = []
    const paths = Array.from(vault).sort()
    for (const p of paths) {
      if (!p.startsWith(prefix)) continue
      const rest = p.slice(prefix.length)
      if (rest === '') continue
      if (rest.includes('/')) continue
      const isFolder = folders.has(p)
      items.push({
        kind: isFolder ? 'folder' : 'file',
        path: p,
        name: rest,
        extension: isFolder ? undefined : rest.split('.').pop(),
      })
    }
    return { items, nextCursor: null, hasMore: false }
  })
  const createVaultFolder = jest.fn(async (path: string) => {
    vault.add(path)
    folders.add(path)
  })
  const uploadVaultFiles = jest.fn(async () => [
    { path: 'ok', ok: true as const },
  ])
  const client = {
    listVaultFolder,
    createVaultFolder,
    uploadVaultFiles,
    createVaultFile: jest.fn(async (path: string) => {
      vault.add(path)
    }),
    renameVaultPath: jest.fn(async (_from: string, to: string) => {
      vault.add(to)
    }),
    moveVaultPath: jest.fn(async (_from: string, to: string) => {
      vault.add(to)
    }),
    deleteVaultFile: jest.fn(async (path: string) => {
      vault.delete(path)
    }),
    deleteVaultFolder: jest.fn(async (path: string) => {
      for (const p of Array.from(vault)) {
        if (p === path || p.startsWith(path + '/')) vault.delete(p)
      }
      folders.delete(path)
    }),
    searchVault: jest.fn(async () => ({
      items: [],
      nextCursor: null,
      hasMore: false,
    })),
    downloadVaultFile: jest.fn(),
  }
  return {
    client: client as unknown as WebApiClient,
    vault,
    folders,
    listVaultFolder,
    createVaultFolder,
    uploadVaultFiles,
  }
}

function flush() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0))
}

describe('createObsidianFileTree reconciliation', () => {
  beforeEach(() => {
    installDomCompat()
  })

  it('folder creation selects the new folder, not a file', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([])

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    // let initial loadFolder('') settle
    await flush()
    await flush()

    const newFolderBtn = parent.querySelector(
      '.nav-action-button[aria-label="新建文件夹"]',
    ) as HTMLElement
    newFolderBtn.click()

    // Allow createVaultFolder + refreshLoadedFolders + post-create rename trigger to settle.
    for (let i = 0; i < 6; i++) await flush()

    const folderRow = parent.querySelector('[data-path="Untitled"]')
    expect(folderRow).not.toBeNull()
    expect(folderRow!.classList.contains('nav-folder')).toBe(true)
    // Folder active state: selectedFilePath == null && path === selectedFolderPath
    const selfEl = folderRow!.querySelector('.tree-item-self') as HTMLElement
    expect(selfEl.classList.contains('is-active')).toBe(true)

    // No file row should be marked active (regression: previously a file was selected).
    const activeFileRow = parent.querySelector(
      '.nav-file .tree-item-self.is-active',
    )
    expect(activeFileRow).toBeNull()

    tree.destroy()
    parent.remove()
  })

  it('clicking blank tree area clears selection back to the invisible root', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
      { kind: 'file', path: 'readme.md', name: 'readme.md', extension: 'md' },
    ])

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const docsSelf = parent.querySelector(
      '[data-path="docs"] > .tree-item-self',
    ) as HTMLElement
    docsSelf.click()
    await flush()

    expect(
      (
        parent.querySelector(
          '[data-path="docs"] > .tree-item-self',
        ) as HTMLElement
      ).classList.contains('is-active'),
    ).toBe(true)

    const treeContainer = parent.querySelector(
      '.nav-files-container',
    ) as HTMLElement
    treeContainer.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    await flush()

    expect(parent.querySelector('.tree-item-self.is-active')).toBeNull()

    tree.destroy()
    parent.remove()
  })

  it('keeps root unselected after blank click in a scoped workspace', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'Notes', name: 'Notes' },
      { kind: 'folder', path: 'Notes/Project', name: 'Project' },
      {
        kind: 'file',
        path: 'Notes/Project/readme.md',
        name: 'readme.md',
        extension: 'md',
      },
    ])

    createObsidianFileTree(
      parent,
      client,
      {
        onOpenFile: () => {},
        onOpenFolder: () => {},
        onPreview: () => {},
        onOperationError: () => {},
        refreshTree: () => {},
        prompts: {
          requestRename: async () => null,
          requestMove: async () => null,
          requestDelete: async () => false,
        },
      },
      { workspaceRoot: 'Notes/Project' },
    )

    await flush()
    await flush()

    const treeContainer = parent.querySelector(
      '.nav-files-container',
    ) as HTMLElement
    treeContainer.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    )
    await flush()

    const renameBtn = parent.querySelector(
      '.nav-action-button[aria-label="重命名所选"]',
    ) as HTMLElement
    const deleteBtn = parent.querySelector(
      '.nav-action-button[aria-label="删除所选"]',
    ) as HTMLElement
    expect(renameBtn.getAttribute('aria-disabled')).toBe('true')
    expect(deleteBtn.getAttribute('aria-disabled')).toBe('true')
  })

  it('new folder creation immediately prompts for rename', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([])
    const requestRename = jest.fn(async (_entry: unknown) => null)

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      prompts: {
        requestRename,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const newFolderBtn = parent.querySelector(
      '.nav-action-button[aria-label="新建文件夹"]',
    ) as HTMLElement
    newFolderBtn.click()

    for (let i = 0; i < 6; i++) await flush()

    expect(requestRename).toHaveBeenCalledTimes(1)
    expect(requestRename.mock.calls[0]?.[0]).toMatchObject({
      kind: 'folder',
      path: 'Untitled',
      name: 'Untitled',
    })

    tree.destroy()
    parent.remove()
  })

  it('expands the parent folder before prompting rename for a new subfolder', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
      { kind: 'folder', path: 'docs/sub', name: 'sub' },
    ])
    const requestRename = jest.fn(async () => null)

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      prompts: {
        requestRename,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const docsSelf = parent.querySelector(
      '[data-path="docs"] > .tree-item-self',
    ) as HTMLElement
    docsSelf.click()
    for (let i = 0; i < 4; i++) await flush()

    const subSelf = parent.querySelector(
      '[data-path="docs/sub"] > .tree-item-self',
    ) as HTMLElement
    subSelf.click()
    for (let i = 0; i < 4; i++) await flush()

    // Click the selected folder again so it stays selected but becomes collapsed.
    subSelf.click()
    for (let i = 0; i < 4; i++) await flush()

    expect(parent.querySelector('[data-path="docs/sub/Untitled"]')).toBeNull()

    const newFolderBtn = parent.querySelector(
      '.nav-action-button[aria-label="新建文件夹"]',
    ) as HTMLElement
    newFolderBtn.click()

    for (let i = 0; i < 6; i++) await flush()

    expect(requestRename).toHaveBeenCalledTimes(1)
    expect(
      parent.querySelector('[data-path="docs/sub/Untitled"]'),
    ).not.toBeNull()

    tree.destroy()
    parent.remove()
  })

  it('expands the parent folder before showing a new file in a collapsed subfolder', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
      { kind: 'folder', path: 'docs/sub', name: 'sub' },
    ])

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const docsSelf = parent.querySelector(
      '[data-path="docs"] > .tree-item-self',
    ) as HTMLElement
    docsSelf.click()
    for (let i = 0; i < 4; i++) await flush()

    const subSelf = parent.querySelector(
      '[data-path="docs/sub"] > .tree-item-self',
    ) as HTMLElement
    subSelf.click()
    for (let i = 0; i < 4; i++) await flush()
    subSelf.click()
    for (let i = 0; i < 4; i++) await flush()

    expect(
      parent.querySelector('[data-path="docs/sub/Untitled.md"]'),
    ).toBeNull()

    const newFileBtn = parent.querySelector(
      '.nav-action-button[aria-label="新建文件"]',
    ) as HTMLElement
    newFileBtn.click()

    for (let i = 0; i < 6; i++) await flush()

    expect(
      parent.querySelector('[data-path="docs/sub/Untitled.md"]'),
    ).not.toBeNull()

    tree.destroy()
    parent.remove()
  })

  it('upload reloads the drop-target folder, not selectedFolderPath', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    // Root contains a 'docs' folder; selectedFolderPath stays '' (root).
    const { client, listVaultFolder } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
    ])

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const docsRow = parent.querySelector('[data-path="docs"]') as HTMLElement
    expect(docsRow).not.toBeNull()

    const file = {
      name: 'note.md',
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    } as unknown as File

    const event = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as unknown as DragEvent
    Object.defineProperty(event, 'dataTransfer', {
      value: { files: [file], dropEffect: 'none' },
      configurable: true,
    })
    docsRow.querySelector('.tree-item-self')!.dispatchEvent(event)

    for (let i = 0; i < 6; i++) await flush()

    const lastPath =
      listVaultFolder.mock.calls[listVaultFolder.mock.calls.length - 1]![0]
    expect(lastPath).toBe('docs')
    expect(lastPath).not.toBe('')

    tree.destroy()
    parent.remove()
  })

  it('deletes a selected folder from the nav action', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
      {
        kind: 'file',
        path: 'docs/note.md',
        name: 'note.md',
        extension: 'md',
      },
    ])

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => true,
      },
    })

    await flush()
    await flush()

    const docsSelf = parent.querySelector(
      '[data-path="docs"] > .tree-item-self',
    ) as HTMLElement
    docsSelf.click()
    await flush()

    const deleteBtn = parent.querySelector(
      '.nav-action-button[aria-label="删除所选"]',
    ) as HTMLElement
    deleteBtn.click()

    for (let i = 0; i < 6; i++) await flush()

    // eslint-disable-next-line @typescript-eslint/unbound-method -- jest mock 断言需要方法引用（jasmine 无 this 绑定）
    expect(client.deleteVaultFolder as jest.Mock).toHaveBeenCalledWith(
      'docs',
      true,
    )
    expect(parent.querySelector('[data-path="docs"]')).toBeNull()

    tree.destroy()
    parent.remove()
  })

  it('manual refresh notifies vault mutation observers after reloading folders', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client, listVaultFolder } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
    ])
    const onVaultMutated = jest.fn()

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      onVaultMutated,
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    listVaultFolder.mockClear()
    onVaultMutated.mockClear()

    const refreshBtn = parent.querySelector(
      '.nav-action-button[aria-label="刷新文件"]',
    ) as HTMLElement
    refreshBtn.click()

    for (let i = 0; i < 4; i++) await flush()

    expect(listVaultFolder).toHaveBeenCalled()
    expect(onVaultMutated).toHaveBeenCalledTimes(1)

    tree.destroy()
    parent.remove()
  })

  it('ignores dropping a folder onto its own row', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
    ])
    const onOperationError = jest.fn()

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError,
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const docsRow = parent.querySelector('[data-path="docs"]') as HTMLElement
    expect(docsRow).not.toBeNull()

    const dragStart = new Event('dragstart', {
      bubbles: true,
      cancelable: true,
    }) as unknown as DragEvent
    Object.defineProperty(dragStart, 'dataTransfer', {
      value: {
        setData: jest.fn(),
        effectAllowed: 'none',
      },
      configurable: true,
    })
    docsRow.dispatchEvent(dragStart)

    const drop = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as unknown as DragEvent
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        files: [],
        getData: (type: string) =>
          type === 'application/x-yolo-vault-path' ? 'docs' : '',
      },
      configurable: true,
    })
    docsRow.querySelector('.tree-item-self')!.dispatchEvent(drop)

    await flush()
    await flush()

    expect(onOperationError).not.toHaveBeenCalled()
    expect((client.moveVaultPath as jest.Mock).mock.calls).toHaveLength(0)

    tree.destroy()
    parent.remove()
  })

  it('renders a standard drop indicator during internal drag hover', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
      { kind: 'file', path: 'readme.md', name: 'readme.md', extension: 'md' },
    ])

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const readmeRow = parent.querySelector(
      '[data-path="readme.md"] .tree-item-self',
    ) as HTMLElement
    expect(readmeRow).not.toBeNull()

    Object.defineProperty(readmeRow, 'getBoundingClientRect', {
      value: () => ({
        top: 100,
        bottom: 132,
        left: 20,
        right: 220,
        width: 200,
        height: 32,
        x: 20,
        y: 100,
        toJSON: () => ({}),
      }),
      configurable: true,
    })

    const dragOver = new Event('dragover', {
      bubbles: true,
      cancelable: true,
    }) as unknown as DragEvent
    Object.defineProperty(dragOver, 'clientY', {
      value: 102,
      configurable: true,
    })
    // Source is a file inside a subfolder; dropping at root.before-readme.md
    // is a valid cross-parent move, so the indicator should render.
    Object.defineProperty(dragOver, 'dataTransfer', {
      value: {
        types: ['application/x-yolo-vault-path'],
        dropEffect: 'none',
        getData: (type: string) =>
          type === 'application/x-yolo-vault-path' ? 'docs/note.md' : '',
      },
      configurable: true,
    })
    readmeRow.dispatchEvent(dragOver)

    const indicator = parent.querySelector('.drop-indicator.is-active')
    expect(indicator).not.toBeNull()
    expect((indicator as HTMLElement).style.left).toBe('20px')
    expect((indicator as HTMLElement).style.width).toBe('200px')

    const drop = new Event('drop', {
      bubbles: true,
      cancelable: true,
    }) as unknown as DragEvent
    Object.defineProperty(drop, 'clientY', {
      value: 102,
      configurable: true,
    })
    Object.defineProperty(drop, 'dataTransfer', {
      value: {
        files: [],
        getData: (type: string) =>
          type === 'application/x-yolo-vault-path' ? 'docs' : '',
      },
      configurable: true,
    })
    readmeRow.dispatchEvent(drop)

    await flush()

    expect(parent.querySelector('.drop-indicator.is-active')).toBeNull()

    tree.destroy()
    parent.remove()
  })

  it('scopes dragging to the visible row, not the folder subtree container', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
      {
        kind: 'file',
        path: 'docs/note.md',
        name: 'note.md',
        extension: 'md',
      },
    ])

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError: () => {},
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const docsSelf = parent.querySelector(
      '[data-path="docs"] > .tree-item-self',
    ) as HTMLElement
    docsSelf.click()

    for (let i = 0; i < 4; i++) await flush()

    const docsRow = parent.querySelector('[data-path="docs"]') as HTMLElement
    const noteSelf = parent.querySelector(
      '[data-path="docs/note.md"] .tree-item-self',
    ) as HTMLElement

    expect(docsRow.draggable).toBe(false)
    expect(docsSelf.draggable).toBe(true)
    expect(noteSelf.draggable).toBe(true)

    const setData = jest.fn()
    const dragStart = new Event('dragstart', {
      bubbles: true,
      cancelable: true,
    }) as unknown as DragEvent
    Object.defineProperty(dragStart, 'dataTransfer', {
      value: {
        setData,
        effectAllowed: 'none',
      },
      configurable: true,
    })

    noteSelf.dispatchEvent(dragStart)

    expect(setData).toHaveBeenCalledWith(
      'application/x-yolo-vault-path',
      'docs/note.md',
    )

    tree.destroy()
    parent.remove()
  })

  it('falls back to root when the selected folder disappears during refresh', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client, vault, folders } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
      {
        kind: 'file',
        path: 'docs/note.md',
        name: 'note.md',
        extension: 'md',
      },
      { kind: 'file', path: 'readme.md', name: 'readme.md', extension: 'md' },
    ])
    let docsDeleted = false
    ;(client.listVaultFolder as jest.Mock).mockImplementation(
      async (path: string) => {
        if (docsDeleted && path === 'docs') {
          throw new Error('Folder not found')
        }
        const prefix = path === '/' ? '' : path + '/'
        const items: WebVaultListItem[] = []
        const paths = Array.from(vault).sort()
        for (const p of paths) {
          if (!p.startsWith(prefix)) continue
          const rest = p.slice(prefix.length)
          if (rest === '') continue
          if (rest.includes('/')) continue
          const isFolder = folders.has(p)
          items.push({
            kind: isFolder ? 'folder' : 'file',
            path: p,
            name: rest,
            extension: isFolder ? undefined : rest.split('.').pop(),
          })
        }
        return { items, nextCursor: null, hasMore: false }
      },
    )

    const onOperationError = jest.fn()

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError,
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const docsSelf = parent.querySelector(
      '[data-path="docs"] > .tree-item-self',
    ) as HTMLElement
    docsSelf.click()
    await flush()

    docsDeleted = true
    vault.delete('docs')
    vault.delete('docs/note.md')
    folders.delete('docs')

    await tree.refreshAll()
    await flush()
    await flush()

    expect(parent.textContent).not.toContain('Folder not found')
    expect(parent.querySelector('[data-path="readme.md"]')).not.toBeNull()
    expect(parent.querySelector('.tree-item-self.is-active')).toBeNull()
    expect(onOperationError).toHaveBeenCalledWith('Folder not found')

    tree.destroy()
    parent.remove()
  })

  it('keeps the selected folder when refresh fails with a non-missing error', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
      {
        kind: 'file',
        path: 'docs/note.md',
        name: 'note.md',
        extension: 'md',
      },
    ])
    let failDocs = false
    ;(client.listVaultFolder as jest.Mock).mockImplementation(
      async (path: string) => {
        if (failDocs && path === 'docs') {
          throw Object.assign(new Error('Service unavailable'), { status: 503 })
        }
        const prefix = path === '/' ? '' : path + '/'
        const items: WebVaultListItem[] = []
        for (const p of ['docs', 'docs/note.md']) {
          if (!p.startsWith(prefix)) continue
          const rest = p.slice(prefix.length)
          if (rest === '' || rest.includes('/')) continue
          items.push({
            kind: p === 'docs' ? 'folder' : 'file',
            path: p,
            name: rest,
            extension: p.endsWith('.md') ? 'md' : undefined,
          })
        }
        return { items, nextCursor: null, hasMore: false }
      },
    )
    const onOperationError = jest.fn()

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError,
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const docsSelf = parent.querySelector(
      '[data-path="docs"] > .tree-item-self',
    ) as HTMLElement
    docsSelf.click()
    await flush()

    failDocs = true
    await tree.refreshAll()
    await flush()
    await flush()

    expect(
      (
        parent.querySelector(
          '[data-path="docs"] > .tree-item-self',
        ) as HTMLElement
      ).classList.contains('is-active'),
    ).toBe(true)
    expect(onOperationError).toHaveBeenCalledTimes(1)
    expect(onOperationError).toHaveBeenCalledWith(
      'This resource is unavailable for the current web session.',
    )

    tree.destroy()
    parent.remove()
  })

  it('coalesces repeated refresh failures into one error callback', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client } = makeVaultClient([
      { kind: 'folder', path: 'docs', name: 'docs' },
      { kind: 'folder', path: 'docs/sub', name: 'sub' },
    ])
    let failExpandedFolders = false
    ;(client.listVaultFolder as jest.Mock).mockImplementation(
      async (path: string) => {
        if (failExpandedFolders && (path === 'docs' || path === 'docs/sub')) {
          throw Object.assign(new Error('Service unavailable'), { status: 503 })
        }
        return {
          items: [{ kind: 'folder', path: 'docs', name: 'docs' }],
          nextCursor: null,
          hasMore: false,
        }
      },
    )
    const onOperationError = jest.fn()

    const tree = createObsidianFileTree(parent, client, {
      onOpenFile: () => {},
      onOpenFolder: () => {},
      onPreview: () => {},
      onOperationError,
      refreshTree: () => {},
      prompts: {
        requestRename: async () => null,
        requestMove: async () => null,
        requestDelete: async () => false,
      },
    })

    await flush()
    await flush()

    const docsSelf = parent.querySelector(
      '[data-path="docs"] > .tree-item-self',
    ) as HTMLElement
    docsSelf.click()
    for (let i = 0; i < 4; i++) await flush()

    failExpandedFolders = true
    onOperationError.mockClear()

    await tree.refreshAll()
    await flush()
    await flush()

    expect(onOperationError).toHaveBeenCalledTimes(1)
    expect(onOperationError).toHaveBeenCalledWith(
      'This resource is unavailable for the current web session.',
    )

    tree.destroy()
    parent.remove()
  })

  it('scopes the tree to workspaceRoot when provided', async () => {
    const parent = document.createElement('div')
    document.body.append(parent)
    const { client, listVaultFolder } = makeVaultClient([
      { kind: 'folder', path: 'Notes', name: 'Notes' },
      { kind: 'folder', path: 'Notes/Project', name: 'Project' },
      {
        kind: 'file',
        path: 'Notes/Project/file.md',
        name: 'file.md',
        extension: 'md',
      },
      // sibling outside home — must not appear in the tree.
      {
        kind: 'file',
        path: 'Other/outside.md',
        name: 'outside.md',
        extension: 'md',
      },
    ])

    const tree = createObsidianFileTree(
      parent,
      client,
      {
        onOpenFile: () => {},
        onOpenFolder: () => {},
        onPreview: () => {},
        onOperationError: () => {},
        refreshTree: () => {},
        prompts: {
          requestRename: async () => null,
          requestMove: async () => null,
          requestDelete: async () => false,
        },
      },
      { workspaceRoot: 'Notes/Project' },
    )

    await flush()
    await flush()

    // Initial load targets home, not vault root.
    expect(listVaultFolder.mock.calls[0]![0]).toBe('Notes/Project')

    // Item under home is rendered; siblings outside home are not.
    expect(
      parent.querySelector('[data-path="Notes/Project/file.md"]'),
    ).not.toBeNull()
    expect(parent.querySelector('[data-path="Other/outside.md"]')).toBeNull()
    // Home itself is the implicit root — no row for the parent folder.
    expect(parent.querySelector('[data-path="Notes/Project"]')).toBeNull()
    expect(parent.querySelector('[data-path="Notes"]')).toBeNull()

    tree.destroy()
    parent.remove()
  })
})
