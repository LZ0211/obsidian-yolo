jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) =>
      ({
        'common.loading': '加载中',
        'quickAsk.statusThinking': '思考中',
      })[key] ??
      fallback ??
      key,
  }),
}))

import { renderToStaticMarkup } from 'react-dom/server'

import DotLoader from './DotLoader'

describe('DotLoader', () => {
  it('uses translated defaults for visible and accessible labels', () => {
    const html = renderToStaticMarkup(<DotLoader />)

    expect(html).toContain('思考中')
    expect(html).toContain('aria-label="加载中"')
  })

  it('keeps an explicit text prop', () => {
    const html = renderToStaticMarkup(<DotLoader text="自定义文案" />)

    expect(html).toContain('自定义文案')
  })

  it('uses the translated loading label on the dots variant', () => {
    const html = renderToStaticMarkup(<DotLoader variant="dots" />)

    expect(html).toContain('aria-label="加载中"')
  })
})
