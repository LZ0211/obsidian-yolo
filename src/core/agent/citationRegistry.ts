import type { ChatMessage, CitationSource } from '../../types/chat'

// Single source of truth moved to the types layer (`types/chat.ts`) to break
// the bidirectional edge chat.ts <-> citationRegistry.ts (deps ratchet).
// Re-exported for the existing consumers that imported the type from here.
export type { CitationSource }

export class CitationRegistry {
  private byKey = new Map<string, CitationSource>()
  private nextOrdinal = 1

  assign(dedupKey: string, meta: Omit<CitationSource, 'ordinal'>): number {
    const existing = this.byKey.get(dedupKey)
    if (existing) {
      return existing.ordinal
    }
    const ordinal = this.nextOrdinal
    this.nextOrdinal += 1
    this.byKey.set(dedupKey, { ...meta, ordinal })
    return ordinal
  }

  toArray(): CitationSource[] {
    return [...this.byKey.values()].sort((a, b) => a.ordinal - b.ordinal)
  }

  get size(): number {
    return this.byKey.size
  }
}

/**
 * Writes the registry's collected sources into the latest assistant message's
 * metadata (new array + new message object, never in-place mutation), so chat
 * surfaces and web citation routes render the source cards. No-op when the
 * registry is empty.
 */
export function attachSourcesToLatestAssistant(
  messages: ChatMessage[],
  registry: CitationRegistry,
): ChatMessage[] {
  if (registry.size === 0) {
    return messages
  }
  const sources = registry.toArray()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role !== 'assistant') {
      continue
    }
    const next = [...messages]
    next[index] = {
      ...message,
      metadata: {
        ...message.metadata,
        sources,
      },
    }
    return next
  }
  return messages
}
