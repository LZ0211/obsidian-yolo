import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const mockUseSettings = jest.fn()
const mockUseLanguage = jest.fn()
const mockObsidianSetting = jest.fn()
const mockObsidianToggle = jest.fn()

jest.mock('../../../contexts/settings-context', () => ({
  useSettings: () => mockUseSettings(),
}))

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => mockUseLanguage(),
}))

jest.mock('../../common/ObsidianSetting', () => ({
  ObsidianSetting: (props: {
    name?: string
    desc?: string
    children?: React.ReactNode
  }) => {
    mockObsidianSetting(props)
    return <section data-name={props.name}>{props.children}</section>
  },
}))

jest.mock('../../common/ObsidianDropdown', () => ({
  ObsidianDropdown: () => null,
}))

jest.mock('../../common/ObsidianTextArea', () => ({
  ObsidianTextArea: () => null,
}))

jest.mock('../../common/ObsidianTextInput', () => ({
  ObsidianTextInput: () => null,
}))

jest.mock('../../common/ObsidianToggle', () => ({
  ObsidianToggle: (props: Record<string, unknown>) => {
    mockObsidianToggle(props)
    return null
  },
}))

import { DefaultModelsAndPromptsSection } from './DefaultModelsAndPromptsSection'

const createSettings = () => ({
  chatModels: [],
  providers: [],
  chatModelId: 'chat-model',
  chatTitleModelId: 'title-model',
  memoryAgentModelId: 'memory-model',
  advancedMemoryIndexEnabled: false,
  memoryReflectionEnabled: false,
  systemPrompt: 'preserve this prompt',
  chatOptions: { chatTitlePrompt: 'preserve this title prompt' },
  continuationOptions: {
    streamFallbackRecoveryEnabled: true,
    primaryRequestTimeoutMs: 60_000,
  },
  preservedField: 'preserve this field',
})

const translations: Record<string, string> = {
  'settings.defaults.advancedMemoryIndexEnabled': 'Advanced memory index',
  'settings.defaults.advancedMemoryIndexEnabledDesc':
    'Advanced memory index description',
  'settings.defaults.memoryReflectionEnabled': 'Memory reflection',
  'settings.defaults.memoryReflectionEnabledDesc':
    'Memory reflection description',
}

describe('DefaultModelsAndPromptsSection memory settings', () => {
  beforeEach(() => {
    mockUseSettings.mockReturnValue({
      settings: createSettings(),
      setSettings: jest.fn().mockResolvedValue(undefined),
    })
    mockUseLanguage.mockReturnValue({
      language: 'en',
      t: (key: string) => translations[key] ?? key,
    })
    mockObsidianSetting.mockClear()
    mockObsidianToggle.mockClear()
  })

  it('renders advanced index and dependent reflection toggles', () => {
    renderToStaticMarkup(<DefaultModelsAndPromptsSection />)

    expect(mockObsidianSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Advanced memory index',
        desc: 'Advanced memory index description',
      }),
    )
    expect(mockObsidianSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Memory reflection',
        desc: 'Memory reflection description',
      }),
    )
    // advanced index 与 reflection 两个开关都绑定为 false（reflection 不再
    // 受 advanced 门控——master 移除了 disabled 依赖，见生产代码）。
    const toggleValues = mockObsidianToggle.mock.calls.map(
      ([props]) => props.value,
    )
    expect(toggleValues.filter((value) => value === false)).toHaveLength(2)
  })

  it('preserves unrelated settings when toggles are committed', async () => {
    const setSettings = jest.fn().mockResolvedValue(undefined)
    mockUseSettings.mockReturnValue({
      settings: createSettings(),
      setSettings,
    })
    renderToStaticMarkup(<DefaultModelsAndPromptsSection />)

    // 渲染顺序确定：advanced index 在 reflection 之前，两者 value 均为 false
    // （master 移除了 reflection 的 disabled 依赖，按顺序区分两个开关）。
    const toggles = mockObsidianToggle.mock.calls
      .map(([props]) => props)
      .filter((props) => props.value === false)
    const [advancedToggle, reflectionToggle] = toggles
    expect(advancedToggle?.onChange).toEqual(expect.any(Function))
    expect(reflectionToggle?.onChange).toEqual(expect.any(Function))

    advancedToggle?.onChange(true)
    reflectionToggle?.onChange(true)
    await Promise.resolve()

    expect(setSettings).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        advancedMemoryIndexEnabled: true,
        memoryReflectionEnabled: false,
        preservedField: 'preserve this field',
      }),
    )
    expect(setSettings).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        advancedMemoryIndexEnabled: false,
        memoryReflectionEnabled: true,
        preservedField: 'preserve this field',
      }),
    )
  })
})
