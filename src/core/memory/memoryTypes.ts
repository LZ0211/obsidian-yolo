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
}>

export type MemoryIndexQuery = Readonly<{
  partition: MemoryPartition
  sourceFileFingerprint: string
  target: MemoryRecallTarget
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
    sourceFingerprint: string
  }>
