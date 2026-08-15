import { type ReactElement, useEffect, useRef, useState } from 'react'

type WikiEmbedProps = {
  'data-target'?: string
  'data-fallback-target'?: string
  'data-kind'?: string
  'data-alt'?: string
  onLoadBinary: (path: string) => Promise<Blob>
  registerBlobUrl: (url: string) => void
}

type EmbedSlots = Array<Promise<void>>

const MAX_CONCURRENT = 4
const activeSlots: EmbedSlots = []

/**
 * 嵌入资源加载：首选笔记目录相对路径，失败回退 vault 根相对路径
 * （Obsidian 的 fallback 规则）。仅当两个候选都失败才抛错。
 */
export async function loadEmbedBlob(
  target: string,
  fallbackTarget: string | null | undefined,
  onLoadBinary: (path: string) => Promise<Blob>,
): Promise<Blob> {
  try {
    return await onLoadBinary(target)
  } catch (primaryError) {
    if (!fallbackTarget) throw primaryError
    return await onLoadBinary(fallbackTarget)
  }
}

function acquireSlot(): Promise<() => void> {
  const slot =
    activeSlots.length < MAX_CONCURRENT
      ? Promise.resolve()
      : Promise.race(activeSlots)

  let release: () => void
  const tracker = new Promise<void>((resolve) => {
    release = resolve
  })

  const entry = slot.then(() => tracker)
  activeSlots.push(entry)

  return slot.then(() => () => {
    const idx = activeSlots.indexOf(entry)
    if (idx >= 0) activeSlots.splice(idx, 1)
    release!()
  })
}

export function WikiEmbed(props: WikiEmbedProps): ReactElement {
  const target = props['data-target']
  const fallbackTarget = props['data-fallback-target']
  const kind = props['data-kind']
  const alt = props['data-alt'] ?? ''

  const [blobUrl, setBlobUrl] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const blobUrlRef = useRef<string | null>(null)

  useEffect(() => {
    if (!target || !kind || (kind !== 'image' && kind !== 'pdf')) {
      return
    }

    let cancelled = false

    void (async () => {
      const release = await acquireSlot()
      if (cancelled) {
        release()
        return
      }

      try {
        const blob = await loadEmbedBlob(
          target,
          fallbackTarget,
          props.onLoadBinary,
        )
        if (cancelled) {
          release()
          return
        }

        const url = URL.createObjectURL(blob)
        if (cancelled) {
          URL.revokeObjectURL(url)
          release()
          return
        }

        blobUrlRef.current = url
        props.registerBlobUrl(url)
        setBlobUrl(url)
      } catch {
        if (!cancelled) setError(true)
      }
      release()
    })()

    return () => {
      cancelled = true
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current)
        blobUrlRef.current = null
      }
    }
  }, [target, fallbackTarget, kind])

  if (error) {
    return <span className="yolo-web-embed-error">{target ?? 'unknown'}</span>
  }

  if (!blobUrl) {
    return (
      <span className="yolo-web-embed-loading">{target ?? 'loading…'}</span>
    )
  }

  if (kind === 'image') {
    return (
      <img
        src={blobUrl}
        alt={alt}
        className="image-embed yolo-web-embed-image"
      />
    )
  }

  return (
    <iframe
      src={blobUrl}
      title={target}
      className="pdf-embed yolo-web-embed-pdf"
    />
  )
}
