import { createTranslationFunction, loadLocale } from './index'
import { en } from './locales/en'
import { zh } from './locales/zh'

describe('chat working directory i18n', () => {
  it('resolves zh keys at the top-level chat path', async () => {
    await loadLocale('zh')
    const t = createTranslationFunction('zh')
    expect(t('chat.workingDirectory.locked')).toBe('工作目录已锁定')
    expect(t('chat.workingDirectory.select')).toBe('选择工作目录')
    expect(t('chat.workingDirectory.clear')).toBe('清除工作目录')
  })

  it('resolves en keys at the top-level chat path', async () => {
    await loadLocale('en')
    const t = createTranslationFunction('en')
    expect(t('chat.workingDirectory.locked')).toBe('Working directory is locked')
    expect(t('chat.workingDirectory.select')).toBe('Select working directory')
  })
})

describe('i18n key-set consistency', () => {
  const collectKeys = (value: unknown, prefix = ''): string[] => {
    const keys: string[] = []
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const path = prefix ? `${prefix}.${key}` : key
      if (child !== null && typeof child === 'object') {
        keys.push(...collectKeys(child, path))
      } else {
        keys.push(path)
      }
    }
    return keys
  }

  // `settings.providers.kind` is an open Record<string, string> in the type
  // declaration; its concrete keys may legitimately differ across locales.
  const isOpenRecordKey = (key: string): boolean =>
    key.startsWith('settings.providers.kind.')

  it('every zh key exists in en (no silent English fallback for zh users)', () => {
    const enKeys = new Set(
      collectKeys(en).filter((key) => !isOpenRecordKey(key)),
    )
    const missing = collectKeys(zh).filter(
      (key) => !isOpenRecordKey(key) && !enKeys.has(key),
    )
    expect(missing).toEqual([])
  })
})
