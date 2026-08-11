import type { Root } from 'mdast'
import { visit } from 'unist-util-visit'

import { normalizeVaultPath } from '../webWorkspaceUtils'

const WIKILINK_REGEX = /(?<!!)\[\[([^\]|]+?)(?:\|[^\]]*)?\]\]/g

type TextNode = { type: 'text'; value: string }
type LinkNode = {
  type: 'link'
  url: string
  title: null
  children: TextNode[]
  data?: { hName?: string; hProperties?: Record<string, unknown> }
}

function resolveWikilink(link: string, sourceFilePath: string): string | null {
  const base = link.split('#')[0].trim()
  if (!base) return null

  try {
    const normalized = normalizeVaultPath(base)
    const sourceDir =
      sourceFilePath.lastIndexOf('/') >= 0
        ? sourceFilePath.slice(0, sourceFilePath.lastIndexOf('/'))
        : ''
    return sourceDir ? `${sourceDir}/${normalized}` : normalized
  } catch {
    return null
  }
}

export function remarkObsidianWikilink({ filePath }: { filePath: string }) {
  return (tree: Root): void => {
    visit(
      tree,
      'text',
      (
        node: TextNode,
        index: number | null,
        parent: { children: Array<TextNode | LinkNode> } | null,
      ) => {
        if (!parent || index === null) return

        const matches: Array<{
          start: number
          end: number
          fullMatch: string
          link: string
          display: string
        }> = []

        const regex = new RegExp(WIKILINK_REGEX.source, WIKILINK_REGEX.flags)
        let match: RegExpExecArray | null
        while ((match = regex.exec(node.value)) !== null) {
          const linkText = match[1]
          const pipeIdx = linkText.indexOf('|')
          const link = pipeIdx >= 0 ? linkText.slice(0, pipeIdx) : linkText
          const alias = pipeIdx >= 0 ? linkText.slice(pipeIdx + 1).trim() : ''
          const display = alias || link.split('#')[0].trim()

          matches.push({
            start: match.index,
            end: match.index + match[0].length,
            fullMatch: match[0],
            link,
            display,
          })
        }

        if (matches.length === 0) return

        const resultNodes: Array<TextNode | LinkNode> = []
        let cursor = 0

        for (const m of matches) {
          if (m.start > cursor) {
            resultNodes.push({
              type: 'text',
              value: node.value.slice(cursor, m.start),
            })
          }

          const resolved = resolveWikilink(m.link, filePath)
          if (resolved) {
            resultNodes.push({
              type: 'link',
              url: '#',
              title: null,
              children: [{ type: 'text', value: m.display }],
              data: {
                hName: 'a',
                hProperties: {
                  className: 'internal-link',
                  'data-href': resolved,
                  href: '#',
                },
              },
            })
          } else {
            // Unresolvable — render as plain text
            resultNodes.push({ type: 'text', value: m.display })
          }

          cursor = m.end
        }

        if (cursor < node.value.length) {
          resultNodes.push({ type: 'text', value: node.value.slice(cursor) })
        }

        parent.children.splice(index, 1, ...resultNodes)
      },
    )
  }
}
