import {
  ConversationMutationQueue,
  conversationMutationQueue,
  shouldSkipCreatingEmptyConversation,
} from './chatHistoryPersistence'

describe('empty conversation persistence', () => {
  it('keeps a metadata-only empty conversation when overrides are meaningful', () => {
    expect(
      shouldSkipCreatingEmptyConversation(0, false, {
        workingDirectory: '/Projects/demo',
      }),
    ).toBe(false)
  })

  it('skips an untouched empty conversation', () => {
    expect(shouldSkipCreatingEmptyConversation(0, false, null)).toBe(true)
  })
})

describe('ConversationMutationQueue', () => {
  it('shares deletion invalidation across independent hook consumers', async () => {
    const firstConsumer = conversationMutationQueue
    const secondConsumer = conversationMutationQueue
    const conversationId = 'cross-window-conversation'
    const events: string[] = []
    const staleSaveGeneration = firstConsumer.captureGeneration(conversationId)

    const deleteGeneration = secondConsumer.invalidate(conversationId)
    await secondConsumer.enqueue(conversationId, deleteGeneration, async () => {
      events.push('delete')
    })
    await firstConsumer.enqueue(conversationId, staleSaveGeneration, async () => {
      events.push('save')
    })

    expect(events).toEqual(['delete'])
  })

  it('discards a delayed save captured before deletion', async () => {
    const queue = new ConversationMutationQueue()
    const events: string[] = []
    const staleSaveGeneration = queue.captureGeneration('conversation-1')

    const deleteGeneration = queue.invalidate('conversation-1')
    await queue.enqueue('conversation-1', deleteGeneration, async () => {
      events.push('delete')
    })
    await queue.enqueue('conversation-1', staleSaveGeneration, async () => {
      events.push('save')
    })

    expect(events).toEqual(['delete'])
  })

  it('runs deletion after a save that was already executing', async () => {
    const queue = new ConversationMutationQueue()
    const events: string[] = []
    let releaseSave: (() => void) | undefined
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve
    })
    const saveGeneration = queue.captureGeneration('conversation-1')
    const save = queue.enqueue('conversation-1', saveGeneration, async () => {
      events.push('save-start')
      await saveGate
      events.push('save-end')
    })
    await Promise.resolve()

    const deleteGeneration = queue.invalidate('conversation-1')
    const deletion = queue.enqueue(
      'conversation-1',
      deleteGeneration,
      async () => {
        events.push('delete')
      },
    )
    releaseSave?.()
    await Promise.all([save, deletion])

    expect(events).toEqual(['save-start', 'save-end', 'delete'])
  })
})
