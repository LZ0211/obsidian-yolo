import type { App, TFile } from 'obsidian'

import {
  YoloSettingsLike,
  batchLookupImageCache,
  batchWriteImageCache,
  buildImageCacheKey,
} from '../../database/json/chat/imageCacheStore'
import { MentionableImage } from '../../types/mentionable'
import { arrayBufferToBase64 } from '../base64'

import { compressImage } from './imageCompress'

/**
 * Vault-file extensions we treat as images for vision payloads.
 *
 * Restricted to the intersection supported by all current provider adapters
 * (OpenAI / Anthropic / Bedrock / Gemini): jpeg, png, gif, webp. Adding
 * formats outside this set (e.g. svg, bmp, heic) would fail provider-side
 * MIME validation and abort the whole request.
 */
export const IMAGE_FILE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
])

const EXTENSION_TO_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

export function isImageTFile(file: TFile): boolean {
  const ext = file.extension?.toLowerCase() ?? ''
  return IMAGE_FILE_EXTENSIONS.has(ext)
}

export function getImageMimeTypeFromExtension(ext: string): string | null {
  return EXTENSION_TO_MIME[ext.toLowerCase()] ?? null
}

export function parseImageDataUrl(dataUrl: string): {
  mimeType: string
  base64Data: string
} {
  const matches = dataUrl.match(/^data:([^;]+);base64,(.+)/)
  if (!matches) {
    throw new Error('Invalid image data URL format')
  }
  const [, mimeType, base64Data] = matches
  return { mimeType, base64Data }
}

export async function fileToMentionableImage(
  file: File,
): Promise<MentionableImage> {
  const base64Data = await fileToBase64(file)
  return {
    type: 'image',
    name: file.name,
    mimeType: file.type,
    data: base64Data,
  }
}

/**
 * Files at or above this size are compressed before being sent to a model
 * (fs_read's plain-image branch). Base64 inflates raw bytes by ~33%, so a
 * 2 MB image becomes a ~2.7 MB request payload.
 */
export const IMAGE_COMPRESSION_THRESHOLD_BYTES = 2 * 1024 * 1024

/**
 * Read a vault image TFile and return a base64 data URL suitable for the
 * `image_url` content part used by OpenAI / Anthropic vision payloads.
 *
 * Pass `options.cache` to enable the persistent image cache.
 * When cache is disabled (default), behaviour is unchanged.
 */
export async function tFileToImageDataUrl(
  app: App,
  file: TFile,
  options?: { cache?: { enabled: true; settings?: YoloSettingsLike | null } },
): Promise<string> {
  const ext = file.extension?.toLowerCase() ?? ''
  const mimeType =
    getImageMimeTypeFromExtension(ext) ?? 'application/octet-stream'

  if (options?.cache?.enabled) {
    const key = buildImageCacheKey(file.path, file.stat.mtime, file.stat.size)
    const hits = await batchLookupImageCache(app, [key], options.cache.settings)
    const cached = hits.get(key)
    if (cached !== undefined) {
      return cached
    }

    const buffer = await app.vault.readBinary(file)
    const base64 = arrayBufferToBase64(buffer)
    const dataUrl = `data:${mimeType};base64,${base64}`

    void batchWriteImageCache(
      app,
      [{ hash: key, dataUrl, sourcePath: file.path }],
      options.cache.settings,
    ).catch((error) => {
      console.warn('[YOLO] Failed to write image cache', file.path, error)
    })

    return dataUrl
  }

  const buffer = await app.vault.readBinary(file)
  const base64 = arrayBufferToBase64(buffer)
  return `data:${mimeType};base64,${base64}`
}

/**
 * Read a vault image as a data URL, compressing it first when it exceeds
 * {@link IMAGE_COMPRESSION_THRESHOLD_BYTES} (GIFs excepted — they may be
 * animated). Returns whether compression happened so callers can surface a
 * model-visible notice.
 */
export async function tFileToImageDataUrlWithCompression(
  app: App,
  file: TFile,
  options: {
    quality: number
    cache?: { enabled: true; settings?: YoloSettingsLike | null }
  },
): Promise<{ url: string; compressed: boolean }> {
  const ext = file.extension?.toLowerCase() ?? ''
  if (ext === 'gif' || file.stat.size <= IMAGE_COMPRESSION_THRESHOLD_BYTES) {
    const url = await tFileToImageDataUrl(
      app,
      file,
      options.cache ? { cache: options.cache } : undefined,
    )
    return { url, compressed: false }
  }

  const buffer = await app.vault.readBinary(file)
  const compressed = await compressImage(buffer, ext, options.quality)
  return {
    url: `data:${compressed.mimeType};base64,${compressed.base64}`,
    compressed: true,
  }
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.readAsDataURL(file)
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
  })
}
