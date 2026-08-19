import type { MemoryRecallTarget } from './memoryRecallTarget'

export type MemorySector =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'emotional'
  | 'reflective'

export type MemoryPartition = Readonly<{
  scope: 'global' | 'assistant'
  assistantId: string | null
  partitionKey: string
}>

export type MemoryAgentEntry = {
  id: string
  content: string
  keywords: string[]
  category: 'profile' | 'preferences' | 'other'
  scope: 'global' | 'assistant'
  memoryKey?: string
  sector?: MemorySector
  contentHash?: string
  salience?: number
  lastRecalledAt?: number | null
  sourceFingerprint?: string
}

export type MemorySourceEntry = Readonly<{
  localId: string
  content: string
  keywords: readonly string[]
  category: MemoryAgentEntry['category']
  partition: MemoryPartition
  sourcePath: string
  entryFingerprint: string
  /** Why this memory matters / when to apply it (md `<!-- reason: -->` annotation). */
  reason?: string
}>

export type MemoryIndexQuery = Readonly<{
  partition: MemoryPartition
  sourceFileFingerprint: string
  target: MemoryRecallTarget
  memoryKeys?: readonly string[]
  maxEntries: number
  maxChars: number
}>

export type IndexedMemoryEntry = MemoryAgentEntry &
  Readonly<{
    memoryKey: string
    sector: MemorySector
    contentHash: string
    salience: number
    lastRecalledAt: number | null
    /** When the reinforcement window last opened (or null: never reinforced). */
    lastReinforcedAt: number | null
    sourceFingerprint: string
  }>

/**
 * Final render outcome of the token packer (C1+C2). `content` is null when
 * nothing could be rendered (empty candidate list, or the XML wrapper alone
 * exceeds the token budget).
 */
export type MemoryRecallRenderResult = Readonly<{
  content: string | null
  tokenCount: number
  selectedCount: number
  truncatedCount: number
  omittedCount: number
}>
