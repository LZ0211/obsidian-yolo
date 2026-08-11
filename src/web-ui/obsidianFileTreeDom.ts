/* eslint-disable @typescript-eslint/no-unused-vars -- backup 逐字节拷贝：newFileBtn/refreshNavBtn 等未接线按钮引用保留 */
/* eslint-disable obsidianmd/no-static-styles-assignment -- web 运行时 mock Obsidian DOM 直接操作 style（桌面端 setCssProps 约定不适用） */
import {
  createDiv,
  createEl,
  createSpan,
} from '../runtime/web/obsidianDomCompat'
import type {
  WebApiClient,
  WebVaultListItem,
} from '../runtime/web/WebApiClient'

import type { WebPreviewTarget } from './webWorkspaceTypes'
import {
  classifyPreviewKind,
  compareVaultItems,
  formatModifiedTime,
  getBaseName,
  getParentPath,
  isVisibleVaultItem,
  joinVaultPath,
  normalizeVaultPath,
  toApiFolderPath,
  toUserMessage,
} from './webWorkspaceUtils'

type FileTreeState = {
  items: WebVaultListItem[]
  nextCursor: string | null
  hasMore: boolean
  loading: boolean
  error: string | null
  errorKind: 'missing' | 'other' | null
  explicitlyLoaded: boolean
}

type FileOperationPrompts = {
  requestRename: (item: WebVaultListItem) => Promise<string | null>
  requestMove: (item: WebVaultListItem) => Promise<string | null>
  requestDelete: (item: WebVaultListItem) => Promise<boolean>
}

type FileTreeCallbacks = {
  onOpenFile: (item: WebVaultListItem) => void
  onOpenFolder: (path: string) => void
  onPreview: (target: WebPreviewTarget, item: WebVaultListItem) => void
  onOperationError: (message: string) => void
  refreshTree: () => void
  onPathRenamed?: (fromPath: string, toPath: string) => void
  onPathDeleted?: (path: string) => void
  /** Fired after any vault mutation (create/rename/move/delete/upload) so
   *  observers that cache the vault index (e.g. @-mention's `app.vault`) can
   *  refresh. */
  onVaultMutated?: () => void
  prompts: FileOperationPrompts
}

type MutationResult =
  | { action: 'rename' | 'move'; fromPath: string; toPath: string }
  | { action: 'delete'; fromPath: string }
  | { action: 'create-file'; toPath: string }
  | { action: 'create-folder'; toPath: string }

function rewritePathIfDescendant(
  path: string | null,
  from: string,
  to: string,
): string | null {
  if (!path) return path
  if (path === from) return to
  const prefix = from.endsWith('/') ? from : from + '/'
  if (path.startsWith(prefix)) {
    const suffix = path.slice(prefix.length)
    return to + (to.endsWith('/') ? '' : '/') + suffix
  }
  return path
}

function rewriteFolderPath(path: string, from: string, to: string): string {
  if (path === from) return to
  const prefix = from.endsWith('/') ? from : from + '/'
  if (path.startsWith(prefix)) {
    const suffix = path.slice(prefix.length)
    return to + (to.endsWith('/') ? '' : '/') + suffix
  }
  return path
}

const PAGE_SIZE = 100

type FileExplorerNavHeaderLikeObsidian = {
  navHeaderEl: HTMLElement
  navButtonsEl: HTMLElement
}

type FileTreeRowLikeObsidian = {
  rowEl: HTMLElement
  selfEl: HTMLElement
  titleContentEl: HTMLElement
  childrenEl: HTMLElement | null
}

type InternalDragKind = 'file' | 'folder'

type ResolvedDropTarget = {
  folderPath: string
  hoverEl: HTMLElement | null
  indicatorAnchorEl: HTMLElement | null
  placement: 'before' | 'after' | null
  rowPath: string | null
  rowIsFolder: boolean
}

function appendFileExplorerActionIcon(
  parentEl: HTMLElement,
  icon:
    | 'new-note'
    | 'new-folder'
    | 'upload'
    | 'collapse-all'
    | 'refresh'
    | 'rename'
    | 'delete',
): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')

  const makePath = (d: string): SVGPathElement => {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    return path
  }

  const pathsByIcon: Record<typeof icon, string[]> = {
    'new-note': [
      'M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z',
      'M14 2v5a1 1 0 0 0 1 1h5',
      'M9 15h6',
      'M12 18v-6',
    ],
    'new-folder': [
      'M12 10v6',
      'M9 13h6',
      'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    ],
    upload: [
      'M12 3v12',
      'm17 8-5-5-5 5',
      'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4',
    ],
    'collapse-all': ['m7 15 5 5 5-5', 'm7 9 5-5 5 5'],
    refresh: [
      'M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8',
      'M21 3v5h-5',
      'M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16',
      'M8 16H3v5',
    ],
    rename: [
      'M13 21h8',
      'M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z',
    ],
    delete: [
      'M3 6h18',
      'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
      'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
      'M10 11v6',
      'M14 11v6',
    ],
  }

  for (const d of pathsByIcon[icon]) {
    svg.append(makePath(d))
  }

  parentEl.append(svg)
}

function appendRightTriangleIcon(parentEl: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'M3 8L12 17L21 8')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '2')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  parentEl.append(svg)
}

// Copied from the Obsidian R6 constructor in reference/obsidian/app.js and reduced
// to the DOM creation/addNavButton behavior we need here.
function createFileExplorerNavHeaderLikeObsidian(
  parentEl: HTMLElement,
  signal: AbortSignal,
): FileExplorerNavHeaderLikeObsidian & {
  addNavButton: (
    icon:
      | 'new-note'
      | 'new-folder'
      | 'upload'
      | 'collapse-all'
      | 'refresh'
      | 'rename'
      | 'delete',
    title: string,
    onClick: (event: MouseEvent) => void,
    extraClassName?: string,
  ) => HTMLElement
} {
  const navHeaderEl = createDiv(document.createElement('div'), 'nav-header')
  parentEl.prepend(navHeaderEl)
  const navButtonsEl = navHeaderEl.createDiv(
    'nav-buttons-container',
  ) as HTMLElement

  function addNavButton(
    icon:
      | 'new-note'
      | 'new-folder'
      | 'upload'
      | 'collapse-all'
      | 'refresh'
      | 'rename'
      | 'delete',
    title: string,
    onClick: (event: MouseEvent) => void,
    extraClassName?: string,
  ): HTMLElement {
    const buttonEl = navButtonsEl.createDiv(
      'clickable-icon nav-action-button',
    ) as HTMLElement
    if (extraClassName) {
      buttonEl.addClass(extraClassName)
    }
    buttonEl.setAttr('aria-label', title)
    buttonEl.setAttr('data-tooltip-position', 'bottom')
    buttonEl.addEventListener('click', onClick, { signal })
    appendFileExplorerActionIcon(buttonEl, icon)
    return buttonEl
  }

  return {
    navHeaderEl,
    navButtonsEl,
    addNavButton,
  }
}

// Copied from the Obsidian C8 factory in reference/obsidian/app.js.
function createFileRowLikeObsidian(
  parentEl: HTMLElement,
): FileTreeRowLikeObsidian {
  const rowEl = createDiv(parentEl, 'tree-item nav-file')
  const selfEl = createDiv(
    rowEl,
    'tree-item-self nav-file-title tappable is-clickable',
  )
  const titleContentEl = createDiv(
    selfEl,
    'tree-item-inner nav-file-title-content',
  )

  return {
    rowEl,
    selfEl,
    titleContentEl,
    childrenEl: null,
  }
}

// Copied from the Obsidian M8 factory in reference/obsidian/app.js.
function createFolderRowLikeObsidian(
  parentEl: HTMLElement,
): FileTreeRowLikeObsidian {
  const rowEl = createDiv(parentEl, 'tree-item nav-folder')
  const selfEl = createDiv(
    rowEl,
    'tree-item-self nav-folder-title is-clickable',
  )
  const titleContentEl = createDiv(
    selfEl,
    'tree-item-inner nav-folder-title-content',
  )
  const childrenEl = createDiv(rowEl, 'tree-item-children nav-folder-children')

  return {
    rowEl,
    selfEl,
    titleContentEl,
    childrenEl,
  }
}

export type FileTreeOptions = {
  /** Vault-absolute path of the assistant's workspace root ("home"). When
   *  non-empty, the tree is scoped to this folder: initial load starts here,
   *  the root key for rendering becomes this path, and the user never sees
   *  anything above it. Internal state (selectedFolderPath, item.path, etc.)
   *  stays vault-absolute — display-relative translation happens elsewhere. */
  workspaceRoot?: string
}

export function createObsidianFileTree(
  parentEl: HTMLElement,
  client: WebApiClient,
  callbacks: FileTreeCallbacks,
  options: FileTreeOptions = {},
): {
  contentEl: HTMLElement
  loadFolder: (path: string) => Promise<void>
  refresh: () => Promise<void>
  /** Reload every currently-loaded folder so backend-side mutations surface
   *  in all expanded subtrees, not just the selected folder. */
  refreshAll: () => Promise<void>
  destroy: () => void
} {
  const cleanupController = new AbortController()
  const homeRoot = normalizeVaultPath(options.workspaceRoot ?? '')

  const state: FileTreeState = {
    items: [],
    nextCursor: null,
    hasMore: false,
    loading: true,
    error: null,
    errorKind: null,
    explicitlyLoaded: false,
  }
  const folderStates = new Map<string, FileTreeState>([[homeRoot, state]])

  let selectedFolderPath: string | null = null
  let selectedFilePath: string | null = null
  let expandedPaths = new Set<string>()
  let submittedQuery = ''
  let searchItems: WebVaultListItem[] = []
  let searchLoading = false
  let dragDepth = 0
  let internalDragSourcePath: string | null = null
  let internalDragSourceKind: InternalDragKind | null = null
  let hoveredDropEl: HTMLElement | null = null
  let hoverExpandTimeout: number | null = null
  let hoverExpandTargetPath: string | null = null
  let lastResolvedDropTarget: ResolvedDropTarget | null = null

  // Copied from the Obsidian D8 constructor in reference/obsidian/app.js and reduced
  // to the shell/container creation used by this web file explorer.
  const navFileContainerEl = parentEl.createDiv(
    'nav-files-container',
  ) as HTMLElement
  navFileContainerEl.addClass('yolo-web-files-nav-container')
  navFileContainerEl.style.position = 'relative'
  const headerDom = createFileExplorerNavHeaderLikeObsidian(
    parentEl,
    cleanupController.signal,
  )
  headerDom.navHeaderEl.addClass('yolo-web-files-nav-header')

  function getFolderState(path: string): FileTreeState {
    const normalized = normalizeVaultPath(path)
    let folderState = folderStates.get(normalized)
    if (!folderState) {
      folderState = {
        items: [],
        nextCursor: null,
        hasMore: false,
        loading: false,
        error: null,
        errorKind: null,
        explicitlyLoaded: false,
      }
      folderStates.set(normalized, folderState)
    }
    return folderState
  }

  function getCurrentFolderPath(): string {
    return selectedFilePath
      ? getParentPath(selectedFilePath)
      : (selectedFolderPath ?? homeRoot)
  }

  function isNotFoundError(error: unknown): boolean {
    if (
      typeof error === 'object' &&
      error != null &&
      'status' in error &&
      (error as { status?: unknown }).status === 404
    ) {
      return true
    }
    const message = error instanceof Error ? error.message : String(error)
    return /\bnot found\b/i.test(message)
  }

  function collectLoadedItems(): WebVaultListItem[] {
    const seen = new Set<string>()
    const items: WebVaultListItem[] = []
    for (const folderState of folderStates.values()) {
      for (const item of folderState.items) {
        if (seen.has(item.path)) continue
        seen.add(item.path)
        items.push(item)
      }
    }
    return items
  }

  const newFileBtn = headerDom.addNavButton(
    'new-note',
    '新建文件',
    () => void createItem('file'),
  )
  const newFolderBtn = headerDom.addNavButton(
    'new-folder',
    '新建文件夹',
    () => void createItem('folder'),
  )
  const renameNavBtn = headerDom.addNavButton('rename', '重命名所选', () =>
    renameSelected(),
  )
  const deleteNavBtn = headerDom.addNavButton('delete', '删除所选', () =>
    deleteSelected(),
  )
  const refreshNavBtn = headerDom.addNavButton('refresh', '刷新文件', () => {
    void refreshLoadedFolders().then(() => callbacks.onVaultMutated?.())
  })
  const uploadNavBtn = headerDom.addNavButton('upload', '上传', () =>
    fileInput.click(),
  )
  const collapseAllBtn = headerDom.addNavButton(
    'collapse-all',
    '全部折叠',
    () => {
      expandedPaths.clear()
      renderTree()
    },
  )

  const searchBoxEl = createDiv(headerDom.navHeaderEl, 'search-input-container')
  const searchInput = createEl(searchBoxEl, 'input', {
    attr: { type: 'search', placeholder: '搜索可读文件' },
  }) as HTMLInputElement
  const searchClearBtn = createDiv(searchBoxEl, 'search-input-clear-button')
  searchClearBtn.setAttr('aria-label', '清空搜索')

  const fileInput = createEl(parentEl, 'input', {
    attr: { type: 'file', multiple: '' },
  }) as HTMLInputElement
  fileInput.style.display = 'none'

  const stateEl = createDiv(parentEl, 'empty-state yolo-web-files-state')
  const dropIndicatorEl = document.createElement('div')
  dropIndicatorEl.className = 'drop-indicator'

  // --- Tree container ---
  const treeContainerEl = navFileContainerEl
  treeContainerEl.setAttribute('role', 'tree')

  // --- Load more ---
  const loadMoreEl = createEl(parentEl, 'button', {
    text: '加载更多',
    cls: 'yolo-web-load-more yolo-web-files-state',
  })
  loadMoreEl.style.display = 'none'

  navFileContainerEl.addEventListener(
    'click',
    (event) => {
      if (submittedQuery) return
      if ((event.target as HTMLElement | null)?.closest('.tree-item-self'))
        return
      selectedFilePath = null
      selectedFolderPath = null
      renderTree()
    },
    { signal: cleanupController.signal },
  )

  searchInput.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter') void submitSearch()
    },
    { signal: cleanupController.signal },
  )
  searchInput.addEventListener(
    'input',
    () => {
      if (!searchInput.value.trim()) {
        submittedQuery = ''
        searchItems = []
        renderTree()
      }
    },
    { signal: cleanupController.signal },
  )
  searchClearBtn.addEventListener(
    'mousedown',
    (event) => {
      event.preventDefault()
    },
    { signal: cleanupController.signal },
  )
  searchClearBtn.addEventListener(
    'click',
    () => {
      searchInput.value = ''
      submittedQuery = ''
      searchItems = []
      renderTree()
    },
    { signal: cleanupController.signal },
  )

  fileInput.addEventListener(
    'change',
    () => {
      const files = fileInput.files
      if (files) void uploadFiles(getCurrentFolderPath(), Array.from(files))
      fileInput.value = ''
    },
    { signal: cleanupController.signal },
  )

  function clearHoverExpandTimer(): void {
    if (hoverExpandTimeout != null) {
      window.clearTimeout(hoverExpandTimeout)
      hoverExpandTimeout = null
    }
    hoverExpandTargetPath = null
  }

  function clearDropFeedback(): void {
    if (hoveredDropEl) {
      hoveredDropEl.removeClass('is-being-dragged-over')
      hoveredDropEl = null
    }
    dropIndicatorEl.removeClass('is-active')
    dropIndicatorEl.remove()
    clearHoverExpandTimer()
    lastResolvedDropTarget = null
  }

  function clearInternalDragSource(): void {
    internalDragSourcePath = null
    internalDragSourceKind = null
    const draggedEls = treeContainerEl.querySelectorAll('.is-being-dragged')
    for (const draggedEl of Array.from(draggedEls)) {
      draggedEl.classList.remove('is-being-dragged')
    }
  }

  // Cached row list used by the Y-scan fallback in resolveDropTargetFromEvent.
  // dragover fires at ~mouse-move frequency, and a fresh
  // querySelectorAll('[data-path]') per event over a large tree is wasteful.
  // Invalidated whenever renderTree runs (which is the only path that can
  // add/remove rows in this component).
  let visibleRowsCache: HTMLElement[] | null = null
  function invalidateVisibleRowsCache(): void {
    visibleRowsCache = null
  }
  function getVisibleRows(): HTMLElement[] {
    if (!visibleRowsCache) {
      visibleRowsCache = Array.from(
        treeContainerEl.querySelectorAll<HTMLElement>('[data-path]'),
      )
    }
    return visibleRowsCache
  }

  // Mirrors Obsidian's c2() in reference/obsidian/app.js (~Line 186171). Picks
  // a row by event.target hit-test, falling back to Y-based scan when the
  // cursor lands in inter-row gaps (e.g. inside .nav-folder-children whitespace
  // where closest('.tree-item-self') walks past the parent folder's selfEl).
  // Then classifies as drop-INTO-folder (90% center band) or before/after.
  function resolveDropTargetFromEvent(e: DragEvent): ResolvedDropTarget {
    const eventTarget = e.target as HTMLElement | null
    let row = eventTarget?.closest('[data-path]') as HTMLElement | null
    let self = eventTarget?.closest('.tree-item-self') as HTMLElement | null

    // If hit-test didn't land on a row's title, scan visible rows by Y to find
    // the nearest one (above or containing the cursor).
    if (!row || !self) {
      const allRows = getVisibleRows()
      let above: { row: HTMLElement; self: HTMLElement; rect: DOMRect } | null =
        null
      let below: { row: HTMLElement; self: HTMLElement; rect: DOMRect } | null =
        null
      for (const candidate of allRows) {
        const candidateSelf = candidate.querySelector<HTMLElement>(
          ':scope > .tree-item-self',
        )
        if (!candidateSelf) continue
        const rect = candidateSelf.getBoundingClientRect()
        if (e.clientY >= rect.top && e.clientY <= rect.bottom) {
          row = candidate
          self = candidateSelf
          break
        }
        if (rect.bottom < e.clientY) {
          above = { row: candidate, self: candidateSelf, rect }
        } else if (rect.top > e.clientY && !below) {
          below = { row: candidate, self: candidateSelf, rect }
        }
      }

      if (!row || !self) {
        // No row contained the cursor. Pick nearest above (drop after it) or
        // nearest below (drop before it), defaulting to home (the tree's
        // visible root, which may be either the vault root or workspaceRoot).
        if (above) {
          return {
            folderPath: homeRoot,
            hoverEl: null,
            indicatorAnchorEl: above.self,
            placement: 'after',
            rowPath: null,
            rowIsFolder: false,
          }
        }
        if (below) {
          return {
            folderPath: homeRoot,
            hoverEl: null,
            indicatorAnchorEl: below.self,
            placement: 'before',
            rowPath: null,
            rowIsFolder: false,
          }
        }
        // Empty tree.
        return {
          folderPath: homeRoot,
          hoverEl: null,
          indicatorAnchorEl: null,
          placement: null,
          rowPath: null,
          rowIsFolder: false,
        }
      }
    }

    const path = row.getAttribute('data-path')
    if (!path) {
      return {
        folderPath: homeRoot,
        hoverEl: null,
        indicatorAnchorEl: null,
        placement: null,
        rowPath: null,
        rowIsFolder: false,
      }
    }

    const rowIsFolder = row.classList.contains('nav-folder')
    const rect = self.getBoundingClientRect()
    // |dy| / (height/2) < 0.9 qualifies as "drop INTO folder" — anywhere
    // except the top/bottom 5% slivers of the row.
    const dy = rect.height > 0 ? e.clientY - (rect.top + rect.height / 2) : 0
    const halfH = rect.height > 0 ? rect.height / 2 : 1
    const centerRatio = Math.abs(dy) / halfH

    if (rowIsFolder && centerRatio < 0.9) {
      return {
        folderPath: normalizeVaultPath(path),
        hoverEl: self,
        indicatorAnchorEl: null,
        placement: null,
        rowPath: path,
        rowIsFolder: true,
      }
    }

    return {
      folderPath: getParentPath(path),
      hoverEl: null,
      indicatorAnchorEl: self,
      placement: dy > 0 ? 'after' : 'before',
      rowPath: path,
      rowIsFolder,
    }
  }

  function applyDropFeedback(target: ResolvedDropTarget): void {
    if (hoveredDropEl && hoveredDropEl !== target.hoverEl) {
      hoveredDropEl.removeClass('is-being-dragged-over')
      hoveredDropEl = null
    }

    if (target.hoverEl) {
      hoveredDropEl = target.hoverEl
      hoveredDropEl.addClass('is-being-dragged-over')

      const targetPath = target.rowPath
      if (
        targetPath &&
        target.rowIsFolder &&
        !expandedPaths.has(targetPath) &&
        hoverExpandTargetPath !== targetPath
      ) {
        clearHoverExpandTimer()
        hoverExpandTargetPath = targetPath
        hoverExpandTimeout = window.setTimeout(() => {
          if (hoverExpandTargetPath !== targetPath) return
          expandedPaths.add(targetPath)
          const existing = folderStates.get(targetPath)
          if (!existing?.explicitlyLoaded) {
            void loadFolder(targetPath, null, { updateSelection: false })
          } else {
            renderTree()
          }
        }, 750)
      }

      dropIndicatorEl.removeClass('is-active')
      dropIndicatorEl.remove()
      return
    }

    clearHoverExpandTimer()
    if (!target.indicatorAnchorEl || !target.placement) {
      dropIndicatorEl.removeClass('is-active')
      dropIndicatorEl.remove()
      return
    }

    const anchorRect = target.indicatorAnchorEl.getBoundingClientRect()
    const containerRect = navFileContainerEl.getBoundingClientRect()
    dropIndicatorEl.addClass('is-active')
    dropIndicatorEl.style.left = `${Math.max(0, anchorRect.left - containerRect.left)}px`
    dropIndicatorEl.style.width = `${Math.max(0, anchorRect.width)}px`
    dropIndicatorEl.style.top = `${target.placement === 'after' ? anchorRect.bottom - containerRect.top - 1 : anchorRect.top - containerRect.top - 1}px`
    if (dropIndicatorEl.parentNode !== navFileContainerEl) {
      navFileContainerEl.prepend(dropIndicatorEl)
    }
  }

  function resolveDragKindFromPath(path: string): InternalDragKind | null {
    const item = collectLoadedItems().find((entry) => entry.path === path)
    return item?.kind === 'folder'
      ? 'folder'
      : item?.kind === 'file'
        ? 'file'
        : null
  }

  function isInvalidInternalDrop(
    sourcePath: string,
    sourceKind: InternalDragKind | null,
    target: ResolvedDropTarget,
  ): boolean {
    const kind = sourceKind ?? resolveDragKindFromPath(sourcePath)
    if (!kind) return false

    const currentParent = getParentPath(sourcePath)
    if (target.rowPath === sourcePath) {
      return true
    }
    if (kind === 'folder') {
      if (
        target.folderPath === sourcePath ||
        target.folderPath.startsWith(sourcePath + '/')
      ) {
        return true
      }
    }
    if (target.folderPath === currentParent) {
      return true
    }
    return false
  }

  const dragOverHandler = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!e.dataTransfer) return
    const hasInternal =
      e.dataTransfer.types.includes('application/x-yolo-vault-path') ||
      internalDragSourcePath != null
    const target = resolveDropTargetFromEvent(e)

    if (hasInternal) {
      const sourcePath =
        e.dataTransfer.getData('application/x-yolo-vault-path') ||
        internalDragSourcePath
      const sourceKind = (e.dataTransfer.getData(
        'application/x-yolo-vault-kind',
      ) || internalDragSourceKind) as InternalDragKind | ''

      if (
        sourcePath &&
        isInvalidInternalDrop(sourcePath, sourceKind || null, target)
      ) {
        clearDropFeedback()
        e.dataTransfer.dropEffect = 'none'
        return
      }

      lastResolvedDropTarget = target
      applyDropFeedback(target)
      e.dataTransfer.dropEffect = 'move'
      return
    }

    lastResolvedDropTarget = target
    applyDropFeedback(target)
    e.dataTransfer.dropEffect = 'copy'
  }

  const dropHandler = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth = 0
    navFileContainerEl.removeClass('yolo-web-drag-over')
    const target = lastResolvedDropTarget ?? resolveDropTargetFromEvent(e)
    clearDropFeedback()
    const files = e.dataTransfer?.files
    if (files && files.length > 0) {
      void uploadFiles(target.folderPath, Array.from(files))
      clearInternalDragSource()
      return
    }
    const sourcePath = e.dataTransfer?.getData('application/x-yolo-vault-path')
    if (sourcePath) {
      const sourceKind = (e.dataTransfer?.getData(
        'application/x-yolo-vault-kind',
      ) || internalDragSourceKind) as InternalDragKind | ''
      void dragMoveItem(sourcePath, target.folderPath, sourceKind || null)
    }
    clearInternalDragSource()
  }

  const dragEnterHandler = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth++
    navFileContainerEl.addClass('yolo-web-drag-over')
  }

  const dragLeaveHandler = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    dragDepth--
    if (dragDepth <= 0) {
      dragDepth = 0
      navFileContainerEl.removeClass('yolo-web-drag-over')
      clearDropFeedback()
    }
  }

  navFileContainerEl.addEventListener('dragover', dragOverHandler, {
    signal: cleanupController.signal,
  })
  navFileContainerEl.addEventListener('drop', dropHandler, {
    signal: cleanupController.signal,
  })
  navFileContainerEl.addEventListener('dragenter', dragEnterHandler, {
    signal: cleanupController.signal,
  })
  navFileContainerEl.addEventListener('dragleave', dragLeaveHandler, {
    signal: cleanupController.signal,
  })

  // Safety net for dragend events that miss the row's own selfEl listener
  // (e.g. when the source element is removed mid-drag by an unrelated
  // renderTree, or when the drag terminates outside the file pane).
  const windowDragEndHandler = (): void => {
    dragDepth = 0
    navFileContainerEl.removeClass('yolo-web-drag-over')
    clearDropFeedback()
    clearInternalDragSource()
  }
  window.addEventListener('dragend', windowDragEndHandler, {
    capture: true,
    signal: cleanupController.signal,
  })

  loadMoreEl.addEventListener(
    'click',
    () => {
      const currentFolderPath = getCurrentFolderPath()
      const folderState = getFolderState(currentFolderPath)
      void loadFolder(currentFolderPath, folderState.nextCursor, {
        updateSelection: false,
      })
    },
    { signal: cleanupController.signal },
  )

  function showOperationError(message: string): void {
    callbacks.onOperationError(message)
  }

  function reconcileAfterMutation(result: MutationResult): void {
    if (result.action === 'rename' || result.action === 'move') {
      selectedFilePath = rewritePathIfDescendant(
        selectedFilePath,
        result.fromPath,
        result.toPath,
      )
      selectedFolderPath =
        selectedFolderPath == null
          ? null
          : rewriteFolderPath(
              selectedFolderPath,
              result.fromPath,
              result.toPath,
            )
      expandedPaths = new Set(
        Array.from(expandedPaths).map((p) =>
          rewriteFolderPath(p, result.fromPath, result.toPath),
        ),
      )
      callbacks.onPathRenamed?.(result.fromPath, result.toPath)
      return
    }
    if (result.action === 'delete') {
      const deletedPrefix = result.fromPath + '/'
      if (
        selectedFilePath &&
        (selectedFilePath === result.fromPath ||
          selectedFilePath.startsWith(deletedPrefix))
      ) {
        selectedFilePath = null
      }
      if (selectedFolderPath === result.fromPath) {
        selectedFolderPath = null
      } else if (
        selectedFolderPath != null &&
        selectedFolderPath.startsWith(deletedPrefix)
      ) {
        // keep current folder if it's a descendant? No — descendant was deleted too.
        selectedFolderPath = null
      }
      expandedPaths = new Set(
        Array.from(expandedPaths).filter(
          (p) => p !== result.fromPath && !p.startsWith(deletedPrefix),
        ),
      )
      callbacks.onPathDeleted?.(result.fromPath)
      return
    }
    // create-file / create-folder: refreshLoadedFolders will surface the new item.
    // Selection state is set in createItem directly.
  }

  function renderState(message: string): void {
    stateEl.empty()
    const container = createDiv(stateEl, 'empty-state-container')
    createDiv(container, 'empty-state-title', (el) => el.setText(message))
  }

  // --- Data loading ---
  async function loadFolder(
    path: string,
    cursor?: string | null,
    options: { updateSelection?: boolean; reportError?: boolean } = {},
  ): Promise<void> {
    const normalized = normalizeVaultPath(path)
    const folderState = getFolderState(normalized)
    folderState.error = null
    folderState.errorKind = null
    if (!cursor) {
      folderState.loading = true
      // Keep existing items during a refresh so the user sees a stable list;
      // they're atomically replaced on success. Only clear on the genuine
      // initial load (no items yet) — otherwise refreshes after every
      // mutation would briefly empty the tree, causing visible flicker.
      if (!folderState.explicitlyLoaded) {
        folderState.items = []
      }
    }
    scheduleRender()
    try {
      const response = await client.listVaultFolder(
        toApiFolderPath(normalized),
        {
          limit: PAGE_SIZE,
          cursor: cursor ?? undefined,
        },
      )
      if (cursor) {
        folderState.items = [...folderState.items, ...response.items]
      } else {
        folderState.items = response.items
      }
      folderState.nextCursor = response.nextCursor
      folderState.hasMore = response.hasMore
      folderState.explicitlyLoaded = true
      if (options.updateSelection !== false) {
        selectedFolderPath = normalized
      }
    } catch (err) {
      folderState.error = toUserMessage(err)
      folderState.errorKind = isNotFoundError(err) ? 'missing' : 'other'
      folderState.items = []
      folderState.nextCursor = null
      folderState.hasMore = false
      if (options.reportError !== false) {
        showOperationError(folderState.error)
      }
    } finally {
      folderState.loading = false
      scheduleRender()
    }
  }

  async function submitSearch(): Promise<void> {
    const q = searchInput.value.trim()
    submittedQuery = q
    searchItems = []
    if (!q) {
      renderTree()
      return
    }
    searchLoading = true
    renderTree()
    try {
      const response = await client.searchVault(q, { limit: PAGE_SIZE })
      searchItems = response.items
    } catch (err) {
      showOperationError(toUserMessage(err))
    } finally {
      searchLoading = false
      renderTree()
    }
  }

  // --- Tree rendering ---
  // Coalesces bursts of renderTree() requests (multiple concurrent
  // loadFolder calls from refreshLoadedFolders or the vault poll) into a
  // single per-microtask render. Callers that need an immediate visual
  // response (click handlers, keyboard nav) keep calling renderTree()
  // directly so user-driven updates stay snappy.
  let renderScheduled = false
  function scheduleRender(): void {
    if (renderScheduled) return
    renderScheduled = true
    queueMicrotask(() => {
      renderScheduled = false
      renderTree()
    })
  }

  function renderTree(): void {
    invalidateVisibleRowsCache()
    treeContainerEl.empty()
    const activeFolderState = getFolderState(getCurrentFolderPath())
    const rootState = getFolderState(homeRoot)

    // states
    stateEl.style.display = 'none'
    loadMoreEl.style.display = 'none'

    const hasSelectedItem =
      selectedFilePath != null || selectedFolderPath != null
    const syncNavBtnDisabled = (btn: HTMLElement): void => {
      btn.toggleClass('is-disabled', !hasSelectedItem)
      btn.setAttr('aria-disabled', hasSelectedItem ? 'false' : 'true')
      if (hasSelectedItem) {
        btn.removeAttribute('disabled')
      } else {
        btn.setAttr('disabled', 'true')
      }
    }
    syncNavBtnDisabled(renameNavBtn)
    syncNavBtnDisabled(deleteNavBtn)

    if (submittedQuery && searchLoading) {
      renderState('正在搜索…')
      stateEl.removeClass('is-error')
      stateEl.style.display = ''
      return
    }

    if (rootState.loading && rootState.items.length === 0 && !submittedQuery) {
      renderState('正在加载文件…')
      stateEl.removeClass('is-error')
      stateEl.style.display = ''
      return
    }

    const visibleItems = (submittedQuery ? searchItems : collectLoadedItems())
      .filter(isVisibleVaultItem)
      .sort((a, b) => compareVaultItems(a, b, 'name', 'asc'))

    if (
      visibleItems.length === 0 &&
      !(submittedQuery ? searchLoading : rootState.loading)
    ) {
      renderState(
        submittedQuery
          ? '没有匹配该搜索的可读文件。'
          : '当前目录下没有可预览的文件。',
      )
      stateEl.removeClass('is-error')
      stateEl.style.display = ''
    }

    if (submittedQuery) {
      for (const item of visibleItems) {
        renderItem(treeContainerEl, item, 0)
      }
      return
    }

    // build tree
    const childrenByParent = new Map<string, WebVaultListItem[]>()
    for (const item of visibleItems) {
      const parent = getParentPath(item.path)
      const siblings = childrenByParent.get(parent) ?? []
      siblings.push(item)
      childrenByParent.set(parent, siblings)
    }

    function renderItem(
      parentEl: HTMLElement,
      item: WebVaultListItem,
      depth: number,
    ): void {
      const isFolder = item.kind === 'folder'
      const expanded = expandedPaths.has(item.path)
      const active =
        item.kind === 'file'
          ? item.path === selectedFilePath
          : selectedFilePath == null &&
            selectedFolderPath != null &&
            item.path === selectedFolderPath
      const row = isFolder
        ? createFolderRowLikeObsidian(parentEl)
        : createFileRowLikeObsidian(parentEl)
      const rowEl = row.rowEl
      const selfEl = row.selfEl
      const titleContentEl = row.titleContentEl

      if (isFolder && !expanded) {
        rowEl.addClass('is-collapsed')
      }
      rowEl.setAttribute('data-path', item.path)

      if (isFolder) {
        selfEl.addClass('mod-collapsible')
      }
      if (active) {
        selfEl.addClass('is-active')
      }
      // If a re-render fires mid-drag (e.g. hover-expand of another folder),
      // re-apply the dragged class so the visual stays in sync with the
      // browser's still-active drag operation on the detached element.
      if (internalDragSourcePath && item.path === internalDragSourcePath) {
        selfEl.addClass('is-being-dragged')
      }
      selfEl.setAttribute('role', 'treeitem')
      selfEl.setAttribute('tabindex', '0')
      if (isFolder) selfEl.setAttribute('aria-expanded', String(expanded))

      // Indentation is driven by the nested `.tree-item-children` containers
      // (see app.css). Per-row padding stays constant so files and folders at
      // the same depth share the same baseline. File rows get an invisible
      // spacer matching the folder's collapse-icon width so their titles
      // align with folder titles.
      selfEl.style.paddingInlineStart = ''
      if (!isFolder) {
        const spacer = createSpan(selfEl, 'tree-item-icon collapse-icon')
        spacer.style.width = '10px'
        spacer.style.height = '10px'
        spacer.setAttribute('aria-hidden', 'true')
        selfEl.insertBefore(spacer, titleContentEl)
      }

      if (isFolder) {
        const collapseIcon = createSpan(
          selfEl,
          `tree-item-icon collapse-icon${expanded ? '' : ' is-collapsed'}`,
        )
        appendRightTriangleIcon(collapseIcon)
        selfEl.insertBefore(collapseIcon, titleContentEl)
        // Pressing the collapse triangle must NOT initiate a folder drag.
        // The browser walks up to find the nearest draggable ancestor (selfEl),
        // so suppress the gesture by disabling selfEl.draggable for the
        // duration of this mousedown.
        collapseIcon.addEventListener(
          'mousedown',
          () => {
            selfEl.draggable = false
            const restore = (): void => {
              selfEl.draggable = true
              window.removeEventListener('mouseup', restore, true)
            }
            window.addEventListener('mouseup', restore, {
              capture: true,
              signal: cleanupController.signal,
            })
          },
          { signal: cleanupController.signal },
        )
        collapseIcon.addEventListener(
          'click',
          (e) => {
            e.stopPropagation()
            if (expandedPaths.has(item.path)) expandedPaths.delete(item.path)
            else {
              expandedPaths.add(item.path)
              const existing = folderStates.get(item.path)
              if (!existing?.explicitlyLoaded) {
                void loadFolder(item.path, null, { updateSelection: false })
              }
            }
            renderTree()
          },
          { signal: cleanupController.signal },
        )
      }

      titleContentEl.setText(item.name)

      if (item.kind === 'file' && item.extension) {
        const extension = item.extension
        createDiv(selfEl, 'nav-file-tag', (tagEl) => tagEl.setText(extension))
      }

      if (item.kind === 'file') {
        const flairOuterEl = createDiv(selfEl, 'tree-item-flair-outer')
        createSpan(flairOuterEl, 'tree-item-flair', (flairEl) => {
          const parts: string[] = []
          const modified = formatModifiedTime(item.stat?.mtime)
          if (modified) {
            parts.push(modified)
          }
          flairEl.setText(parts.join(' · '))
        })
      }

      selfEl.addEventListener('click', () => openItem(item), {
        signal: cleanupController.signal,
      })
      selfEl.addEventListener(
        'keydown',
        (e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            openItem(item)
          }
          if (e.key === 'F2') {
            e.preventDefault()
            void startRename(item)
          }
          if (e.key === 'Delete' || e.key === 'Backspace') {
            e.preventDefault()
            void deleteItem(item)
          }
        },
        { signal: cleanupController.signal },
      )

      // Drag-to-move is scoped to the visible row handle only. Folder rowEl
      // wraps its descendant subtree, so making rowEl draggable causes nested
      // file drags to resolve to the ancestor folder.
      selfEl.draggable = true
      selfEl.addEventListener(
        'dragstart',
        (e) => {
          if (!e.dataTransfer) return
          internalDragSourcePath = item.path
          internalDragSourceKind = item.kind
          e.dataTransfer.setData('application/x-yolo-vault-path', item.path)
          e.dataTransfer.setData('application/x-yolo-vault-kind', item.kind)
          e.dataTransfer.effectAllowed = 'move'
          selfEl.addClass('is-being-dragged')
        },
        { signal: cleanupController.signal },
      )
      selfEl.addEventListener(
        'dragend',
        () => {
          dragDepth = 0
          navFileContainerEl.removeClass('yolo-web-drag-over')
          clearDropFeedback()
          clearInternalDragSource()
        },
        { signal: cleanupController.signal },
      )

      if (isFolder && expanded && row.childrenEl) {
        row.childrenEl.empty()
        renderChildren(row.childrenEl, item.path, depth + 1)
      }
    }

    function renderChildren(
      parentEl: HTMLElement,
      parentPath: string,
      depth: number,
    ): void {
      const children = childrenByParent.get(parentPath) ?? []
      for (const item of children) {
        renderItem(parentEl, item, depth)
      }
    }

    renderChildren(treeContainerEl, homeRoot, 0)

    // load more
    if (activeFolderState.hasMore && !submittedQuery) {
      loadMoreEl.style.display = ''
      loadMoreEl.setText(
        activeFolderState.loading ? 'Loading more…' : 'Load more',
      )
    }
  }

  // --- Actions ---
  function openItem(item: WebVaultListItem): void {
    const normalized = normalizeVaultPath(item.path)
    if (item.kind === 'folder') {
      selectedFolderPath = normalized
      selectedFilePath = null
      if (expandedPaths.has(normalized)) {
        expandedPaths.delete(normalized)
      } else {
        expandedPaths.add(normalized)
        const existing = folderStates.get(normalized)
        if (!existing?.explicitlyLoaded) {
          void loadFolder(normalized, null, { updateSelection: false })
          callbacks.onOpenFolder(normalized)
          return
        }
      }
      renderTree()
      callbacks.onOpenFolder(normalized)
      return
    }
    selectedFilePath = normalized
    selectedFolderPath = null
    callbacks.onOpenFile(item)
    callbacks.onPreview(
      { path: normalized, source: submittedQuery ? 'search' : 'file-tree' },
      item,
    )
    renderTree()
  }

  async function downloadItem(item: WebVaultListItem): Promise<void> {
    if (item.kind !== 'file') return
    try {
      const blob = await client.downloadVaultFile(item.path)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = item.name
      document.body.append(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      showOperationError(toUserMessage(err))
    }
  }

  async function startRename(item: WebVaultListItem): Promise<void> {
    const newName = await callbacks.prompts.requestRename(item)
    if (!newName || newName === item.name) return
    const parentPath = getParentPath(item.path)
    const toPath = joinVaultPath(parentPath, newName)
    await runMutation(async () => {
      await client.renameVaultPath(item.path, toPath, false)
      return { action: 'rename' as const, fromPath: item.path, toPath }
    })
  }

  function renameSelected(): void {
    const selectedPath = selectedFilePath ?? selectedFolderPath
    if (!selectedPath) {
      return
    }
    const selectedItem = collectLoadedItems().find(
      (item) => item.path === selectedPath,
    )
    if (!selectedItem) {
      return
    }
    void startRename(selectedItem)
  }

  function deleteSelected(): void {
    const selectedPath = selectedFilePath ?? selectedFolderPath
    if (!selectedPath) return
    const selectedItem = collectLoadedItems().find(
      (item) => item.path === selectedPath,
    )
    if (!selectedItem) return
    void deleteItem(selectedItem)
  }

  async function dragMoveItem(
    sourcePath: string,
    targetFolder: string,
    sourceKind: InternalDragKind | null,
  ): Promise<void> {
    if (!sourcePath) return
    const itemName = getBaseName(sourcePath)
    const toPath = joinVaultPath(targetFolder, itemName)
    if (toPath === sourcePath) return
    const resolvedSourceKind = sourceKind ?? resolveDragKindFromPath(sourcePath)
    if (
      resolvedSourceKind === 'folder' &&
      (targetFolder === sourcePath || targetFolder.startsWith(sourcePath + '/'))
    ) {
      return
    }
    await runMutation(async () => {
      await client.moveVaultPath(sourcePath, toPath, false)
      return { action: 'move' as const, fromPath: sourcePath, toPath }
    })
  }

  async function deleteItem(item: WebVaultListItem): Promise<void> {
    const confirmed = await callbacks.prompts.requestDelete(item)
    if (!confirmed) return
    await runMutation(async () => {
      if (item.kind === 'folder')
        await client.deleteVaultFolder(item.path, true)
      else await client.deleteVaultFile(item.path)
      return { action: 'delete' as const, fromPath: item.path }
    })
  }

  async function createItem(kind: 'file' | 'folder'): Promise<void> {
    const defaultName = kind === 'file' ? 'Untitled.md' : 'Untitled'
    const parentFolder = getCurrentFolderPath()
    const path = joinVaultPath(parentFolder, defaultName)
    expandedPaths.add(parentFolder)
    await runMutation(async () => {
      if (kind === 'file') await client.createVaultFile(path, '', false)
      else await client.createVaultFolder(path, false)
      if (kind === 'file') {
        selectedFilePath = path
        selectedFolderPath = null
      } else {
        selectedFolderPath = path
        selectedFilePath = null
      }
      return kind === 'file'
        ? { action: 'create-file' as const, toPath: path }
        : { action: 'create-folder' as const, toPath: path }
    })
    // Trigger rename on the new item after refresh so the row exists.
    const newItem = getFolderState(getParentPath(path)).items.find(
      (i) => i.path === path,
    )
    if (newItem) void startRename(newItem)
  }

  async function runMutation(
    mutation: () => Promise<MutationResult>,
  ): Promise<void> {
    try {
      const result = await mutation()
      reconcileAfterMutation(result)
      await refreshLoadedFolders()
      callbacks.onVaultMutated?.()
    } catch (err) {
      showOperationError(toUserMessage(err))
    }
  }

  async function refreshLoadedFolders(): Promise<void> {
    const previousCurrentFolderPath = getCurrentFolderPath()
    const folders = new Set<string>([
      homeRoot,
      previousCurrentFolderPath,
      ...expandedPaths,
    ])
    const refreshErrors: string[] = []
    await Promise.all(
      Array.from(folders).map(async (folder) => {
        await loadFolder(folder, null, {
          updateSelection: false,
          reportError: false,
        })
        const state = getFolderState(folder)
        if (state.error) {
          refreshErrors.push(state.error)
        }
      }),
    )

    const currentFolderMissing =
      previousCurrentFolderPath !== homeRoot &&
      getFolderState(previousCurrentFolderPath).errorKind === 'missing'
    if (currentFolderMissing) {
      selectedFolderPath = null
      selectedFilePath = null
      expandedPaths = new Set(
        Array.from(expandedPaths).filter(
          (path) =>
            path !== previousCurrentFolderPath &&
            !path.startsWith(previousCurrentFolderPath + '/'),
        ),
      )
      await loadFolder(homeRoot, null, {
        updateSelection: false,
        reportError: false,
      })
      renderTree()
    }

    const uniqueErrors = Array.from(new Set(refreshErrors))
    if (uniqueErrors.length > 0) {
      showOperationError(uniqueErrors[0])
    }
  }

  async function uploadFiles(
    targetFolder: string,
    files: File[],
  ): Promise<void> {
    try {
      const uploads = await Promise.all(
        files.map(async (file) => ({
          path: joinVaultPath(targetFolder, file.name),
          data: await file.arrayBuffer(),
          overwrite: false,
        })),
      )
      const results = await client.uploadVaultFiles(uploads)
      const failed = results.filter((r) => !r.ok)
      if (failed.length > 0)
        showOperationError(`${failed.length} upload(s) failed.`)
      await loadFolder(targetFolder, null, { updateSelection: false })
      callbacks.onVaultMutated?.()
    } catch (err) {
      showOperationError(toUserMessage(err))
    }
  }

  // Initial load — scope to home when a workspaceRoot is configured.
  void loadFolder(homeRoot)

  return {
    contentEl: parentEl,
    loadFolder,
    refresh: () =>
      loadFolder(getCurrentFolderPath(), null, { updateSelection: false }),
    refreshAll: () => refreshLoadedFolders(),
    destroy: () => {
      cleanupController.abort()
      navFileContainerEl.removeEventListener('dragover', dragOverHandler)
      navFileContainerEl.removeEventListener('drop', dropHandler)
      navFileContainerEl.removeEventListener('dragenter', dragEnterHandler)
      navFileContainerEl.removeEventListener('dragleave', dragLeaveHandler)
      window.removeEventListener('dragend', windowDragEndHandler, true)
      clearDropFeedback()
      clearInternalDragSource()
    },
  }
}
