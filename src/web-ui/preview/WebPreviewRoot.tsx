import { Component, type ErrorInfo, type ReactElement } from 'react'

import { WebCodePreview } from './WebCodePreview'
import { WebCsvPreview } from './WebCsvPreview'
import { WebMarkdownPreview } from './WebMarkdownPreview'
import { WebTextPreview } from './WebTextPreview'

export type WebPreviewRootProps = {
  kind: 'markdown' | 'text'
  content: string
  extension: string | undefined
  filePath: string
  onLoadBinary: (path: string) => Promise<Blob>
  onNavigate: (path: string) => void
}

const CODE_EXTENSIONS = new Set([
  'json',
  'js',
  'jsx',
  'ts',
  'tsx',
  'py',
  'css',
  'scss',
  'less',
  'xml',
  'html',
  'htm',
  'yaml',
  'yml',
  'toml',
])

class MarkdownErrorBoundary extends Component<
  { children: React.ReactNode; content: string },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; content: string }) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('[YOLO] Markdown preview crashed', error, errorInfo)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="yolo-web-preview-content">
          <WebTextPreview content={this.props.content} />
        </div>
      )
    }
    return this.props.children
  }
}

export function WebPreviewRoot(props: WebPreviewRootProps): ReactElement {
  if (props.kind === 'markdown') {
    try {
      return (
        <MarkdownErrorBoundary content={props.content}>
          <div className="yolo-web-preview-content">
            <WebMarkdownPreview
              content={props.content}
              filePath={props.filePath}
              onLoadBinary={props.onLoadBinary}
              onNavigate={props.onNavigate}
            />
          </div>
        </MarkdownErrorBoundary>
      )
    } catch (_e) {
      // If even creating the element throws, fall back to text
      return (
        <div className="yolo-web-preview-content">
          <WebTextPreview content={props.content} />
        </div>
      )
    }
  }

  if (props.kind === 'text' && props.extension === 'csv') {
    return (
      <div className="yolo-web-preview-content">
        <WebCsvPreview content={props.content} />
      </div>
    )
  }

  if (
    props.kind === 'text' &&
    props.extension &&
    CODE_EXTENSIONS.has(props.extension)
  ) {
    return (
      <div className="yolo-web-preview-content">
        <WebCodePreview content={props.content} extension={props.extension} />
      </div>
    )
  }

  return (
    <div className="yolo-web-preview-content">
      <WebTextPreview content={props.content} />
    </div>
  )
}
