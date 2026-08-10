import { isRagIndexablePath } from './indexSourcePolicy'

describe('RAG index source policy', () => {
  const settings = {
    yolo: { baseDir: 'Config/YOLO' },
    ragOptions: {
      indexPdf: true,
      excludeYoloBaseDir: true,
      excludePatterns: ['private/**'],
      includePatterns: ['notes/**', 'papers/**'],
    },
  }

  it.each([
    ['notes/a.md', true],
    ['papers/a.markdown', true],
    ['papers/a.pdf', true],
    ['notes/a.txt', false],
    ['outside/a.md', false],
    ['private/a.md', false],
    ['Config/YOLO/skills/a.md', false],
  ])('classifies %s as %s', (path, expected) => {
    expect(isRagIndexablePath(path, settings)).toBe(expected)
  })

  it('honors PDF and managed-directory opt-outs', () => {
    expect(
      isRagIndexablePath('papers/a.pdf', {
        ...settings,
        ragOptions: { ...settings.ragOptions, indexPdf: false },
      }),
    ).toBe(false)
    expect(
      isRagIndexablePath('Config/YOLO/notes/a.md', {
        ...settings,
        ragOptions: {
          ...settings.ragOptions,
          excludeYoloBaseDir: false,
          includePatterns: ['Config/YOLO/**'],
        },
      }),
    ).toBe(true)
  })
})
