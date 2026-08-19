jest.mock('../llm/manager', () => ({
  getChatModelClient: jest.fn(),
}))

jest.mock('./single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { ChatMessage } from '../../types/chat'
import { getChatModelClient } from '../llm/manager'

import { executeSingleTurn } from './single-turn'
import {
  buildVisionFallbackPrompt,
  describeImageViaVisionEngine,
  resolveVisionFallbackEngines,
} from './visionFallback'

const buildSettings = (
  chatModels: Array<Record<string, unknown>>,
): YoloSettings =>
  ({
    chatModels: chatModels.map((m) => ({
      id: m.id,
      providerId: 'p',
      model: m.model ?? m.id,
      enable: m.enable ?? true,
      modalities: m.modalities ?? ['text', 'vision'],
    })),
    chatOptions: {},
  }) as unknown as YoloSettings

const visionModel = (id: string, model?: string) => ({
  id,
  model: model ?? id,
  modalities: ['text', 'vision'],
})

const textModel = (id: string) => ({ id, modalities: ['text'] })

const pdfModel = (id: string) => ({
  id,
  modalities: ['text', 'vision', 'pdf'],
})

afterEach(() => {
  ;(getChatModelClient as jest.Mock).mockReset()
  ;(executeSingleTurn as jest.Mock).mockReset()
})

describe('resolveVisionFallbackEngines', () => {
  it('uses the explicit model list in order, filtering out missing and non-vision models', () => {
    const settings = buildSettings([
      visionModel('qwen-vl'),
      textModel('deepseek'),
      pdfModel('gemini'),
    ])
    settings.chatOptions.imageReadingFallbackModelIds = [
      'gemini',
      'deepseek',
      'missing',
      'qwen-vl',
    ]

    const engines = resolveVisionFallbackEngines(settings)

    expect(engines.map((m) => m.id)).toEqual(['gemini', 'qwen-vl'])
  })

  it('auto-discovers vision models when no explicit list is configured, excluding the current model', () => {
    const settings = buildSettings([
      visionModel('qwen-vl'),
      textModel('deepseek'),
      pdfModel('gemini'),
      visionModel('disabled-model', 'x'),
    ])
    // Disabled models never qualify, explicit or auto.
    settings.chatModels[3].enable = false

    const engines = resolveVisionFallbackEngines(settings, {
      excludeModelId: 'qwen-vl',
    })

    expect(engines.map((m) => m.id)).toEqual(['gemini'])
  })

  it('returns an empty list when no vision model is available', () => {
    const settings = buildSettings([textModel('deepseek')])
    settings.chatOptions.imageReadingFallbackModelIds = ['deepseek']

    expect(resolveVisionFallbackEngines(settings)).toEqual([])
  })

  it('does not throw when chatModels is missing from the settings object', () => {
    const settings = {
      chatOptions: { imageReadingFallbackModelIds: ['qwen-vl'] },
    } as unknown as YoloSettings

    expect(resolveVisionFallbackEngines(settings)).toEqual([])
  })
})

describe('buildVisionFallbackPrompt', () => {
  it('includes the last user prompt when present', () => {
    const messages = [
      { role: 'assistant', content: 'let me look' },
      { role: 'user', content: null, promptContent: '这个报错在哪里？' },
    ] as unknown as ChatMessage[]

    const prompt = buildVisionFallbackPrompt(messages)

    expect(prompt).toContain('这个报错在哪里？')
    expect(prompt).toContain('针对上述问题')
  })

  it('falls back to a generic instruction without conversation context', () => {
    const prompt = buildVisionFallbackPrompt(undefined)

    expect(prompt).toContain('描述这张图片')
    expect(prompt).not.toContain('用户当前')
  })

  it('skips user messages with empty prompt content', () => {
    const messages = [
      { role: 'user', content: null, promptContent: null },
      { role: 'user', content: null, promptContent: '' },
      { role: 'assistant', content: 'hi' },
    ] as unknown as ChatMessage[]

    const prompt = buildVisionFallbackPrompt(messages)

    expect(prompt).toContain('描述这张图片')
  })
})

describe('describeImageViaVisionEngine', () => {
  it('returns the first engine that succeeds', async () => {
    const settings = buildSettings([visionModel('qwen-vl'), pdfModel('gemini')])
    const providerClient = {}
    ;(getChatModelClient as jest.Mock).mockImplementation(
      ({ modelId }: { modelId: string }) => ({
        providerClient,
        model: settings.chatModels.find((m) => m.id === modelId),
      }),
    )
    ;(executeSingleTurn as jest.Mock)
      .mockRejectedValueOnce(new Error('quota exceeded'))
      .mockResolvedValueOnce({ content: '图中有红色报错横幅。' })

    const result = await describeImageViaVisionEngine({
      settings,
      dataUrl: 'data:image/png;base64,AAA',
      conversationMessages: [
        { role: 'user', content: null, promptContent: '报错在哪？' },
      ] as unknown as ChatMessage[],
    })

    expect(result).toEqual({
      modelId: 'gemini',
      description: '图中有红色报错横幅。',
    })
    expect(executeSingleTurn).toHaveBeenCalledTimes(2)
    expect(executeSingleTurn).toHaveBeenLastCalledWith(
      expect.objectContaining({
        model: expect.objectContaining({ id: 'gemini' }),
        request: expect.objectContaining({
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: { url: 'data:image/png;base64,AAA' },
                },
                { type: 'text', text: expect.stringContaining('报错在哪？') },
              ],
            },
          ],
        }),
      }),
    )
  })

  it('treats an empty engine response as a failure and moves on', async () => {
    const settings = buildSettings([visionModel('qwen-vl'), pdfModel('gemini')])
    ;(getChatModelClient as jest.Mock).mockImplementation(
      ({ modelId }: { modelId: string }) => ({
        providerClient: {},
        model: settings.chatModels.find((m) => m.id === modelId),
      }),
    )
    ;(executeSingleTurn as jest.Mock)
      .mockResolvedValueOnce({ content: '   ' })
      .mockResolvedValueOnce({ content: 'ok' })

    const result = await describeImageViaVisionEngine({
      settings,
      dataUrl: 'data:image/png;base64,AAA',
    })

    expect(result.modelId).toBe('gemini')
  })

  it('throws a combined error when every engine fails', async () => {
    const settings = buildSettings([visionModel('qwen-vl'), pdfModel('gemini')])
    ;(getChatModelClient as jest.Mock).mockImplementation(
      ({ modelId }: { modelId: string }) => ({
        providerClient: {},
        model: settings.chatModels.find((m) => m.id === modelId),
      }),
    )
    ;(executeSingleTurn as jest.Mock)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockRejectedValueOnce(new Error('bad request'))

    await expect(
      describeImageViaVisionEngine({
        settings,
        dataUrl: 'data:image/png;base64,AAA',
      }),
    ).rejects.toThrow(/所有视觉引擎均失败[\s\S]*qwen-vl[\s\S]*gemini/)
  })

  it('throws immediately when no engine is available', async () => {
    const settings = buildSettings([textModel('deepseek')])

    await expect(
      describeImageViaVisionEngine({
        settings,
        dataUrl: 'data:image/png;base64,AAA',
      }),
    ).rejects.toThrow(/没有可用的视觉引擎/)
    expect(executeSingleTurn).not.toHaveBeenCalled()
  })
})
