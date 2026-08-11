import type { WebVaultListItem } from '../runtime/web/WebApiClient'

import type {
  WebPreviewKind,
  WebSortDirection,
  WebSortKey,
} from './webWorkspaceTypes'

const TEXT_EXTENSIONS = new Set([
  'txt',
  'json',
  'csv',
  'ts',
  'tsx',
  'js',
  'jsx',
  'css',
  'xml',
  'yaml',
  'yml',
  'toml',
  'log',
  'html',
  'htm',
  'py',
  'scss',
  'less',
])

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export function normalizeVaultPath(input: string): string {
  const decoded = decodeURIComponent(input.trim())
  if (decoded === '' || decoded === '/') return ''
  if (decoded.startsWith('/')) {
    throw new Error('Invalid path: absolute paths are not allowed')
  }
  if (decoded.includes('\\')) {
    throw new Error('Invalid path: backslash separators are not allowed')
  }
  if (decoded.includes('//')) {
    throw new Error('Invalid path: empty segment is not allowed')
  }
  const parts = decoded.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error('Invalid path: traversal segments are not allowed')
  }
  return parts.join('/')
}

export function toApiFolderPath(path: string): string {
  const normalized = normalizeVaultPath(path)
  return normalized === '' ? '/' : normalized
}

export function getParentPath(path: string): string {
  const normalized = normalizeVaultPath(path)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

export function getBaseName(path: string): string {
  const normalized = normalizeVaultPath(path)
  return normalized.split('/').pop() ?? normalized
}

export function joinVaultPath(folderPath: string, name: string): string {
  const folder = normalizeVaultPath(folderPath)
  const cleanName = normalizeVaultPath(name)
  if (!cleanName || cleanName.includes('/')) {
    throw new Error('Invalid name: expected a single path segment')
  }
  return folder ? `${folder}/${cleanName}` : cleanName
}

export function isHiddenVaultPath(path: string): boolean {
  const normalized = normalizeVaultPath(path)
  return normalized.split('/').some((segment) => segment.startsWith('.'))
}

export function isVisibleVaultItem(item: WebVaultListItem): boolean {
  return !isHiddenVaultPath(item.path)
}

export function compareVaultItems(
  a: WebVaultListItem,
  b: WebVaultListItem,
  key: WebSortKey,
  direction: WebSortDirection,
): number {
  const folderOrder = a.kind === b.kind ? 0 : a.kind === 'folder' ? -1 : 1
  if (folderOrder !== 0) return folderOrder

  if (a.kind === 'folder' && b.kind === 'folder') {
    const result = a.name.localeCompare(b.name)
    return direction === 'asc' ? result : -result
  }

  let result = 0
  if (key === 'modified') {
    result = (a.stat?.mtime ?? 0) - (b.stat?.mtime ?? 0)
  } else if (key === 'size') {
    result = (a.stat?.size ?? 0) - (b.stat?.size ?? 0)
  } else if (key === 'type') {
    result = (a.extension ?? '').localeCompare(b.extension ?? '')
  } else {
    result = a.name.localeCompare(b.name)
  }
  if (result === 0 && key !== 'name') {
    result = a.name.localeCompare(b.name)
  }
  return direction === 'asc' ? result : -result
}

export function classifyPreviewKindByPath(
  path: string,
): Exclude<WebPreviewKind, 'auto'> {
  const ext = (path.split('.').pop() ?? '').toLowerCase()
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  return 'unsupported'
}

export function classifyPreviewKind(
  item: WebVaultListItem,
): Exclude<WebPreviewKind, 'auto'> {
  const extension = (
    item.extension ??
    item.path.split('.').pop() ??
    ''
  ).toLowerCase()
  if (item.kind !== 'file') return 'unsupported'
  if (extension === 'md' || extension === 'markdown') return 'markdown'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (extension === 'pdf') return 'pdf'
  return 'unsupported'
}

export function isSafeTextPreviewExtension(extension: string): boolean {
  const normalizedExtension = extension.toLowerCase()
  return (
    normalizedExtension === 'md' ||
    normalizedExtension === 'markdown' ||
    TEXT_EXTENSIONS.has(normalizedExtension)
  )
}

export function classifyPreviewType(item: WebVaultListItem): 'text' | 'binary' {
  return item.kind === 'file' &&
    isSafeTextPreviewExtension(item.extension ?? '')
    ? 'text'
    : 'binary'
}

export function applyPathMove(
  path: string,
  fromPath: string,
  toPath: string,
): string {
  const normalizedPath = normalizeVaultPath(path)
  const from = normalizeVaultPath(fromPath)
  const to = normalizeVaultPath(toPath)
  if (normalizedPath === from) return to
  if (from !== '' && normalizedPath.startsWith(`${from}/`)) {
    return to
      ? `${to}/${normalizedPath.slice(from.length + 1)}`
      : normalizedPath.slice(from.length + 1)
  }
  return normalizedPath
}

export function rewritePathSet(
  paths: ReadonlySet<string>,
  fromPath: string,
  toPath: string,
): Set<string> {
  const next = new Set<string>()
  for (const path of paths) {
    next.add(applyPathMove(path, fromPath, toPath))
  }
  return next
}

export function clearDeletedPath(
  path: string | null,
  deletedPath: string,
): string | null {
  if (!path) return null
  const normalizedPath = normalizeVaultPath(path)
  const deleted = normalizeVaultPath(deletedPath)
  if (normalizedPath === deleted) return null
  if (deleted !== '' && normalizedPath.startsWith(`${deleted}/`)) return null
  return normalizedPath
}

export function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

export function formatModifiedTime(mtime?: number): string {
  return mtime ? new Date(mtime).toLocaleDateString() : ''
}

export function toUserMessage(error: unknown): string {
  const message =
    error instanceof Error ? error.message : 'This resource is unavailable.'
  return /forbidden|denied|expired|unauthenticated|unavailable/i.test(message)
    ? 'This resource is unavailable for the current web session.'
    : message
}
