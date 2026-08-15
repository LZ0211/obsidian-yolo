/* eslint-disable @typescript-eslint/no-unused-vars -- backup 逐字节拷贝：未接线骨架变量保留 */
/* eslint-disable @typescript-eslint/no-deprecated -- backup 逐字节拷贝：navigator.platform 是 web 端平台探测唯一可用来源 */
/* eslint-disable obsidianmd/no-static-styles-assignment -- web 运行时 mock Obsidian DOM 直接操作 style（CSS 变量注入/布局） */
/* eslint-disable obsidianmd/platform -- web 端无 Obsidian Platform，用 navigator 探测（与 obsidianCompat mock 同源） */
import { debounce } from '../runtime/web/debounce'
import { Platform } from '../runtime/web/obsidianCompat'
import {
  createDiv,
  createEl,
  installDomCompat,
} from '../runtime/web/obsidianDomCompat'

installDomCompat()

export type ObsidianWebShell = {
  appContainerEl: HTMLElement
  horizontalMainContainerEl: HTMLElement
  workspaceEl: HTMLElement
  statusBarEl: HTMLElement
  mobileNavbarEl: HTMLElement
  mobileToolbarSpacerEl: HTMLElement
  mobileToolbarEl: HTMLElement
  leftLeafContentEl: HTMLElement
  leftContentEl: HTMLElement
  /** Visible title in the left sidedock's `workspace-tab-header-container`.
   *  The standard `workspace-tab-header-inner-title` is hidden by Obsidian's
   *  sidebar CSS (`--sidebar-tab-text-display`), so the shell inserts a
   *  dedicated visible title element instead. Updated by the shell controller
   *  when the left pane switches between file explorer and history. */
  leftTabHeaderTitleEl: HTMLElement
  centerLeafContentEl: HTMLElement
  centerContentEl: HTMLElement
  rightLeafContentEl: HTMLElement
  rightContentEl: HTMLElement
  /** Visible title in the right sidedock's `workspace-tab-header-container`. */
  rightTabHeaderTitleEl: HTMLElement
  centerNavButtonsEl: HTMLElement
  tabsInnerEl: HTMLElement
  leftRibbonActionsEl: HTMLElement
  leftRibbonSettingsEl: HTMLElement
  leftRibbonFilesButtonEl: HTMLElement
  leftRibbonHistoryButtonEl: HTMLElement
  rightRibbonEl: HTMLElement
  rightHeaderTitleParentEl: HTMLElement
  rightHeaderTitleEl: HTMLElement
  rightHeaderActionsEl: HTMLElement
  centerTabsContainerEl: HTMLElement
  centerNewTabButtonEl: HTMLElement
  centerTabListButtonEl: HTMLElement
  centerTopBarTitleEl: HTMLElement
  setLeftVisible: (visible: boolean) => void
  setRightVisible: (visible: boolean) => void
  /** Non-null only when Platform.isMobile — hosts file tree / preview /
   *  history via detach-reparent instead of the desktop side splits. */
  mobileDrawer: MobileDrawer | null
  destroy: () => void
}

export type MobileDrawerPanel = 'files' | 'preview' | 'history'

export type MobileDrawer = {
  drawerEl: HTMLElement
  backdropEl: HTMLElement
  slots: Record<MobileDrawerPanel, HTMLElement>
  /** Top ribbon group: files / preview / history switch icons. */
  ribbonActionsEl: HTMLElement
  /** Bottom ribbon group: theme / logout, moved here from the desktop
   *  ribbon's leftRibbonSettingsEl on mobile (see renderLeftRibbonLogout). */
  ribbonSettingsEl: HTMLElement
  switchPanel: (target: MobileDrawerPanel) => void
  open: () => void
  close: () => void
  destroy: () => void
}

type SplitParts = {
  splitEl: HTMLElement
  resizeHandleEl: HTMLElement
  tabsEl: HTMLElement
  tabHeaderContainerEl: HTMLElement
  tabsInnerEl: HTMLElement
  tabsContainerEl: HTMLElement
  newTabButtonEl: HTMLElement
  tabListButtonEl: HTMLElement
  leafContentEl: HTMLElement
  contentEl: HTMLElement
  navButtonsEl: HTMLElement
  actionsEl: HTMLElement
  titleContainerEl: HTMLElement
  titleParentEl: HTMLElement
  titleEl: HTMLElement
  tabHeaderTitleEl: HTMLElement
}

type ItemViewHeaderParts = {
  navButtonsEl: HTMLElement
  actionsEl: HTMLElement
  titleContainerEl: HTMLElement
  titleParentEl: HTMLElement
  titleEl: HTMLElement
}

type BodyLifecycle = {
  destroy: () => void
}

function detectPlatformClass():
  | 'mod-windows'
  | 'mod-macos'
  | 'mod-linux'
  | null {
  const userAgent = navigator.userAgent.toLowerCase()
  const platform = navigator.platform.toLowerCase()
  if (platform.includes('mac') || userAgent.includes('mac os')) {
    return 'mod-macos'
  }
  if (platform.includes('win') || userAgent.includes('windows')) {
    return 'mod-windows'
  }
  if (platform.includes('linux') || userAgent.includes('linux')) {
    return 'mod-linux'
  }
  return null
}

function applyBodyCssVariables(bodyEl: HTMLElement): void {
  // Obsidian derives --font-ui-smaller/small/medium/large (and therefore most
  // UI text — nav items, headers, buttons) from --font-text-size via the
  // .is-mobile rules in app.css. Shrinking it here, rather than via CSS zoom/
  // transform, scales text through that existing, layout-safe mechanism
  // instead of fighting the browser's own measurement APIs.
  const baseFontSize = Platform.isMobile ? '14px' : '16px'
  bodyEl.style.setProperty('--font-text-size', baseFontSize)
  bodyEl.style.setProperty('--indent-size', '4')
  bodyEl.style.setProperty('--font-interface-override', 'ui-sans-serif')
  bodyEl.style.setProperty('--font-text-override', 'ui-sans-serif')
  bodyEl.style.setProperty('--font-print-override', 'ui-sans-serif')
  bodyEl.style.setProperty('--font-monospace-override', 'ui-monospace')
  bodyEl.style.setProperty('--zoom-factor', '1')
  document.documentElement.style.setProperty('font-size', baseFontSize)
}

const shellOwnedBodyClasses = [
  'obsidian-app',
  'show-ribbon',
  'show-view-header',
  'styled-scrollbars',
  'is-mobile',
  'is-tablet',
  'is-phone',
  'mod-toolbar-open',
] as const

function removeBodyCssVariables(bodyEl: HTMLElement): void {
  bodyEl.style.removeProperty('--font-text-size')
  bodyEl.style.removeProperty('--indent-size')
  bodyEl.style.removeProperty('--font-interface-override')
  bodyEl.style.removeProperty('--font-text-override')
  bodyEl.style.removeProperty('--font-print-override')
  bodyEl.style.removeProperty('--font-monospace-override')
  bodyEl.style.removeProperty('--zoom-factor')
  document.documentElement.style.removeProperty('font-size')
}

function installObsidianBodyLikeApp(): BodyLifecycle {
  const bodyEl = document.body
  const platformClass = detectPlatformClass()
  bodyEl.addClass(
    'obsidian-app',
    'show-ribbon',
    'show-view-header',
    'is-focused',
  )
  if (platformClass) {
    bodyEl.addClass(platformClass)
  }
  if (platformClass !== 'mod-macos') {
    bodyEl.addClass('styled-scrollbars')
  }
  applyBodyCssVariables(bodyEl)

  const mediaQuery = window.matchMedia(
    '(min-width: 600px) and (min-height: 600px)',
  )
  const updateMobileClasses = () => {
    // 窄视口（手机宽、或桌面浏览器缩得很窄/嵌在面板里）也启用移动抽屉布局：
    // 桌面布局的固定侧栏（280~320px）+ ribbon（44px）在 480px 以下会把主
    // 聊天挤成残废，且没有任何可见入口可以恢复（侧栏 toggle 无 label）。
    const isMobile = Platform.isMobile || window.innerWidth <= 480
    bodyEl.toggleClass('is-mobile', isMobile)
    const isTablet = isMobile && mediaQuery.matches
    const isPhone = isMobile && !isTablet
    bodyEl.toggleClass('is-tablet', isTablet)
    bodyEl.toggleClass('is-phone', isPhone)
  }

  const handleFocus = () => bodyEl.addClass('is-focused')
  const handleBlur = () => bodyEl.removeClass('is-focused')
  const handleScrollReset = () => {
    document.documentElement.scrollTop = 0
  }
  const handleTouchStart = (event: TouchEvent) => {
    ;(
      window as typeof window & { __yoloTouchCount?: number }
    ).__yoloTouchCount = event.touches.length
  }
  const handleTouchReset = () => {
    ;(
      window as typeof window & { __yoloTouchCount?: number }
    ).__yoloTouchCount = 0
  }

  updateMobileClasses()
  window.addEventListener('focus', handleFocus)
  window.addEventListener('blur', handleBlur)
  window.addEventListener('resize', updateMobileClasses)
  mediaQuery.addEventListener('change', updateMobileClasses)
  document.addEventListener('scroll', handleScrollReset, { passive: false })
  window.addEventListener('touchstart', handleTouchStart, true)
  window.addEventListener('touchend', handleTouchReset, true)
  window.addEventListener('touchcancel', handleTouchReset, true)

  return {
    destroy: () => {
      window.removeEventListener('focus', handleFocus)
      window.removeEventListener('blur', handleBlur)
      window.removeEventListener('resize', updateMobileClasses)
      mediaQuery.removeEventListener('change', updateMobileClasses)
      document.removeEventListener('scroll', handleScrollReset)
      window.removeEventListener('touchstart', handleTouchStart, true)
      window.removeEventListener('touchend', handleTouchReset, true)
      window.removeEventListener('touchcancel', handleTouchReset, true)
      bodyEl.removeClass('is-focused')
      if (platformClass) {
        bodyEl.removeClass(platformClass)
      }
      for (const className of shellOwnedBodyClasses) {
        bodyEl.removeClass(className)
      }
      removeBodyCssVariables(bodyEl)
    },
  }
}

function appendSidebarToggleIcon(
  parent: HTMLElement,
  side: 'left' | 'right',
): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '24')
  svg.setAttribute('height', '24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.classList.add('svg-icon', 'sidebar-toggle-button-icon')

  const outer = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  outer.setAttribute('x', '1')
  outer.setAttribute('y', '2')
  outer.setAttribute('width', '22')
  outer.setAttribute('height', '20')
  outer.setAttribute('rx', '4')

  const inner = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  inner.setAttribute('x', '4')
  inner.setAttribute('y', '5')
  inner.setAttribute('width', '2')
  inner.setAttribute('height', '14')
  inner.setAttribute('rx', '2')
  inner.setAttribute('fill', 'currentColor')
  inner.classList.add('sidebar-toggle-icon-inner')

  svg.append(outer, inner)
  parent.append(svg)
}

function appendPanelIcon(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.classList.add('svg-icon')

  const paths = [
    'M3 5a2 2 0 0 1 2-2h3v18H5a2 2 0 0 1-2-2V5Z',
    'M8 3h11a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H8',
  ]
  for (const d of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
  }
  parent.append(svg)
}

function appendFolderClosedIcon(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.classList.add('svg-icon', 'lucide-folder-closed')
  for (const d of [
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9l-.81-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
    'M2 10h20',
  ]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
  }
  parent.append(svg)
}

function appendHistoryIcon(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '18')
  svg.setAttribute('height', '18')
  svg.classList.add('svg-icon', 'lucide-history')
  for (const d of [
    'M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8',
    'M3 3v5h5',
    'M12 7v5l4 2',
  ]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
  }
  parent.append(svg)
}

function appendArrowIcon(
  parent: HTMLElement,
  direction: 'left' | 'right',
): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute(
    'd',
    direction === 'left' ? 'M15 18l-6-6 6-6' : 'M9 18l6-6-6-6',
  )
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '2')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  parent.append(svg)
}

function appendArrowLeftRightIcon(
  parent: HTMLElement,
  direction: 'left' | 'right',
): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')

  const shaft = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  shaft.setAttribute('d', direction === 'left' ? 'M19 12H5' : 'M5 12h14')
  shaft.setAttribute('fill', 'none')
  shaft.setAttribute('stroke', 'currentColor')
  shaft.setAttribute('stroke-width', '2')
  shaft.setAttribute('stroke-linecap', 'round')
  shaft.setAttribute('stroke-linejoin', 'round')

  const head = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  head.setAttribute(
    'd',
    direction === 'left' ? 'm12 19-7-7 7-7' : 'm12 5 7 7-7 7',
  )
  head.setAttribute('fill', 'none')
  head.setAttribute('stroke', 'currentColor')
  head.setAttribute('stroke-width', '2')
  head.setAttribute('stroke-linecap', 'round')
  head.setAttribute('stroke-linejoin', 'round')

  svg.append(shaft, head)
  parent.append(svg)
}

function appendPlusIcon(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')
  for (const d of ['M12 5v14', 'M5 12h14']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
  }
  parent.append(svg)
}

function appendSearchIcon(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')
  for (const d of [
    'M11 19a8 8 0 1 1 0-16 8 8 0 0 1 0 16Z',
    'm21 21-4.35-4.35',
  ]) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
  }
  parent.append(svg)
}

function appendMenuIcon(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')
  for (const d of ['M4 6h16', 'M4 12h16', 'M4 18h16']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
  }
  parent.append(svg)
}

function appendChevronDownIcon(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', 'm6 9 6 6 6-6')
  path.setAttribute('fill', 'none')
  path.setAttribute('stroke', 'currentColor')
  path.setAttribute('stroke-width', '2')
  path.setAttribute('stroke-linecap', 'round')
  path.setAttribute('stroke-linejoin', 'round')
  svg.append(path)
  parent.append(svg)
}

function appendChevronsUpDownIcon(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')
  for (const d of ['m7 15 5 5 5-5', 'm7 9 5-5 5 5']) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', d)
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
  }
  parent.append(svg)
}

function appendTabFrameIcon(parent: HTMLElement): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '16')
  svg.setAttribute('height', '16')
  svg.classList.add('svg-icon')

  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  rect.setAttribute('x', '1')
  rect.setAttribute('y', '3')
  rect.setAttribute('width', '22')
  rect.setAttribute('height', '18')
  rect.setAttribute('rx', '4')
  rect.setAttribute('fill', 'none')
  rect.setAttribute('stroke', 'currentColor')
  rect.setAttribute('stroke-width', '2')
  svg.append(rect)
  parent.append(svg)
}

function installTitleFadeLikeObsidian(
  titleContainerEl: HTMLElement,
  titleEl: HTMLElement,
): () => void {
  const update = () => {
    const scrollLeft = titleEl.scrollLeft
    const scrollWidth = titleEl.scrollWidth
    const width = titleEl.offsetWidth
    titleContainerEl.toggleClass('mod-at-start', scrollLeft === 0)
    titleContainerEl.toggleClass(
      'mod-at-end',
      Math.ceil(scrollLeft) >= scrollWidth - width,
    )
  }

  const handleScroll = debounce(() => update(), 10)
  const handleResize = debounce(() => update(), 10)
  titleEl.addEventListener('scroll', handleScroll)
  window.addEventListener('resize', handleResize)
  update()

  return () => {
    titleEl.removeEventListener('scroll', handleScroll)
    window.removeEventListener('resize', handleResize)
    handleScroll.cancel()
    handleResize.cancel()
  }
}

// Copied from the Obsidian WorkspaceRibbon constructor in reference/obsidian/app.js
// and reduced to the DOM construction that this web shell needs.
function createWorkspaceRibbonLikeObsidian(
  workspaceEl: HTMLElement,
  side: 'left' | 'right',
): {
  ribbonEl: HTMLElement
  actionsEl: HTMLElement | null
  settingsEl: HTMLElement | null
} {
  const ribbonEl = createDiv(workspaceEl, 'workspace-ribbon side-dock-ribbon')
  ribbonEl.addClass(`mod-${side}`)

  if (side === 'left') {
    const actionsEl = createDiv(ribbonEl, 'side-dock-actions')
    const settingsEl = createDiv(ribbonEl, 'side-dock-settings')
    return {
      ribbonEl,
      actionsEl,
      settingsEl,
    }
  }

  return {
    ribbonEl,
    actionsEl: null,
    settingsEl: null,
  }
}

// Copied from the Obsidian ItemView constructor in reference/obsidian/app.js
// and reduced to the shared header/content DOM that our leaves need.
function createItemViewFrameLikeObsidian(
  leafEl: HTMLElement,
  type: string,
  title: string,
  options?: {
    hideHeader?: boolean
  },
): ItemViewHeaderParts & {
  leafContentEl: HTMLElement
  contentEl: HTMLElement
  destroy: () => void
} {
  const leafContentEl = createDiv(leafEl, 'workspace-leaf-content')
  leafContentEl.setAttr('data-type', type)
  const viewHeaderEl = createDiv(leafContentEl, 'view-header')
  if (options?.hideHeader) {
    viewHeaderEl.style.display = 'none'
  }
  const contentEl = createDiv(leafContentEl, 'view-content')

  const headerLeftEl = createDiv(viewHeaderEl, 'view-header-left')
  const navButtonsEl = createDiv(headerLeftEl, 'view-header-nav-buttons')
  const titleContainerEl = createDiv(
    viewHeaderEl,
    'view-header-title-container mod-at-start',
  )
  titleContainerEl.addClass('mod-fade')
  const titleParentEl = createDiv(titleContainerEl, 'view-header-title-parent')
  const titleEl = createDiv(titleContainerEl, 'view-header-title', (el) =>
    el.setText(title),
  )
  const actionsEl = createDiv(viewHeaderEl, 'view-actions')
  if (document.body.hasClass('is-phone')) {
    actionsEl.addClass('mod-raised')
  }
  const destroyTitleFade = installTitleFadeLikeObsidian(
    titleContainerEl,
    titleEl,
  )

  return {
    navButtonsEl,
    actionsEl,
    titleContainerEl,
    titleParentEl,
    titleEl,
    leafContentEl,
    contentEl,
    destroy: () => destroyTitleFade(),
  }
}

function createTabHeaderActionIcon(
  parent: HTMLElement,
  icon: 'new-tab' | 'tab-list',
): HTMLElement {
  const iconEl = createEl(parent, 'span', { cls: 'clickable-icon' })
  if (icon === 'new-tab') {
    appendPlusIcon(iconEl)
  } else {
    appendChevronDownIcon(iconEl)
  }
  return iconEl
}

// Copied from the Obsidian WorkspaceTabs constructor in reference/obsidian/app.js
// and reduced to the static tab-group DOM used by this shell.
function createWorkspaceTabsGroupLikeObsidian(
  parentEl: HTMLElement,
  type: string,
  title: string,
  options?: {
    top?: boolean
    bareLeafContent?: boolean
    hideTabHeaderInner?: boolean
    /** Skip creating the tab-header-inner, new-tab button, spacer, and
     *  tab-list button. Used by the left/right sidedocks, which only show a
     *  static title in the tab-header bar (no tab switching UX). */
    bareTabHeader?: boolean
  },
): {
  tabsEl: HTMLElement
  tabHeaderContainerEl: HTMLElement
  tabsInnerEl: HTMLElement
  tabsContainerEl: HTMLElement
  newTabButtonEl: HTMLElement
  tabListButtonEl: HTMLElement
  tabHeaderTitleEl: HTMLElement
  leafContentEl: HTMLElement
  contentEl: HTMLElement
  destroy: () => void
} & ItemViewHeaderParts {
  const tabsEl = createDiv(parentEl, 'workspace-tabs')
  tabsEl.addClass('mod-active', 'mod-visible')
  if (options?.top) {
    tabsEl.addClass('mod-top')
  }

  const tabHeaderContainerEl = createDiv(
    tabsEl,
    'workspace-tab-header-container',
  )
  // Placeholders so the return type stays uniform when bareTabHeader skips
  // the real elements. They're never appended to the DOM in that case.
  const placeholder = (): HTMLElement => document.createElement('div')

  let tabsInnerEl: HTMLElement
  let tabHeaderTitleEl: HTMLElement
  let newTabButtonEl: HTMLElement
  let tabListButtonEl: HTMLElement

  if (options?.bareTabHeader) {
    tabsInnerEl = placeholder()
    tabHeaderTitleEl = placeholder()
    newTabButtonEl = placeholder()
    tabListButtonEl = placeholder()
  } else {
    tabsInnerEl = createDiv(
      tabHeaderContainerEl,
      'workspace-tab-header-container-inner',
    )
    if (options?.hideTabHeaderInner) {
      tabsInnerEl.style.display = 'none'
    }
    const tabHeaderEl = createDiv(
      tabsInnerEl,
      'workspace-tab-header tappable is-active',
    )
    tabHeaderEl.draggable = true
    tabHeaderEl.setAttr('data-type', type)
    const tabHeaderInnerEl = createDiv(
      tabHeaderEl,
      'workspace-tab-header-inner',
    )
    createDiv(tabHeaderInnerEl, 'workspace-tab-header-inner-icon')
    tabHeaderTitleEl = createDiv(
      tabHeaderInnerEl,
      'workspace-tab-header-inner-title',
      (el) => el.setText(title),
    )
    createDiv(tabHeaderInnerEl, 'workspace-tab-header-status-container')
    createDiv(tabHeaderInnerEl, 'workspace-tab-header-inner-close-button')

    newTabButtonEl = createDiv(
      tabHeaderContainerEl,
      'workspace-tab-header-new-tab',
      (el) => {
        createTabHeaderActionIcon(el, 'new-tab')
      },
    )
    createDiv(tabHeaderContainerEl, 'workspace-tab-header-spacer')
    tabListButtonEl = createDiv(
      tabHeaderContainerEl,
      'workspace-tab-header-tab-list',
      (el) => {
        createTabHeaderActionIcon(el, 'tab-list')
      },
    )
  }

  const tabsContainerEl = createDiv(tabsEl, 'workspace-tab-container')
  const leafEl = createDiv(tabsContainerEl, 'workspace-leaf mod-active')
  const itemViewFrame = options?.bareLeafContent
    ? {
        navButtonsEl: document.createElement('div'),
        actionsEl: document.createElement('div'),
        titleContainerEl: document.createElement('div'),
        titleParentEl: document.createElement('div'),
        titleEl: document.createElement('div'),
        leafContentEl: createDiv(leafEl, 'workspace-leaf-content'),
        contentEl: document.createElement('div'),
        destroy: () => {},
      }
    : createItemViewFrameLikeObsidian(leafEl, type, title, {
        hideHeader: type === 'yolo-chat',
      })
  if (options?.bareLeafContent) {
    itemViewFrame.leafContentEl.setAttr('data-type', type)
  }

  return {
    tabsEl,
    tabHeaderContainerEl,
    tabsInnerEl,
    tabsContainerEl,
    newTabButtonEl,
    tabListButtonEl,
    ...itemViewFrame,
    tabHeaderTitleEl,
  }
}

// Copied from the Obsidian WorkspaceSplit constructor in reference/obsidian/app.js
// plus the static child creation used by desktop layout initialization.
function createWorkspaceSplitContainerLikeObsidian(
  workspaceEl: HTMLElement,
  splitClassName: string,
  type: string,
  title: string,
  options?: {
    topTabs?: boolean
    bareLeafContent?: boolean
  },
): SplitParts {
  const splitEl = createDiv(workspaceEl, splitClassName)
  splitEl.addClass('mod-visible')
  const resizeHandleEl = createEl(splitEl, 'hr', {
    cls: 'workspace-leaf-resize-handle',
  })
  const tabs = createWorkspaceTabsGroupLikeObsidian(splitEl, type, title, {
    top: options?.topTabs,
    bareLeafContent: options?.bareLeafContent,
    bareTabHeader: type === 'file-explorer' || type === 'web-preview',
  })

  return {
    splitEl,
    resizeHandleEl,
    tabsEl: tabs.tabsEl,
    tabHeaderContainerEl: tabs.tabHeaderContainerEl,
    tabsInnerEl: tabs.tabsInnerEl,
    tabsContainerEl: tabs.tabsContainerEl,
    newTabButtonEl: tabs.newTabButtonEl,
    tabListButtonEl: tabs.tabListButtonEl,
    leafContentEl: tabs.leafContentEl,
    contentEl: tabs.contentEl,
    navButtonsEl: tabs.navButtonsEl,
    actionsEl: tabs.actionsEl,
    titleContainerEl: tabs.titleContainerEl,
    titleParentEl: tabs.titleParentEl,
    titleEl: tabs.titleEl,
    tabHeaderTitleEl: tabs.tabHeaderTitleEl,
  }
}

// Mobile-only drawer that hosts the files/preview/history panels behind a
// hamburger toggle (docs/superpowers/plans/2026-06-30-mobile-web-layout.md,
// PR2). Callers are responsible for only invoking this when isMobileShell —
// the function itself has no Platform/body-class checks.
function createMobileDrawer(
  workspaceEl: HTMLElement,
  onBackdropClose?: () => void,
): MobileDrawer {
  const backdropEl = createDiv(workspaceEl, 'yolo-mobile-drawer-backdrop')
  const drawerEl = createDiv(workspaceEl, 'yolo-mobile-drawer')

  const ribbonEl = createDiv(
    drawerEl,
    'yolo-mobile-drawer-ribbon side-dock-ribbon mod-left',
  )
  const ribbonActionsEl = createDiv(ribbonEl, 'side-dock-actions')
  const ribbonSettingsEl = createDiv(ribbonEl, 'side-dock-settings')

  const bodyEl = createDiv(drawerEl, 'yolo-mobile-drawer-body')
  const titleEl = createDiv(bodyEl, 'yolo-mobile-drawer-title')
  const slotsEl = createDiv(bodyEl, 'yolo-mobile-drawer-slots')
  const filesSlotEl = createDiv(slotsEl, 'yolo-mobile-drawer-slot')
  const previewSlotEl = createDiv(slotsEl, 'yolo-mobile-drawer-slot')
  const historySlotEl = createDiv(slotsEl, 'yolo-mobile-drawer-slot')

  const slots: Record<MobileDrawerPanel, HTMLElement> = {
    files: filesSlotEl,
    preview: previewSlotEl,
    history: historySlotEl,
  }
  const panelTitles: Record<MobileDrawerPanel, string> = {
    files: '资源管理器',
    preview: '预览',
    history: '历史会话',
  }

  const historyButton = createRibbonActionButtonLikeObsidian(
    ribbonActionsEl,
    '历史会话',
    'history',
  )
  const filesButton = createRibbonActionButtonLikeObsidian(
    ribbonActionsEl,
    '资源管理器',
    'files',
  )
  const previewButton = createRibbonActionButtonLikeObsidian(
    ribbonActionsEl,
    '预览',
    'preview',
  )
  const ribbonButtons: Record<MobileDrawerPanel, HTMLElement> = {
    files: filesButton,
    preview: previewButton,
    history: historyButton,
  }
  for (const panel of Object.keys(ribbonButtons) as MobileDrawerPanel[]) {
    ribbonButtons[panel].setAttr('data-panel', panel)
  }

  const switchPanel = (target: MobileDrawerPanel) => {
    for (const panel of Object.keys(slots) as MobileDrawerPanel[]) {
      slots[panel].toggleClass('is-hidden', panel !== target)
      ribbonButtons[panel].toggleClass('is-active', panel === target)
    }
    titleEl.setText(panelTitles[target])
  }
  switchPanel('history')

  const open = () => {
    drawerEl.addClass('is-open')
    backdropEl.addClass('is-open')
  }
  const close = () => {
    drawerEl.removeClass('is-open')
    backdropEl.removeClass('is-open')
  }
  backdropEl.addEventListener('click', () => {
    close()
    onBackdropClose?.()
  })

  // The drawer is full-width (no backdrop strip left to tap), so swipe-left
  // is the primary way to dismiss it — mirrors the edge-swipe-to-open
  // gesture in installObsidianWorkspaceLikeApp.
  //
  // Wide markdown tables/CSV previews get their own horizontal scroller
  // (index.html), so a touch that starts on one of those must not also be
  // interpreted as "swipe the drawer closed" — walk up from the touch
  // target and bail out if any ancestor actually has horizontal overflow to
  // scroll.
  const isTouchInsideHorizontalScroller = (
    target: EventTarget | null,
  ): boolean => {
    let el = target instanceof Element ? target : null
    while (el && el !== drawerEl) {
      const style = window.getComputedStyle(el)
      if (
        (style.overflowX === 'auto' || style.overflowX === 'scroll') &&
        el.scrollWidth > el.clientWidth
      ) {
        return true
      }
      el = el.parentElement
    }
    return false
  }
  const SWIPE_CLOSE_THRESHOLD_PX = 60
  let swipeStartX: number | null = null
  let swipeStartY: number | null = null
  let swipeTriggered = false
  const handleSwipeStart = (event: TouchEvent) => {
    if (
      event.touches.length !== 1 ||
      isTouchInsideHorizontalScroller(event.target)
    ) {
      swipeStartX = null
      return
    }
    swipeStartX = event.touches[0].clientX
    swipeStartY = event.touches[0].clientY
    swipeTriggered = false
  }
  const handleSwipeMove = (event: TouchEvent) => {
    if (swipeStartX === null || swipeTriggered || event.touches.length !== 1) {
      return
    }
    const touch = event.touches[0]
    const deltaX = touch.clientX - swipeStartX
    const deltaY = touch.clientY - (swipeStartY ?? touch.clientY)
    if (Math.abs(deltaY) > Math.abs(deltaX)) {
      return
    }
    if (deltaX < -SWIPE_CLOSE_THRESHOLD_PX) {
      swipeTriggered = true
      close()
      onBackdropClose?.()
    }
  }
  const handleSwipeReset = () => {
    swipeStartX = null
    swipeStartY = null
    swipeTriggered = false
  }
  drawerEl.addEventListener('touchstart', handleSwipeStart, { passive: true })
  drawerEl.addEventListener('touchmove', handleSwipeMove, { passive: true })
  drawerEl.addEventListener('touchend', handleSwipeReset, { passive: true })
  drawerEl.addEventListener('touchcancel', handleSwipeReset, { passive: true })

  return {
    drawerEl,
    backdropEl,
    slots,
    ribbonActionsEl,
    ribbonSettingsEl,
    switchPanel,
    open,
    close,
    destroy: () => {
      drawerEl.removeEventListener('touchstart', handleSwipeStart)
      drawerEl.removeEventListener('touchmove', handleSwipeMove)
      drawerEl.removeEventListener('touchend', handleSwipeReset)
      drawerEl.removeEventListener('touchcancel', handleSwipeReset)
      backdropEl.remove()
      drawerEl.remove()
    },
  }
}

function createMobileHamburgerLikeObsidian(
  parent: HTMLElement,
  onToggle: () => void,
): HTMLElement {
  const button = createEl(parent, 'button', {
    cls: 'clickable-icon yolo-mobile-hamburger',
    attr: { type: 'button', 'aria-label': 'Toggle sidebar' },
  })
  appendMenuIcon(button)
  button.addEventListener('click', () => onToggle())
  return button
}

// Copied from the Obsidian WorkspaceSidedock constructor/collapse-expand flow
// in reference/obsidian/app.js and reduced to width/collapsed DOM behavior.
function createWorkspaceSidedockLikeObsidian(
  workspaceEl: HTMLElement,
  side: 'left' | 'right',
  type: string,
  title: string,
): SplitParts & {
  setCollapsed: (collapsed: boolean) => void
  setSize: (width: number) => void
  isCollapsed: () => boolean
} {
  const split = createWorkspaceSplitContainerLikeObsidian(
    workspaceEl,
    `workspace-split mod-horizontal mod-sidedock mod-${side}-split`,
    type,
    title,
    {
      bareLeafContent: type === 'file-explorer',
    },
  )

  let size = side === 'left' ? 320 : 380
  let collapsed = false
  let animationFrameId: number | null = null
  let transitionCleanup: (() => void) | null = null
  let transitionFallbackTimer: number | null = null

  split.splitEl.style.width = `${size}px`
  split.splitEl.style.minWidth = `${size}px`

  const clearAnimationState = () => {
    if (animationFrameId != null) {
      window.cancelAnimationFrame(animationFrameId)
      animationFrameId = null
    }
    transitionCleanup?.()
    transitionCleanup = null
    if (transitionFallbackTimer != null) {
      window.clearTimeout(transitionFallbackTimer)
      transitionFallbackTimer = null
    }
  }

  const animateWidth = (
    fromWidth: number,
    toWidth: number,
    onComplete: () => void,
  ) => {
    clearAnimationState()
    split.splitEl.style.overflow = 'hidden'
    split.splitEl.style.width = `${fromWidth}px`
    split.splitEl.style.minWidth = `${Math.max(fromWidth, toWidth)}px`
    split.tabsEl.style.minWidth = `${Math.max(fromWidth, 1)}px`

    let completed = false
    const finishAnimation = () => {
      if (completed) return
      completed = true
      clearAnimationState()
      split.splitEl.style.transition = ''
      split.splitEl.style.overflow = ''
      split.tabsEl.style.minWidth = ''
      onComplete()
    }

    const handleTransitionEnd = (event: TransitionEvent) => {
      if (event.propertyName !== 'width') {
        return
      }
      finishAnimation()
    }

    transitionCleanup = () => {
      split.splitEl.removeEventListener('transitionend', handleTransitionEnd)
    }
    split.splitEl.addEventListener('transitionend', handleTransitionEnd)
    transitionFallbackTimer = window.setTimeout(finishAnimation, 220)

    animationFrameId = window.requestAnimationFrame(() => {
      split.splitEl.style.transition = 'width 150ms ease-out'
      split.splitEl.style.width = `${toWidth}px`
      split.splitEl.style.minWidth = `${Math.max(toWidth, 0)}px`
    })
  }

  const setSize = (width: number) => {
    size = Math.max(side === 'left' ? 240 : 280, Math.min(width, 640))
    if (!collapsed) {
      clearAnimationState()
      split.splitEl.style.transition = ''
      split.splitEl.style.width = `${size}px`
      split.splitEl.style.minWidth = `${size}px`
      split.tabsEl.style.minWidth = ''
    }
  }

  const setCollapsed = (nextCollapsed: boolean) => {
    if (collapsed === nextCollapsed) {
      return
    }
    const currentWidth = split.splitEl.getBoundingClientRect().width || size
    collapsed = nextCollapsed
    workspaceEl.toggleClass(`is-${side}-sidedock-open`, !collapsed)

    if (collapsed) {
      split.splitEl.addClass('is-sidedock-collapsed')
      animateWidth(currentWidth, 0, () => {
        split.splitEl.removeClass('mod-visible')
        split.tabsEl.removeClass('mod-visible')
        split.splitEl.style.width = '0px'
        split.splitEl.style.minWidth = '0px'
      })
    } else {
      split.splitEl.addClass('mod-visible')
      split.tabsEl.addClass('mod-visible')
      split.splitEl.style.width = '0px'
      split.splitEl.style.minWidth = `${size}px`
      animateWidth(0, size, () => {
        split.splitEl.removeClass('is-sidedock-collapsed')
        split.splitEl.style.width = `${size}px`
        split.splitEl.style.minWidth = `${size}px`
      })
    }
  }

  split.resizeHandleEl.addEventListener('mousedown', (event) => {
    event.preventDefault()
    const startX = event.clientX
    const startWidth = split.splitEl.getBoundingClientRect().width
    document.body.addClass('is-grabbing')

    const cleanup = () => {
      document.body.removeClass('is-grabbing')
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', cleanup)
      document.documentElement.removeEventListener('mouseleave', cleanup)
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX
      const nextWidth =
        side === 'left' ? startWidth + delta : startWidth - delta
      setSize(nextWidth)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', cleanup)
    document.documentElement.addEventListener('mouseleave', cleanup)
  })

  setCollapsed(false)

  return {
    ...split,
    setCollapsed,
    setSize,
    isCollapsed: () => collapsed,
  }
}

function createRibbonActionButtonLikeObsidian(
  parent: HTMLElement,
  title: string,
  icon: 'files' | 'history' | 'preview',
): HTMLElement {
  const button = createDiv(
    parent,
    'side-dock-ribbon-action clickable-icon',
    (el) => {
      el.setAttr('aria-label', title)
      el.setAttr('data-tooltip-position', 'right')
    },
  )
  if (icon === 'files') {
    appendFolderClosedIcon(button)
  } else if (icon === 'history') {
    appendHistoryIcon(button)
  } else {
    appendPanelIcon(button)
  }
  return button
}

function createMobileSidebarToggleLikeObsidian(
  parent: HTMLElement,
  side: 'left' | 'right',
  title: string,
): HTMLElement {
  const button = createEl(parent, 'button', {
    cls: `view-action clickable-icon mod-${side}-split-toggle mod-raised sidebar-toggle-button mod-${side}`,
    attr: { type: 'button', 'aria-label': title },
  })
  appendSidebarToggleIcon(button, side)
  return button
}

function createDesktopSidebarToggleLikeObsidian(
  parent: HTMLElement,
  side: 'left' | 'right',
): HTMLElement {
  const toggleEl = createDiv(parent, `sidebar-toggle-button mod-${side}`)
  // 空 aria-label 让屏幕阅读器无标签、且（web shell 内）无任何可发现入口；
  // 桌面侧栏在窄视口被挤压时只能靠这个按钮恢复布局。
  toggleEl.setAttr('aria-label', 'Toggle sidebar')
  toggleEl.setAttr('data-tooltip-position', side === 'left' ? 'right' : 'left')
  const clickableIconEl = createDiv(toggleEl, 'clickable-icon')
  appendSidebarToggleIcon(clickableIconEl, side)
  return toggleEl
}

function moveDesktopToggleLikeObsidian(
  toggleEl: HTMLElement,
  targetEl: HTMLElement,
  options?: { prepend?: boolean },
): void {
  if (toggleEl.parentElement === targetEl) {
    return
  }
  if (options?.prepend) {
    targetEl.prepend(toggleEl)
  } else {
    targetEl.append(toggleEl)
  }
}

function createMobileNavbarLikeObsidian(parentEl: HTMLElement): {
  containerEl: HTMLElement
  backActionEl: HTMLElement
  forwardActionEl: HTMLElement
  quickSwitcherActionEl: HTMLElement
  newTabActionEl: HTMLElement
  tabsActionEl: HTMLElement
  tabsNumberEl: HTMLElement
  menuActionEl: HTMLElement
} {
  const containerEl = createDiv(parentEl, 'mobile-navbar mod-raised')
  const actionsEl = createDiv(containerEl, 'mobile-navbar-actions')
  const backActionEl = createDiv(
    actionsEl,
    'mobile-navbar-action mobile-navbar-action-back',
  )
  const forwardActionEl = createDiv(
    actionsEl,
    'mobile-navbar-action mobile-navbar-action-forward',
  )
  const quickSwitcherActionEl = createDiv(
    actionsEl,
    'mobile-navbar-action mobile-navbar-action-quick-switcher',
  )
  const newTabActionEl = createDiv(
    actionsEl,
    'mobile-navbar-action mobile-navbar-action-new-tab',
  )
  const tabsActionEl = createDiv(
    actionsEl,
    'mobile-navbar-action mobile-navbar-action-tabs',
  )
  const tabsNumberEl = createDiv(
    tabsActionEl,
    'mobile-navbar-tabs-number',
    (countEl) => countEl.setText('3'),
  )
  const menuActionEl = createDiv(
    actionsEl,
    'mobile-navbar-action mobile-navbar-action-menu has-longpress-menu',
  )
  appendArrowIcon(
    createEl(backActionEl, 'span', { cls: 'clickable-icon' }),
    'left',
  )
  appendArrowIcon(
    createEl(forwardActionEl, 'span', { cls: 'clickable-icon' }),
    'right',
  )
  appendSearchIcon(
    createEl(quickSwitcherActionEl, 'span', { cls: 'clickable-icon' }),
  )
  appendPlusIcon(createEl(newTabActionEl, 'span', { cls: 'clickable-icon' }))
  const tabsClickableIconEl = createDiv(tabsActionEl, 'clickable-icon')
  appendTabFrameIcon(tabsClickableIconEl)
  tabsClickableIconEl.append(tabsNumberEl)
  const menuClickableIconEl = createEl(menuActionEl, 'span', {
    cls: 'clickable-icon',
  })
  appendMenuIcon(menuClickableIconEl)
  const menuFlairEl = createDiv(menuActionEl, 'navbar-action-flair')
  appendChevronsUpDownIcon(menuFlairEl)
  menuFlairEl.toggleClass('is-hidden', true)
  return {
    containerEl,
    backActionEl,
    forwardActionEl,
    quickSwitcherActionEl,
    newTabActionEl,
    tabsActionEl,
    tabsNumberEl,
    menuActionEl,
  }
}

function createMobileToolbarLikeObsidian(parentEl: HTMLElement): {
  spacerEl: HTMLElement
  wrapperEl: HTMLElement
  optionsListEl: HTMLElement
} {
  const spacerEl = createDiv(parentEl, 'mobile-toolbar-spacer')
  const wrapperEl = createDiv(parentEl, 'mobile-toolbar')
  const optionsContainerEl = createDiv(
    wrapperEl,
    'mobile-toolbar-options-container',
  )
  const listContainerEl = createDiv(
    optionsContainerEl,
    'mobile-toolbar-options-list-container mod-raised',
  )
  const optionsListEl = createDiv(
    listContainerEl,
    'mobile-toolbar-options-list',
  )
  const floatingOptionsEl = createDiv(
    optionsContainerEl,
    'mobile-toolbar-floating-options mod-raised',
  )
  return {
    spacerEl,
    wrapperEl,
    optionsListEl,
  }
}

// Obsidian's sidebar CSS hides `workspace-tab-header-inner-title` via
// `--sidebar-tab-text-display`, so the standard tab title is invisible in the
// left/right sidedocks. This inserts a dedicated, visible title element as the
// first child of the tab-header container.
function createSidedockTabTitle(
  tabHeaderContainerEl: HTMLElement,
  title: string,
): HTMLElement {
  const titleEl = document.createElement('div')
  titleEl.className = 'yolo-sidedock-tab-title'
  titleEl.setText(title)
  tabHeaderContainerEl.insertBefore(titleEl, tabHeaderContainerEl.firstChild)
  return titleEl
}

export function createObsidianWebShell(
  parentEl: HTMLElement,
): ObsidianWebShell {
  parentEl.empty()
  const bodyLifecycle = installObsidianBodyLikeApp()
  const isMobileShell = document.body.hasClass('is-mobile')
  const appContainerEl = createDiv(parentEl, 'app-container')
  const horizontalMainContainerEl = createDiv(
    appContainerEl,
    'horizontal-main-container',
  )
  const workspaceEl = createDiv(
    horizontalMainContainerEl,
    'workspace yolo-web-demo-workspace',
  )
  const statusBarEl = createDiv(appContainerEl, 'status-bar')
  // Superseded by the drawer-based mobile design (docs/superpowers/plans/
  // 2026-06-30-mobile-web-layout.md) — the ported Obsidian-mobile navbar/
  // toolbar skeleton is never mounted. Helpers kept in place for now.
  const mobileNavbar = null as ReturnType<
    typeof createMobileNavbarLikeObsidian
  > | null
  const mobileToolbar = null as ReturnType<
    typeof createMobileToolbarLikeObsidian
  > | null
  const leftRibbon = createWorkspaceRibbonLikeObsidian(workspaceEl, 'left')
  const leftRibbonActionsEl = leftRibbon.actionsEl as HTMLElement
  const leftRibbonSettingsEl = leftRibbon.settingsEl as HTMLElement
  const leftSplit = createWorkspaceSidedockLikeObsidian(
    workspaceEl,
    'left',
    'file-explorer',
    'Files',
  )
  const rootSplit = createWorkspaceSplitContainerLikeObsidian(
    workspaceEl,
    'workspace-split mod-vertical mod-root',
    'yolo-chat',
    'Smart RAG',
    { topTabs: true },
  )
  const rightSplit = createWorkspaceSidedockLikeObsidian(
    workspaceEl,
    'right',
    'web-preview',
    'Preview',
  )
  const rightRibbon = createWorkspaceRibbonLikeObsidian(workspaceEl, 'right')
  rightRibbon.ribbonEl.addClass('is-hidden')

  // Visible center topbar anchor lives inside the (always-visible) center tab
  // header container so the agent title has a stable, on-screen mount point
  // even though the center view-header itself is hidden (yolo-chat hideHeader).
  const centerTopBarMetaEl = createDiv(
    rootSplit.tabHeaderContainerEl,
    'yolo-web-center-topbar-meta',
  )
  const centerTopBarTitleEl = createDiv(
    centerTopBarMetaEl,
    'yolo-web-center-topbar-title',
  )

  const leftRibbonFilesButton = createRibbonActionButtonLikeObsidian(
    leftRibbonActionsEl,
    'Files',
    'files',
  )
  const leftRibbonHistoryButton = createRibbonActionButtonLikeObsidian(
    leftRibbonActionsEl,
    'History',
    'history',
  )
  // 导航与侧栏 toggle 四按钮整体隐藏：web 壳不提供历史导航，侧栏可见性
  // 由文件/历史/预览面板入口驱动（桌面端）。保留创建以便未来恢复。
  const centerBackButton = createEl(rootSplit.navButtonsEl, 'button', {
    cls: 'clickable-icon',
    attr: { type: 'button', 'aria-label': 'Back' },
  })
  centerBackButton.addClass('is-hidden')
  centerBackButton.setAttribute('aria-hidden', 'true')
  appendArrowLeftRightIcon(centerBackButton, 'left')
  const centerForwardButton = createEl(rootSplit.navButtonsEl, 'button', {
    cls: 'clickable-icon',
    attr: { type: 'button', 'aria-label': 'Forward' },
  })
  centerForwardButton.addClass('is-hidden')
  centerForwardButton.setAttribute('aria-hidden', 'true')
  appendArrowLeftRightIcon(centerForwardButton, 'right')
  const centerLeftToggle = createDesktopSidebarToggleLikeObsidian(
    workspaceEl,
    'left',
  )
  centerLeftToggle.addClass('is-hidden')
  centerLeftToggle.setAttribute('aria-hidden', 'true')
  const centerRightToggle = createDesktopSidebarToggleLikeObsidian(
    workspaceEl,
    'right',
  )
  centerRightToggle.addClass('is-hidden')
  centerRightToggle.setAttribute('aria-hidden', 'true')
  let leftVisible = true
  let rightVisible = true
  let toolbarVisible = false

  const updateDesktopSidebarToggleLayout = () => {
    if (isMobileShell) {
      return
    }

    leftSplit.tabsEl.removeClass('mod-top-left-space')
    rightSplit.tabsEl.removeClass('mod-top-right-space')
    rootSplit.tabsEl.removeClass('mod-top-right-space')
    rootSplit.tabsEl.removeClass('mod-top-left-space')

    const leftRibbonShown = !leftRibbon.ribbonEl.hasClass('is-hidden')
    if (leftRibbonShown) {
      moveDesktopToggleLikeObsidian(centerLeftToggle, leftRibbon.ribbonEl, {
        prepend: true,
      })
      leftSplit.tabsEl.addClass('mod-top-left-space')
    } else if (leftVisible) {
      moveDesktopToggleLikeObsidian(
        centerLeftToggle,
        leftSplit.tabHeaderContainerEl,
        {
          prepend: true,
        },
      )
      leftSplit.tabsEl.addClass('mod-top-left-space')
    } else {
      moveDesktopToggleLikeObsidian(
        centerLeftToggle,
        rootSplit.tabHeaderContainerEl,
        {
          prepend: true,
        },
      )
      rootSplit.tabsEl.addClass('mod-top-left-space')
    }

    if (rightVisible) {
      moveDesktopToggleLikeObsidian(
        centerRightToggle,
        rightSplit.tabHeaderContainerEl,
      )
      rightSplit.tabsEl.addClass('mod-top-right-space')
    } else {
      moveDesktopToggleLikeObsidian(
        centerRightToggle,
        rootSplit.tabHeaderContainerEl,
      )
      rootSplit.tabsEl.addClass('mod-top-right-space')
    }
  }

  const setToolbarVisible = (visible: boolean) => {
    if (!mobileToolbar || !mobileNavbar) {
      return
    }
    toolbarVisible = visible
    document.body.toggleClass('mod-toolbar-open', visible)
    mobileToolbar.wrapperEl.toggleClass('is-hidden', !visible)
    mobileToolbar.spacerEl.toggleClass('is-hidden', !visible)
    mobileNavbar.containerEl.toggleClass('is-hidden', visible)
  }

  const setLeftVisible = (visible: boolean) => {
    if (isMobileShell) {
      // The mobile drawer owns files/history visibility instead of the
      // desktop left sidedock — see mobileDrawer.open()/close()/switchPanel().
      return
    }
    leftVisible = visible
    leftSplit.setCollapsed(!visible)
    updateDesktopSidebarToggleLayout()
  }

  const setRightVisible = (visible: boolean) => {
    if (isMobileShell) {
      // The mobile drawer owns preview visibility instead of the desktop
      // right sidedock — see mobileDrawer.open()/close()/switchPanel().
      return
    }
    rightVisible = visible
    rightSplit.setCollapsed(!visible)
    rightRibbon.ribbonEl.toggleClass('is-hidden', true)
    updateDesktopSidebarToggleLayout()
  }

  mobileNavbar?.quickSwitcherActionEl.addEventListener('click', () => {
    setLeftVisible(!leftVisible)
  })
  mobileNavbar?.tabsActionEl.addEventListener('click', () => {
    setRightVisible(!rightVisible)
  })
  mobileNavbar?.menuActionEl.addEventListener('click', () => {
    window.dispatchEvent(new CustomEvent('yolo:web-open-settings'))
  })
  mobileNavbar?.backActionEl.addEventListener('click', () => {
    setLeftVisible(true)
  })
  mobileNavbar?.forwardActionEl.addEventListener('click', () => {
    setRightVisible(true)
  })
  mobileNavbar?.newTabActionEl.addEventListener('click', () => {
    setLeftVisible(true)
    setRightVisible(false)
  })

  centerLeftToggle.addEventListener('click', () => setLeftVisible(!leftVisible))
  centerRightToggle.addEventListener('click', () =>
    setRightVisible(!rightVisible),
  )

  if (isMobileShell) {
    // Superseded by the drawer-based mobile design — the ported Obsidian-
    // mobile sidebar toggles and keyboard/focus wiring are no longer created.
    // The drawer (docs/superpowers/plans/2026-06-30-mobile-web-layout.md,
    // PR2) owns pane visibility on mobile instead.
    centerLeftToggle.addClass('is-hidden')
    centerRightToggle.addClass('is-hidden')
  } else {
    // 四按钮已整体隐藏（见创建处），桌面分支不再恢复显示。
    updateDesktopSidebarToggleLayout()
  }

  setLeftVisible(true)
  setRightVisible(true)
  setToolbarVisible(false)

  let drawerOpen = false
  const mobileDrawer = isMobileShell
    ? createMobileDrawer(workspaceEl, () => {
        drawerOpen = false
      })
    : null
  const toggleDrawer = () => {
    drawerOpen = !drawerOpen
    if (drawerOpen) {
      mobileDrawer?.open()
    } else {
      mobileDrawer?.close()
    }
  }
  const mobileHamburgerEl = isMobileShell
    ? createMobileHamburgerLikeObsidian(appContainerEl, toggleDrawer)
    : null

  // Swipe-from-left-half gesture to open the mobile drawer (docs/superpowers/
  // plans/2026-06-30-mobile-web-layout.md, PR2 follow-up) — the hamburger
  // button is the only other way to open it.
  const EDGE_SWIPE_OPEN_THRESHOLD_PX = 60
  let edgeSwipeStartX: number | null = null
  let edgeSwipeStartY: number | null = null
  let edgeSwipeTriggered = false
  const handleEdgeSwipeStart = (event: TouchEvent) => {
    if (drawerOpen || event.touches.length !== 1) {
      edgeSwipeStartX = null
      return
    }
    const touch = event.touches[0]
    if (touch.clientX >= window.innerWidth / 2) {
      edgeSwipeStartX = null
      return
    }
    edgeSwipeStartX = touch.clientX
    edgeSwipeStartY = touch.clientY
    edgeSwipeTriggered = false
  }
  const handleEdgeSwipeMove = (event: TouchEvent) => {
    if (
      edgeSwipeStartX === null ||
      edgeSwipeTriggered ||
      event.touches.length !== 1
    ) {
      return
    }
    const touch = event.touches[0]
    const deltaX = touch.clientX - edgeSwipeStartX
    const deltaY = touch.clientY - (edgeSwipeStartY ?? touch.clientY)
    if (Math.abs(deltaY) > Math.abs(deltaX)) {
      return
    }
    if (deltaX > EDGE_SWIPE_OPEN_THRESHOLD_PX) {
      edgeSwipeTriggered = true
      drawerOpen = true
      mobileDrawer?.open()
    }
  }
  const handleEdgeSwipeReset = () => {
    edgeSwipeStartX = null
    edgeSwipeStartY = null
    edgeSwipeTriggered = false
  }
  if (isMobileShell) {
    workspaceEl.addEventListener('touchstart', handleEdgeSwipeStart, {
      passive: true,
    })
    workspaceEl.addEventListener('touchmove', handleEdgeSwipeMove, {
      passive: true,
    })
    workspaceEl.addEventListener('touchend', handleEdgeSwipeReset, {
      passive: true,
    })
    workspaceEl.addEventListener('touchcancel', handleEdgeSwipeReset, {
      passive: true,
    })
  }

  return {
    appContainerEl,
    horizontalMainContainerEl,
    workspaceEl,
    statusBarEl,
    mobileNavbarEl: mobileNavbar?.containerEl ?? document.createElement('div'),
    mobileToolbarSpacerEl:
      mobileToolbar?.spacerEl ?? document.createElement('div'),
    mobileToolbarEl: mobileToolbar?.wrapperEl ?? document.createElement('div'),
    leftLeafContentEl: leftSplit.leafContentEl,
    leftContentEl: leftSplit.contentEl,
    leftTabHeaderTitleEl: createSidedockTabTitle(
      leftSplit.tabHeaderContainerEl,
      '资源管理器',
    ),
    centerLeafContentEl: rootSplit.leafContentEl,
    centerContentEl: rootSplit.contentEl,
    rightLeafContentEl: rightSplit.leafContentEl,
    rightContentEl: rightSplit.contentEl,
    rightTabHeaderTitleEl: createSidedockTabTitle(
      rightSplit.tabHeaderContainerEl,
      '文件预览',
    ),
    centerNavButtonsEl: rootSplit.navButtonsEl,
    tabsInnerEl: rootSplit.tabsInnerEl,
    leftRibbonActionsEl,
    leftRibbonSettingsEl,
    leftRibbonFilesButtonEl: leftRibbonFilesButton,
    leftRibbonHistoryButtonEl: leftRibbonHistoryButton,
    rightRibbonEl: rightRibbon.ribbonEl,
    rightHeaderTitleParentEl: rightSplit.titleParentEl,
    rightHeaderTitleEl: rightSplit.titleEl,
    rightHeaderActionsEl: rightSplit.actionsEl,
    centerTabsContainerEl: rootSplit.tabsContainerEl,
    centerNewTabButtonEl: rootSplit.newTabButtonEl,
    centerTabListButtonEl: rootSplit.tabListButtonEl,
    centerTopBarTitleEl,
    setLeftVisible,
    setRightVisible,
    mobileDrawer,
    destroy: () => {
      workspaceEl.removeEventListener('touchstart', handleEdgeSwipeStart)
      workspaceEl.removeEventListener('touchmove', handleEdgeSwipeMove)
      workspaceEl.removeEventListener('touchend', handleEdgeSwipeReset)
      workspaceEl.removeEventListener('touchcancel', handleEdgeSwipeReset)
      mobileDrawer?.destroy()
      mobileHamburgerEl?.remove()
      bodyLifecycle.destroy()
      appContainerEl.remove()
    },
  }
}
