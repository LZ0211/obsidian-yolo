import * as path from 'node:path'

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function getSqliteNamespaceDir(
  baseDir: string,
  namespaceId: string,
): string {
  return toDisplayPath(path.join(baseDir, 'rag', namespaceId))
}

export function getSqliteDbPath(baseDir: string, namespaceId: string): string {
  return toDisplayPath(path.join(baseDir, 'rag', namespaceId, 'rag.sqlite'))
}
