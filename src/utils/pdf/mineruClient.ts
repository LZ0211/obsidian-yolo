import * as JSZipModule from 'jszip'
import { requestUrl } from 'obsidian'

import { base64ToUint8Array } from '../base64'

type JSZipConstructor = typeof import('jszip')
type JSZipInstance = InstanceType<JSZipConstructor>

const JSZip =
  (JSZipModule as unknown as { default?: JSZipConstructor }).default ??
  JSZipModule

export type MinerUOptions = {
  enabled: boolean
  baseUrl: string
  apiKey: string
}

export type MinerUConversionResult = {
  markdown: string
  images: { name: string; vaultPath: string }[]
}

/** Session-level availability used by the three-way integration (T3). */
export type MinerUAvailability = 'available' | 'unavailable'

/** Raw image extracted from a MinerU zip, before it is written to the vault. */
export type MinerURawImage = { name: string; data: Uint8Array }

/** Protocol-level conversion result (no vault paths yet; see MinerUConversionResult). */
export type MinerURawConversionResult = {
  markdown: string
  images: MinerURawImage[]
}

export const MINERU_API_NAME = '/convert_to_markdown_stream'

/**
 * gradio 4.x API protocol implemented here:
 *   POST {baseUrl}/gradio_api/call/{api_name}  body: multipart/form-data (pdf + params)
 *     → { event_id }
 *   GET  {baseUrl}/gradio_api/call/{event_id}  → SSE stream (heartbeat/complete/error)
 *   complete: {"output":{"data":[FileData|string]}}
 *   FileData: { path?, url?, data?, orig_name, meta: {_type:"gradio.FileData"} }
 */

type GradioFileData = {
  path?: string
  url?: string
  data?: string
  orig_name?: string
  meta?: { _type?: string }
}

type GradioEvent = {
  type?: string
  output?: { data?: unknown[] }
  error?: string
  message?: string
}

/** Conversion params fixed to match the reference mineru_runner.py defaults. */
type MinerUConversionParams = {
  end_pages: number
  is_ocr: boolean
  formula_enable: boolean
  table_enable: boolean
  image_analysis: boolean
  language: string
  backend: string
}

const MINERU_CONVERSION_PARAMS: MinerUConversionParams = {
  end_pages: 1000,
  is_ocr: false,
  formula_enable: true,
  table_enable: true,
  image_analysis: true,
  language: 'ch (Chinese, English, Chinese Traditional)',
  backend: 'hybrid-auto-engine',
}

const MINERU_IMAGE_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.webp',
  '.gif',
  '.bmp',
  '.tif',
  '.tiff',
])

const createAbortError = (): DOMException =>
  new DOMException('The MinerU conversion was aborted.', 'AbortError')

const throwIfAborted = (signal?: AbortSignal | null): void => {
  if (signal?.aborted) {
    throw createAbortError()
  }
}

/**
 * requestUrl has no AbortSignal support (obsidian.d.ts RequestUrlParam), so
 * cancellation is emulated: pre-abort checks plus a signal listener that
 * rejects the caller-facing promise. The underlying HTTP request itself is not
 * cancellable, which is fine — the conversion result is discarded on abort.
 */
const withAbort = <T>(
  promise: Promise<T>,
  signal?: AbortSignal | null,
): Promise<T> => {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(createAbortError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(createAbortError())
    }
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error instanceof Error ? error : new Error(String(error)))
      },
    )
  })
}

const authHeaders = (apiKey: string): Record<string, string> =>
  apiKey ? { Authorization: apiKey } : {}

/** Copies a Uint8Array view into a standalone ArrayBuffer (adapter writes). */
export const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer

/**
 * Builds a multipart/form-data body byte-by-byte so the PDF is uploaded as raw
 * binary (a string body would be UTF-8-encoded and corrupt non-ASCII bytes).
 */
function buildMultipartBody(
  pdfBytes: Uint8Array,
  fileName: string,
  boundary: string,
): Uint8Array {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = []
  const pushText = (text: string): void => {
    parts.push(encoder.encode(text))
  }
  // Obsidian forbids some characters in file names but not quotes; sanitize so
  // the filename header cannot break out of the multipart structure.
  const safeName = fileName.replace(/["\r\n]/g, '_')

  pushText(`--${boundary}\r\n`)
  pushText(
    `Content-Disposition: form-data; name="file_path"; filename="${safeName}"\r\n`,
  )
  pushText('Content-Type: application/pdf\r\n\r\n')
  parts.push(pdfBytes)
  pushText('\r\n')

  for (const [key, value] of Object.entries(MINERU_CONVERSION_PARAMS)) {
    pushText(`--${boundary}\r\n`)
    pushText(`Content-Disposition: form-data; name="${key}"\r\n\r\n`)
    pushText(String(value))
    pushText('\r\n')
  }
  pushText(`--${boundary}--\r\n`)

  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const body = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    body.set(part, offset)
    offset += part.length
  }
  return body
}

/** Splits a full SSE payload into `data:` payload strings. */
function parseSseDataPayloads(text: string): string[] {
  const payloads: string[] = []
  for (const block of text.split(/\r?\n\r?\n/)) {
    for (const line of block.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed.startsWith('data:')) {
        const payload = trimmed.slice(5).trimStart()
        if (payload.length > 0) payloads.push(payload)
      }
    }
  }
  return payloads
}

const parseGradioEvent = (payload: string): GradioEvent | null => {
  if (payload === '[DONE]') return null
  try {
    return JSON.parse(payload) as GradioEvent
  } catch {
    return null
  }
}

/** Returns the last terminal (complete/error) event, throwing on error events. */
function findTerminalEvent(payloads: string[]): GradioEvent {
  let terminal: GradioEvent | null = null
  for (const payload of payloads) {
    const event = parseGradioEvent(payload)
    if (!event) continue
    if (event.type === 'complete' || event.type === 'error') terminal = event
  }
  if (!terminal) {
    throw new Error('MinerU event stream ended without a complete event')
  }
  if (terminal.type === 'error') {
    const reason = terminal.error ?? terminal.message ?? 'unknown error'
    throw new Error(`MinerU conversion failed: ${reason}`)
  }
  return terminal
}

const basenameOf = (path: string): string => {
  const cleaned = path.replace(/\\/g, '/')
  return cleaned.slice(cleaned.lastIndexOf('/') + 1)
}

const isZip = (bytes: Uint8Array): boolean =>
  bytes.length >= 4 &&
  bytes[0] === 0x50 &&
  bytes[1] === 0x4b &&
  bytes[2] === 0x03 &&
  bytes[3] === 0x04

/** Mirrors the reference script's ensure_unique_path for colliding zip names. */
function ensureUniqueName(used: Set<string>, name: string): string {
  if (!used.has(name)) return name
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  let counter = 1
  while (used.has(`${stem} ${counter}${ext}`)) counter += 1
  return `${stem} ${counter}${ext}`
}

async function parseZipResult(
  zipBytes: ArrayBuffer | Uint8Array,
): Promise<MinerURawConversionResult> {
  let zip: JSZipInstance
  try {
    zip = await JSZip.loadAsync(zipBytes)
  } catch (error) {
    throw new Error(
      `MinerU zip result could not be parsed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }

  const entries = Object.values(zip.files)
  const markdownEntries = entries.filter(
    (entry) => !entry.dir && /\.md$/i.test(entry.name),
  )
  if (markdownEntries.length === 0) {
    throw new Error('MinerU zip result contains no markdown file')
  }

  const markdown = await markdownEntries[0].async('text')
  const images: MinerURawImage[] = []
  const usedNames = new Set<string>()
  for (const entry of entries) {
    if (entry.dir) continue
    const baseName = basenameOf(entry.name)
    const extension = baseName.slice(baseName.lastIndexOf('.')).toLowerCase()
    if (!MINERU_IMAGE_EXTENSIONS.has(extension)) continue
    const uniqueName = ensureUniqueName(usedNames, baseName)
    usedNames.add(uniqueName)
    const data = new Uint8Array(await entry.async('arraybuffer'))
    images.push({ name: uniqueName, data })
  }
  return { markdown, images }
}

async function resolveFileDataBytes(
  fileData: GradioFileData,
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal | null,
): Promise<Uint8Array> {
  if (typeof fileData.data === 'string' && fileData.data.length > 0) {
    // Inline data URI ("data:...;base64,<payload>") or a bare base64 payload.
    const comma = fileData.data.indexOf(',')
    const base64 = comma >= 0 ? fileData.data.slice(comma + 1) : fileData.data
    return base64ToUint8Array(base64)
  }
  if (typeof fileData.url === 'string' && fileData.url.length > 0) {
    const url = fileData.url.startsWith('http')
      ? fileData.url
      : `${baseUrl}/${fileData.url.replace(/^\/+/, '')}`
    const response = await withAbort(
      requestUrl({
        url,
        method: 'GET',
        headers: {
          Accept: 'application/octet-stream',
          ...authHeaders(apiKey),
        },
        throw: true,
      }),
      signal,
    )
    return new Uint8Array(response.arrayBuffer)
  }
  throw new Error(
    'MinerU returned a FileData without a downloadable url or inline data',
  )
}

/**
 * Runs one PDF through the MinerU gradio API and returns the raw conversion
 * (markdown text plus extracted images). No caching here — see
 * `mineruCacheStore.convertPdfViaMinerU` for the cached entry point.
 */
async function runMinerUConversion(input: {
  pdfBytes: ArrayBuffer
  fileName: string
  baseUrl: string
  apiKey: string
  signal?: AbortSignal | null
}): Promise<MinerURawConversionResult> {
  const { pdfBytes, fileName, baseUrl, apiKey, signal } = input
  throwIfAborted(signal)

  const normalizedBaseUrl = (baseUrl ?? '').replace(/\/+$/, '')
  if (!normalizedBaseUrl) {
    throw new Error('MinerU baseUrl is empty')
  }
  const boundary = `----yolo-mineru-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const multipart = buildMultipartBody(
    new Uint8Array(pdfBytes),
    fileName,
    boundary,
  )

  // ① POST the PDF: { event_id }
  const startResponse = await withAbort(
    requestUrl({
      url: `${normalizedBaseUrl}/gradio_api/call/${MINERU_API_NAME.replace(/^\//, '')}`,
      method: 'POST',
      contentType: `multipart/form-data; boundary=${boundary}`,
      headers: { Accept: 'application/json', ...authHeaders(apiKey) },
      body: toArrayBuffer(multipart),
      throw: true,
    }),
    signal,
  )
  throwIfAborted(signal)

  let eventId: string | undefined
  try {
    eventId = (JSON.parse(startResponse.text) as { event_id?: string }).event_id
  } catch {
    eventId = undefined
  }
  if (!eventId) {
    throw new Error(
      `MinerU job start response did not include an event_id (HTTP ${startResponse.status})`,
    )
  }

  // ② Poll the SSE event stream until complete/error (single long-running GET).
  const eventResponse = await withAbort(
    requestUrl({
      url: `${normalizedBaseUrl}/gradio_api/call/${eventId}`,
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...authHeaders(apiKey) },
      throw: true,
    }),
    signal,
  )
  throwIfAborted(signal)

  // ③ Parse the terminal event and its output.
  const terminal = findTerminalEvent(parseSseDataPayloads(eventResponse.text))
  const output = terminal.output?.data?.[0]

  if (typeof output === 'string') {
    return { markdown: output, images: [] }
  }

  const bytes = await resolveFileDataBytes(
    output as GradioFileData,
    normalizedBaseUrl,
    apiKey,
    signal,
  )
  if (isZip(bytes)) {
    return parseZipResult(toArrayBuffer(bytes))
  }

  const markdown = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  if (markdown.trim().length === 0) {
    throw new Error('MinerU returned an empty result')
  }
  return { markdown, images: [] }
}

export async function convertPdfToMarkdown(input: {
  pdfBytes: ArrayBuffer
  fileName: string
  baseUrl: string
  apiKey: string
  signal?: AbortSignal | null
}): Promise<MinerURawConversionResult> {
  const endpoint = normalizeMinerUEndpoint(input.baseUrl)
  try {
    const result = await runMinerUConversion(input)
    markMinerUSuccess(endpoint)
    return result
  } catch (error) {
    if (!(error instanceof DOMException && error.name === 'AbortError')) {
      markMinerUFailure(endpoint)
    }
    throw error
  }
}

/**
 * Connectivity probe: GET {baseUrl}/gradio_api/info and check that the
 * conversion endpoint is exposed. Any network error, non-2xx status, or a
 * missing endpoint resolves to false.
 */
export async function probeMinerU(
  baseUrl: string,
  apiKey: string,
): Promise<boolean> {
  const normalizedBaseUrl = (baseUrl ?? '').replace(/\/+$/, '')
  if (!normalizedBaseUrl) return false
  try {
    const response = await requestUrl({
      url: `${normalizedBaseUrl}/gradio_api/info`,
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders(apiKey) },
      throw: false,
    })
    if (response.status < 200 || response.status >= 300) return false
    // gradio 4.x exposes named endpoints with a leading slash; match the bare
    // name so both shapes ("/convert_to_markdown_stream" and without) probe OK.
    return response.text.includes(MINERU_API_NAME.slice(1))
  } catch {
    return false
  }
}

/** Minimal structural view of the settings object the three-way integration
 * reads MinerU config from (full `YoloSettings.mineru` is assignable). */
type MinerUSettingsLike = {
  mineru?: {
    enabled?: boolean
    baseUrl?: string
    apiKey?: string
  }
}

// Session-level circuit breakers shared by the three-way integration (fs_read /
// RAG indexing / attachment context), isolated per normalized endpoint.
type MinerUBreakerState = { consecutiveFailures: number; brokenAt: number }
const mineruBreakerStates = new Map<string, MinerUBreakerState>()
const MINERU_CONSECUTIVE_FAILURE_THRESHOLD = 3
/** 熔断后自动恢复的冷却窗口：服务端恢复后无需重启插件即可重新使用。 */
export const MINERU_BREAKER_COOLDOWN_MS = 5 * 60 * 1000

const normalizeMinerUEndpoint = (baseUrl: string | null | undefined): string =>
  (baseUrl ?? '').trim().replace(/\/+$/, '')

/** MinerU availability gate: switch on + baseUrl configured + not circuit-broken. */
export function isMinerUEnabled(
  settings: MinerUSettingsLike | null | undefined,
): boolean {
  const mineru = settings?.mineru
  const endpoint = normalizeMinerUEndpoint(mineru?.baseUrl)
  if (!mineru?.enabled || !endpoint) return false

  const state = mineruBreakerStates.get(endpoint)
  if (!state?.brokenAt) return true
  if (Date.now() - state.brokenAt < MINERU_BREAKER_COOLDOWN_MS) return false
  mineruBreakerStates.delete(endpoint)
  return true
}

/** Counts one conversion failure; the third consecutive one breaks the session. */
export function markMinerUFailure(baseUrl: string): void {
  const endpoint = normalizeMinerUEndpoint(baseUrl)
  if (!endpoint) return
  const current = mineruBreakerStates.get(endpoint)
  const consecutiveFailures = (current?.consecutiveFailures ?? 0) + 1
  mineruBreakerStates.set(endpoint, {
    consecutiveFailures,
    brokenAt:
      consecutiveFailures >= MINERU_CONSECUTIVE_FAILURE_THRESHOLD
        ? Date.now()
        : 0,
  })
}

/** A successful conversion clears prior failures for the same endpoint. */
export function markMinerUSuccess(baseUrl: string): void {
  mineruBreakerStates.delete(normalizeMinerUEndpoint(baseUrl))
}

/** Clears the failure counter and the session break (call at session start). */
export function resetMinerUSessionState(): void {
  mineruBreakerStates.clear()
}

const MARKDOWN_IMAGE_REF_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

/**
 * Rewrites `![](relative path)` image references in the converted markdown to
 * vault-relative absolute paths (for reading via the vault adapter), matching
 * by basename against the cached image list. Returns the rewritten markdown
 * plus the referenced vault paths in order of appearance, capped at `limit`.
 */
export function resolveMinerUImageRefs(
  markdown: string,
  images: MinerUConversionResult['images'],
  limit: number,
): { refs: string[]; markdown: string } {
  const byBasename = new Map<string, MinerUConversionResult['images'][number]>()
  for (const image of images) {
    byBasename.set(basenameOf(image.name).toLowerCase(), image)
  }

  const refs: string[] = []
  const refSet = new Set<string>()
  const rewritten = markdown.replace(
    MARKDOWN_IMAGE_REF_RE,
    (full, alt: string, target: string) => {
      const image = byBasename.get(basenameOf(target).toLowerCase())
      if (!image) return full
      if (refSet.has(image.vaultPath)) {
        // Already counted within the limit; rewriting is harmless.
        return `![${alt}](${image.vaultPath})`
      }
      if (refs.length >= limit) return full
      refSet.add(image.vaultPath)
      refs.push(image.vaultPath)
      return `![${alt}](${image.vaultPath})`
    },
  )
  return { refs, markdown: rewritten }
}
