jest.mock('react', () => {
  const actual = jest.requireActual('react')
  return {
    ...actual,
    useLayoutEffect: actual.useEffect,
  }
})

const MockReactMarkdown = jest.fn()
jest.mock('react-markdown', () => ({
  __esModule: true,
  default: MockReactMarkdown,
  defaultUrlTransform: (url: string) => url,
}))

jest.mock('remark-gfm', () => ({ __esModule: true, default: jest.fn() }))
jest.mock('./remark-obsidian-wikilink', () => ({
  remarkObsidianWikilink: () => (tree: unknown) => tree,
}))
jest.mock('./remark-obsidian-embed', () => ({
  remarkObsidianEmbed: () => (tree: unknown) => tree,
}))
jest.mock('./remark-obsidian-callout', () => ({
  remarkObsidianCallout: () => (tree: unknown) => tree,
}))
jest.mock('./WikiEmbed', () => ({
  WikiEmbed: (props: Record<string, unknown>) => {
    const React = jest.requireActual('react')
    return React.createElement('wiki-embed', {
      'data-target': props['data-target'],
      'data-kind': props['data-kind'],
      'data-alt': props['data-alt'],
    })
  },
}))

import { renderToStaticMarkup } from 'react-dom/server'

import { WebMarkdownPreview } from './WebMarkdownPreview'

const noopBinary = async () => new Blob()
const noopNavigate = () => {}

describe('WebMarkdownPreview', () => {
  beforeEach(() => {
    MockReactMarkdown.mockReset()
  })

  it('renders with skipHtml and urlTransform props', () => {
    MockReactMarkdown.mockReturnValue(<div>rendered</div>)
    renderToStaticMarkup(
      <WebMarkdownPreview
        content="Hello"
        filePath="notes/test.md"
        onLoadBinary={noopBinary}
        onNavigate={noopNavigate}
      />,
    )
    expect(MockReactMarkdown).toHaveBeenCalled()
    const callProps = MockReactMarkdown.mock.calls[0][0]
    expect(callProps.skipHtml).toBe(true)
    expect(callProps.remarkPlugins).toBeDefined()
    expect(callProps.urlTransform).toBeDefined()
    expect(callProps.children).toBe('Hello')
  })

  it('wraps content in markdown-rendered container', () => {
    MockReactMarkdown.mockReturnValue(<div>test</div>)
    const html = renderToStaticMarkup(
      <WebMarkdownPreview
        content="test"
        filePath="notes/test.md"
        onLoadBinary={noopBinary}
        onNavigate={noopNavigate}
      />,
    )
    expect(html).toContain('yolo-web-markdown-preview')
    expect(html).toContain('markdown-rendered')
  })

  it('filterDangerousUrls blocks data:text/html URLs', () => {
    MockReactMarkdown.mockImplementation(
      ({ urlTransform, children: _children }: Record<string, unknown>) => {
        const result = (urlTransform as (url: string) => string)(
          'data:text/html,<script>',
        )
        return <div>{String(result)}</div>
      },
    )
    const html = renderToStaticMarkup(
      <WebMarkdownPreview
        content="test"
        filePath="notes/test.md"
        onLoadBinary={noopBinary}
        onNavigate={noopNavigate}
      />,
    )
    expect(html).not.toContain('data:')
  })

  it('filterDangerousUrls passes through data:image URLs', () => {
    MockReactMarkdown.mockImplementation(
      ({ urlTransform, children: _children }: Record<string, unknown>) => {
        const result = (urlTransform as (url: string) => string)(
          'data:image/png,abc',
        )
        return <div>{String(result)}</div>
      },
    )
    const html = renderToStaticMarkup(
      <WebMarkdownPreview
        content="test"
        filePath="notes/test.md"
        onLoadBinary={noopBinary}
        onNavigate={noopNavigate}
      />,
    )
    expect(html).toContain('data:image/png,abc')
  })

  it('renders external links with target blank and noopener', () => {
    MockReactMarkdown.mockImplementation(
      ({ components }: Record<string, unknown>) => {
        const A = (
          components as Record<
            string,
            React.ComponentType<Record<string, unknown>>
          >
        )?.a
        if (!A) return <div>no link component</div>
        const React = jest.requireActual('react')
        return React.createElement(A, {
          href: 'https://google.com',
          children: 'google',
        })
      },
    )
    const html = renderToStaticMarkup(
      <WebMarkdownPreview
        content="[google](https://google.com)"
        filePath="notes/test.md"
        onLoadBinary={noopBinary}
        onNavigate={noopNavigate}
      />,
    )
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener nofollow"')
  })

  it('renders internal wikilinks with internal-link class and data-href', () => {
    MockReactMarkdown.mockImplementation(
      ({ components }: Record<string, unknown>) => {
        const A = (
          components as Record<
            string,
            React.ComponentType<Record<string, unknown>>
          >
        )?.a
        if (!A) return <div>no link component</div>
        const React = jest.requireActual('react')
        return React.createElement(A, {
          href: '#',
          className: 'internal-link',
          'data-href': 'notes/target.md',
          children: 'target',
        })
      },
    )
    const html = renderToStaticMarkup(
      <WebMarkdownPreview
        content="[[target]]"
        filePath="notes/test.md"
        onLoadBinary={noopBinary}
        onNavigate={noopNavigate}
      />,
    )
    expect(html).toContain('internal-link')
    expect(html).toContain('data-href="notes/target.md"')
    expect(html).toContain('target')
  })

  it('renders wiki-embed component for image embeds', () => {
    MockReactMarkdown.mockImplementation(
      ({ components }: Record<string, unknown>) => {
        const WE = (
          components as Record<
            string,
            React.ComponentType<Record<string, unknown>>
          >
        )?.['wiki-embed']
        if (!WE) return <div>no embed component</div>
        const React = jest.requireActual('react')
        return React.createElement(WE, {
          'data-target': 'notes/img.png',
          'data-kind': 'image',
          'data-alt': '',
        })
      },
    )
    const html = renderToStaticMarkup(
      <WebMarkdownPreview
        content="![[img.png]]"
        filePath="notes/test.md"
        onLoadBinary={noopBinary}
        onNavigate={noopNavigate}
      />,
    )
    expect(html).toContain('wiki-embed')
    expect(html).toContain('data-target="notes/img.png"')
    expect(html).toContain('data-kind="image"')
  })
})
