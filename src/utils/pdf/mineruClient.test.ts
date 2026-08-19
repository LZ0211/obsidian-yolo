import * as JSZipModule from 'jszip'
import {
  type RequestUrlParam,
  type RequestUrlResponse,
  type RequestUrlResponsePromise,
  requestUrl,
} from 'obsidian'

import { arrayBufferToBase64 } from '../base64'

import {
  MINERU_BREAKER_COOLDOWN_MS,
  convertPdfToMarkdown,
  isMinerUEnabled,
  markMinerUFailure,
  markMinerUSuccess,
  probeMinerU,
  resetMinerUSessionState,
  resolveMinerUImageRefs,
} from './mineruClient'

type JSZipConstructor = typeof import('jszip')
type JSZipInstance = InstanceType<JSZipConstructor>

const JSZip =
  (JSZipModule as unknown as { default?: JSZipConstructor }).default ??
  JSZipModule

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

const BASE_URL = 'http://mineru.test'
const API_KEY = 'Bearer xxx'
const FORMER_REQUEST_TIMEOUT_MS = 120_000
const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4\n% mock pdf for mineru\n%%EOF',
)

const MARKDOWN = '# Report\n\n![](images/1.png)\n\nBody text.\n'

const responseWithText = (text: string, status = 200): RequestUrlResponse => ({
  status,
  headers: {},
  arrayBuffer: new TextEncoder().encode(text).buffer,
  json: null,
  text,
})

const responseWithArrayBuffer = (
  arrayBuffer: ArrayBuffer,
): RequestUrlResponse => ({
  status: 200,
  headers: {},
  arrayBuffer,
  json: null,
  text: '',
})

const buildZip = async (
  files: Record<string, string | Uint8Array>,
): Promise<ArrayBuffer> => {
  const zip: JSZipInstance = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content)
  }
  return await zip.generateAsync({ type: 'arraybuffer' })
}

/** /config response exposing the conversion endpoint as dependency id 6. */
const CONFIG_RESPONSE_TEXT = JSON.stringify({
  dependencies: [{ api_name: 'convert_to_markdown_stream', id: 6 }],
})

/** /gradio_api/upload response: server-side path of the uploaded pdf. */
const UPLOAD_RESPONSE_TEXT = JSON.stringify(['/tmp/gradio/uploaded.pdf'])

const JOIN_RESPONSE_TEXT = JSON.stringify({ event_id: 'evt-1' })

/** SSE terminal event in the gradio 5/6 shape: msg process_completed. */
const sseCompletedWith = (data: unknown[]): string =>
  [
    'data: {"msg":"heartbeat","event_id":"evt-1"}',
    '',
    `data: ${JSON.stringify({
      msg: 'process_completed',
      event_id: 'evt-1',
      output: { data, error: null, duration: 1, visible: true, title: '' },
      success: true,
      title: '',
    })}`,
  ].join('\n\n')

const fileData = (
  overrides: Record<string, string>,
): Record<string, string> => ({
  path: '/tmp/x.zip',
  url: `${BASE_URL}/gradio_api/file=zip-1`,
  orig_name: 'x.zip',
  ...overrides,
})

/**
 * Queues one full sse_v3 conversion: config → upload → queue/join →
 * queue/data SSE → optional zip download. `zipBuffer` is required whenever
 * the FileData result is downloaded via its url. Pass `skipConfig` when the
 * fn_index is already cached for the session (no /config request is made).
 */
const mockZipConversion = (
  data = fileData({}),
  zipBuffer?: ArrayBuffer,
  skipConfig = false,
): void => {
  if (!skipConfig) {
    mockedRequestUrl.mockResolvedValueOnce(
      responseWithText(CONFIG_RESPONSE_TEXT),
    )
  }
  mockedRequestUrl
    .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
    .mockResolvedValueOnce(responseWithText(JOIN_RESPONSE_TEXT))
    .mockResolvedValueOnce(
      responseWithText(
        sseCompletedWith([
          '<div class="status">ok</div>',
          { ...data, meta: { _type: 'gradio.FileData' } },
        ]),
      ),
    )
  if (zipBuffer) {
    mockedRequestUrl.mockResolvedValueOnce(responseWithArrayBuffer(zipBuffer))
  }
}

/** requestUrl accepts a bare string overload; normalize calls to RequestUrlParam. */
const requestParams = (call: unknown[]): RequestUrlParam =>
  typeof call[0] === 'string' ? { url: call[0] } : (call[0] as RequestUrlParam)

const decodeBody = (call: unknown[]): unknown => {
  const body = requestParams(call).body
  if (body === undefined) return undefined
  const text = typeof body === 'string' ? body : new TextDecoder().decode(body)
  return JSON.parse(text)
}

const waitUntil = async (
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> => {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitUntil timed out')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const convert = (
  overrides: {
    fileName?: string
    apiKey?: string
    signal?: AbortSignal
  } = {},
) =>
  convertPdfToMarkdown({
    pdfBytes: PDF_BYTES.buffer,
    fileName: overrides.fileName ?? 'report.pdf',
    baseUrl: BASE_URL,
    apiKey: overrides.apiKey ?? API_KEY,
    signal: overrides.signal,
  })

describe('convertPdfToMarkdown', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
    resetMinerUSessionState()
  })

  afterEach(() => {
    resetMinerUSessionState()
  })

  it('converts via the gradio 5/6 sse_v3 protocol and parses a zip FileData result', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ])
    const zipBuffer = await buildZip({
      'result.md': MARKDOWN,
      'images/1.png': pngBytes,
    })
    mockZipConversion(fileData({}), zipBuffer)

    const result = await convert()

    expect(result.markdown).toBe(MARKDOWN)
    expect(result.images).toHaveLength(1)
    expect(result.images[0]?.name).toBe('1.png')
    expect(result.images[0]?.data).toEqual(pngBytes)

    expect(mockedRequestUrl).toHaveBeenCalledTimes(5)
    const [config, upload, join, stream, download] =
      mockedRequestUrl.mock.calls.map(requestParams)

    // ① fn_index discovery from /config (api_name → dependency id);
    // gradio 6+ serves the config at the root path, not /gradio_api/config.
    expect(config.url).toBe(`${BASE_URL}/config`)
    expect(config.method).toBe('GET')
    expect(config.headers?.['Authorization']).toBe(API_KEY)

    // ② upload: multipart body with the pdf under the `files` field
    expect(upload.url).toBe(`${BASE_URL}/gradio_api/upload`)
    expect(upload.method).toBe('POST')
    expect(upload.contentType).toMatch(/^multipart\/form-data; boundary=/)
    const uploadBody = new TextDecoder().decode(upload.body as ArrayBuffer)
    expect(uploadBody).toContain(
      'Content-Disposition: form-data; name="files"; filename="report.pdf"',
    )
    expect(uploadBody).toContain('%PDF-1.4')

    // ③ queue/join: JSON data array in the server fn signature order
    expect(join.url).toBe(`${BASE_URL}/gradio_api/queue/join`)
    expect(join.method).toBe('POST')
    expect(join.contentType).toContain('application/json')
    const joinBody = decodeBody(mockedRequestUrl.mock.calls[2] ?? []) as {
      data: unknown[]
      fn_index: number
      session_hash: string
    }
    expect(joinBody.fn_index).toBe(6)
    expect(joinBody.data[0]).toMatchObject({
      path: '/tmp/gradio/uploaded.pdf',
      orig_name: 'report.pdf',
      meta: { _type: 'gradio.FileData' },
    })
    // max_pages, force_ocr, formula_label_hybrid, table_enable,
    // image_analysis_enable, ocr_language, backend, server_url
    expect(joinBody.data.slice(1)).toEqual([
      1000,
      false,
      true,
      true,
      true,
      'ch (Chinese, English, Chinese Traditional)',
      'hybrid-auto-engine',
      '',
    ])

    // ④ SSE event stream keyed by the same session_hash
    expect(stream.url).toBe(
      `${BASE_URL}/gradio_api/queue/data?session_hash=${joinBody.session_hash}`,
    )
    expect(stream.method).toBe('GET')
    expect(stream.headers?.['Accept']).toContain('text/event-stream')

    // ⑤ FileData url download
    expect(download.url).toBe(`${BASE_URL}/gradio_api/file=zip-1`)
    expect(download.method).toBe('GET')
  })

  it('reuses the discovered fn_index for the same endpoint within the session', async () => {
    const zipBuffer = await buildZip({ 'result.md': MARKDOWN })
    mockZipConversion(fileData({}), zipBuffer)
    await convert()
    expect(mockedRequestUrl).toHaveBeenCalledTimes(5)

    // Second conversion: no /config fetch (4 requests).
    mockedRequestUrl.mockClear()
    mockZipConversion(fileData({}), zipBuffer, true)
    await convert({ fileName: 'b.pdf' })
    expect(mockedRequestUrl).toHaveBeenCalledTimes(4)
    expect(requestParams(mockedRequestUrl.mock.calls[0] ?? []).url).toBe(
      `${BASE_URL}/gradio_api/upload`,
    )

    // Session reset clears the cache: /config fetched again.
    resetMinerUSessionState()
    mockedRequestUrl.mockClear()
    mockZipConversion(fileData({}), zipBuffer)
    await convert({ fileName: 'c.pdf' })
    expect(mockedRequestUrl).toHaveBeenCalledTimes(5)
  })

  it('deduplicates a concurrent fn_index discovery into one config fetch', async () => {
    const zipBuffer = await buildZip({ 'result.md': MARKDOWN })
    // Both conversions interleave after the shared config fetch resolves:
    // upload, upload, join, join, stream, stream, zip, zip.
    mockedRequestUrl
      .mockResolvedValueOnce(responseWithText(CONFIG_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(JOIN_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(JOIN_RESPONSE_TEXT))
      .mockResolvedValueOnce(
        responseWithText(
          sseCompletedWith([
            '<div class="status">ok</div>',
            { ...fileData({}), meta: { _type: 'gradio.FileData' } },
          ]),
        ),
      )
      .mockResolvedValueOnce(
        responseWithText(
          sseCompletedWith([
            '<div class="status">ok</div>',
            {
              ...fileData({ url: `${BASE_URL}/gradio_api/file=zip-2` }),
              meta: { _type: 'gradio.FileData' },
            },
          ]),
        ),
      )
      .mockResolvedValueOnce(responseWithArrayBuffer(zipBuffer))
      .mockResolvedValueOnce(responseWithArrayBuffer(zipBuffer))

    const [a, b] = await Promise.all([
      convert(),
      convert({ fileName: 'b.pdf' }),
    ])
    expect(a.markdown).toBe(MARKDOWN)
    expect(b.markdown).toBe(MARKDOWN)
    // 1 shared config + 4 requests per conversion.
    expect(mockedRequestUrl).toHaveBeenCalledTimes(9)
  })

  it('throws when the config does not expose the conversion endpoint', async () => {
    mockedRequestUrl.mockResolvedValueOnce(
      responseWithText(
        JSON.stringify({
          dependencies: [{ api_name: 'convert_to_markdown', id: 3 }],
        }),
      ),
    )

    await expect(convert()).rejects.toThrow(
      /did not expose the conversion endpoint/,
    )
    expect(mockedRequestUrl).toHaveBeenCalledTimes(1)
  })

  it('decodes a FileData inline data URI without an extra download request', async () => {
    const md = '# Data uri'
    const zipBuffer = await buildZip({ 'result.md': md })
    const dataUri = `data:application/octet-stream;base64,${arrayBufferToBase64(zipBuffer)}`
    mockZipConversion(fileData({ url: '', path: '', data: dataUri }))

    const result = await convert()

    expect(result.markdown).toBe(md)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(4)
  })

  it('throws when the completed event contains no downloadable FileData', async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(responseWithText(CONFIG_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(JOIN_RESPONSE_TEXT))
      .mockResolvedValueOnce(
        responseWithText(sseCompletedWith(['<div class="status">ok</div>'])),
      )

    await expect(convert()).rejects.toThrow(/no downloadable file/)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(4)
  })

  it('sends the apiKey verbatim as the Authorization header on every request', async () => {
    const zipBuffer = await buildZip({ 'result.md': MARKDOWN })
    mockZipConversion(fileData({}), zipBuffer)

    await convert()

    expect(mockedRequestUrl).toHaveBeenCalledTimes(5)
    for (const call of mockedRequestUrl.mock.calls) {
      expect(requestParams(call).headers?.['Authorization']).toBe(API_KEY)
    }
  })

  it('omits the Authorization header when apiKey is empty', async () => {
    const zipBuffer = await buildZip({ 'result.md': MARKDOWN })
    mockZipConversion(fileData({}), zipBuffer)

    await convert({ apiKey: '' })

    for (const call of mockedRequestUrl.mock.calls) {
      expect(requestParams(call).headers?.['Authorization']).toBeUndefined()
    }
  })

  it('aborts immediately when the signal is already aborted (no request is made)', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(convert({ signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    })

    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('rejects with AbortError when the signal aborts while polling the event stream', async () => {
    const sseDeferred: {
      resolve: ((response: RequestUrlResponse) => void) | null
    } = { resolve: null }
    mockedRequestUrl
      .mockResolvedValueOnce(responseWithText(CONFIG_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(JOIN_RESPONSE_TEXT))
      .mockImplementationOnce(
        () =>
          new Promise<RequestUrlResponse>((resolve) => {
            sseDeferred.resolve = resolve
          }) as unknown as RequestUrlResponsePromise,
      )
    const controller = new AbortController()

    const promise = convert({ signal: controller.signal })

    await waitUntil(() => mockedRequestUrl.mock.calls.length === 4)
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    sseDeferred.resolve?.(responseWithText(''))
  })

  it('allows the event stream to outlast the former request timeout', async () => {
    const md = '# Slow'
    const zipBuffer = await buildZip({ 'result.md': md })
    const dataUri = `data:application/octet-stream;base64,${arrayBufferToBase64(zipBuffer)}`
    jest.useFakeTimers()
    try {
      let resolveEvent: ((response: RequestUrlResponse) => void) | undefined
      mockedRequestUrl
        .mockResolvedValueOnce(responseWithText(CONFIG_RESPONSE_TEXT))
        .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
        .mockResolvedValueOnce(responseWithText(JOIN_RESPONSE_TEXT))
        .mockImplementationOnce(
          () =>
            new Promise<RequestUrlResponse>((resolve) => {
              resolveEvent = resolve
            }) as unknown as RequestUrlResponsePromise,
        )

      const promise = convert()
      const assertion = expect(promise).resolves.toMatchObject({
        markdown: md,
      })

      await jest.advanceTimersByTimeAsync(FORMER_REQUEST_TIMEOUT_MS + 1000)
      resolveEvent?.(
        responseWithText(
          sseCompletedWith([
            '<div class="status">ok</div>',
            {
              ...fileData({ url: '', path: '', data: dataUri }),
              meta: { _type: 'gradio.FileData' },
            },
          ]),
        ),
      )
      jest.useRealTimers()
      await assertion
      expect(mockedRequestUrl).toHaveBeenCalledTimes(4)
    } finally {
      jest.useRealTimers()
    }
  })

  it('allows a FileData download to outlast the former request timeout', async () => {
    const zipBuffer = await buildZip({ 'result.md': MARKDOWN })
    jest.useFakeTimers()
    try {
      let resolveDownload: ((response: RequestUrlResponse) => void) | undefined
      mockedRequestUrl
        .mockResolvedValueOnce(responseWithText(CONFIG_RESPONSE_TEXT))
        .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
        .mockResolvedValueOnce(responseWithText(JOIN_RESPONSE_TEXT))
        .mockResolvedValueOnce(
          responseWithText(
            sseCompletedWith([
              '<div class="status">ok</div>',
              {
                ...fileData({ url: `${BASE_URL}/gradio_api/file=stalled` }),
                meta: { _type: 'gradio.FileData' },
              },
            ]),
          ),
        )
        .mockImplementationOnce(
          () =>
            new Promise<RequestUrlResponse>((resolve) => {
              resolveDownload = resolve
            }) as unknown as RequestUrlResponsePromise,
        )

      const promise = convert()
      const assertion = expect(promise).resolves.toMatchObject({
        markdown: MARKDOWN,
      })

      await jest.advanceTimersByTimeAsync(FORMER_REQUEST_TIMEOUT_MS + 1000)
      resolveDownload?.(responseWithArrayBuffer(zipBuffer))
      jest.useRealTimers()
      await assertion
      expect(mockedRequestUrl).toHaveBeenCalledTimes(5)
    } finally {
      jest.useRealTimers()
    }
  })

  it('surfaces the server error message from a failed completion', async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(responseWithText(CONFIG_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(JOIN_RESPONSE_TEXT))
      .mockResolvedValueOnce(
        responseWithText(
          [
            'data: {"msg":"heartbeat","event_id":"evt-1"}',
            '',
            `data: ${JSON.stringify({
              msg: 'process_completed',
              event_id: 'evt-1',
              output: {
                data: [],
                error: 'backend exploded',
                duration: 1,
                visible: true,
                title: 'Error',
              },
              success: false,
              title: 'Error',
            })}`,
          ].join('\n\n'),
        ),
      )

    await expect(convert()).rejects.toThrow(/backend exploded/)
  })

  it('falls back to /gradio_api/config when the root config endpoint 404s (gradio 5)', async () => {
    const markdownBase64 = btoa(MARKDOWN)
    mockedRequestUrl
      .mockResolvedValueOnce(responseWithText('Not Found', 404)) // /config
      .mockResolvedValueOnce(responseWithText(CONFIG_RESPONSE_TEXT)) // /gradio_api/config
      .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
      .mockResolvedValueOnce(responseWithText(JOIN_RESPONSE_TEXT))
      .mockResolvedValueOnce(
        responseWithText(
          sseCompletedWith([
            '<div class="status">ok</div>',
            {
              path: '/tmp/x.zip',
              data: `data:text/markdown;base64,${markdownBase64}`,
              orig_name: 'x.zip',
              meta: { _type: 'gradio.FileData' },
            },
          ]),
        ),
      )

    const result = await convert()

    const calls = mockedRequestUrl.mock.calls.map(requestParams)
    expect(calls[0]?.url).toBe(`${BASE_URL}/config`)
    expect(calls[1]?.url).toBe(`${BASE_URL}/gradio_api/config`)
    expect(result.markdown).toBe(MARKDOWN)
  })
})

describe('probeMinerU', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
  })

  it('returns true for a modern (gradio 5+) info schema exposing the conversion api', async () => {
    mockedRequestUrl.mockResolvedValueOnce(
      responseWithText(
        JSON.stringify({
          named_endpoints: {
            '/convert_to_markdown_stream': {
              parameters: [
                {
                  label: { key: 'upload_file', _type: 'translation_metadata' },
                  parameter_name: 'file_path',
                },
              ],
              returns: [],
            },
          },
        }),
      ),
    )

    await expect(probeMinerU(BASE_URL, API_KEY)).resolves.toBe(true)

    const params = requestParams(mockedRequestUrl.mock.calls[0] ?? [])
    expect(params.url).toBe(`${BASE_URL}/gradio_api/info`)
    expect(params.method).toBe('GET')
    expect(params.headers?.['Authorization']).toBe(API_KEY)
    expect(params.throw).toBe(false)
  })

  it('returns false for a legacy gradio 4 info schema (string labels)', async () => {
    mockedRequestUrl.mockResolvedValueOnce(
      responseWithText(
        JSON.stringify({
          named_endpoints: {
            '/convert_to_markdown_stream': {
              parameters: [
                { label: 'upload_file', parameter_name: 'file_path' },
              ],
              returns: [],
            },
          },
        }),
      ),
    )

    await expect(probeMinerU(BASE_URL, '')).resolves.toBe(false)
  })

  it('returns false for non-2xx responses', async () => {
    mockedRequestUrl.mockResolvedValueOnce(responseWithText('not found', 404))
    await expect(probeMinerU(BASE_URL, '')).resolves.toBe(false)
  })

  it('returns false when the conversion api is not exposed', async () => {
    mockedRequestUrl.mockResolvedValueOnce(
      responseWithText(
        JSON.stringify({
          named_endpoints: {
            '/convert_to_markdown': {
              parameters: [
                {
                  label: { key: 'upload_file', _type: 'translation_metadata' },
                  parameter_name: 'file_path',
                },
              ],
              returns: [],
            },
          },
        }),
      ),
    )
    await expect(probeMinerU(BASE_URL, '')).resolves.toBe(false)
  })

  it('returns false on network errors, invalid JSON, and empty base urls', async () => {
    mockedRequestUrl.mockRejectedValueOnce(new Error('connection refused'))
    await expect(probeMinerU(BASE_URL, '')).resolves.toBe(false)
    mockedRequestUrl.mockResolvedValueOnce(responseWithText('not json'))
    await expect(probeMinerU(BASE_URL, '')).resolves.toBe(false)
    await expect(probeMinerU('', '')).resolves.toBe(false)
  })
})

describe('resolveMinerUImageRefs', () => {
  const images = [
    {
      name: '1.png',
      vaultPath: 'Projects/mineru-cache/abc123/images/1.png',
    },
    {
      name: '2.jpg',
      vaultPath: 'Projects/mineru-cache/abc123/images/2.jpg',
    },
  ]

  it('rewrites refs in order of appearance, capped at the limit, deduplicated', () => {
    const md =
      'a ![](images/1.png) b ![](images/2.jpg) c ![](images/1.png) d ![](missing.png)'

    const { refs, markdown } = resolveMinerUImageRefs(md, images, 1)

    expect(refs).toEqual(['Projects/mineru-cache/abc123/images/1.png'])
    expect(markdown).toBe(
      'a ![](Projects/mineru-cache/abc123/images/1.png) b ![](images/2.jpg) c ![](Projects/mineru-cache/abc123/images/1.png) d ![](missing.png)',
    )
  })

  it('collects all refs up to the limit and leaves unmatched refs untouched', () => {
    const md = '![](images/2.jpg) ![](images/1.png)'

    const { refs, markdown } = resolveMinerUImageRefs(md, images, 10)

    expect(refs).toEqual([
      'Projects/mineru-cache/abc123/images/2.jpg',
      'Projects/mineru-cache/abc123/images/1.png',
    ])
    expect(markdown).toBe(
      '![](Projects/mineru-cache/abc123/images/2.jpg) ![](Projects/mineru-cache/abc123/images/1.png)',
    )
  })
})

describe('convertPdfToMarkdown job start', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
    resetMinerUSessionState()
  })

  afterEach(() => {
    resetMinerUSessionState()
  })

  it('allows a slow job-start POST to outlast the former request timeout', async () => {
    // JSZip generation uses timers internally; build the zip before entering
    // fake timers so the mock queue below can reference it.
    const zipBuffer = await buildZip({ 'result.md': MARKDOWN })
    jest.useFakeTimers()
    try {
      let resolveStart: ((response: RequestUrlResponse) => void) | undefined
      mockedRequestUrl
        .mockResolvedValueOnce(responseWithText(CONFIG_RESPONSE_TEXT))
        .mockResolvedValueOnce(responseWithText(UPLOAD_RESPONSE_TEXT))
        .mockImplementationOnce(
          () =>
            new Promise<RequestUrlResponse>((resolve) => {
              resolveStart = resolve
            }) as unknown as RequestUrlResponsePromise,
        )
        .mockResolvedValueOnce(
          responseWithText(
            sseCompletedWith([
              '<div class="status">ok</div>',
              {
                ...fileData({}),
                meta: { _type: 'gradio.FileData' },
              },
            ]),
          ),
        )
        .mockResolvedValueOnce(responseWithArrayBuffer(zipBuffer))

      const promise = convert()
      const assertion = expect(promise).resolves.toMatchObject({
        markdown: MARKDOWN,
      })

      await jest.advanceTimersByTimeAsync(FORMER_REQUEST_TIMEOUT_MS + 1000)
      resolveStart?.(responseWithText(JOIN_RESPONSE_TEXT))
      jest.useRealTimers()
      await assertion
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('MinerU session circuit breaker', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
    resetMinerUSessionState()
  })

  afterEach(() => {
    resetMinerUSessionState()
  })

  it('counts failures from actual conversion attempts', async () => {
    mockedRequestUrl.mockRejectedValue(new Error('network down'))

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(convert()).rejects.toThrow('network down')
    }

    expect(
      isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }),
    ).toBe(false)
  })

  it('clears prior failures after an actual conversion succeeds', async () => {
    markMinerUFailure(BASE_URL)
    markMinerUFailure(BASE_URL)
    const zipBuffer = await buildZip({ 'result.md': MARKDOWN })
    mockZipConversion(fileData({}), zipBuffer)

    await convert()
    markMinerUFailure(BASE_URL)

    expect(
      isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }),
    ).toBe(true)
  })

  it('tracks consecutive failures per endpoint and recovers after success or cooldown', () => {
    jest.useFakeTimers()
    try {
      resetMinerUSessionState()
      markMinerUFailure(BASE_URL)
      markMinerUFailure(BASE_URL)
      expect(
        isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }),
      ).toBe(true)

      markMinerUSuccess(BASE_URL)
      markMinerUFailure(BASE_URL)
      markMinerUFailure(BASE_URL)
      expect(
        isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }),
      ).toBe(true)

      markMinerUFailure(BASE_URL)
      expect(
        isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }),
      ).toBe(false)
      expect(
        isMinerUEnabled({
          mineru: { enabled: true, baseUrl: 'http://mineru-other.test' },
        }),
      ).toBe(true)

      // 冷却窗口未过：仍然熔断。
      jest.advanceTimersByTime(MINERU_BREAKER_COOLDOWN_MS - 1000)
      expect(
        isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }),
      ).toBe(false)

      // 冷却结束：自动恢复，无需重启插件。
      jest.advanceTimersByTime(2000)
      expect(
        isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }),
      ).toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})
