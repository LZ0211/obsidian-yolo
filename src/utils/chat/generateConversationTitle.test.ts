import { markRequestErrorNonRetryable } from '../../core/ai/requestRetry'
import { executeSingleTurn } from '../../core/ai/single-turn'
import { LLMAPIKeyNotSetException } from '../../core/llm/exception'
import { getChatModelClient } from '../../core/llm/manager'
import type { ChatMessage } from '../../types/chat'

import {
  buildConversationTitleInput,
  generateConversationTitleText,
} from './generateConversationTitle'

jest.mock('../../core/llm/manager', () => ({
  getChatModelClient: jest.fn(),
}))

jest.mock('../../core/ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

describe('buildConversationTitleInput', () => {
  it('builds title input from plain prompt content', () => {
    expect(
      buildConversationTitleInput({
        role: 'user',
        id: 'u1',
        content: null,
        promptContent: 'Fix the scroll bug',
        mentionables: [],
      }),
    ).toBe('User first message:\nFix the scroll bug')
  })

  it('returns null when the user message has no signal', () => {
    expect(
      buildConversationTitleInput({
        role: 'user',
        id: 'u1',
        content: null,
        promptContent: null,
        mentionables: [],
      }),
    ).toBeNull()
  })
})

describe('generateConversationTitleText API-key fallback (A4 web 回归)', () => {
  const mockedGetChatModelClient = getChatModelClient as jest.Mock
  const mockedExecuteSingleTurn = executeSingleTurn as jest.Mock

  const settings = {
    chatTitleModelId: 'model-1',
    chatModels: [{ id: 'model-1', providerId: 'p1', model: 'm', name: 'M' }],
    chatOptions: {},
    providers: [{ id: 'p1', apiKey: '' }],
  } as never

  const userMessage: ChatMessage = {
    role: 'user',
    id: 'u1',
    content: null,
    promptContent: 'Fix the scroll bug',
    mentionables: [],
  }

  beforeEach(() => {
    mockedGetChatModelClient.mockReset()
    mockedExecuteSingleTurn.mockReset()
  })

  it('falls back to the first user message when the API key is missing', async () => {
    mockedGetChatModelClient.mockImplementation(() => {
      throw new LLMAPIKeyNotSetException('OpenAI API key is not set')
    })

    const result = await generateConversationTitleText({
      settings,
      language: 'en',
      messages: [userMessage],
    })

    expect(result).toEqual({ ok: true, title: 'Fix the scroll bug' })
    // key 缺失直接兜底，不做 LLM 调用、不重试退避
    expect(mockedExecuteSingleTurn).not.toHaveBeenCalled()
  })

  it('truncates long fallback titles with an ellipsis', async () => {
    mockedGetChatModelClient.mockImplementation(() => {
      throw new LLMAPIKeyNotSetException('OpenAI API key is not set')
    })
    const long = 'x'.repeat(60)

    const result = await generateConversationTitleText({
      settings,
      language: 'en',
      messages: [{ ...userMessage, promptContent: long }],
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.title).toBe(`${'x'.repeat(40)}…`)
      expect(result.title.length).toBe(41)
    }
  })

  it('still reports llm_generation_failed for non-key errors', async () => {
    mockedGetChatModelClient.mockImplementation(() => {
      throw markRequestErrorNonRetryable(new Error('network down'))
    })

    const result = await generateConversationTitleText({
      settings,
      language: 'en',
      messages: [userMessage],
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe('llm_generation_failed')
    }
  })
})
