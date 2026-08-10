/**
 * BotOutbox — in-memory idempotent record of one outgoing turn.
 *
 * Bot Platform design doc, "BotOutbox" section: keyed by
 * `${conversationId}:${sourceUserMessageId}:${sessionKey}` so that a single
 * agent turn (one `sourceUserMessageId`) can only ever produce one outgoing
 * send per session, even if `BotOutputDispatcher` (Phase 5) is re-entered
 * (e.g. a duplicate `completed` event, or a retried dispatch after a
 * transient adapter error). "内存 Map，MVP 不持久化。用于: 去重 / 重试 / 状态查询"
 * — no persistence, this is process-lifetime only.
 */
import type { ReplyContent } from './types'

export type BotOutboxStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'skipped'

export type BotOutboxRecord = {
  id: string
  conversationId: string
  sourceUserMessageId: string
  sessionKey: string
  content: ReplyContent
  status: BotOutboxStatus
  platformMessageIds?: string[]
  createdAt: number
  updatedAt: number
  error?: string
}

/**
 * `${conversationId}:${sourceUserMessageId}:${sessionKey}` — matches the
 * design doc's `BotOutboxRecord.id` shape verbatim.
 */
export function buildBotOutboxId(params: {
  conversationId: string
  sourceUserMessageId: string
  sessionKey: string
}): string {
  return `${params.conversationId}:${params.sourceUserMessageId}:${params.sessionKey}`
}

export class BotOutbox {
  private readonly records = new Map<string, BotOutboxRecord>()

  /**
   * Creates a new `pending` record, or returns the existing one unchanged if
   * this exact turn+session was already registered — callers should check
   * `record.status` before proceeding so a re-entrant call doesn't send
   * twice.
   */
  createPending(params: {
    conversationId: string
    sourceUserMessageId: string
    sessionKey: string
    content: ReplyContent
    now?: number
  }): BotOutboxRecord {
    const id = buildBotOutboxId(params)
    const existing = this.records.get(id)
    if (existing) return existing

    const now = params.now ?? Date.now()
    const record: BotOutboxRecord = {
      id,
      conversationId: params.conversationId,
      sourceUserMessageId: params.sourceUserMessageId,
      sessionKey: params.sessionKey,
      content: params.content,
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    }
    this.records.set(id, record)
    return record
  }

  get(id: string): BotOutboxRecord | undefined {
    return this.records.get(id)
  }

  isSent(id: string): boolean {
    return this.records.get(id)?.status === 'sent'
  }

  markSending(
    id: string,
    now: number = Date.now(),
  ): BotOutboxRecord | undefined {
    return this.updateStatus(id, { status: 'sending' }, now)
  }

  markSent(
    id: string,
    platformMessageIds: string[],
    now: number = Date.now(),
  ): BotOutboxRecord | undefined {
    return this.updateStatus(id, { status: 'sent', platformMessageIds }, now)
  }

  markFailed(
    id: string,
    error: string,
    now: number = Date.now(),
  ): BotOutboxRecord | undefined {
    return this.updateStatus(id, { status: 'failed', error }, now)
  }

  markSkipped(
    id: string,
    now: number = Date.now(),
  ): BotOutboxRecord | undefined {
    return this.updateStatus(id, { status: 'skipped' }, now)
  }

  delete(id: string): boolean {
    return this.records.delete(id)
  }

  clear(): void {
    this.records.clear()
  }

  private updateStatus(
    id: string,
    patch: Partial<
      Pick<BotOutboxRecord, 'status' | 'platformMessageIds' | 'error'>
    >,
    now: number,
  ): BotOutboxRecord | undefined {
    const existing = this.records.get(id)
    if (!existing) return undefined
    const updated: BotOutboxRecord = { ...existing, ...patch, updatedAt: now }
    this.records.set(id, updated)
    return updated
  }
}
