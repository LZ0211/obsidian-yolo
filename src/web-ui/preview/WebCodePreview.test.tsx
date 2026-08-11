jest.mock('react', () => {
  const actual = jest.requireActual('react')
  return {
    ...actual,
    useLayoutEffect: actual.useEffect,
  }
})

jest.mock('react-syntax-highlighter/dist/esm/styles/prism', () => ({
  oneLight: {},
}))

import { renderToStaticMarkup } from 'react-dom/server'

import { WebCodePreview } from './WebCodePreview'

describe('WebCodePreview', () => {
  it('renders typescript code with language-typescript class', () => {
    const html = renderToStaticMarkup(
      <WebCodePreview content="const x: number = 1" extension="ts" />,
    )
    expect(html).toContain('language-typescript')
    expect(html).toContain('const')
  })

  it('renders python code with language-python class', () => {
    const html = renderToStaticMarkup(
      <WebCodePreview content="def foo():\n  pass" extension="py" />,
    )
    expect(html).toContain('language-python')
  })

  it('renders json with language-json class', () => {
    const html = renderToStaticMarkup(
      <WebCodePreview content='{"key": "value"}' extension="json" />,
    )
    expect(html).toContain('language-json')
  })

  it('renders xml language for html extension', () => {
    const html = renderToStaticMarkup(
      <WebCodePreview content="<div>hello</div>" extension="html" />,
    )
    expect(html).toContain('language-xml')
  })

  it('falls back to plaintext for unknown extensions', () => {
    const html = renderToStaticMarkup(
      <WebCodePreview content="some content" extension="txt" />,
    )
    expect(html).toContain('language-plaintext')
  })

  it('falls back to plaintext when extension is undefined', () => {
    const html = renderToStaticMarkup(<WebCodePreview content="some content" />)
    expect(html).toContain('language-plaintext')
  })

  it('renders scss and less as css language', () => {
    const scssHtml = renderToStaticMarkup(
      <WebCodePreview content=".foo { color: red; }" extension="scss" />,
    )
    expect(scssHtml).toContain('language-css')

    const lessHtml = renderToStaticMarkup(
      <WebCodePreview content=".foo { color: red; }" extension="less" />,
    )
    expect(lessHtml).toContain('language-css')
  })

  it('renders yaml with language-yaml class', () => {
    const html = renderToStaticMarkup(
      <WebCodePreview content="key: value" extension="yaml" />,
    )
    expect(html).toContain('language-yaml')
  })

  it('renders toml with language-toml class', () => {
    const html = renderToStaticMarkup(
      <WebCodePreview content='key = "value"' extension="toml" />,
    )
    expect(html).toContain('language-toml')
  })
})
