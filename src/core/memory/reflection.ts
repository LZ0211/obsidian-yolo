import { sha256Hex } from '../../utils/common/content-hash'

import type { MemoryPartition, MemorySector } from './memoryTypes'

export const MEMORY_REFLECTION_PROMPT_VERSION = 'memory-reflection-v1'
export const MEMORY_REFLECTION_MIN_SOURCE_COUNT = 31
export const MEMORY_REFLECTION_INTERVAL_MS = 24 * 60 * 60 * 1000
export const MAX_REFLECTION_SECTOR_GROUPS = 3
export const MAX_REFLECTION_SOURCES_PER_GROUP = 4
export const MAX_REFLECTION_SOURCES = 12
export const MAX_REFLECTION_SOURCE_CHARS = 6000
export const MAX_REFLECTION_CONTENT_CHARS = 512
export const MAX_REFLECTION_PROMPT_CHARS = 8192
export const DEFAULT_REFLECTION_TIMEOUT_MS = 30_000

type ReflectionSourceSector = Exclude<MemorySector, 'reflective'>

export type MemoryReflectionSource = Readonly<{
  memoryKey: string
  content: string
  sector: ReflectionSourceSector
  salience: number
  updatedAt: number
  entryFingerprint: string
}>

export type MemoryReflectionOutput = Readonly<{
  content: string
  sector: 'reflective'
  sourceKeys: readonly string[]
}>

export type MemoryReflectionIdentity = Readonly<{
  reflectionId: string
  sourceFingerprint: string
  promptVersion: typeof MEMORY_REFLECTION_PROMPT_VERSION
}>

const compareSources = (
  left: MemoryReflectionSource,
  right: MemoryReflectionSource,
): number =>
  right.salience - left.salience ||
  right.updatedAt - left.updatedAt ||
  left.memoryKey.localeCompare(right.memoryKey)

export const shouldRunMemoryReflection = ({
  partition,
  sourceCount,
  lastReflectionAt,
  nowMs,
}: {
  partition: MemoryPartition
  sourceCount: number
  lastReflectionAt: number | null
  nowMs: number
}): boolean =>
  partition.scope === 'global' &&
  partition.assistantId === null &&
  partition.partitionKey === 'global' &&
  sourceCount >= MEMORY_REFLECTION_MIN_SOURCE_COUNT &&
  (lastReflectionAt === null ||
    nowMs - lastReflectionAt >= MEMORY_REFLECTION_INTERVAL_MS)

export function selectMemoryReflectionSources(
  sources: readonly MemoryReflectionSource[],
): MemoryReflectionSource[] {
  const grouped = new Map<ReflectionSourceSector, MemoryReflectionSource[]>()
  for (const source of sources) {
    if (!source.content || !source.memoryKey || !source.entryFingerprint)
      continue
    const sectorSources = grouped.get(source.sector) ?? []
    sectorSources.push(source)
    grouped.set(source.sector, sectorSources)
  }
  const selectedGroups = [...grouped.values()]
    .map((items) => items.sort(compareSources))
    .sort((left, right) => compareSources(left[0], right[0]))
    .slice(0, MAX_REFLECTION_SECTOR_GROUPS)
  const candidates = selectedGroups
    .flatMap((items) => items.slice(0, MAX_REFLECTION_SOURCES_PER_GROUP))
    .sort(compareSources)
  const selected: MemoryReflectionSource[] = []
  let sourceChars = 0
  for (const candidate of candidates) {
    if (selected.length >= MAX_REFLECTION_SOURCES) break
    if (sourceChars + candidate.content.length > MAX_REFLECTION_SOURCE_CHARS)
      continue
    selected.push(candidate)
    sourceChars += candidate.content.length
  }
  return selected
}

const promptHeader = `Memory reflection protocol ${MEMORY_REFLECTION_PROMPT_VERSION}.
Derive one durable user insight only from the bounded source memories below.
Return exactly one JSON object with only these fields:
{"content":"non-empty text up to 512 characters","sector":"reflective","sourceKeys":["one or more exact source keys"]}
Every source key must be copied exactly from the input. Do not use markdown or prose outside JSON.

Sources:
`

const promptFooter = '\n\nReturn the strict JSON object now.'

export function buildMemoryReflectionPrompt(
  sources: readonly MemoryReflectionSource[],
): string {
  const metadata = sources.map(
    (source) =>
      `[key=${JSON.stringify(source.memoryKey)} sector=${source.sector} salience=${source.salience.toFixed(3)} updatedAt=${source.updatedAt}]\n`,
  )
  const fixedChars =
    promptHeader.length +
    promptFooter.length +
    metadata.reduce((total, value) => total + value.length + 1, 0)
  if (fixedChars > MAX_REFLECTION_PROMPT_CHARS) {
    throw new Error('Memory reflection prompt metadata exceeds budget')
  }
  let remaining = MAX_REFLECTION_PROMPT_CHARS - fixedChars
  const rendered = sources.map((source, index) => {
    const content = source.content.slice(0, remaining)
    remaining -= content.length
    return `${metadata[index]}${content}`
  })
  return `${promptHeader}${rendered.join('\n')}${promptFooter}`
}

export function parseMemoryReflectionOutput(
  content: string,
  allowedSourceKeys: readonly string[],
): MemoryReflectionOutput | null {
  let decoded: unknown
  try {
    decoded = JSON.parse(content)
  } catch {
    return null
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded))
    return null
  const value = decoded as Record<string, unknown>
  const keys = Object.keys(value).sort()
  if (
    keys.length !== 3 ||
    keys[0] !== 'content' ||
    keys[1] !== 'sector' ||
    keys[2] !== 'sourceKeys'
  )
    return null
  if (typeof value.content !== 'string') return null
  const reflectionContent = value.content.trim()
  if (
    !reflectionContent ||
    value.content.length > MAX_REFLECTION_CONTENT_CHARS ||
    value.sector !== 'reflective' ||
    !Array.isArray(value.sourceKeys) ||
    value.sourceKeys.length === 0
  )
    return null
  const allowed = new Set(allowedSourceKeys)
  const sourceKeys: string[] = []
  for (const sourceKey of value.sourceKeys) {
    if (
      typeof sourceKey !== 'string' ||
      !sourceKey ||
      !allowed.has(sourceKey) ||
      sourceKeys.includes(sourceKey)
    )
      return null
    sourceKeys.push(sourceKey)
  }
  return {
    content: reflectionContent,
    sector: 'reflective',
    sourceKeys,
  }
}

export async function buildMemoryReflectionIdentity(
  partitionKey: string,
  sources: readonly MemoryReflectionSource[],
): Promise<MemoryReflectionIdentity> {
  const sourceDescriptors = sources
    .map(({ memoryKey, entryFingerprint }) => ({
      memoryKey,
      entryFingerprint,
    }))
    .sort((left, right) => left.memoryKey.localeCompare(right.memoryKey))
  const sourceFingerprint = await sha256Hex(JSON.stringify(sourceDescriptors))
  const reflectionId = await sha256Hex(
    JSON.stringify({
      partitionKey,
      sourceKeys: sourceDescriptors.map(({ memoryKey }) => memoryKey),
      sourceFingerprints: sourceDescriptors.map(
        ({ entryFingerprint }) => entryFingerprint,
      ),
      promptVersion: MEMORY_REFLECTION_PROMPT_VERSION,
    }),
  )
  return {
    reflectionId,
    sourceFingerprint,
    promptVersion: MEMORY_REFLECTION_PROMPT_VERSION,
  }
}

export async function runMemoryReflectionModel(
  runner: (prompt: string, signal: AbortSignal) => Promise<string>,
  prompt: string,
  timeoutMs = DEFAULT_REFLECTION_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  if (signal?.aborted) throw new Error('Memory reflection model aborted')
  const controller = new AbortController()
  let timeout: ReturnType<typeof setTimeout> | undefined
  let removeAbortListener: (() => void) | undefined
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => {
        controller.abort()
        reject(new Error('Memory reflection model timed out'))
      },
      Math.max(1, Math.trunc(timeoutMs)),
    )
  })
  const abortPromise = new Promise<never>((_resolve, reject) => {
    if (!signal) return
    const abort = (): void => {
      controller.abort()
      reject(new Error('Memory reflection model aborted'))
    }
    signal.addEventListener('abort', abort, { once: true })
    removeAbortListener = () => signal.removeEventListener('abort', abort)
    if (signal.aborted) abort()
  })
  try {
    return await Promise.race([
      runner(prompt, controller.signal),
      timeoutPromise,
      abortPromise,
    ])
  } finally {
    if (timeout !== undefined) clearTimeout(timeout)
    removeAbortListener?.()
  }
}
