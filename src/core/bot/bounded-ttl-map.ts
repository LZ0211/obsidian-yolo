/**
 * Generic capacity + TTL bounded map.
 *
 * Eviction policy:
 * - Capacity: once `size >= capacity`, the least-recently-used entry is
 *   evicted before inserting a new key. "Recently used" is tracked via
 *   `Map`'s insertion order — `get()`/`set()` on an existing key re-insert it
 *   so it moves to the most-recently-used end.
 * - TTL: expiry is lazy — a key is only actually removed once something
 *   reads it (`get`/`has`) after its `expiresAt` has passed. There is no
 *   background sweep, keeping this usable outside of a Node timer context
 *   (mobile/browser included).
 *
 * Shared by `dedupe-store.ts` (`Map<dedupeKey, timestamp>`, capacity 10000,
 * TTL 1h) and, per the Bot Platform plan's Phase 3 (WeChat), the adapter's
 * `contextTokens` / `recentMessages` maps — both reuse this class instead of
 * duplicating eviction logic.
 */
export type BoundedTtlMapOptions = {
  /** Maximum number of live entries before LRU eviction kicks in. */
  capacity: number
  /** Time-to-live for each entry, in milliseconds. */
  ttlMs: number
}

type BoundedTtlMapEntry<V> = {
  value: V
  expiresAt: number
}

export class BoundedTtlMap<K, V> {
  private readonly capacity: number
  private readonly ttlMs: number
  private readonly store = new Map<K, BoundedTtlMapEntry<V>>()

  constructor(options: BoundedTtlMapOptions) {
    if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
      throw new Error('BoundedTtlMap: capacity must be a positive number')
    }
    if (!Number.isFinite(options.ttlMs) || options.ttlMs <= 0) {
      throw new Error('BoundedTtlMap: ttlMs must be a positive number')
    }
    this.capacity = options.capacity
    this.ttlMs = options.ttlMs
  }

  /** Number of entries currently stored, including not-yet-lazily-expired ones. */
  get size(): number {
    return this.store.size
  }

  has(key: K, now: number = Date.now()): boolean {
    return this.get(key, now) !== undefined
  }

  get(key: K, now: number = Date.now()): V | undefined {
    const entry = this.store.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= now) {
      this.store.delete(key)
      return undefined
    }
    // Refresh recency: delete + re-insert moves this key to the
    // most-recently-used end of the Map's iteration order.
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  set(key: K, value: V, now: number = Date.now()): void {
    if (this.store.has(key)) {
      this.store.delete(key)
    } else if (this.store.size >= this.capacity) {
      this.evictOldest()
    }
    this.store.set(key, { value, expiresAt: now + this.ttlMs })
  }

  delete(key: K): boolean {
    return this.store.delete(key)
  }

  clear(): void {
    this.store.clear()
  }

  private evictOldest(): void {
    const next = this.store.keys().next()
    if (!next.done) {
      this.store.delete(next.value)
    }
  }
}
