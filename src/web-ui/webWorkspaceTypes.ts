import type { ReactNode } from 'react'

import type { WebVaultListItem } from '../runtime/web/WebApiClient'

export type NormalizedVaultPath = string

export type WebSortKey = 'name' | 'modified' | 'size' | 'type'
export type WebSortDirection = 'asc' | 'desc'

export type WebPreviewSource =
  | 'file-tree'
  | 'cite'
  | 'search'
  | 'fs_search'
  | 'meta_search'

export type WebPreviewKind =
  | 'auto'
  | 'markdown'
  | 'text'
  | 'image'
  | 'pdf'
  | 'unsupported'

export type WebPreviewTarget = {
  path: NormalizedVaultPath
  source: WebPreviewSource
  kind?: WebPreviewKind
}

export type WebPreviewLoadState =
  | { status: 'idle' }
  | { status: 'loading'; target: WebPreviewTarget }
  | { status: 'unavailable'; title: string; message: string }
  | {
      status: 'ready'
      target: WebPreviewTarget
      kind: 'markdown' | 'text' | 'image' | 'pdf'
      content: string | Blob
      item?: WebVaultListItem
    }
  | {
      status: 'unsupported'
      target: WebPreviewTarget
      message: string
      item?: WebVaultListItem
    }
  | { status: 'forbidden'; target: WebPreviewTarget }
  | { status: 'not_found'; target: WebPreviewTarget }
  | { status: 'deleted'; target: WebPreviewTarget }
  | {
      status: 'too_large'
      target: WebPreviewTarget
      size?: number
      item?: WebVaultListItem
    }
  | { status: 'error'; target: WebPreviewTarget; message: string }

export type WebShellStatus = 'loading' | 'setup' | 'login' | 'ready' | 'error'

export type WebTreeLoadState =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'refreshing' }
  | { status: 'empty' }
  | { status: 'error'; message: string }

export type WebSearchState = {
  query: string
  submittedQuery: string
  items: WebVaultListItem[]
  nextCursor: string | null
  hasMore: boolean
  loading: boolean
  error: string | null
}

export type WebFileDialogState =
  | { type: 'move'; item: WebVaultListItem }
  | { type: 'delete'; item: WebVaultListItem }
  | null

export type WebInlineRenameState = {
  item: WebVaultListItem
  initialName: string
} | null

export type WebContextMenuState = {
  item: WebVaultListItem
  x: number
  y: number
} | null

export type WebPaneFrameProps = {
  type: 'file-explorer' | 'yolo-chat' | 'web-preview'
  title: string
  parentTitle?: ReactNode
  navButtons?: ReactNode
  actions?: ReactNode
  className?: string
  children: ReactNode
}
