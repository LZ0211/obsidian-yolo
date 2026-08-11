import type { Root } from 'mdast'
import { visit } from 'unist-util-visit'

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

const EMBED_REGEX = /!\[\[([^\]]+)\]\]|!\[([^\]]*)\]\(([^)]+)\)/g

const MAX_EMBEDS = 50

type TextNode = { type: 'text'; value: string }
type WikiEmbedNode = {
  type: 'wikiEmbed'
  data: {
    hName: string
    hProperties: Record<string, string>
  }
}

function resolveEmbedTarget(
  target: string,
  sourceFilePath: string,
): string | null {
  // Drop alias/anchor suffixes used by Obsidian wikilink syntax.
  const cleanTarget = target.split('|')[0].split('#')[0].trim()
  if (!cleanTarget) return null

  // Decode percent-encoding (markdown image hrefs may be URL-encoded), then
  // walk the segments so `.`/`..` resolve like a real filesystem instead of
  // rejecting outright. `normalizeVaultPath` throws on `..` so the previous
  // version silently dropped any embed using relative parents — including
  // common cases like `![alt](../assets/foo.png)`.
  let decoded: string
  try {
    decoded = decodeURIComponent(cleanTarget)
  } catch {
    decoded = cleanTarget
  }

  const absolute = decoded.startsWith('/')
  const relPath = absolute ? decoded.replace(/^\/+/, '') : decoded
  const sourceDir =
    !absolute && sourceFilePath.lastIndexOf('/') >= 0
      ? sourceFilePath.slice(0, sourceFilePath.lastIndexOf('/'))
      : ''
  const segments = sourceDir ? sourceDir.split('/') : []
  for (const part of relPath.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return segments.length > 0 ? segments.join('/') : null
}

function getEmbedKind(target: string): 'image' | 'pdf' | null {
  const ext = (target.split('.').pop() ?? '').toLowerCase()
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  return null
}

export function remarkObsidianEmbed({ filePath }: { filePath: string }) {
  return (tree: Root): void => {
    const textNodes: Array<{
      node: TextNode
      index: number
      parent: { children: Array<TextNode | WikiEmbedNode> }
    }> = []

    visit(
      tree,
      'text',
      (
        node: TextNode,
        index: number | null,
        parent: { children: Array<TextNode | WikiEmbedNode> } | null,
      ) => {
        if (!parent || index === null) return
        textNodes.push({ node, index, parent })
      },
    )

    let embedCount = 0

    for (const { node, index, parent } of textNodes) {
      if (embedCount >= MAX_EMBEDS) break

      const matches: Array<{
        start: number
        end: number
        fullMatch: string
        target: string
        alt: string
        kind: 'image' | 'pdf'
      }> = []

      const regex = new RegExp(EMBED_REGEX.source, EMBED_REGEX.flags)
      let match: RegExpExecArray | null
      while (
        (match = regex.exec(node.value)) !== null &&
        embedCount + matches.length < MAX_EMBEDS
      ) {
        if (match[1] !== undefined) {
          // Wiki embed: ![[path]]
          const resolved = resolveEmbedTarget(match[1], filePath)
          if (!resolved) continue
          const kind = getEmbedKind(resolved)
          if (!kind) continue
          matches.push({
            start: match.index,
            end: match.index + match[0].length,
            fullMatch: match[0],
            target: resolved,
            alt: '',
            kind,
          })
        } else if (match[3] !== undefined) {
          // Markdown image: ![alt](url)
          const url = match[3]
          // Remote URLs: skip for now (out of scope)
          if (/^https?:\/\//i.test(url)) continue
          const resolved = resolveEmbedTarget(url, filePath)
          if (!resolved) continue
          const kind = getEmbedKind(resolved)
          if (!kind) continue
          matches.push({
            start: match.index,
            end: match.index + match[0].length,
            fullMatch: match[0],
            target: resolved,
            alt: match[2] ?? '',
            kind,
          })
        }
      }

      if (matches.length === 0) continue

      const resultNodes: Array<TextNode | WikiEmbedNode> = []
      let cursor = 0

      for (const m of matches) {
        if (m.start > cursor) {
          resultNodes.push({
            type: 'text',
            value: node.value.slice(cursor, m.start),
          })
        }

        resultNodes.push({
          type: 'wikiEmbed',
          data: {
            hName: 'wiki-embed',
            hProperties: {
              'data-target': m.target,
              'data-kind': m.kind,
              'data-alt': m.alt,
            },
          },
        })
        embedCount++

        cursor = m.end
      }

      if (cursor < node.value.length) {
        resultNodes.push({ type: 'text', value: node.value.slice(cursor) })
      }

      parent.children.splice(index, 1, ...resultNodes)
    }

    if (embedCount >= MAX_EMBEDS) {
      visit(tree, 'root', (root: { children: unknown[] }) => {
        root.children.push({
          type: 'paragraph',
          children: [
            {
              type: 'text',
              value: `… and ${embedCount - MAX_EMBEDS} more embeds not rendered.`,
            },
          ],
        })
      })
    }
  }
}
