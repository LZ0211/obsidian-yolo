/**
 * Incoming-message dedupe store.
 *
 * Bot Platform implementation plan, Phase 1.3 (`dedupe-store.ts`): "LRU
 * `Map<dedupeKey, timestamp>`, TTL 1h, capacity 10000." Design doc's Incoming
 * Flow step 3 keys this by
 * `${platformName}:${sessionKey}:${threadId}:${messageId}` and checks it
 * before any other processing to guard against platform-level redelivery
 * (e.g. Telegram polling overlap, WeChat long-poll retries).
 *
 * Built directly on `BoundedTtlMap` (shared with the WeChat adapter's
 * `contextTokens`/`recentMessages` maps per the same plan section) rather
 * than duplicating capacity/TTL eviction logic.
 */
import { BoundedTtlMap } from './bounded-ttl-map'

const DEFAULT_CAPACITY = 10000
const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour

export type DedupeStoreOptions = {
  capacity?: number
  ttlMs?: number
}

export class DedupeStore {
  private readonly seen: BoundedTtlMap<string, number>

  constructor(options: DedupeStoreOptions = {}) {
    this.seen = new BoundedTtlMap<string, number>({
      capacity: options.capacity ?? DEFAULT_CAPACITY,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    })
  }

  /** True if `key` was marked seen and hasn't expired yet. */
  hasSeen(key: string, now: number = Date.now()): boolean {
    return this.seen.has(key, now)
  }

  /** Marks `key` as seen, refreshing its TTL if already present. */
  markSeen(key: string, now: number = Date.now()): void {
    this.seen.set(key, now, now)
  }

  get size(): number {
    return this.seen.size
  }

  clear(): void {
    this.seen.clear()
  }
}

/**
 * Builds the dedupe key per the design doc's Incoming Flow step 3:
 * `${platformName}:${sessionKey}:${threadId}:${messageId}`. `threadId`
 * defaults to the empty string so private chats (no thread) still produce a
 * stable, comparable key shape.
 */
export function buildDedupeKey(params: {
  platformName: string
  sessionKey: string
  threadId?: string
  messageId: string
}): string {
  return `${params.platformName}:${params.sessionKey}:${params.threadId ?? ''}:${params.messageId}`
}
