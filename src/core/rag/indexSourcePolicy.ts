import { minimatch } from 'minimatch'

import type { YoloSettingsLike } from '../../types/yoloSettingsLike'
import { normalizePathSlashes } from '../paths/normalizePath'
import { getYoloBaseDir } from '../paths/yoloPaths'

export type RagIndexSourceSettings = YoloSettingsLike & {
  ragOptions?: {
    indexPdf?: boolean
    excludeYoloBaseDir?: boolean
    excludePatterns?: readonly string[]
    includePatterns?: readonly string[]
  }
}

export function isRagIndexablePath(
  path: string,
  settings: RagIndexSourceSettings,
): boolean {
  const normalizedPath = normalizePathSlashes(path.trim())
  const lowerPath = normalizedPath.toLowerCase()
  const isMarkdown =
    lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown')
  const isPdf = lowerPath.endsWith('.pdf')
  if (!isMarkdown && !(isPdf && (settings.ragOptions?.indexPdf ?? true))) {
    return false
  }

  if (settings.ragOptions?.excludeYoloBaseDir ?? true) {
    const yoloBaseDir = getYoloBaseDir(settings)
    if (
      normalizedPath === yoloBaseDir ||
      normalizedPath.startsWith(`${yoloBaseDir}/`)
    ) {
      return false
    }
  }

  if (
    settings.ragOptions?.excludePatterns?.some((pattern) =>
      minimatch(normalizedPath, pattern),
    )
  ) {
    return false
  }

  const includePatterns = settings.ragOptions?.includePatterns ?? []
  return (
    includePatterns.length === 0 ||
    includePatterns.some((pattern) => minimatch(normalizedPath, pattern))
  )
}
