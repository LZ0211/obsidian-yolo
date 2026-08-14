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
  MINERU_EVENT_POLL_TIMEOUT_MS,
  convertPdfToMarkdown,
  isMinerUEnabled,
  markMinerUFailure,
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

const sseCompleteZip = (fileData: Record<string, string>): string =>
  [
    'data: {"type":"heartbeat"}',
    '',
    `data: {"type":"complete","output":{"data":[${JSON.stringify({
      ...fileData,
      meta: { _type: 'gradio.FileData' },
    })}]}}`,
  ].join('\n\n')

/** requestUrl accepts a bare string overload; normalize calls to RequestUrlParam. */
const requestParams = (call: unknown[]): RequestUrlParam =>
  typeof call[0] === 'string' ? { url: call[0] } : (call[0] as RequestUrlParam)

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

describe('convertPdfToMarkdown', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
  })

  it('converts via the gradio protocol and parses a zip FileData result', async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3,
    ])
    const zipBuffer = await buildZip({
      'result.md': MARKDOWN,
      'images/1.png': pngBytes,
    })

    mockedRequestUrl
      .mockResolvedValueOnce(
        responseWithText(JSON.stringify({ event_id: 'evt-1' })),
      )
      .mockResolvedValueOnce(
        responseWithText(
          sseCompleteZip({
            path: '/tmp/x.zip',
            url: `${BASE_URL}/gradio_api/file=zip-1`,
            orig_name: 'x.zip',
          }),
        ),
      )
      .mockResolvedValueOnce(responseWithArrayBuffer(zipBuffer))

    const result = await convertPdfToMarkdown({
      pdfBytes: PDF_BYTES.buffer,
      fileName: 'report.pdf',
      baseUrl: BASE_URL,
      apiKey: API_KEY,
    })

    expect(result.markdown).toBe(MARKDOWN)
    expect(result.images).toHaveLength(1)
    expect(result.images[0]?.name).toBe('1.png')
    expect(result.images[0]?.data).toEqual(pngBytes)

    expect(mockedRequestUrl).toHaveBeenCalledTimes(3)
    const [post, sse, download] = mockedRequestUrl.mock.calls.map(requestParams)

    // POST: multipart body carrying the pdf file and the fixed conversion params
    expect(post.url).toBe(
      `${BASE_URL}/gradio_api/call/convert_to_markdown_stream`,
    )
    expect(post.method).toBe('POST')
    expect(post.contentType).toMatch(/^multipart\/form-data; boundary=/)
    const bodyText = new TextDecoder().decode(post.body as ArrayBuffer)
    expect(bodyText).toContain(
      'Content-Disposition: form-data; name="file_path"; filename="report.pdf"',
    )
    expect(bodyText).toContain('%PDF-1.4')
    expect(bodyText).toContain('name="end_pages"')
    expect(bodyText).toContain('1000')
    expect(bodyText).toContain('name="is_ocr"')
    expect(bodyText).toContain('name="formula_enable"')
    expect(bodyText).toContain('name="table_enable"')
    expect(bodyText).toContain('name="image_analysis"')
    expect(bodyText).toContain('ch (Chinese, English, Chinese Traditional)')
    expect(bodyText).toContain('name="backend"')
    expect(bodyText).toContain('hybrid-auto-engine')

    // SSE event polling on the returned event_id
    expect(sse.url).toBe(`${BASE_URL}/gradio_api/call/evt-1`)
    expect(sse.method).toBe('GET')
    expect(sse.headers?.['Accept']).toContain('text/event-stream')

    // FileData url download
    expect(download.url).toBe(`${BASE_URL}/gradio_api/file=zip-1`)
    expect(download.method).toBe('GET')
  })

  it('returns a plain markdown string output directly', async () => {
    const md = '# Plain\n\nNo images.\n'
    mockedRequestUrl
      .mockResolvedValueOnce(
        responseWithText(JSON.stringify({ event_id: 'evt-2' })),
      )
      .mockResolvedValueOnce(
        responseWithText(
          `data: {"type":"complete","output":{"data":[${JSON.stringify(md)}]}}`,
        ),
      )

    const result = await convertPdfToMarkdown({
      pdfBytes: PDF_BYTES.buffer,
      fileName: 'a.pdf',
      baseUrl: BASE_URL,
      apiKey: API_KEY,
    })

    expect(result.markdown).toBe(md)
    expect(result.images).toEqual([])
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2)
  })

  it('decodes a FileData inline data URI without an extra download request', async () => {
    const md = '# Data uri'
    const zipBuffer = await buildZip({ 'result.md': md })
    const dataUri = `data:application/octet-stream;base64,${arrayBufferToBase64(zipBuffer)}`
    mockedRequestUrl
      .mockResolvedValueOnce(
        responseWithText(JSON.stringify({ event_id: 'evt-8' })),
      )
      .mockResolvedValueOnce(
        responseWithText(
          `data: {"type":"complete","output":{"data":[${JSON.stringify({
            data: dataUri,
            orig_name: 'x.zip',
            meta: { _type: 'gradio.FileData' },
          })}]}}`,
        ),
      )

    const result = await convertPdfToMarkdown({
      pdfBytes: PDF_BYTES.buffer,
      fileName: 'a.pdf',
      baseUrl: BASE_URL,
      apiKey: API_KEY,
    })

    expect(result.markdown).toBe(md)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2)
  })

  it('sends the apiKey verbatim as the Authorization header on every request', async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(
        responseWithText(JSON.stringify({ event_id: 'evt-3' })),
      )
      .mockResolvedValueOnce(
        responseWithText(
          'data: {"type":"complete","output":{"data":["# ok"]}}',
        ),
      )

    await convertPdfToMarkdown({
      pdfBytes: PDF_BYTES.buffer,
      fileName: 'a.pdf',
      baseUrl: BASE_URL,
      apiKey: API_KEY,
    })

    for (const call of mockedRequestUrl.mock.calls) {
      expect(requestParams(call).headers?.['Authorization']).toBe(API_KEY)
    }
  })

  it('omits the Authorization header when apiKey is empty', async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(
        responseWithText(JSON.stringify({ event_id: 'evt-4' })),
      )
      .mockResolvedValueOnce(
        responseWithText(
          'data: {"type":"complete","output":{"data":["# ok"]}}',
        ),
      )

    await convertPdfToMarkdown({
      pdfBytes: PDF_BYTES.buffer,
      fileName: 'a.pdf',
      baseUrl: BASE_URL,
      apiKey: '',
    })

    for (const call of mockedRequestUrl.mock.calls) {
      expect(requestParams(call).headers?.['Authorization']).toBeUndefined()
    }
  })

  it('aborts immediately when the signal is already aborted (no request is made)', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      convertPdfToMarkdown({
        pdfBytes: PDF_BYTES.buffer,
        fileName: 'a.pdf',
        baseUrl: BASE_URL,
        apiKey: API_KEY,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' })

    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('rejects with AbortError when the signal aborts while polling the event stream', async () => {
    const sseDeferred: {
      resolve: ((response: RequestUrlResponse) => void) | null
    } = { resolve: null }
    mockedRequestUrl
      .mockResolvedValueOnce(
        responseWithText(JSON.stringify({ event_id: 'evt-5' })),
      )
      .mockImplementationOnce(
        () =>
          new Promise<RequestUrlResponse>((resolve) => {
            sseDeferred.resolve = resolve
          }) as unknown as RequestUrlResponsePromise,
      )
    const controller = new AbortController()

    const promise = convertPdfToMarkdown({
      pdfBytes: PDF_BYTES.buffer,
      fileName: 'a.pdf',
      baseUrl: BASE_URL,
      apiKey: API_KEY,
      signal: controller.signal,
    })

    await waitUntil(() => mockedRequestUrl.mock.calls.length === 2)
    controller.abort()

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    sseDeferred.resolve?.(responseWithText(''))
  })

  it('throws when the event stream does not complete within the poll timeout', async () => {
    jest.useFakeTimers()
    try {
      mockedRequestUrl
        .mockResolvedValueOnce(
          responseWithText(JSON.stringify({ event_id: 'evt-6' })),
        )
        .mockImplementationOnce(
          () =>
            new Promise<RequestUrlResponse>(
              () => {},
            ) as unknown as RequestUrlResponsePromise,
        )

      const promise = convertPdfToMarkdown({
        pdfBytes: PDF_BYTES.buffer,
        fileName: 'a.pdf',
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      })
      // Attach the rejection handler before advancing timers so the timeout
      // rejection is not flagged as unhandled mid-tick.
      const assertion = expect(promise).rejects.toThrow(/timed out/i)

      await jest.advanceTimersByTimeAsync(MINERU_EVENT_POLL_TIMEOUT_MS + 1000)
      await assertion
    } finally {
      jest.useRealTimers()
    }
  })

  it('surfaces the server error event message', async () => {
    mockedRequestUrl
      .mockResolvedValueOnce(
        responseWithText(JSON.stringify({ event_id: 'evt-7' })),
      )
      .mockResolvedValueOnce(
        responseWithText('data: {"type":"error","error":"backend exploded"}'),
      )

    await expect(
      convertPdfToMarkdown({
        pdfBytes: PDF_BYTES.buffer,
        fileName: 'a.pdf',
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      }),
    ).rejects.toThrow(/backend exploded/)
  })
})

describe('probeMinerU', () => {
  beforeEach(() => {
    mockedRequestUrl.mockReset()
  })

  it('returns true when /gradio_api/info is 2xx and exposes the conversion api', async () => {
    mockedRequestUrl.mockResolvedValueOnce(
      responseWithText(
        JSON.stringify({
          named_endpoints: { convert_to_markdown_stream: {} },
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

  it('returns false for non-2xx responses', async () => {
    mockedRequestUrl.mockResolvedValueOnce(responseWithText('not found', 404))
    await expect(probeMinerU(BASE_URL, '')).resolves.toBe(false)
  })

  it('returns false when the conversion api is not exposed', async () => {
    mockedRequestUrl.mockResolvedValueOnce(
      responseWithText(
        JSON.stringify({
          named_endpoints: { convert_to_markdown: {} },
        }),
      ),
    )
    await expect(probeMinerU(BASE_URL, '')).resolves.toBe(false)
  })

  it('returns false on network errors and empty base urls', async () => {
    mockedRequestUrl.mockRejectedValueOnce(new Error('connection refused'))
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

describe('convertPdfToMarkdown job start timeout', () => {
  it('times out a hung job-start POST (no infinite pending)', async () => {
    jest.useFakeTimers()
    try {
      // POST 永久 pending：此前只有 SSE GET 有超时，挂起的 POST 会让调用
      // 方永久卡住。
      mockedRequestUrl.mockImplementationOnce(
        () =>
          new Promise<RequestUrlResponse>(
            () => {},
          ) as unknown as RequestUrlResponsePromise,
      )

      const promise = convertPdfToMarkdown({
        pdfBytes: PDF_BYTES.buffer,
        fileName: 'a.pdf',
        baseUrl: BASE_URL,
        apiKey: API_KEY,
      })
      const assertion = expect(promise).rejects.toThrow(/timed out/i)

      await jest.advanceTimersByTimeAsync(MINERU_EVENT_POLL_TIMEOUT_MS + 1000)
      await assertion
    } finally {
      jest.useRealTimers()
    }
  })
})

describe('MinerU session circuit breaker', () => {
  afterEach(() => {
    resetMinerUSessionState()
  })

  it('breaks after three consecutive failures and recovers after the cooldown window', () => {
    jest.useFakeTimers()
    try {
      resetMinerUSessionState()
      markMinerUFailure()
      markMinerUFailure()
      expect(isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }))
        .toBe(true)
      markMinerUFailure()
      expect(isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }))
        .toBe(false)

      // 冷却窗口未过：仍然熔断。
      jest.advanceTimersByTime(MINERU_BREAKER_COOLDOWN_MS - 1000)
      expect(isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }))
        .toBe(false)

      // 冷却结束：自动恢复，无需重启插件。
      jest.advanceTimersByTime(2000)
      expect(isMinerUEnabled({ mineru: { enabled: true, baseUrl: BASE_URL } }))
        .toBe(true)
    } finally {
      jest.useRealTimers()
    }
  })
})
