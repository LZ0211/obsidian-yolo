import { createTranslationFunction, loadLocale } from './index'

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
