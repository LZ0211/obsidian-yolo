import type { ReactElement } from 'react'

export type WebTextPreviewProps = { content: string }

export function WebTextPreview({ content }: WebTextPreviewProps): ReactElement {
  return (
    <pre className="markdown-reading-view yolo-web-text-preview">{content}</pre>
  )
}
