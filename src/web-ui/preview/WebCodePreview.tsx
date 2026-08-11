import type { ReactElement } from 'react'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism'

export type WebCodePreviewProps = {
  content: string
  extension?: string
}

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  json: 'json',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'tsx',
  py: 'python',
  css: 'css',
  scss: 'css',
  less: 'css',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
}

export function WebCodePreview({
  content,
  extension,
}: WebCodePreviewProps): ReactElement {
  const language = extension
    ? (EXTENSION_LANGUAGE_MAP[extension] ?? 'plaintext')
    : 'plaintext'

  return (
    <SyntaxHighlighter
      language={language}
      style={oneLight}
      className="yolo-web-code-preview"
      showLineNumbers={false}
      wrapLines={true}
      wrapLongLines={true}
    >
      {content}
    </SyntaxHighlighter>
  )
}
