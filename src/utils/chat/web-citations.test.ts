/** @jest-environment jsdom */

import { ToolCallResponseStatus } from '../../types/tool-call.types'
import type { ChatToolMessage } from '../../types/chat'

import {
  WebCitationSources,
  bindWebCitationLinks,
  collectWebCitationSources,
  isWebCitationLinkText,
  resolveWebCitation,
} from './web-citations'

function webSearchToolMessage(
  text: string,
  options: { name?: string; status?: ToolCallResponseStatus } = {},
): ChatToolMessage {
  const name = options.name ?? 'yolo_local__web_search'
  const status = options.status ?? ToolCallResponseStatus.Success
  return {
    role: 'tool',
    id: 'tool-1',
    toolCalls: [
      {
        request: { id: 'call-1', name },
        response:
          status === ToolCallResponseStatus.Success
            ? { status, data: { type: 'text', text } }
            : { status },
      },
    ],
  } as ChatToolMessage
}

function fsReadToolMessage(): ChatToolMessage {
  return {
    role: 'tool',
    id: 'tool-2',
    toolCalls: [
      {
        request: { id: 'call-2', name: 'yolo_local__fs_read' },
        response: {
          status: ToolCallResponseStatus.Success,
          data: { type: 'text', text: '{"results":[]}' },
        },
      },
    ],
  } as ChatToolMessage
}

function webSearchResultText(items: unknown[]): string {
  return JSON.stringify({
    tool: 'web_search',
    provider: 'tavily',
    answer: 'ok',
    items,
  })
}

describe('isWebCitationLinkText', () => {
  it('recognizes the web-search citation link text', () => {
    expect(isWebCitationLinkText('citation,itdcw.com')).toBe(true)
    expect(isWebCitationLinkText('citation,baike.baidu.com')).toBe(true)
  })

  it('rejects ordinary link text', () => {
    expect(isWebCitationLinkText('notes/foo')).toBe(false)
    expect(isWebCitationLinkText('https://example.com')).toBe(false)
    expect(isWebCitationLinkText('')).toBe(false)
    expect(isWebCitationLinkText('citation')).toBe(false)
  })
})

describe('collectWebCitationSources', () => {
  it('maps web_search result item ids to urls', () => {
    const sources = collectWebCitationSources([
      webSearchToolMessage(
        webSearchResultText([
          {
            id: '6wchmk',
            index: 1,
            title: 'A轮融资',
            url: 'https://itdcw.com/a',
            text: '...',
          },
          { id: 'wysu7f', index: 2, url: 'https://sohu.com/b', text: '...' },
        ]),
      ),
    ])
    expect(sources.get('6wchmk')).toEqual({
      url: 'https://itdcw.com/a',
      title: 'A轮融资',
    })
    expect(sources.get('wysu7f')).toEqual({ url: 'https://sohu.com/b' })
    expect(sources.size).toBe(2)
  })

  it('returns an empty map for no messages', () => {
    expect(collectWebCitationSources([]).size).toBe(0)
  })

  it('ignores tool calls of other tools', () => {
    const sources = collectWebCitationSources([
      fsReadToolMessage(),
      webSearchToolMessage(
        webSearchResultText([{ id: 'abc123', url: 'https://x.com' }]),
      ),
    ])
    expect(sources.size).toBe(1)
    expect(sources.has('abc123')).toBe(true)
  })

  it('accepts legacy bare web_search names', () => {
    const sources = collectWebCitationSources([
      webSearchToolMessage(
        webSearchResultText([{ id: 'legacy1', url: 'https://x.com' }]),
        { name: 'web_search' },
      ),
    ])
    expect(sources.has('legacy1')).toBe(true)
  })

  it('ignores failed tool responses', () => {
    const sources = collectWebCitationSources([
      webSearchToolMessage('{"items":[]}', {
        status: ToolCallResponseStatus.Error,
      }),
    ])
    expect(sources.size).toBe(0)
  })

  it('ignores unparseable result text', () => {
    const sources = collectWebCitationSources([
      webSearchToolMessage('not json at all'),
    ])
    expect(sources.size).toBe(0)
  })

  it('skips items without an id or url', () => {
    const sources = collectWebCitationSources([
      webSearchToolMessage(
        webSearchResultText([
          { id: 'ok1', url: 'https://x.com' },
          { id: 'no-url', title: 't' },
          { url: 'https://no-id.com' },
          { id: '', url: 'https://empty-id.com' },
        ]),
      ),
    ])
    expect(sources.size).toBe(1)
    expect(sources.has('ok1')).toBe(true)
  })

  it('accepts web_search results from any server when the result shape matches', () => {
    const sources = collectWebCitationSources([
      webSearchToolMessage(
        webSearchResultText([{ id: 'other', url: 'https://x.com' }]),
        { name: 'other_server__web_search' },
      ),
    ])
    expect(sources.size).toBe(1)
    expect(sources.has('other')).toBe(true)
  })
})

describe('resolveWebCitation', () => {
  const sources: WebCitationSources = new Map([
    ['6wchmk', { url: 'https://itdcw.com/a', title: 'A轮融资' }],
  ])

  it('resolves a known citation id', () => {
    expect(resolveWebCitation('6wchmk', sources)).toEqual({
      url: 'https://itdcw.com/a',
      title: 'A轮融资',
    })
  })

  it('returns null for an unknown id', () => {
    expect(resolveWebCitation('nope', sources)).toBeNull()
  })

  it('returns null for an empty or missing map', () => {
    expect(resolveWebCitation('6wchmk', new Map())).toBeNull()
    expect(resolveWebCitation('6wchmk', undefined)).toBeNull()
  })
})

describe('bindWebCitationLinks', () => {
  const sources: WebCitationSources = new Map([
    ['6wchmk', { url: 'https://itdcw.com/a', title: 'A轮融资' }],
  ])

  function renderLinks(markup: string): HTMLElement {
    const container = document.createElement('div')
    container.innerHTML = markup
    return container
  }

  it('turns a resolvable citation anchor into an external link', () => {
    const container = renderLinks(
      '<a href="6wchmk" class="internal-link">citation,itdcw.com</a>',
    )
    const opened: string[] = []
    bindWebCitationLinks(container, sources, (url) => opened.push(url))

    const anchor = container.querySelector('a')
    expect(anchor).not.toBeNull()
    expect(anchor!.getAttribute('href')).toBe('https://itdcw.com/a')
    expect(anchor!.className).toContain('external-link')
    expect(anchor!.className).not.toContain('internal-link')
    anchor!.dispatchEvent(new MouseEvent('click', { cancelable: true }))
    expect(opened).toEqual(['https://itdcw.com/a'])
  })

  it('replaces an unresolvable citation anchor with plain text', () => {
    const container = renderLinks(
      '<a href="6wchmk" class="internal-link">citation,itdcw.com</a>',
    )
    bindWebCitationLinks(container, new Map(), (url) => url)

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('citation,itdcw.com')
  })

  it('replaces an unresolvable citation anchor when no sources are known', () => {
    const container = renderLinks(
      '<a href="unknown" class="internal-link">citation,sohu.com</a>',
    )
    bindWebCitationLinks(container, sources, (url) => url)

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('citation,sohu.com')
  })

  it('leaves non-citation anchors untouched', () => {
    const container = renderLinks(
      '<a href="notes/foo" class="internal-link">foo</a><a href="https://x.com">x</a>',
    )
    bindWebCitationLinks(container, sources, (url) => url)

    expect(container.querySelectorAll('a')).toHaveLength(2)
  })

  it('is a no-op on an empty container', () => {
    const container = document.createElement('div')
    bindWebCitationLinks(container, sources, (url) => url)
    expect(container.childNodes).toHaveLength(0)
  })
})
