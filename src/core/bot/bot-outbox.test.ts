import { BotOutbox, buildBotOutboxId } from './bot-outbox'

const baseParams = {
  conversationId: 'conv-1',
  sourceUserMessageId: 'msg-1',
  sessionKey: 'telegram:private:123',
  content: { text: 'hello' },
}

describe('buildBotOutboxId', () => {
  it('joins conversationId/sourceUserMessageId/sessionKey with colons', () => {
    expect(
      buildBotOutboxId({
        conversationId: 'conv-1',
        sourceUserMessageId: 'msg-1',
        sessionKey: 'telegram:private:123',
      }),
    ).toBe('conv-1:msg-1:telegram:private:123')
  })
})

describe('BotOutbox', () => {
  it('creates a pending record', () => {
    const outbox = new BotOutbox()
    const record = outbox.createPending(baseParams)
    expect(record.status).toBe('pending')
    expect(record.id).toBe(buildBotOutboxId(baseParams))
    expect(outbox.get(record.id)).toEqual(record)
  })

  it('createPending is idempotent for the same id', () => {
    const outbox = new BotOutbox()
    const first = outbox.createPending(baseParams)
    const second = outbox.createPending(baseParams)
    expect(second).toEqual(first)
  })

  it('transitions pending -> sending -> sent', () => {
    const outbox = new BotOutbox()
    const record = outbox.createPending(baseParams)
    outbox.markSending(record.id)
    expect(outbox.get(record.id)?.status).toBe('sending')

    outbox.markSent(record.id, ['platform-msg-1'])
    const sent = outbox.get(record.id)
    expect(sent?.status).toBe('sent')
    expect(sent?.platformMessageIds).toEqual(['platform-msg-1'])
    expect(outbox.isSent(record.id)).toBe(true)
  })

  it('markFailed records the error and status', () => {
    const outbox = new BotOutbox()
    const record = outbox.createPending(baseParams)
    outbox.markFailed(record.id, 'network error')
    const failed = outbox.get(record.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.error).toBe('network error')
    expect(outbox.isSent(record.id)).toBe(false)
  })

  it('markSkipped sets status without requiring platformMessageIds', () => {
    const outbox = new BotOutbox()
    const record = outbox.createPending(baseParams)
    outbox.markSkipped(record.id)
    expect(outbox.get(record.id)?.status).toBe('skipped')
  })

  it('updating an unknown id is a no-op that returns undefined', () => {
    const outbox = new BotOutbox()
    expect(outbox.markSending('missing')).toBeUndefined()
    expect(outbox.markSent('missing', [])).toBeUndefined()
    expect(outbox.markFailed('missing', 'x')).toBeUndefined()
    expect(outbox.markSkipped('missing')).toBeUndefined()
  })

  it('delete() and clear() remove records', () => {
    const outbox = new BotOutbox()
    const record = outbox.createPending(baseParams)
    expect(outbox.delete(record.id)).toBe(true)
    expect(outbox.get(record.id)).toBeUndefined()

    outbox.createPending(baseParams)
    outbox.clear()
    expect(outbox.get(record.id)).toBeUndefined()
  })

  it('updatedAt advances on status transitions', () => {
    const outbox = new BotOutbox()
    const record = outbox.createPending({ ...baseParams, now: 0 })
    outbox.markSending(record.id, 100)
    expect(outbox.get(record.id)?.updatedAt).toBe(100)
    expect(outbox.get(record.id)?.createdAt).toBe(0)
  })
})
