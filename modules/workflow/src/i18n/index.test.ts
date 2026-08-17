import {
  createWorkflowCopy,
  createWorkflowLocalizedText,
  en,
  it as italian,
  normalizeWorkflowLocale,
  zh,
} from './index'

describe('Workflow i18n', () => {
  it('keeps English, Chinese, and Italian leaf keys in parity', () => {
    expect(leafKeys(zh)).toEqual(leafKeys(en))
    expect(leafKeys(italian)).toEqual(leafKeys(en))
  })

  it('normalizes supported locales and falls back to English', () => {
    expect(normalizeWorkflowLocale('zh-CN')).toBe('zh')
    expect(normalizeWorkflowLocale('it-IT')).toBe('it')
    expect(normalizeWorkflowLocale('fr-FR')).toBe('en')
    expect(createWorkflowCopy('zh-CN').studio.title).toBe(
      '\u6d41\u7a0b\u5de5\u4f5c\u5ba4',
    )
    expect(createWorkflowCopy('unknown')).toBe(en)
  })

  it('creates the host localized-text payload only for module metadata', () => {
    expect(createWorkflowLocalizedText('module.name')).toEqual({
      en: 'Workflow Studio',
      zh: '\u6d41\u7a0b\u5de5\u4f5c\u5ba4',
      it: 'Studio del flusso di lavoro',
    })
    expect(createWorkflowLocalizedText('module.open')).toEqual({
      en: 'Open Workflow Studio',
      zh: '\u6253\u5f00\u6d41\u7a0b\u5de5\u4f5c\u5ba4',
      it: 'Apri Studio del flusso di lavoro',
    })
    expect(createWorkflowLocalizedText('mode.description')).toEqual({
      en: 'Design and maintain document-driven agent workflows.',
      zh: '\u8bbe\u8ba1\u5e76\u7ef4\u62a4\u7531\u6587\u6863\u9a71\u52a8\u7684 Agent \u5de5\u4f5c\u6d41\u3002',
      it: 'Progetta e gestisci flussi di agenti basati su documenti.',
    })
  })
})

function leafKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix]
  return Object.entries(value)
    .flatMap(([key, child]) =>
      leafKeys(child, prefix ? `${prefix}.${key}` : key),
    )
    .sort()
}
