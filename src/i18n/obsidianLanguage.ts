import { getLanguage } from 'obsidian'

import type { Language } from './types'

/**
 * Resolve the Obsidian UI language into one of the supported YOLO locales.
 *
 * Shared by non-React host callers (scheduler, runtime bridges, notices) so the
 * resolution rule lives in one place instead of being duplicated per module.
 */
export function resolveObsidianLanguage(): Language {
  const rawLanguage = String(getLanguage() ?? '')
    .trim()
    .toLowerCase()
  if (rawLanguage.startsWith('zh')) return 'zh'
  if (rawLanguage.startsWith('it')) return 'it'
  return 'en'
}
