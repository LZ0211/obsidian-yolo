import type { ConversationOverrideSettings } from '../types/conversation-settings.types'

export const shouldSkipCreatingEmptyConversation = (
  messageCount: number,
  hasExistingConversation: boolean,
  overrides: ConversationOverrideSettings | null | undefined,
): boolean =>
  messageCount === 0 && !hasExistingConversation && overrides == null

export class ConversationMutationQueue {
  private readonly queues = new Map<string, Promise<unknown>>()
  private readonly generations = new Map<string, number>()

  captureGeneration(conversationId: string): number {
    return this.generations.get(conversationId) ?? 0
  }

  invalidate(conversationId: string): number {
    const generation = this.captureGeneration(conversationId) + 1
    this.generations.set(conversationId, generation)
    return generation
  }

  async enqueue(
    conversationId: string,
    generation: number,
    operation: () => Promise<void>,
  ): Promise<void> {
    const previous = this.queues.get(conversationId) ?? Promise.resolve()
    const run = async (): Promise<void> => {
      if (this.captureGeneration(conversationId) !== generation) return
      await operation()
    }
    const next = previous.then(run, run)
    this.queues.set(conversationId, next)
    try {
      await next
    } finally {
      if (this.queues.get(conversationId) === next) {
        this.queues.delete(conversationId)
      }
    }
  }
}

// Obsidian popouts create independent React trees in one JavaScript realm.
// Keep delete/save ordering process-wide so a stale save from another window
// cannot recreate a conversation deleted in the current window.
export const conversationMutationQueue = new ConversationMutationQueue()
