import type { Blockquote, Parent, Root, RootContent, Text } from 'mdast'
import { visit } from 'unist-util-visit'

// Matches `[!type][+-?] Title` on the first line of a blockquote's first text
// node. We deliberately stop the title capture at the next newline (rather
// than `$` with /m) because the blockquote often contains the body on
// subsequent lines as part of the same text node; `$` without /m wouldn't
// match, and `$` with /m can still bind to the final `$` if the title line
// is empty.
const CALLOUT_REGEX = /^\[!(\w[\w-]*)\]([+-]?)[ \t]*([^\n]*)/

type CalloutMdastNode = {
  type: string
  children: Array<{
    type: string
    children: unknown[]
    data?: {
      hName?: string
      hProperties?: Record<string, string | boolean>
    }
  }>
  data: {
    hName: string
    hProperties: Record<string, string | boolean>
  }
}

export function remarkObsidianCallout() {
  return (tree: Root): void => {
    visit(
      tree,
      'blockquote',
      (node: Blockquote, index: number | null, parent: Parent | null) => {
        if (!parent || index === null) return
        if (!node.children || node.children.length === 0) return

        const firstChild = node.children[0]
        if (firstChild.type !== 'paragraph') return

        const firstText = firstChild.children?.[0] as Text | undefined
        if (!firstText || firstText.type !== 'text') return

        const match = CALLOUT_REGEX.exec(firstText.value)
        if (!match) return

        const calloutType = match[1].toLowerCase()
        const fold = match[2] || ''
        const titleText = match[3] || calloutType

        // Split the first text: remove the [!type] prefix, keep title and rest
        const remainingFirstLine = firstText.value.slice(match[0].length)
        const hasRemaining = remainingFirstLine.trim().length > 0

        // Build callout-title children
        const titleChildren: unknown[] = [
          {
            type: 'div',
            data: { hName: 'div', hProperties: { className: 'callout-icon' } },
            children: [],
          },
          {
            type: 'div',
            data: {
              hName: 'div',
              hProperties: { className: 'callout-title-inner' },
            },
            children: [{ type: 'text', value: titleText }],
          },
        ]

        // Build callout-content children from remaining blockquote children
        const contentChildren: unknown[] = []

        if (hasRemaining) {
          // Replace the first text in the first paragraph with the remaining text
          const modifiedFirstPara = {
            ...firstChild,
            children: [
              { type: 'text', value: remainingFirstLine },
              ...firstChild.children.slice(1),
            ],
          }
          contentChildren.push(modifiedFirstPara)
        } else if (firstChild.children.length > 1) {
          // Type-only callout with body text on next line
          contentChildren.push({
            ...firstChild,
            children: [
              { type: 'text', value: '' },
              ...firstChild.children.slice(1),
            ],
          })
        }

        // Add remaining blockquote children (paragraphs after the first)
        contentChildren.push(...node.children.slice(1))

        // If no content, add empty paragraph
        if (contentChildren.length === 0) {
          contentChildren.push({
            type: 'paragraph',
            children: [],
          })
        }

        const hProperties: Record<string, string | boolean> = {
          className: 'callout',
          'data-callout': calloutType,
        }
        if (fold) {
          hProperties['data-callout-fold'] = fold
        }

        const calloutNode: CalloutMdastNode = {
          type: 'div',
          data: {
            hName: 'div',
            hProperties,
          },
          children: [
            {
              type: 'div',
              data: {
                hName: 'div',
                hProperties: { className: 'callout-title' },
              },
              children: titleChildren as Array<{
                type: string
                children: unknown[]
              }>,
            },
            {
              type: 'div',
              data: {
                hName: 'div',
                hProperties: { className: 'callout-content' },
              },
              children: contentChildren as Array<{
                type: string
                children: unknown[]
              }>,
            },
          ],
        }

        // Replace the blockquote with the callout div
        parent.children.splice(index, 1, calloutNode as unknown as RootContent)
      },
    )
  }
}
