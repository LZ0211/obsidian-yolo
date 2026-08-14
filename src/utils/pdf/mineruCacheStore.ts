import type { App, DataAdapter, TFile } from 'obsidian'
import { normalizePath } from 'obsidian'

import { getYoloProjectsDir } from '../../core/paths/yoloPaths'
import { arrayBufferToBase64 } from '../base64'
import { sha256Hex } from '../common/content-hash'

import {
  type MinerUConversionResult,
  type MinerUOptions,
  type MinerURawConversionResult,
  convertPdfToMarkdown,
} from './mineruClient'

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
    projectsDir?: string
  }
}

export type MineruCacheManifest = {
  version: 1
  createdAt: string
  images: { name: string; vaultPath: string }[]
}

/**
 * Vault-relative cache directory for one PDF conversion:
 * `{getYoloProjectsDir(settings)}/mineru-cache/{hash16}` where `hash16` is the
 * first 16 hex chars of the SHA-256 of the PDF content. The caller computes
 * the hash (it requires reading the file); pass the yolo settings to honor a
 * configured projectsDir.
 */
export function getMineruCacheDir(
  hash16: string,
  settings?: YoloSettingsLike | null,
): string {
  return normalizePath(`${getYoloProjectsDir(settings)}/mineru-cache/${hash16}`)
}

const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer

/** Creates every missing path segment (Obsidian mkdir only creates one dir). */
async function ensureDir(adapter: DataAdapter, dirPath: string): Promise<void> {
  const segments = dirPath.split('/').filter(Boolean)
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    if (!(await adapter.exists(current))) {
      await adapter.mkdir(current)
    }
  }
}

/**
 * Reads a complete cache entry, or null when anything is missing: the
 * manifest must parse, list every image, and every listed file must exist on
 * disk. A failed/incomplete cache is disposable — the caller re-converts.
 */
async function readCacheIfComplete(
  app: App,
  cacheDir: string,
): Promise<MinerUConversionResult | null> {
  const adapter = app.vault.adapter
  const manifestPath = `${cacheDir}/manifest.json`
  const resultPath = `${cacheDir}/result.md`
  try {
    if (!(await adapter.exists(manifestPath))) return null
    if (!(await adapter.exists(resultPath))) return null
    const manifest = JSON.parse(
      await adapter.read(manifestPath),
    ) as MineruCacheManifest
    if (manifest.version !== 1 || !Array.isArray(manifest.images)) return null
    for (const image of manifest.images) {
      if (
        typeof image?.name !== 'string' ||
        typeof image.vaultPath !== 'string'
      ) {
        return null
      }
      if (!(await adapter.exists(image.vaultPath))) return null
    }
    return {
      markdown: await adapter.read(resultPath),
      images: manifest.images,
    }
  } catch (error) {
    console.warn(
      `[YOLO] MinerU cache read failed for ${cacheDir}; will re-convert:`,
      error instanceof Error ? error.message : error,
    )
    return null
  }
}

async function writeCache(
  app: App,
  cacheDir: string,
  raw: MinerURawConversionResult,
): Promise<MinerUConversionResult> {
  const adapter = app.vault.adapter
  await ensureDir(adapter, `${cacheDir}/images`)

  const images: MinerUConversionResult['images'] = []
  for (const image of raw.images) {
    const vaultPath = normalizePath(`${cacheDir}/images/${image.name}`)
    await adapter.writeBinary(vaultPath, toArrayBuffer(image.data))
    images.push({ name: image.name, vaultPath })
  }

  const resultPath = `${cacheDir}/result.md`
  await adapter.write(resultPath, raw.markdown)

  const manifest: MineruCacheManifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    images,
  }
  await adapter.write(`${cacheDir}/manifest.json`, JSON.stringify(manifest))

  return { markdown: raw.markdown, images }
}

// Same-hash conversions running concurrently share one network round-trip.
const inFlightConversions = new Map<string, Promise<MinerUConversionResult>>()

/**
 * Converts a PDF via MinerU with a content-hash cache: cache hits return the
 * stored markdown + image list without touching the network; misses run the
 * gradio conversion and persist the result under
 * `{projectsDir}/mineru-cache/{hash16}/`. Concurrent conversions of the same
 * content share a single in-flight request.
 *
 * Throws (fail-fast) when MinerU is disabled or misconfigured; callers gate on
 * their own availability checks and fall back to the legacy PDF pipeline.
 */
export async function convertPdfViaMinerU(input: {
  app: App
  file: TFile
  options: MinerUOptions
  /** Yolo settings used only for cache path resolution (projectsDir). */
  settings?: YoloSettingsLike | null
  signal?: AbortSignal | null
}): Promise<MinerUConversionResult> {
  const { app, file, options, signal } = input
  if (!options.enabled) {
    throw new Error('MinerU is disabled; enable it in settings first')
  }
  const baseUrl = (options.baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!baseUrl) {
    throw new Error('MinerU baseUrl is empty; configure it in settings first')
  }

  const pdfBytes = await app.vault.readBinary(file)
  const hash16 = (await sha256Hex(arrayBufferToBase64(pdfBytes))).slice(0, 16)
  const cacheDir = getMineruCacheDir(hash16, input.settings)

  const inFlight = inFlightConversions.get(hash16)
  if (inFlight) return inFlight

  const task = (async (): Promise<MinerUConversionResult> => {
    const cached = await readCacheIfComplete(app, cacheDir)
    if (cached) return cached

    const raw = await convertPdfToMarkdown({
      pdfBytes,
      fileName: file.name,
      baseUrl,
      apiKey: options.apiKey,
      signal,
    })
    return writeCache(app, cacheDir, raw)
  })().finally(() => {
    inFlightConversions.delete(hash16)
  })

  inFlightConversions.set(hash16, task)
  return task
}
