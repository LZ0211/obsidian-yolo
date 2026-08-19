import { createContext } from 'react'

import { parseToolName } from '../../core/mcp/tool-name-utils'
import type { ChatMessage } from '../../types/chat'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

/**
 * Web-search citation protocol: the `web_search` tool returns result items
 * with short ids and instructs the model to cite them as
 * `[citation,<domain>](<id>)`. The chat renderers resolve the id back to the
 * result url here; ids that resolve to nothing (e.g. the model reusing the
 * syntax without a matching tool result) render as plain text instead of
 * Obsidian internal links that would create blank documents on click.
 */
export type WebCitationSource = {
  url: string
  title?: string
}

export type WebCitationSources = ReadonlyMap<string, WebCitationSource>

const WEB_SEARCH_TOOL_NAME = 'web_search'

export function isWebCitationLinkText(text: string): boolean {
  return text.startsWith('citation,')
}

function toolNameOf(name: string): string | null {
  if (name === WEB_SEARCH_TOOL_NAME) return name
  try {
    return parseToolName(name).toolName
  } catch {
    return null
  }
}

function parseWebSearchItems(text: string): readonly {
  id?: unknown
  url?: unknown
  title?: unknown
}[] {
  try {
    const parsed = JSON.parse(text) as { items?: unknown }
    if (!Array.isArray(parsed.items)) return []
    return parsed.items as readonly {
      id?: unknown
      url?: unknown
      title?: unknown
    }[]
  } catch {
    return []
  }
}

/** Collects web_search result items (id → url) from a message group. */
export function collectWebCitationSources(
  messages: readonly ChatMessage[],
): WebCitationSources {
  const sources = new Map<string, WebCitationSource>()
  for (const message of messages) {
    if (message.role !== 'tool') continue
    for (const toolCall of message.toolCalls) {
      const toolName = toolNameOf(toolCall.request.name)
      if (toolName !== WEB_SEARCH_TOOL_NAME) continue
      const { response } = toolCall
      if (
        response.status !== ToolCallResponseStatus.Success ||
        response.data.type !== 'text'
      ) {
        continue
      }
      for (const item of parseWebSearchItems(response.data.text)) {
        if (
          typeof item.id !== 'string' ||
          item.id.length === 0 ||
          typeof item.url !== 'string' ||
          item.url.length === 0
        ) {
          continue
        }
        sources.set(item.id, {
          url: item.url,
          ...(typeof item.title === 'string' && item.title.length > 0
            ? { title: item.title }
            : {}),
        })
      }
    }
  }
  return sources
}

export function resolveWebCitation(
  href: string,
  sources: WebCitationSources | undefined,
): WebCitationSource | null {
  return sources?.get(href) ?? null
}

/**
 * Rewrites rendered `[citation,<domain>](<id>)` anchors in place: resolvable
 * ids become external links; unresolvable ones degrade to plain text so they
 * can never open (or create) a vault note. Replaces each anchor with a clone
 * before binding, so callers can re-run this without stacking listeners.
 */
export function bindWebCitationLinks(
  containerEl: HTMLElement,
  sources: WebCitationSources | undefined,
  openUrl: (url: string) => void,
): void {
  containerEl.querySelectorAll('a').forEach((anchor) => {
    const text = anchor.textContent ?? ''
    if (!isWebCitationLinkText(text)) return
    const fresh = anchor.cloneNode(true) as HTMLAnchorElement
    anchor.replaceWith(fresh)

    const source = resolveWebCitation(fresh.getAttribute('href') ?? '', sources)
    if (!source) {
      fresh.replaceWith(document.createTextNode(text))
      return
    }
    fresh.href = source.url
    fresh.classList.remove('internal-link')
    fresh.classList.add('external-link')
    fresh.title = source.title ?? source.url
    fresh.addEventListener('click', (event) => {
      event.preventDefault()
      openUrl(source.url)
    })
  })
}

export const WebCitationSourcesContext = createContext<
  WebCitationSources | undefined
>(undefined)
