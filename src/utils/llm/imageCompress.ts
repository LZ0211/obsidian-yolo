import { arrayBufferToBase64 } from '../base64'

const EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/**
 * Compress an image using Canvas API.
 * GIF is skipped (may be animated).
 * PNG is converted to JPEG (transparency becomes white).
 * JPEG/WebP are re-encoded at the given quality.
 */
export async function compressImage(
  buffer: ArrayBuffer,
  ext: string,
  quality: number,
): Promise<{
  base64: string
  mimeType: string
  originalWidth: number
  originalHeight: number
  scaledWidth: number
  scaledHeight: number
}> {
  // GIF: skip compression (may be animated)
  if (ext === 'gif') {
    return {
      base64: arrayBufferToBase64(buffer),
      mimeType: 'image/gif',
      originalWidth: 0,
      originalHeight: 0,
      scaledWidth: 0,
      scaledHeight: 0,
    }
  }

  const scale = quality / 100
  const blob = new Blob([buffer], {
    type: EXTENSION_TO_MIME[ext] ?? 'image/png',
  })
  const bitmap = await createImageBitmap(blob)

  const origWidth = bitmap.width
  const origHeight = bitmap.height

  // Scale dimensions and quality by the same factor
  const targetWidth = Math.round(origWidth * scale)
  const targetHeight = Math.round(origHeight * scale)

  const canvas = new OffscreenCanvas(targetWidth, targetHeight)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return {
      base64: arrayBufferToBase64(buffer),
      mimeType: EXTENSION_TO_MIME[ext] ?? 'image/png',
      originalWidth: origWidth,
      originalHeight: origHeight,
      scaledWidth: origWidth,
      scaledHeight: origHeight,
    }
  }

  // For PNG → JPEG conversion, fill white background first
  if (ext === 'png') {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, targetWidth, targetHeight)
  }

  ctx.drawImage(bitmap, 0, 0, targetWidth, targetHeight)
  bitmap.close()

  // Determine output format
  const outputMime = ext === 'webp' ? 'image/webp' : 'image/jpeg'
  const outputBlob = await canvas.convertToBlob({
    type: outputMime,
    quality: scale,
  })

  const compressedBuffer = await outputBlob.arrayBuffer()
  return {
    base64: arrayBufferToBase64(compressedBuffer),
    mimeType: outputMime,
    originalWidth: origWidth,
    originalHeight: origHeight,
    scaledWidth: targetWidth,
    scaledHeight: targetHeight,
  }
}
