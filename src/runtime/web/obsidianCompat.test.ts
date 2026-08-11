/** @jest-environment jsdom */

import { MarkdownRenderer, sanitizeHTMLToDom } from './obsidianCompat'

describe('web Obsidian compatibility sanitization', () => {
  it('does not execute raw HTML embedded in Markdown', async () => {
    const container = document.createElement('div')

    await MarkdownRenderer.render(
      null as never,
      '<img src=x onerror="alert(1)"><script>alert(2)</script>',
      container,
      '',
      null as never,
    )

    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.textContent).toContain('<img')
  })

  it('removes executable elements and dangerous URLs from HTML fragments', () => {
    const fragment = sanitizeHTMLToDom(
      '<script>alert(1)</script><a href="javascript:alert(2)" onclick="alert(3)">open</a>',
    )

    expect(fragment.querySelector('script')).toBeNull()
    const link = fragment.querySelector('a')
    expect(link?.getAttribute('onclick')).toBeNull()
    expect(link?.getAttribute('href')).toBe('#')
  })
})
