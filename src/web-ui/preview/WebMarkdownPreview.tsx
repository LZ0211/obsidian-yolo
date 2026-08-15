import { type AnchorHTMLAttributes, Component, type ReactElement } from 'react'
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
} from 'react-markdown'
import remarkGfm from 'remark-gfm'
import yaml from 'js-yaml'

import { remarkObsidianCallout } from './remark-obsidian-callout'
import { remarkObsidianEmbed } from './remark-obsidian-embed'
import { remarkObsidianWikilink } from './remark-obsidian-wikilink'
import { WikiEmbed } from './WikiEmbed'

export type WebMarkdownPreviewProps = {
  content: string
  filePath: string
  onLoadBinary: (path: string) => Promise<Blob>
  onNavigate: (path: string) => void
}

function filterDangerousUrls(url: string): string {
  if (/^data:(?!image\/)/i.test(url)) return ''
  return defaultUrlTransform(url)
}

/**
 * Strips YAML frontmatter from markdown content.
 * Returns the extracted YAML text (trimmed) and the remaining body.
 * Handles `---\n` and `---\r\n` openers; requires a closing `---` line.
 */
function parseFrontmatter(content: string): {
  yaml: string | null
  body: string
} {
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return { yaml: null, body: content }
  }
  const rest = content.startsWith('---\r\n')
    ? content.slice(5)
    : content.slice(4)
  // Find the closing --- (must be at the start of a line)
  const closeMatch = /^---[ \t]*(\r?\n|$)/m.exec(rest)
  if (!closeMatch) return { yaml: null, body: content }
  const yaml = rest.slice(0, closeMatch.index).trim()
  const body = rest.slice(closeMatch.index + closeMatch[0].length)
  return { yaml: yaml || null, body }
}

// Resolve a plain markdown link `[text](href)` against the source file so a
// click can be routed into the preview pane. Returns the vault-relative path
// (without leading slash, fragment, or query), or null when the href can't /
// shouldn't be navigated locally — external URLs, pure anchors, `mailto:`
// etc. — in which case the anchor falls through to its default behaviour.
function resolveMarkdownLink(
  href: string,
  sourceFilePath: string,
): string | null {
  if (!href) return null
  if (href.startsWith('#')) return null
  // Any scheme other than implicit relative path (`foo:` style) is treated
  // as external. Protocol-relative `//host/...` also bails out.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) return null

  const hashIdx = href.indexOf('#')
  const pathWithQuery = hashIdx >= 0 ? href.slice(0, hashIdx) : href
  const queryIdx = pathWithQuery.indexOf('?')
  const rawPath =
    queryIdx >= 0 ? pathWithQuery.slice(0, queryIdx) : pathWithQuery
  if (!rawPath) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    decoded = rawPath
  }

  if (decoded.startsWith('/')) {
    // Treat leading slash as vault-root anchored.
    return decoded.replace(/^\/+/, '') || null
  }

  const sourceDir =
    sourceFilePath.lastIndexOf('/') >= 0
      ? sourceFilePath.slice(0, sourceFilePath.lastIndexOf('/'))
      : ''
  const segments = sourceDir ? sourceDir.split('/') : []
  for (const part of decoded.split('/')) {
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

function renderFrontmatterValue(value: unknown): React.ReactNode {
  if (Array.isArray(value)) {
    if (
      value.every((item) => typeof item === 'string' || typeof item === 'number')
    ) {
      return value.map((item, index) => (
        <span key={index} className="yolo-web-frontmatter-chip">
          {String(item)}
        </span>
      ))
    }
  }
  if (value === null || value === undefined) return null
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function renderFrontmatterRows(yamlText: string): React.ReactNode {
  let parsed: unknown
  try {
    parsed = yaml.load(yamlText)
  } catch {
    return <pre className="yolo-web-frontmatter-yaml">{yamlText}</pre>
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const entries = Object.entries(parsed as Record<string, unknown>)
  if (entries.length === 0) return null
  return (
    <div className="yolo-web-frontmatter-rows">
      {entries.map(([key, value]) => (
        <div key={key} className="yolo-web-frontmatter-row">
          <span className="yolo-web-frontmatter-key">{key}</span>
          <span className="yolo-web-frontmatter-value">
            {renderFrontmatterValue(value)}
          </span>
        </div>
      ))}
    </div>
  )
}

class MarkdownErrorCatcher extends Component<
  { children: React.ReactNode; content: string },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode; content: string }) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    if (this.state.error) {
      return (
        <pre className="markdown-reading-view yolo-web-text-preview">
          {this.props.content}
        </pre>
      )
    }
    return this.props.children
  }
}

export function WebMarkdownPreview({
  content,
  filePath,
  onNavigate,
  onLoadBinary,
}: WebMarkdownPreviewProps): ReactElement {
  const blobUrlsRef: { current: Set<string> } = { current: new Set() }
  const { yaml, body } = parseFrontmatter(content)

  return (
    <MarkdownErrorCatcher content={content}>
      {/* yolo-scale-sm (0.85×) makes preview text slightly smaller than the
          main chat, matching what Obsidian's reading view uses in a side pane */}
      <div className="markdown-rendered yolo-markdown-rendered yolo-scale-sm yolo-web-markdown-preview">
        {yaml && (
          <div className="frontmatter yolo-web-frontmatter">
            {renderFrontmatterRows(yaml)}
          </div>
        )}
        <ReactMarkdown
          remarkPlugins={[
            remarkGfm,
            remarkObsidianCallout,
            [remarkObsidianWikilink, { filePath }],
            [remarkObsidianEmbed, { filePath }],
          ]}
          skipHtml
          urlTransform={filterDangerousUrls}
          components={
            {
              a: ({
                href,
                children,
                ...props
              }: AnchorHTMLAttributes<HTMLAnchorElement>) => {
                if (!href) {
                  return <a {...props}>{children}</a>
                }
                if (/^(https?:)?\/\//.test(href)) {
                  return (
                    <a
                      {...props}
                      href={href}
                      target="_blank"
                      rel="noopener nofollow"
                    >
                      {children}
                    </a>
                  )
                }
                const dataHref = (props as Record<string, unknown>)['data-href']
                if (
                  typeof dataHref === 'string' &&
                  (props as Record<string, unknown>).className ===
                    'internal-link'
                ) {
                  return (
                    <a
                      {...props}
                      href={href}
                      className="internal-link"
                      onClick={(e) => {
                        e.preventDefault()
                        onNavigate(dataHref)
                      }}
                    >
                      {children}
                    </a>
                  )
                }
                // Plain markdown link [text](path) → if it resolves to a
                // vault-internal path, intercept the click and route through
                // the preview pane instead of letting the browser navigate
                // the host page.
                const resolved = resolveMarkdownLink(href, filePath)
                if (resolved) {
                  return (
                    <a
                      {...props}
                      href={href}
                      className="internal-link"
                      onClick={(e) => {
                        e.preventDefault()
                        onNavigate(resolved)
                      }}
                    >
                      {children}
                    </a>
                  )
                }
                return (
                  <a {...props} href={href}>
                    {children}
                  </a>
                )
              },
              'wiki-embed': (embedProps: Record<string, unknown>) => (
                <WikiEmbed
                  data-target={embedProps['data-target'] as string}
                  data-fallback-target={
                    embedProps['data-fallback-target'] as string | undefined
                  }
                  data-kind={embedProps['data-kind'] as string}
                  data-alt={embedProps['data-alt'] as string}
                  onLoadBinary={onLoadBinary}
                  registerBlobUrl={(url: string) =>
                    blobUrlsRef.current.add(url)
                  }
                />
              ),
            } as unknown as Components
          }
        >
          {body}
        </ReactMarkdown>
      </div>
    </MarkdownErrorCatcher>
  )
}
