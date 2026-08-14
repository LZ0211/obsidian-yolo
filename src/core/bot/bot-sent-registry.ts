/**
 * BotSentMessageRegistry — in-memory record of messages the bot itself sent.
 *
 * Bot Platform design doc, "BotSentMessageRegistry" section: "内存 registry，
 * 记录 bot 发出的消息，用于 isReplyToBotMessage() 和 echo 防护." Used by
 * `BotService.handleIncoming` (Incoming Flow step 4) to detect whether an
 * incoming message is a reply to something the bot sent, which feeds the
 * group-chat wakeCheck (step 6).
 *
 * Backed by `BoundedTtlMap` like `dedupe-store.ts` — sent-message history
 * only needs to be reachable for as long as a user might plausibly reply to
 * it, not forever.
 */
import { BoundedTtlMap } from './bounded-ttl-map'

const DEFAULT_CAPACITY = 10000
const DEFAULT_TTL_MS = 60 * 60 * 1000 // 1 hour — long enough to catch a delayed reply

export type BotSentMessageEntry = {
  platformMessageId: string
  sessionKey: string
  platformInstanceId?: string
  sentAt: number
}

export type BotSentMessageRegistryOptions = {
  capacity?: number
  ttlMs?: number
}

export class BotSentMessageRegistry {
  private readonly entries: BoundedTtlMap<string, BotSentMessageEntry>
  private readonly legacyEntries: BoundedTtlMap<string, BotSentMessageEntry>

  constructor(options: BotSentMessageRegistryOptions = {}) {
    const mapOptions = {
      capacity: options.capacity ?? DEFAULT_CAPACITY,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    }
    this.entries = new BoundedTtlMap<string, BotSentMessageEntry>(mapOptions)
    this.legacyEntries = new BoundedTtlMap<string, BotSentMessageEntry>(
      mapOptions,
    )
  }

  register(entry: BotSentMessageEntry, now: number = Date.now()): void {
    this.entries.set(this.keyFor(entry), entry, now)
    if (entry.platformInstanceId === undefined) {
      this.legacyEntries.set(entry.platformMessageId, entry, now)
    }
  }

  /** Registers every platform message id produced by a single outgoing send. */
  registerAll(
    platformMessageIds: string[],
    sessionKey: string,
    now: number = Date.now(),
    platformInstanceId?: string,
  ): void {
    for (const platformMessageId of platformMessageIds) {
      this.register(
        { platformMessageId, sessionKey, platformInstanceId, sentAt: now },
        now,
      )
    }
  }

  get(
    platformMessageId: string,
    now: number = Date.now(),
    sessionKey?: string,
    platformInstanceId?: string,
  ): BotSentMessageEntry | undefined {
    if (sessionKey === undefined && platformInstanceId === undefined) {
      return (
        this.entries.get(platformMessageId, now) ??
        this.legacyEntries.get(platformMessageId, now)
      )
    }
    return this.entries.get(
      this.keyFor({ platformMessageId, sessionKey, platformInstanceId }),
      now,
    )
  }

  isSentByBot(
    platformMessageId: string,
    now: number = Date.now(),
    sessionKey?: string,
    platformInstanceId?: string,
  ): boolean {
    return (
      this.get(platformMessageId, now, sessionKey, platformInstanceId) !==
      undefined
    )
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
    this.legacyEntries.clear()
  }

  private keyFor(entry: {
    platformMessageId: string
    sessionKey?: string
    platformInstanceId?: string
  }): string {
    if (
      entry.sessionKey === undefined &&
      entry.platformInstanceId === undefined
    ) {
      return entry.platformMessageId
    }
    return `${entry.platformInstanceId ?? ''}\u0000${entry.sessionKey ?? ''}\u0000${entry.platformMessageId}`
  }
}
