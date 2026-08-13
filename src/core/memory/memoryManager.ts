import { App, TFile, TFolder, normalizePath } from 'obsidian'

import { sha256Hex } from '../../utils/common/content-hash'
import { getYoloBaseDir } from '../paths/yoloPaths'

import { buildMemoryKey, buildMemoryPartition } from './memoryIndex'
import type { MemoryPartition, MemorySourceEntry } from './memoryTypes'

type AssistantLike = {
  id: string
  name?: string
  systemPrompt?: string
}

export type MemorySettingsLike = {
  advancedMemoryIndexEnabled?: boolean
  memoryReflectionEnabled?: boolean
  memoryAgentModelId?: string
  yolo?: {
    baseDir?: string
  }
  currentAssistantId?: string
  assistants?: AssistantLike[]
}

export type MemoryScope = 'global' | 'assistant'
export type MemorySourceSnapshot = Readonly<{
  partition: MemoryPartition
  sourcePath: string
  sourceFileFingerprint: string
  parserVersion: string
  entries: readonly MemorySourceEntry[]
  valid: boolean
  content?: string
}>
type MemoryCategory = 'profile' | 'preferences' | 'other'
type MemorySectionKey = 'profile' | 'preferences' | 'other'

type MemorySectionDefinition = {
  key: MemorySectionKey
  title: string
  idPrefix: string
  headingAliases: string[]
}

type MemorySectionBlock = {
  key: MemorySectionKey
  headingLineIndex: number
  startLineIndex: number
  endLineIndex: number
}

type MemoryEntryOccurrence = {
  id: string
  content: string
  keywords: string[]
  reason?: string
  lineIndex: number
  sectionKey: MemorySectionKey
}

export type MemoryPromptContext = {
  global: string | null
  assistant: string | null
}

const MEMORY_DIR_NAME = 'memory'
const GLOBAL_MEMORY_FILE_NAME = 'global.md'
const MEMORY_PARSER_VERSION = 'memory-markdown-v1'
const ENTRY_LINE_REGEX = /^\s*[-*]\s+([^:：]+)\s*[:：]\s*(.*)$/
const ENTRY_KEYWORDS_REGEX = /\s*<!--\s*keywords:\s*(.*?)\s*-->\s*$/i
const ENTRY_REASON_REGEX = /\s*<!--\s*reason:\s*(.*?)\s*-->\s*$/i
const MEMORY_MARKDOWN_ESCAPED_CHARACTERS = new Set([
  '\\',
  '`',
  '*',
  '_',
  '{',
  '}',
  '[',
  ']',
  '(',
  ')',
  '#',
  '+',
  '-',
  '.',
  '!',
  '|',
  '<',
  '>',
  '~',
])

const MEMORY_SECTIONS: MemorySectionDefinition[] = [
  {
    key: 'profile',
    title: 'User Profile',
    idPrefix: 'Profile',
    headingAliases: ['user profile', 'profile', '用户画像', '用户信息'],
  },
  {
    key: 'preferences',
    title: 'Preferences',
    idPrefix: 'Preference',
    headingAliases: ['preferences', 'preference', '偏好'],
  },
  {
    key: 'other',
    title: 'Other Memory',
    idPrefix: 'Memory',
    headingAliases: ['other memory', 'memory', 'other', '其他记忆'],
  },
]

const memoryFileLocks = new Map<string, Promise<void>>()

const normalizeMemoryCategory = (value: unknown): MemoryCategory => {
  if (typeof value !== 'string') {
    return 'other'
  }

  const normalized = value.trim().toLowerCase()
  if (normalized === 'profile' || normalized === 'user_profile') {
    return 'profile'
  }
  if (
    normalized === 'preferences' ||
    normalized === 'preference' ||
    normalized === 'user_preferences'
  ) {
    return 'preferences'
  }
  return 'other'
}

const normalizeMemoryScope = (value: unknown): MemoryScope => {
  if (typeof value !== 'string') {
    return 'assistant'
  }
  const normalized = value.trim().toLowerCase()
  return normalized === 'global' ? 'global' : 'assistant'
}

const sanitizeAssistantNameForFileName = (assistantName: string): string => {
  const normalized = assistantName
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
  return normalized.length > 0 ? normalized : 'assistant'
}

const resolveAssistantDisplayName = (assistant: AssistantLike): string => {
  const preferredName = assistant.name?.trim()
  if (preferredName) {
    return preferredName
  }
  return assistant.id
}

const getAssistantNameDuplicateIndex = ({
  settings,
  assistant,
  baseFileName,
}: {
  settings?: MemorySettingsLike
  assistant: AssistantLike
  baseFileName: string
}): number => {
  const assistants = settings?.assistants ?? []
  if (assistants.length === 0) {
    return 0
  }

  const siblings = assistants
    .filter((item) => {
      return (
        sanitizeAssistantNameForFileName(resolveAssistantDisplayName(item)) ===
        baseFileName
      )
    })
    .sort((left, right) => left.id.localeCompare(right.id))

  return Math.max(
    0,
    siblings.findIndex((item) => item.id === assistant.id),
  )
}

const getMemoryDirPath = (settings?: MemorySettingsLike): string => {
  return normalizePath(`${getYoloBaseDir(settings)}/${MEMORY_DIR_NAME}`)
}

const normalizeMemoryPath = (path: string): string => {
  return normalizePath(path.replace(/\\/gu, '/').replace(/\/+/gu, '/'))
}

const getGlobalMemoryPath = (settings?: MemorySettingsLike): string => {
  return normalizeMemoryPath(
    `${getMemoryDirPath(settings)}/${GLOBAL_MEMORY_FILE_NAME}`,
  )
}

const getAssistantById = (
  settings?: MemorySettingsLike,
  assistantId?: string,
): AssistantLike | null => {
  const targetId = assistantId ?? settings?.currentAssistantId
  if (!targetId) {
    return null
  }
  return (
    settings?.assistants?.find((assistant) => assistant.id === targetId) ?? null
  )
}

const getAssistantMemoryPath = ({
  settings,
  assistant,
}: {
  settings?: MemorySettingsLike
  assistant: AssistantLike
}): string => {
  const baseFileName = sanitizeAssistantNameForFileName(
    resolveAssistantDisplayName(assistant),
  )
  const duplicateIndex = getAssistantNameDuplicateIndex({
    settings,
    assistant,
    baseFileName,
  })
  const fileName =
    duplicateIndex === 0
      ? `${baseFileName}.md`
      : `${baseFileName} (${duplicateIndex + 1}).md`
  return normalizeMemoryPath(`${getMemoryDirPath(settings)}/${fileName}`)
}

const getSectionDefinitionByKey = (
  key: MemorySectionKey,
): MemorySectionDefinition => {
  return MEMORY_SECTIONS.find((section) => section.key === key)!
}

const renderTemplateSection = (section: MemorySectionDefinition): string[] => {
  return [`# ${section.title}`]
}

const buildMemoryTemplateContent = (): string => {
  const lines: string[] = []
  MEMORY_SECTIONS.forEach((section, index) => {
    lines.push(...renderTemplateSection(section))
    if (index < MEMORY_SECTIONS.length - 1) {
      lines.push('')
    }
  })
  return `${lines.join('\n')}\n`
}

const MEMORY_TEMPLATE_CONTENT = buildMemoryTemplateContent()

const normalizeHeading = (value: string): string => {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}

const resolveSectionKeyFromHeading = (
  heading: string,
): MemorySectionKey | null => {
  const normalizedHeading = normalizeHeading(heading)
  for (const section of MEMORY_SECTIONS) {
    if (section.headingAliases.includes(normalizedHeading)) {
      return section.key
    }
  }
  return null
}

const parseHeading = (line: string): string | null => {
  const match = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/)
  if (!match) {
    return null
  }
  return match[1]?.trim() ?? null
}

const parseSectionBlocks = (lines: string[]): MemorySectionBlock[] => {
  const recognized: Array<{ key: MemorySectionKey; lineIndex: number }> = []

  lines.forEach((line, index) => {
    const heading = parseHeading(line)
    if (!heading) {
      return
    }
    const sectionKey = resolveSectionKeyFromHeading(heading)
    if (!sectionKey) {
      return
    }
    recognized.push({ key: sectionKey, lineIndex: index })
  })

  return recognized.map((section, index) => ({
    key: section.key,
    headingLineIndex: section.lineIndex,
    startLineIndex: section.lineIndex + 1,
    endLineIndex:
      index < recognized.length - 1
        ? recognized[index + 1].lineIndex
        : lines.length,
  }))
}

const getPrimarySectionBlock = (
  blocks: MemorySectionBlock[],
  key: MemorySectionKey,
): MemorySectionBlock | null => {
  return blocks.find((block) => block.key === key) ?? null
}

const parseEntryLine = (
  line: string,
): { id: string; content: string; keywords: string[]; reason?: string } | null => {
  const match = line.match(ENTRY_LINE_REGEX)
  if (!match) {
    return null
  }
  const id = match[1]?.trim()
  if (!id) {
    return null
  }
  // Strip the trailing reason annotation first (it sits after keywords).
  const rawContent = match[2] ?? ''
  const reasonMatch = rawContent.match(ENTRY_REASON_REGEX)
  const reason = reasonMatch
    ? unescapeMemoryMarkdownValue(reasonMatch[1]?.trim() ?? '')
    : undefined
  const contentWithKeywords = reasonMatch
    ? rawContent.replace(reasonMatch[0], '')
    : rawContent
  const keywordMatch = contentWithKeywords.match(ENTRY_KEYWORDS_REGEX)
  const keywords = keywordMatch
    ? keywordMatch[1]
        .split(',')
        .map((keyword) => unescapeMemoryMarkdownValue(keyword.trim()))
        .filter(Boolean)
    : []
  const content = keywordMatch
    ? contentWithKeywords.replace(keywordMatch[0], '')
    : contentWithKeywords
  return {
    id,
    content: unescapeMemoryMarkdownValue(content).trim(),
    keywords,
    ...(reason ? { reason } : {}),
  }
}

const escapeMemoryMarkdownValue = (value: string): string => {
  let escaped = ''
  for (const character of value) {
    if (MEMORY_MARKDOWN_ESCAPED_CHARACTERS.has(character)) {
      escaped += '\\'
    }
    escaped += character
  }
  return escaped
}

const unescapeMemoryMarkdownValue = (value: string): string => {
  let unescaped = ''
  let escaped = false
  for (const character of value) {
    if (escaped) {
      unescaped += MEMORY_MARKDOWN_ESCAPED_CHARACTERS.has(character)
        ? character
        : `\\${character}`
      escaped = false
    } else if (character === '\\') {
      escaped = true
    } else {
      unescaped += character
    }
  }
  return escaped ? `${unescaped}\\` : unescaped
}

const normalizeSnapshotString = (value: string): string => {
  return value.normalize('NFC').trim()
}

const normalizeSnapshotKeywords = (keywords: readonly string[]): string[] => {
  const normalized = keywords
    .map((keyword) => normalizeSnapshotString(keyword).slice(0, 80))
    .filter(Boolean)
  return [...new Set(normalized)].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
}

const parseMemorySourceEntries = async ({
  content,
  partition,
  sourcePath,
}: {
  content: string
  partition: MemoryPartition
  sourcePath: string
}): Promise<{ entries: readonly MemorySourceEntry[]; valid: boolean }> => {
  const lines = content.split('\n')
  const blocks = parseSectionBlocks(lines)
  const entries: MemorySourceEntry[] = []
  const seenKeys = new Set<string>()
  const seenSectionKeys = new Set<MemorySectionKey>()
  let valid = true

  for (const block of blocks) {
    if (seenSectionKeys.has(block.key)) {
      valid = false
    }
    seenSectionKeys.add(block.key)

    for (
      let lineIndex = block.startLineIndex;
      lineIndex < block.endLineIndex;
      lineIndex += 1
    ) {
      const line = lines[lineIndex] ?? ''
      const parsed = parseEntryLine(line)
      if (!parsed) {
        if (/^\s*[-*]\s+/u.test(line)) {
          valid = false
        }
        continue
      }

      const localId = normalizeSnapshotString(parsed.id)
      const entryContent = normalizeSnapshotString(parsed.content)
      const keywords = normalizeSnapshotKeywords(parsed.keywords)
      if (!localId || !entryContent) {
        valid = false
        continue
      }

      const memoryKey = buildMemoryKey(partition.partitionKey, localId)
      if (seenKeys.has(memoryKey)) {
        valid = false
      }
      seenKeys.add(memoryKey)

      const category = block.key
      const entryFingerprint = await sha256Hex(
        JSON.stringify({
          partitionKey: normalizeSnapshotString(partition.partitionKey),
          localId,
          category,
          content: entryContent,
          keywords,
        }),
      )
      entries.push({
        localId,
        content: entryContent,
        keywords,
        category,
        partition,
        sourcePath,
        entryFingerprint,
        ...(parsed.reason ? { reason: parsed.reason } : {}),
      })
    }
  }

  return { entries, valid }
}

const getEntryOccurrencesInBlock = ({
  lines,
  block,
}: {
  lines: string[]
  block: MemorySectionBlock
}): MemoryEntryOccurrence[] => {
  const entries: MemoryEntryOccurrence[] = []
  for (
    let index = block.startLineIndex;
    index < block.endLineIndex;
    index += 1
  ) {
    const parsed = parseEntryLine(lines[index] ?? '')
    if (!parsed) {
      continue
    }
    entries.push({
      id: parsed.id,
      content: parsed.content,
      keywords: parsed.keywords,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
      lineIndex: index,
      sectionKey: block.key,
    })
  }
  return entries
}

const findEntryOccurrenceById = ({
  lines,
  blocks,
  id,
}: {
  lines: string[]
  blocks: MemorySectionBlock[]
  id: string
}): MemoryEntryOccurrence | null => {
  const matches = blocks
    .flatMap((block) => getEntryOccurrencesInBlock({ lines, block }))
    .filter((entry) => entry.id === id)

  if (matches.length > 1) {
    throw new Error(`Memory id duplicated: ${id}`)
  }

  return matches[0] ?? null
}

const getNextMemoryId = ({
  lines,
  blocks,
  sectionKey,
}: {
  lines: string[]
  blocks: MemorySectionBlock[]
  sectionKey: MemorySectionKey
}): string => {
  const section = getSectionDefinitionByKey(sectionKey)
  const pattern = new RegExp(`^${section.idPrefix}_(\\d+)$`)
  const maxIndex = blocks
    .filter((block) => block.key === sectionKey)
    .flatMap((block) => getEntryOccurrencesInBlock({ lines, block }))
    .reduce((currentMax, entry) => {
      const match = entry.id.match(pattern)
      if (!match) {
        return currentMax
      }
      const parsedIndex = Number.parseInt(match[1] ?? '0', 10)
      return Number.isFinite(parsedIndex) && parsedIndex > currentMax
        ? parsedIndex
        : currentMax
    }, 0)

  return `${section.idPrefix}_${maxIndex + 1}`
}

const ensureDirectoryPathExists = async ({
  app,
  path,
}: {
  app: App
  path: string
}): Promise<void> => {
  const segments = normalizePath(path)
    .split('/')
    .filter((segment) => segment.length > 0)

  let currentPath = ''
  for (const segment of segments) {
    currentPath = currentPath.length > 0 ? `${currentPath}/${segment}` : segment
    const existing = app.vault.getAbstractFileByPath(currentPath)
    if (!existing) {
      await app.vault.createFolder(currentPath)
      continue
    }
    if (!(existing instanceof TFolder)) {
      throw new Error(`Path exists and is not a folder: ${currentPath}`)
    }
  }
}

const ensureMemoryFile = async ({
  app,
  filePath,
  settings,
}: {
  app: App
  filePath: string
  settings?: MemorySettingsLike
}): Promise<TFile> => {
  await ensureDirectoryPathExists({
    app,
    path: getMemoryDirPath(settings),
  })

  const existing = app.vault.getAbstractFileByPath(filePath)
  if (!existing) {
    return await app.vault.create(filePath, MEMORY_TEMPLATE_CONTENT)
  }
  if (!(existing instanceof TFile)) {
    throw new Error(`Memory file path is not a file: ${filePath}`)
  }
  return existing
}

const ensureSectionBlock = ({
  lines,
  blocks,
  sectionKey,
}: {
  lines: string[]
  blocks: MemorySectionBlock[]
  sectionKey: MemorySectionKey
}): MemorySectionBlock[] => {
  if (blocks.some((block) => block.key === sectionKey)) {
    return blocks
  }

  while (lines.length > 0 && lines[lines.length - 1].trim().length === 0) {
    lines.pop()
  }

  if (lines.length > 0) {
    lines.push('')
  }

  lines.push(...renderTemplateSection(getSectionDefinitionByKey(sectionKey)))
  return parseSectionBlocks(lines)
}

type VaultFileCacheEntry = {
  mtime: number
  value: unknown
}

// Memory and prompt files are re-read on every agent turn even though they
// rarely change. Cache the parsed result keyed by (app, purpose, path,
// mtime); Obsidian keeps file metadata fresh, so an unchanged mtime reuses
// the last read instead of hitting disk, parsing, and hashing again. `purpose`
// separates callers that cache different shapes for the same path (raw
// content vs. parsed snapshot) — sharing one slot would poison the cache.
const vaultFileReadCache = new WeakMap<
  App,
  Map<string, VaultFileCacheEntry>
>()

const readVaultFileCached = async <T>(
  app: App,
  canonicalPath: string,
  read: (content: string) => Promise<T> | T,
  purpose = 'content',
): Promise<T | null> => {
  const existing = app.vault.getAbstractFileByPath(canonicalPath)
  if (!existing || !(existing instanceof TFile)) {
    return null
  }
  const mtime = existing.stat.mtime
  let perApp = vaultFileReadCache.get(app)
  if (!perApp) {
    perApp = new Map()
    vaultFileReadCache.set(app, perApp)
  }
  const cacheKey = `${purpose}::${canonicalPath}`
  const cached = perApp.get(cacheKey)
  if (cached && cached.mtime === mtime) {
    return cached.value as T
  }
  const content = await app.vault.read(existing)
  const value = await read(content)
  perApp.set(cacheKey, { mtime, value })
  return value
}

const readMemoryContentIfExists = async ({
  app,
  filePath,
}: {
  app: App
  filePath: string
}): Promise<string | null> => {
  const content = await readVaultFileCached(
    app,
    normalizeMemoryPath(filePath),
    (value) => value,
  )
  if (content == null) return null
  const trimmed = content.trim()
  return trimmed.length > 0 ? trimmed : null
}

const resolveMemoryScope = ({
  settings,
  requestedScope,
  assistantId,
}: {
  settings?: MemorySettingsLike
  requestedScope: MemoryScope
  assistantId?: string
}): {
  scope: MemoryScope
  targetAssistantId: string | null
} => {
  if (requestedScope === 'global') {
    return {
      scope: 'global',
      targetAssistantId: null,
    }
  }

  const assistant = getAssistantById(settings, assistantId)
  if (!assistant) {
    throw new Error('Assistant not found for assistant memory scope.')
  }

  return {
    scope: 'assistant',
    targetAssistantId: assistant.id,
  }
}

const getScopeFilePath = ({
  settings,
  scope,
  assistantId,
}: {
  settings?: MemorySettingsLike
  scope: MemoryScope
  assistantId?: string
}): { path: string; scope: MemoryScope; partition: MemoryPartition } => {
  const resolved = resolveMemoryScope({
    settings,
    requestedScope: scope,
    assistantId,
  })

  if (resolved.scope === 'global') {
    return {
      path: getGlobalMemoryPath(settings),
      scope: 'global',
      partition: buildMemoryPartition({ scope: 'global' }),
    }
  }

  const assistant = getAssistantById(
    settings,
    resolved.targetAssistantId ?? undefined,
  )
  if (!assistant) {
    throw new Error('Assistant not found for assistant memory scope.')
  }

  return {
    path: getAssistantMemoryPath({
      settings,
      assistant,
    }),
    scope: 'assistant',
    partition: buildMemoryPartition({
      scope: 'assistant',
      assistantId: assistant.id,
    }),
  }
}

export const MAX_MEMORY_CONTENT_CHARS = 8_000

const normalizeMemoryContent = (value: unknown, fieldName: string): string => {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string.`)
  }
  const normalized = value
    .trim()
    .replace(/\r?\n|\r/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
  if (normalized.length === 0) {
    throw new Error(`${fieldName} cannot be empty.`)
  }
  if (
    (fieldName === 'content' || fieldName === 'new_content') &&
    normalized.length > MAX_MEMORY_CONTENT_CHARS
  ) {
    throw new Error(
      `${fieldName} exceeds the ${MAX_MEMORY_CONTENT_CHARS}-character limit.`,
    )
  }
  return normalized
}

const normalizeMemoryKeywords = (value: unknown): string[] => {
  if (!Array.isArray(value)) return []
  return [
    ...new Set(
      value
        .filter((keyword): keyword is string => typeof keyword === 'string')
        .map((keyword) => keyword.trim().slice(0, 80))
        .filter(Boolean),
    ),
  ].slice(0, 12)
}

const renderMemoryEntryLine = ({
  id,
  content,
  keywords,
  reason,
}: {
  id: string
  content: string
  keywords: string[]
  reason?: string
}): string => {
  const metadata =
    keywords.length > 0
      ? ` <!-- keywords: ${keywords.map(escapeMemoryMarkdownValue).join(', ')} -->`
      : ''
  const reasonMetadata = reason
    ? ` <!-- reason: ${escapeMemoryMarkdownValue(reason)} -->`
    : ''
  return `- ${id}: ${escapeMemoryMarkdownValue(content)}${metadata}${reasonMetadata}`
}

type MemoryWriteResult = {
  id: string
  scope: MemoryScope
  filePath: string
  skipped?: true
}

type SourceCommittedCallback = (input: {
  partition: MemoryPartition
  sourcePath: string
}) => void | Promise<void>

const notifySourceCommitted = async ({
  callback,
  partition,
  sourcePath,
}: {
  callback?: SourceCommittedCallback
  partition: MemoryPartition
  sourcePath: string
}): Promise<void> => {
  if (!callback) {
    return
  }
  try {
    await callback({ partition, sourcePath })
  } catch {
    return
  }
}

const withMemoryFileLock = async <T>({
  filePath,
  task,
}: {
  filePath: string
  task: () => Promise<T>
}): Promise<T> => {
  const previous = memoryFileLocks.get(filePath) ?? Promise.resolve()
  let releaseCurrent: () => void = () => {}
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve
  })
  const queued = previous.then(() => current)
  memoryFileLocks.set(filePath, queued)

  await previous
  try {
    return await task()
  } finally {
    releaseCurrent()
    if (memoryFileLocks.get(filePath) === queued) {
      memoryFileLocks.delete(filePath)
    }
  }
}

const writeLinesToFile = async ({
  app,
  file,
  lines,
}: {
  app: App
  file: TFile
  lines: string[]
}): Promise<void> => {
  await app.vault.modify(file, `${lines.join('\n')}\n`)
}

/**
 * Always-loaded memory budget per scope. Stays deliberately small (mempalace
 * L0-style identity, not full recall): dynamic recall still runs through the
 * SQLite index, so a long memory file no longer inflates every request.
 */
export const MAX_ALWAYS_LOADED_MEMORY_CHARS = 2000

const MEMORY_SECTION_WEIGHT: Record<MemorySectionKey, number> = {
  preferences: 0,
  profile: 1,
  other: 2,
}

const renderBoundedMemoryContext = async ({
  content,
  partition,
  maxChars,
  salienceByMemoryKey,
}: {
  content: string
  partition: MemoryPartition
  maxChars: number
  salienceByMemoryKey?: Record<string, number>
}): Promise<string> => {
  if (!content.trim()) return content
  const parsed = await parseMemorySourceEntries({
    content,
    partition,
    sourcePath: partition.partitionKey,
  })
  if (!parsed.valid || parsed.entries.length === 0) return content
  const ordered = [...parsed.entries].sort((left, right) => {
    const weightDiff =
      MEMORY_SECTION_WEIGHT[left.category] - MEMORY_SECTION_WEIGHT[right.category]
    if (weightDiff !== 0) return weightDiff
    const leftSalience =
      salienceByMemoryKey?.[buildMemoryKey(partition.partitionKey, left.localId)] ??
      0
    const rightSalience =
      salienceByMemoryKey?.[
        buildMemoryKey(partition.partitionKey, right.localId)
      ] ?? 0
    if (rightSalience !== leftSalience) return rightSalience - leftSalience
    return left.localId.localeCompare(right.localId)
  })
  const lines: string[] = []
  let budget = maxChars
  for (const entry of ordered) {
    const line = `- ${entry.localId}: ${entry.content}`
    if (lines.length > 0 && line.length > budget) break
    lines.push(line)
    budget -= line.length
  }
  return lines.join('\n')
}

export async function getMemoryPromptContext({
  app,
  settings,
  assistantId,
  maxCharsPerScope = MAX_ALWAYS_LOADED_MEMORY_CHARS,
  salienceByMemoryKey,
}: {
  app: App
  settings?: MemorySettingsLike
  assistantId?: string
  /** Character budget per scope; entries beyond it are dropped (salience-aware). */
  maxCharsPerScope?: number
  /** memoryKey (partitionKey::localId) → salience from the SQLite index. */
  salienceByMemoryKey?: Record<string, number>
}): Promise<MemoryPromptContext> {
  const globalPath = getGlobalMemoryPath(settings)
  const global = await readMemoryContentIfExists({
    app,
    filePath: globalPath,
  })
  const boundedGlobal = global
    ? await renderBoundedMemoryContext({
        content: global,
        partition: buildMemoryPartition({ scope: 'global' }),
        maxChars: maxCharsPerScope,
        salienceByMemoryKey,
      })
    : global

  const assistant = getAssistantById(settings, assistantId)
  if (!assistant) {
    return {
      global: boundedGlobal,
      assistant: null,
    }
  }

  const assistantPath = getAssistantMemoryPath({
    settings,
    assistant,
  })
  const assistantContent = await readMemoryContentIfExists({
    app,
    filePath: assistantPath,
  })
  const boundedAssistant = assistantContent
    ? await renderBoundedMemoryContext({
        content: assistantContent,
        partition: buildMemoryPartition({
          scope: 'assistant',
          assistantId: assistant.id,
        }),
        maxChars: maxCharsPerScope,
        salienceByMemoryKey,
      })
    : assistantContent

  return {
    global: boundedGlobal,
    assistant: boundedAssistant,
  }
}

/**
 * Resolve the exact memory file paths that {@link getMemoryPromptContext} would
 * read for the given assistant, mirroring its decision. Used by the system-prompt
 * snapshot fingerprint: the assistant memory path depends on sibling
 * same-named assistants (duplicate index), so adding/renaming a sibling can
 * change which file the current assistant reads — that must invalidate the
 * frozen snapshot even though the current assistant's own fields are unchanged.
 */
export const resolveMemoryFilePaths = ({
  settings,
  assistantId,
}: {
  settings?: MemorySettingsLike
  assistantId?: string
}): { global: string; assistant: string | null } => {
  const assistant = getAssistantById(settings, assistantId)
  return {
    global: getGlobalMemoryPath(settings),
    assistant: assistant
      ? getAssistantMemoryPath({ settings, assistant })
      : null,
  }
}

const readMemorySourceSnapshot = async ({
  app,
  partition,
  sourcePath,
}: {
  app: App
  partition: MemoryPartition
  sourcePath: string
}): Promise<MemorySourceSnapshot> => {
  const canonicalPath = normalizeMemoryPath(sourcePath)
  const cached = await readVaultFileCached(
    app,
    canonicalPath,
    async (content) => {
      const parsed = await parseMemorySourceEntries({
        content,
        partition,
        sourcePath: canonicalPath,
      })
      return {
        partition,
        sourcePath: canonicalPath,
        sourceFileFingerprint: await sha256Hex(content),
        parserVersion: MEMORY_PARSER_VERSION,
        entries: parsed.entries,
        valid: parsed.valid,
        content,
      }
    },
    'snapshot',
  )
  if (cached) return cached
  // No readable TFile: a missing path is a valid empty snapshot, a folder is not.
  const existing = app.vault.getAbstractFileByPath(canonicalPath)
  return {
    partition,
    sourcePath: canonicalPath,
    sourceFileFingerprint: await sha256Hex(''),
    parserVersion: MEMORY_PARSER_VERSION,
    entries: [],
    valid: existing === null,
    content: '',
  }
}

export async function loadMemorySourceSnapshot({
  app,
  settings,
  scope,
  assistantId,
}: {
  app: App
  settings?: MemorySettingsLike
  scope: MemoryScope
  assistantId?: string
}): Promise<MemorySourceSnapshot> {
  const { path, partition } = getScopeFilePath({
    settings,
    scope: normalizeMemoryScope(scope),
    assistantId,
  })
  return await readMemorySourceSnapshot({
    app,
    partition,
    sourcePath: path,
  })
}

export async function loadMemorySourceSnapshotAtPath({
  app,
  partition,
  sourcePath,
}: {
  app: App
  partition: MemoryPartition
  sourcePath: string
}): Promise<MemorySourceSnapshot> {
  return await readMemorySourceSnapshot({ app, partition, sourcePath })
}

export async function loadMemorySourceSnapshots({
  app,
  settings,
  assistantId,
}: {
  app: App
  settings?: MemorySettingsLike
  assistantId?: string
}): Promise<readonly MemorySourceSnapshot[]> {
  const global = await readMemorySourceSnapshot({
    app,
    partition: buildMemoryPartition({ scope: 'global' }),
    sourcePath: getGlobalMemoryPath(settings),
  })
  const snapshots: MemorySourceSnapshot[] = [global]
  const assistant = getAssistantById(settings, assistantId)
  if (!assistant) {
    return snapshots
  }

  snapshots.push(
    await readMemorySourceSnapshot({
      app,
      partition: buildMemoryPartition({
        scope: 'assistant',
        assistantId: assistant.id,
      }),
      sourcePath: getAssistantMemoryPath({ settings, assistant }),
    }),
  )
  return snapshots
}

export function resolveMemoryPartitionByPath({
  settings,
  path,
}: {
  settings?: MemorySettingsLike
  path: string
}): MemoryPartition | null {
  const canonicalPath = normalizeMemoryPath(path)
  if (canonicalPath === getGlobalMemoryPath(settings)) {
    return buildMemoryPartition({ scope: 'global' })
  }

  for (const assistant of settings?.assistants ?? []) {
    if (
      normalizeMemoryPath(getAssistantMemoryPath({ settings, assistant })) ===
      canonicalPath
    ) {
      return buildMemoryPartition({
        scope: 'assistant',
        assistantId: assistant.id,
      })
    }
  }
  return null
}

export async function memoryAdd({
  app,
  settings,
  content,
  keywords,
  category,
  scope,
  reason,
  assistantId,
  onInternalWrite,
  onSourceCommitted,
  shouldWrite,
}: {
  app: App
  settings?: MemorySettingsLike
  content: unknown
  keywords?: unknown
  category?: unknown
  scope?: unknown
  /** Why this memory matters / when to apply it — kept in the md source for maintenance & white-box edits. */
  reason?: unknown
  assistantId?: string
  onInternalWrite?: (path: string) => void
  onSourceCommitted?: SourceCommittedCallback
  shouldWrite?: () => boolean | Promise<boolean>
}): Promise<MemoryWriteResult> {
  const normalizedContent = normalizeMemoryContent(content, 'content')
  const normalizedKeywords = normalizeMemoryKeywords(keywords)
  const normalizedReason =
    typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 200) : undefined
  const normalizedCategory = normalizeMemoryCategory(category)
  const normalizedScope = normalizeMemoryScope(scope)
  const {
    path,
    scope: effectiveScope,
    partition,
  } = getScopeFilePath({
    settings,
    scope: normalizedScope,
    assistantId,
  })

  return await withMemoryFileLock({
    filePath: path,
    task: async () => {
      if (!((await shouldWrite?.()) ?? true)) {
        return { id: '', scope: effectiveScope, filePath: path, skipped: true }
      }
      onInternalWrite?.(path)
      const file = await ensureMemoryFile({
        app,
        filePath: path,
        settings,
      })
      const contentText = await app.vault.read(file)
      const lines = contentText.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
      }

      const sectionKey = normalizeMemoryCategory(normalizedCategory)
      let sectionBlocks = parseSectionBlocks(lines)
      sectionBlocks = ensureSectionBlock({
        lines,
        blocks: sectionBlocks,
        sectionKey,
      })

      const targetSectionBlock = getPrimarySectionBlock(
        sectionBlocks,
        sectionKey,
      )
      if (!targetSectionBlock) {
        throw new Error(`Memory section not found: ${sectionKey}`)
      }

      const id = getNextMemoryId({
        lines,
        blocks: sectionBlocks,
        sectionKey,
      })

      let insertIndex = targetSectionBlock.endLineIndex
      while (
        insertIndex > targetSectionBlock.startLineIndex &&
        lines[insertIndex - 1]?.trim() === ''
      ) {
        insertIndex -= 1
      }

      lines.splice(
        insertIndex,
        0,
        renderMemoryEntryLine({
          id,
          content: normalizedContent,
          keywords: normalizedKeywords,
          reason: normalizedReason,
        }),
      )
      if (!((await shouldWrite?.()) ?? true)) {
        return { id: '', scope: effectiveScope, filePath: path, skipped: true }
      }
      await writeLinesToFile({ app, file, lines })
      await notifySourceCommitted({
        callback: onSourceCommitted,
        partition,
        sourcePath: path,
      })

      return {
        id,
        scope: effectiveScope,
        filePath: path,
      }
    },
  })
}

export async function memoryUpdate({
  app,
  settings,
  id,
  newContent,
  keywords,
  scope,
  reason,
  assistantId,
  onInternalWrite,
  onSourceCommitted,
  shouldWrite,
}: {
  app: App
  settings?: MemorySettingsLike
  id: unknown
  newContent: unknown
  keywords?: unknown
  scope?: unknown
  reason?: unknown
  assistantId?: string
  onInternalWrite?: (path: string) => void
  onSourceCommitted?: SourceCommittedCallback
  shouldWrite?: () => boolean | Promise<boolean>
}): Promise<MemoryWriteResult> {
  const normalizedId = normalizeMemoryContent(id, 'id')
  const normalizedContent = normalizeMemoryContent(newContent, 'new_content')
  const normalizedKeywords = normalizeMemoryKeywords(keywords)
  const normalizedScope = normalizeMemoryScope(scope)
  const {
    path,
    scope: effectiveScope,
    partition,
  } = getScopeFilePath({
    settings,
    scope: normalizedScope,
    assistantId,
  })

  return await withMemoryFileLock({
    filePath: path,
    task: async () => {
      if (!((await shouldWrite?.()) ?? true)) {
        return {
          id: normalizedId,
          scope: effectiveScope,
          filePath: path,
          skipped: true,
        }
      }
      onInternalWrite?.(path)
      const file = await ensureMemoryFile({
        app,
        filePath: path,
        settings,
      })
      const contentText = await app.vault.read(file)
      const lines = contentText.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
      }

      const blocks = parseSectionBlocks(lines)
      const matchedEntry = findEntryOccurrenceById({
        lines,
        blocks,
        id: normalizedId,
      })
      if (!matchedEntry) {
        throw new Error(`Memory id not found: ${normalizedId}`)
      }

      lines[matchedEntry.lineIndex] = renderMemoryEntryLine({
        id: normalizedId,
        content: normalizedContent,
        keywords:
          keywords === undefined ? matchedEntry.keywords : normalizedKeywords,
        reason:
          reason === undefined
            ? matchedEntry.reason
            : typeof reason === 'string' && reason.trim()
              ? reason.trim().slice(0, 200)
              : undefined,
      })
      if (!((await shouldWrite?.()) ?? true)) {
        return {
          id: normalizedId,
          scope: effectiveScope,
          filePath: path,
          skipped: true,
        }
      }
      await writeLinesToFile({ app, file, lines })
      await notifySourceCommitted({
        callback: onSourceCommitted,
        partition,
        sourcePath: path,
      })

      return {
        id: normalizedId,
        scope: effectiveScope,
        filePath: path,
      }
    },
  })
}

export async function memoryDelete({
  app,
  settings,
  id,
  scope,
  assistantId,
  onInternalWrite,
  onSourceCommitted,
  shouldWrite,
}: {
  app: App
  settings?: MemorySettingsLike
  id: unknown
  scope?: unknown
  assistantId?: string
  onInternalWrite?: (path: string) => void
  onSourceCommitted?: SourceCommittedCallback
  shouldWrite?: () => boolean | Promise<boolean>
}): Promise<MemoryWriteResult> {
  const normalizedId = normalizeMemoryContent(id, 'id')
  const normalizedScope = normalizeMemoryScope(scope)
  const {
    path,
    scope: effectiveScope,
    partition,
  } = getScopeFilePath({
    settings,
    scope: normalizedScope,
    assistantId,
  })

  return await withMemoryFileLock({
    filePath: path,
    task: async () => {
      if (!((await shouldWrite?.()) ?? true)) {
        return {
          id: normalizedId,
          scope: effectiveScope,
          filePath: path,
          skipped: true,
        }
      }
      onInternalWrite?.(path)
      const file = await ensureMemoryFile({
        app,
        filePath: path,
        settings,
      })
      const contentText = await app.vault.read(file)
      const lines = contentText.split('\n')
      if (lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop()
      }

      const blocks = parseSectionBlocks(lines)
      const matchedEntry = findEntryOccurrenceById({
        lines,
        blocks,
        id: normalizedId,
      })
      if (!matchedEntry) {
        throw new Error(`Memory id not found: ${normalizedId}`)
      }

      lines.splice(matchedEntry.lineIndex, 1)
      if (!((await shouldWrite?.()) ?? true)) {
        return {
          id: normalizedId,
          scope: effectiveScope,
          filePath: path,
          skipped: true,
        }
      }
      await writeLinesToFile({ app, file, lines })
      await notifySourceCommitted({
        callback: onSourceCommitted,
        partition,
        sourcePath: path,
      })

      return {
        id: normalizedId,
        scope: effectiveScope,
        filePath: path,
      }
    },
  })
}
