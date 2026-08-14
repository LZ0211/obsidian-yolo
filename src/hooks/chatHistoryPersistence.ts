import type { ConversationOverrideSettings } from '../types/conversation-settings.types'

export const shouldSkipCreatingEmptyConversation = (
  messageCount: number,
  hasExistingConversation: boolean,
  overrides: ConversationOverrideSettings | null | undefined,
): boolean =>
  messageCount === 0 && !hasExistingConversation && overrides == null
