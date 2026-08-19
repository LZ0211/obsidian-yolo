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
 * gradio 5/6 API protocol implemented here (server protocol "sse_v3"):
 *   GET  {baseUrl}/gradio_api/config        → dependency list; fn_index for the api
 *   POST {baseUrl}/gradio_api/upload        body: multipart/form-data (files field)
 *     → ["/tmp/gradio/<hash>/<file>.pdf"]   (server-side path)
 *   POST {baseUrl}/gradio_api/queue/join    body: JSON data + fn_index + session_hash
 *     → { event_id }
 *   GET  {baseUrl}/gradio_api/queue/data?session_hash=<hash> → SSE stream
 *     process_completed: {"output":{"data":[...]}} carries the FileData zip
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
  msg?: string
  output?: { data?: unknown[]; error?: string | null }
  error?: string
  message?: string
  success?: boolean
  title?: string
}

/**
 * Conversion param values fixed to match the reference MinerU gradio app, in
 * the endpoint fn signature order: [max_pages, force_ocr,
 * formula_label_hybrid, table_enable, image_analysis_enable, ocr_language,
 * backend, server_url]. The job payload prepends the uploaded FileData.
 */
const MINERU_CONVERSION_PARAM_VALUES: unknown[] = [
  1000, // max_pages
  false, // force_ocr
  true, // formula_label_hybrid
  true, // table_enable
  true, // image_analysis_enable
  'ch (Chinese, English, Chinese Traditional)', // ocr_language
  'hybrid-auto-engine', // backend
  '', // server_url
]

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
 * Builds the multipart/form-data upload body byte-by-byte so the PDF is sent
 * as raw binary (a string body would be UTF-8-encoded and corrupt non-ASCII
 * bytes). The gradio 5/6 upload endpoint expects the file under `files`.
 */
function buildUploadBody(
  pdfBytes: Uint8Array,
  fileName: string,
  boundary: string,
): Uint8Array {
  const encoder = new TextEncoder()
  // Obsidian forbids some characters in file names but not quotes; sanitize so
  // the filename header cannot break out of the multipart structure.
  const safeName = fileName.replace(/["\r\n]/g, '_')
  const parts: Uint8Array[] = [
    encoder.encode(`--${boundary}\r\n`),
    encoder.encode(
      `Content-Disposition: form-data; name="files"; filename="${safeName}"\r\n`,
    ),
    encoder.encode('Content-Type: application/pdf\r\n\r\n'),
    pdfBytes,
    encoder.encode(`\r\n--${boundary}--\r\n`),
  ]

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

/**
 * Returns the last process_completed event, throwing on failed completions.
 * The terminal error signal in the sse_v3 protocol is `success: false` with
 * the reason in `output.error`, not a separate error event.
 */
function findTerminalEvent(payloads: string[]): GradioEvent {
  let terminal: GradioEvent | null = null
  for (const payload of payloads) {
    const event = parseGradioEvent(payload)
    if (!event) continue
    if (event.msg === 'process_completed') terminal = event
  }
  if (!terminal) {
    throw new Error('MinerU event stream ended without a completed event')
  }
  if (terminal.success === false) {
    const reason =
      terminal.output?.error ??
      terminal.error ??
      terminal.message ??
      terminal.title ??
      'unknown error'
    throw new Error(`MinerU conversion failed: ${reason}`)
  }
  return terminal
}

/** Picks the downloadable FileData entry (the convert_result zip) from the
 * terminal output; status/markdown strings and preview files are skipped. */
function findFileDataEntry(data: unknown[]): GradioFileData | null {
  for (const entry of data) {
    if (typeof entry !== 'object' || entry === null) continue
    const fileData = entry as GradioFileData
    if (typeof fileData.url === 'string' || typeof fileData.data === 'string') {
      return fileData
    }
  }
  return null
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

// Session-level fn_index cache per normalized endpoint; the /config fetch is
// deduplicated across concurrent conversions and kept for the session.
const mineruFnIndexPromises = new Map<string, Promise<number>>()

const newSessionHash = (): string =>
  `yolo-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`

/**
 * Fetches the gradio config object, trying the endpoint paths in order:
 * gradio 6+ serves `/config` at the root, gradio 5 exposes it under the
 * `/gradio_api/` prefix. Same sse_v3 protocol either way.
 */
async function fetchMinerUConfig(
  baseUrl: string,
  apiKey: string,
): Promise<{ dependencies?: Array<{ api_name?: string; id?: number }> }> {
  for (const path of ['/config', '/gradio_api/config']) {
    const response = await requestUrl({
      url: `${baseUrl}${path}`,
      method: 'GET',
      headers: { Accept: 'application/json', ...authHeaders(apiKey) },
      throw: false,
    })
    if (response.status >= 200 && response.status < 300) {
      return JSON.parse(response.text) as {
        dependencies?: Array<{ api_name?: string; id?: number }>
      }
    }
  }
  throw new Error('MinerU config endpoint unreachable')
}

/**
 * Resolves the gradio fn index of the conversion endpoint from /config
 * (the queue/join payload requires it; api names are not accepted there).
 * Fails fast when the endpoint is absent from the dependency list.
 */
function resolveMinerUFnIndex(
  baseUrl: string,
  apiKey: string,
  signal?: AbortSignal | null,
): Promise<number> {
  const existing = mineruFnIndexPromises.get(baseUrl)
  if (existing) return withAbort(existing, signal)

  const task = (async (): Promise<number> => {
    const config = await fetchMinerUConfig(baseUrl, apiKey)
    const dependency = (config.dependencies ?? []).find(
      (entry) => entry.api_name === MINERU_API_NAME.slice(1),
    )
    if (!dependency || typeof dependency.id !== 'number') {
      throw new Error('MinerU config did not expose the conversion endpoint')
    }
    return dependency.id
  })()

  mineruFnIndexPromises.set(baseUrl, task)
  // A failed discovery must not poison the session: retried on the next call.
  task.catch(() => {
    if (mineruFnIndexPromises.get(baseUrl) === task) {
      mineruFnIndexPromises.delete(baseUrl)
    }
  })
  return withAbort(task, signal)
}

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

  // ① Resolve the conversion endpoint's fn index (cached per session).
  const fnIndex = await resolveMinerUFnIndex(normalizedBaseUrl, apiKey, signal)
  throwIfAborted(signal)

  // ② Upload the PDF; the server returns the path used in the job payload.
  const boundary = `----yolo-mineru-${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const uploadResponse = await withAbort(
    requestUrl({
      url: `${normalizedBaseUrl}/gradio_api/upload`,
      method: 'POST',
      contentType: `multipart/form-data; boundary=${boundary}`,
      headers: { Accept: 'application/json', ...authHeaders(apiKey) },
      body: toArrayBuffer(
        buildUploadBody(new Uint8Array(pdfBytes), fileName, boundary),
      ),
      throw: true,
    }),
    signal,
  )
  throwIfAborted(signal)

  let serverPath: string | undefined
  try {
    serverPath = (JSON.parse(uploadResponse.text) as string[])[0]
  } catch {
    serverPath = undefined
  }
  if (!serverPath) {
    throw new Error(
      `MinerU upload did not return a server file path (HTTP ${uploadResponse.status})`,
    )
  }

  // ③ Queue the conversion job; results stream on queue/data keyed by session.
  const sessionHash = newSessionHash()
  const joinResponse = await withAbort(
    requestUrl({
      url: `${normalizedBaseUrl}/gradio_api/queue/join`,
      method: 'POST',
      contentType: 'application/json',
      headers: { Accept: 'application/json', ...authHeaders(apiKey) },
      body: JSON.stringify({
        data: [
          {
            path: serverPath,
            orig_name: fileName,
            meta: { _type: 'gradio.FileData' },
          },
          ...MINERU_CONVERSION_PARAM_VALUES,
        ],
        event_data: null,
        fn_index: fnIndex,
        session_hash: sessionHash,
      }),
      throw: true,
    }),
    signal,
  )
  throwIfAborted(signal)

  let eventId: string | undefined
  try {
    eventId = (JSON.parse(joinResponse.text) as { event_id?: string }).event_id
  } catch {
    eventId = undefined
  }
  if (!eventId) {
    throw new Error(
      `MinerU job start response did not include an event_id (HTTP ${joinResponse.status})`,
    )
  }

  // ④ Stream the SSE events until the terminal process_completed event.
  const eventResponse = await withAbort(
    requestUrl({
      url: `${normalizedBaseUrl}/gradio_api/queue/data?session_hash=${sessionHash}`,
      method: 'GET',
      headers: { Accept: 'text/event-stream', ...authHeaders(apiKey) },
      throw: true,
    }),
    signal,
  )
  throwIfAborted(signal)

  // ⑤ Resolve the result FileData (the zip) from the terminal event.
  const terminal = findTerminalEvent(parseSseDataPayloads(eventResponse.text))
  const resultFileData = findFileDataEntry(terminal.output?.data ?? [])
  if (!resultFileData) {
    throw new Error('MinerU conversion result contains no downloadable file')
  }

  const bytes = await resolveFileDataBytes(
    resultFileData,
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
 * conversion endpoint is exposed with the modern (gradio 5+) schema. Any
 * network error, non-2xx status, a missing endpoint, or a legacy gradio-4
 * parameter shape (string labels) resolves to false.
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
    const info = JSON.parse(response.text) as {
      named_endpoints?: Record<string, { parameters?: unknown[] }>
    }
    const entry = Object.entries(info.named_endpoints ?? {}).find(
      ([name]) => name.replace(/^\//, '') === MINERU_API_NAME.slice(1),
    )
    if (!entry) return false
    // gradio 5+ describes parameters with i18n label dicts; gradio 4 uses
    // plain strings and the legacy call protocol this client does not speak.
    const firstParameter = (entry[1].parameters ?? [])[0] as
      | { label?: unknown }
      | undefined
    return typeof firstParameter?.label === 'object'
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

/** Clears the failure counter, the session break, and the fn_index cache
 * (call at session start). */
export function resetMinerUSessionState(): void {
  mineruBreakerStates.clear()
  mineruFnIndexPromises.clear()
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
