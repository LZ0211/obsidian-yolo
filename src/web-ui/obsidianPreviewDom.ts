/* eslint-disable @typescript-eslint/no-unused-vars -- backup 逐字节拷贝：未用 import 保留 */
/* eslint-disable @typescript-eslint/no-base-to-string -- backup 逐字节拷贝：content 联合类型仅文本路径 String() 化，对象分支不可达 */
/* eslint-disable no-alert -- web 运行时使用浏览器原生 confirm */
import React from 'react'
import { type Root, createRoot } from 'react-dom/client'

import {
  createDiv,
  createEl,
  createSpan,
} from '../runtime/web/obsidianDomCompat'
import type {
  WebApiClient,
  WebVaultListItem,
} from '../runtime/web/WebApiClient'

import { hasActiveContent } from './preview/htmlPreview'
import { WebPreviewRoot } from './preview/WebPreviewRoot'
import type { WebPreviewLoadState, WebPreviewTarget } from './webWorkspaceTypes'
import {
  classifyPreviewKind,
  classifyPreviewKindByPath,
  formatFileSize,
  getBaseName,
  getParentPath,
  normalizeVaultPath,
  toUserMessage,
} from './webWorkspaceUtils'

const TEXT_PREVIEW_LIMIT = 20000

export function createObsidianPreviewPane(
  parentEl: HTMLElement,
  client: WebApiClient,
  options?: {
    titleParentEl?: HTMLElement
    titleEl?: HTMLElement
    actionsEl?: HTMLElement
  },
): {
  contentEl: HTMLElement
  openPreview: (
    target: WebPreviewTarget,
    item?: WebVaultListItem | null,
  ) => void
  showDeleted: (target: WebPreviewTarget) => void
  showUnavailable: (title: string, message: string) => void
  destroy: () => void
} {
  let objectUrl: string | null = null
  let currentTarget: WebPreviewTarget | null = null
  let previewRequestId = 0
  let reactRoot: Root | null = null
  let reactHost: HTMLElement | null = null
  let htmlMode: 'source' | 'rendered' = 'source'
  let htmlIframeObjectUrl: string | null = null

  parentEl.empty()
  const titleParentEl =
    options?.titleParentEl ?? createDiv(parentEl, 'view-header-title-parent')
  const titleEl = options?.titleEl ?? createDiv(parentEl, 'view-header-title')
  const actionsEl = options?.actionsEl ?? createDiv(parentEl, 'view-actions')
  // A dedicated child (not parentEl itself) so this pane owns its own
  // scroll/flex contract independent of whatever the host element is —
  // the desktop right sidedock's .view-content vs. the mobile drawer's
  // shared .yolo-mobile-drawer-slot (which must stay overflow:hidden so its
  // sticky header contract elsewhere isn't affected).
  const contentEl = createDiv(parentEl, 'yolo-web-preview-pane')

  setState({ status: 'idle' })

  function revokeObjectUrl(): void {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl)
      objectUrl = null
    }
  }

  function setState(state: WebPreviewLoadState): void {
    // Detach React host before emptying contentEl so React's DOM is not wiped
    // behind React's back. It will be re-attached if the new state needs it.
    if (reactHost && reactHost.parentNode) {
      reactHost.parentNode.removeChild(reactHost)
    }
    revokeObjectUrl()
    contentEl.empty()
    titleParentEl.empty()
    actionsEl.empty()

    const title =
      'target' in state && state.target
        ? getBaseName(state.target.path)
        : 'title' in state && typeof state.title === 'string'
          ? state.title
          : '预览'
    titleEl.setText(title)

    if ('target' in state && state.target) {
      const parent = getParentPath(state.target.path)
      if (parent) {
        const parts = parent.split('/')
        for (let i = 0; i < parts.length; i++) {
          createEl(titleParentEl, 'span', {
            text: parts[i],
            cls: 'view-header-breadcrumb',
          })
          if (i < parts.length - 1) {
            createEl(titleParentEl, 'span', {
              text: '/',
              cls: 'view-header-breadcrumb-separator',
            })
          }
        }
      }
    }

    if ('target' in state && state.target) {
      const downloadBtn = createEl(actionsEl, 'button', { text: '下载' })
      downloadBtn.addEventListener(
        'click',
        () => void downloadFile(state.target),
      )

      // HTML source/rendered toggle button
      if (state.status === 'ready' && state.kind === 'text') {
        const ext = getBaseName(state.target.path)
          .split('.')
          .pop()
          ?.toLowerCase()
        if (ext === 'html' || ext === 'htm') {
          const toggleLabel = htmlMode === 'rendered' ? '源码' : '预览'
          const toggleBtn = createEl(actionsEl, 'button', { text: toggleLabel })
          toggleBtn.addEventListener('click', () => {
            if (htmlMode === 'source') {
              void switchHtmlToRendered(String(state.content))
            } else {
              switchHtmlToSource(state)
            }
          })
        }
      }
    }

    switch (state.status) {
      case 'idle':
        renderState('请选择一个可预览的文件。')
        break

      case 'loading':
        renderState(`正在加载 ${state.target.path}…`)
        break

      case 'unavailable':
      case 'forbidden':
        renderFallback('无法访问', '当前 Web 会话无权访问该资源。')
        break

      case 'not_found':
        renderFallback('未找到', '找不到该文件。')
        break

      case 'deleted':
        renderFallback('已删除', '该文件已不存在。')
        break

      case 'too_large': {
        const sizeStr = state.size ? `（${formatFileSize(state.size)}）` : ''
        renderFallback('文件过大', `该文件过大，无法预览${sizeStr}。`, true)
        break
      }

      case 'unsupported':
        renderFallback('不支持预览', state.message, true)
        break

      case 'error':
        renderFallback('预览错误', state.message)
        break

      case 'ready': {
        if (state.kind === 'markdown' || state.kind === 'text') {
          const ext = getBaseName(state.target.path)
            .split('.')
            .pop()
            ?.toLowerCase()
          if (htmlMode === 'rendered' && (ext === 'html' || ext === 'htm')) {
            // Auto-render HTML in sandboxed iframe
            void switchHtmlToRendered(String(state.content))
            break
          }

          if (!reactHost) {
            reactHost = createDiv(contentEl, 'yolo-web-preview-react-host')
            reactRoot = createRoot(reactHost)
          } else {
            contentEl.append(reactHost)
          }
          const extension = ext
          reactRoot!.render(
            React.createElement(WebPreviewRoot, {
              kind: state.kind,
              content: String(state.content),
              extension,
              filePath: state.target.path,
              onLoadBinary: (path: string) => client.readVaultBinary(path),
              onNavigate: (path: string) =>
                void openPreview({ path, source: 'cite' }),
            }),
          )
        } else if (state.kind === 'image' && state.content instanceof Blob) {
          objectUrl = URL.createObjectURL(state.content)
          createEl(contentEl, 'img', {
            cls: 'image-embed yolo-web-preview-image',
            attr: { src: objectUrl, alt: title },
          })
        } else if (state.kind === 'pdf' && state.content instanceof Blob) {
          objectUrl = URL.createObjectURL(state.content)
          createEl(contentEl, 'iframe', {
            cls: 'pdf-embed yolo-web-preview-pdf',
            attr: { src: objectUrl, title },
          })
        }
        break
      }
    }
  }

  function renderState(message: string): void {
    const stateEl = createDiv(contentEl, 'empty-state')
    const container = createDiv(stateEl, 'empty-state-container')
    createDiv(container, 'empty-state-title', (el) => el.setText(message))
  }

  function renderFallback(
    title: string,
    message: string,
    showDownload = false,
  ): void {
    const fallback = createDiv(contentEl, 'empty-state')
    const container = createDiv(fallback, 'empty-state-container')
    createDiv(container, 'empty-state-title', (el) => el.setText(title))
    createDiv(container, 'setting-item-description', (el) =>
      el.setText(message),
    )
    if (showDownload && currentTarget) {
      const actions = createDiv(container, 'empty-state-action-list')
      const btn = createEl(actions, 'button', {
        text: '下载',
        cls: 'empty-state-action tappable',
      })
      btn.addEventListener('click', () => void downloadFile(currentTarget!))
    }
  }

  async function switchHtmlToRendered(content: string): Promise<void> {
    if (hasActiveContent(content)) {
      const confirmed = window.confirm(
        '该文件包含可执行内容（脚本/事件处理）。是否仍要在沙箱中预览？',
      )
      if (!confirmed) return
    }

    // Detach React host
    if (reactHost && reactHost.parentNode) {
      reactHost.parentNode.removeChild(reactHost)
    }

    // Use srcdoc for blob-free sandboxed rendering
    const iframe = document.createElement('iframe')
    iframe.className = 'yolo-web-html-preview-iframe'
    iframe.setAttribute('sandbox', 'allow-same-origin')
    iframe.setAttribute('srcdoc', content)
    iframe.setAttribute('title', currentTarget?.path ?? 'HTML preview')
    contentEl.append(iframe)

    htmlMode = 'rendered'
    // Rebuild actions to update toggle button label
    const ext = currentTarget
      ? getBaseName(currentTarget.path).split('.').pop()?.toLowerCase()
      : undefined
    if (ext === 'html' || ext === 'htm') {
      actionsEl.empty()
      const downloadBtn = createEl(actionsEl, 'button', { text: '下载' })
      downloadBtn.addEventListener('click', () => {
        if (currentTarget) void downloadFile(currentTarget)
      })
      const toggleBtn = createEl(actionsEl, 'button', { text: '源码' })
      toggleBtn.addEventListener('click', () => {
        switchHtmlToSource({
          status: 'ready',
          target: currentTarget!,
          kind: 'text',
          content,
          item: undefined,
        })
      })
    }
  }

  function switchHtmlToSource(state: WebPreviewLoadState): void {
    if (htmlIframeObjectUrl) {
      URL.revokeObjectURL(htmlIframeObjectUrl)
      htmlIframeObjectUrl = null
    }
    htmlMode = 'source'
    setState(state)
  }

  async function downloadFile(target: WebPreviewTarget): Promise<void> {
    try {
      const blob = await client.downloadVaultFile(target.path)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = getBaseName(target.path)
      document.body.append(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      // silently fail
    }
  }

  async function openPreview(
    target: WebPreviewTarget,
    item?: WebVaultListItem | null,
  ): Promise<void> {
    const requestId = ++previewRequestId
    // Reset HTML mode on target change (before currentTarget is updated)
    if (target.path !== currentTarget?.path) {
      const ext = getBaseName(target.path).split('.').pop()?.toLowerCase()
      htmlMode = ext === 'html' || ext === 'htm' ? 'rendered' : 'source'
      if (htmlIframeObjectUrl) {
        URL.revokeObjectURL(htmlIframeObjectUrl)
        htmlIframeObjectUrl = null
      }
    }
    currentTarget = target
    setState({ status: 'loading', target })

    try {
      const kind = item
        ? classifyPreviewKind(item)
        : target.kind && target.kind !== 'auto'
          ? target.kind
          : classifyPreviewKindByPath(target.path)

      if (kind === 'unsupported') {
        setState({
          status: 'unsupported',
          target,
          message: '该文件类型不支持预览。',
          item: item ?? undefined,
        })
        return
      }

      if (kind === 'markdown' || kind === 'text') {
        const content = await client.previewVaultText(target.path)
        if (requestId !== previewRequestId) return
        if (content.length > TEXT_PREVIEW_LIMIT) {
          setState({
            status: 'too_large',
            target,
            size: item?.stat?.size,
            item: item ?? undefined,
          })
          return
        }
        setState({
          status: 'ready',
          target,
          kind,
          content,
          item: item ?? undefined,
        })
        return
      }

      // image or pdf
      const content = await client.readVaultBinary(target.path)
      if (requestId !== previewRequestId) return
      setState({
        status: 'ready',
        target,
        kind,
        content,
        item: item ?? undefined,
      })
    } catch (err) {
      if (requestId !== previewRequestId) return
      const msg = toUserMessage(err)
      if (/not found/i.test(msg)) setState({ status: 'not_found', target })
      else if (/unavailable|forbidden/i.test(msg))
        setState({ status: 'forbidden', target })
      else setState({ status: 'error', target, message: msg })
    }
  }

  function showDeleted(target: WebPreviewTarget): void {
    currentTarget = target
    setState({ status: 'deleted', target })
  }

  function showUnavailable(title: string, message: string): void {
    setState({ status: 'unavailable', title, message })
  }

  return {
    contentEl,
    openPreview,
    showDeleted,
    showUnavailable,
    destroy: () => {
      if (reactRoot) {
        reactRoot.unmount()
        reactRoot = null
        reactHost = null
      }
      revokeObjectUrl()
      if (htmlIframeObjectUrl) {
        URL.revokeObjectURL(htmlIframeObjectUrl)
        htmlIframeObjectUrl = null
      }
    },
  }
}
