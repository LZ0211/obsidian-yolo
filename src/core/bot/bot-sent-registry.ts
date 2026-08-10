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
  sentAt: number
}

export type BotSentMessageRegistryOptions = {
  capacity?: number
  ttlMs?: number
}

export class BotSentMessageRegistry {
  private readonly entries: BoundedTtlMap<string, BotSentMessageEntry>

  constructor(options: BotSentMessageRegistryOptions = {}) {
    this.entries = new BoundedTtlMap<string, BotSentMessageEntry>({
      capacity: options.capacity ?? DEFAULT_CAPACITY,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
    })
  }

  register(entry: BotSentMessageEntry, now: number = Date.now()): void {
    this.entries.set(entry.platformMessageId, entry, now)
  }

  /** Registers every platform message id produced by a single outgoing send. */
  registerAll(
    platformMessageIds: string[],
    sessionKey: string,
    now: number = Date.now(),
  ): void {
    for (const platformMessageId of platformMessageIds) {
      this.register({ platformMessageId, sessionKey, sentAt: now }, now)
    }
  }

  get(
    platformMessageId: string,
    now: number = Date.now(),
  ): BotSentMessageEntry | undefined {
    return this.entries.get(platformMessageId, now)
  }

  isSentByBot(platformMessageId: string, now: number = Date.now()): boolean {
    return this.entries.has(platformMessageId, now)
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}
