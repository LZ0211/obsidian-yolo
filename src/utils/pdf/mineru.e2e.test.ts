import * as JSZipModule from 'jszip'
import {
  type App,
  type RequestUrlParam,
  type RequestUrlResponse,
  TFile,
  requestUrl,
} from 'obsidian'

import { executeBuiltinTool } from '../../core/tools/dispatcher'
import type { YoloSettings } from '../../settings/schema/setting.types'
import { ToolCallResponseStatus } from '../../types/tool-call.types'

import { extractPdfText } from './extractPdfText'
import { isMinerUEnabled, resetMinerUSessionState } from './mineruClient'

type JSZipConstructor = typeof import('jszip')
type JSZipInstance = InstanceType<JSZipConstructor>

const JSZip =
  (JSZipModule as unknown as { default?: JSZipConstructor }).default ??
  JSZipModule

/**
 * MinerU 端到端（mock requestUrl 模拟真实 gradio 会话）：
 * fs_read（FakeAdapter 假 PDF）→ readPdfViaMinerU → convertPdfViaMinerU →
 * convertPdfToMarkdown → HTTP 全链（config → upload → queue/join →
 * queue/data SSE → 下载 zip）。
 *
 * 与单测的分工：mineruClient.test.ts 验证 gradio 协议、mineruCacheStore.test.ts
 * 验证缓存；本文件不 mock 转换链，只在 HTTP 边界（requestUrl）与 legacy
 * 回退点（extractPdfText）打桩，验证三路径接入（fs_read 分支）的端到端行为。
 */

jest.mock('./extractPdfText', () => ({
  PDF_INDEX_MAX_BYTES: 50 * 1024 * 1024,
  PDF_INDEX_MAX_PAGES: 500,
  extractPdfText: jest.fn(),
}))

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>
const mockedExtractPdfText = extractPdfText as jest.MockedFunction<
  typeof extractPdfText
>

const BASE_URL = 'http://mineru.test'
const API_KEY = 'Bearer xxx'
const PDF_PATH = 'docs/report.pdf'
const PDF_BYTES = new TextEncoder().encode(
  '%PDF-1.4\n% mock pdf for mineru e2e\n%%EOF',
)
const MARKDOWN = '# MinerU Report\n\n![](images/1.png)\n\nBody text.\n'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])

const MINERU_SETTINGS = {
  mineru: { enabled: true, baseUrl: BASE_URL, apiKey: API_KEY },
} as unknown as YoloSettings

class MockAdapter {
  private readonly files = new Map<string, string | ArrayBuffer>()
  private readonly folders = new Set<string>()

  hasFile(path: string): boolean {
    return this.files.has(path)
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.folders.has(path)
  }

  async mkdir(path: string): Promise<void> {
    const segments = path.split('/').filter(Boolean)
    let current = ''
    for (const segment of segments) {
      current = current ? `${current}/${segment}` : segment
      this.folders.add(current)
    }
  }

  async read(path: string): Promise<string> {
    const value = this.files.get(path)
    if (typeof value !== 'string') {
      throw new Error(`MockAdapter: not text: ${path}`)
    }
    return value
  }

  async write(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }

  async readBinary(path: string): Promise<ArrayBuffer> {
    const value = this.files.get(path)
    if (!(value instanceof ArrayBuffer)) {
      throw new Error(`MockAdapter: not binary: ${path}`)
    }
    return value
  }

  async writeBinary(path: string, content: ArrayBuffer): Promise<void> {
    this.files.set(path, content)
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path)
    this.folders.delete(path)
  }
}

const makeTFile = (path: string): TFile => {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  const extension = dot >= 0 ? name.slice(dot + 1).toLowerCase() : ''

  return Object.assign(new TFile(), {
    path,
    name,
    extension,
    stat: { size: 2048, mtime: 1000 },
  })
}

let adapter: MockAdapter
let app: App
let zipBuffer: ArrayBuffer

const buildZip = async (
  files: Record<string, string | Uint8Array>,
): Promise<ArrayBuffer> => {
  const zip: JSZipInstance = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content)
  }
  return await zip.generateAsync({ type: 'arraybuffer' })
}

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

/**
 * Queues one full mock sse_v3 gradio conversation:
 * config → upload → queue/join → queue/data SSE → zip download.
 */
const mockZipConversion = (): void => {
  mockedRequestUrl
    .mockResolvedValueOnce(
      responseWithText(
        JSON.stringify({
          dependencies: [{ api_name: 'convert_to_markdown_stream', id: 6 }],
        }),
      ),
    )
    .mockResolvedValueOnce(
      responseWithText(JSON.stringify(['/tmp/gradio/x.pdf'])),
    )
    .mockResolvedValueOnce(
      responseWithText(JSON.stringify({ event_id: 'evt-e2e-1' })),
    )
    .mockResolvedValueOnce(
      responseWithText(
        [
          'data: {"msg":"heartbeat","event_id":"evt-e2e-1"}',
          '',
          `data: ${JSON.stringify({
            msg: 'process_completed',
            event_id: 'evt-e2e-1',
            output: {
              data: [
                '<div class="status">ok</div>',
                {
                  path: '/tmp/x.zip',
                  url: `${BASE_URL}/gradio_api/file=zip-1`,
                  orig_name: 'x.zip',
                  meta: { _type: 'gradio.FileData' },
                },
              ],
              error: null,
              duration: 1,
              visible: true,
              title: '',
            },
            success: true,
            title: '',
          })}`,
        ].join('\n\n'),
      ),
    )
    .mockResolvedValueOnce(responseWithArrayBuffer(zipBuffer))
}

const requestParams = (call: unknown[]): RequestUrlParam =>
  typeof call[0] === 'string' ? { url: call[0] } : (call[0] as RequestUrlParam)

const readFs = (args: Record<string, unknown>) =>
  executeBuiltinTool('fs_read', args, { app, settings: MINERU_SETTINGS })

const parseSuccessResults = (result: {
  status: ToolCallResponseStatus
  text?: string
}): Array<Record<string, unknown>> => {
  expect(result.status).toBe(ToolCallResponseStatus.Success)
  return (
    JSON.parse((result as { text: string }).text) as {
      results: Array<Record<string, unknown>>
    }
  ).results
}

beforeEach(async () => {
  mockedRequestUrl.mockReset()
  mockedExtractPdfText.mockReset()
  mockedExtractPdfText.mockResolvedValue({
    pages: [{ page: 1, text: 'Legacy fallback page text' }],
  })
  resetMinerUSessionState()

  adapter = new MockAdapter()
  await adapter.writeBinary(PDF_PATH, PDF_BYTES.buffer)
  app = {
    vault: {
      adapter,
      getFileByPath: jest.fn((path: string) =>
        adapter.hasFile(path) ? makeTFile(path) : null,
      ),
      readBinary: jest.fn(async (file: TFile) => adapter.readBinary(file.path)),
    },
    metadataCache: {
      getFirstLinkpathDest: jest.fn().mockReturnValue(null),
      getFileCache: jest.fn().mockReturnValue(null),
    },
  } as unknown as App

  zipBuffer = await buildZip({
    'result.md': MARKDOWN,
    'images/1.png': PNG_BYTES,
  })
})

describe('fs_read MinerU 端到端（mock requestUrl 模拟 gradio 会话）', () => {
  it('全链转换：config/upload/queue-join/queue-data → zip 下载，md 进结果 + 图片 parts 进 contentParts', async () => {
    mockZipConversion()

    const result = await readFs({ paths: [PDF_PATH] })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual(
      expect.objectContaining({
        path: PDF_PATH,
        ok: true,
        // MinerU md 直接作为内容返回，图片引用改写为 vault 缓存路径。
        content: expect.stringContaining('# MinerU Report'),
        effectiveModality: 'text',
      }),
    )
    // 原始相对引用被改写为 vault 缓存绝对路径。
    expect(results[0]?.content as string).not.toContain('![](images/1.png)')
    expect(results[0]?.content as string).toContain(
      '![](YOLO/Projects/mineru-cache/',
    )
    expect(mockedExtractPdfText).not.toHaveBeenCalled()

    // 图片 parts：md 引用的图片转为 image_url 内容块。
    const contentParts = (result as { contentParts?: unknown[] }).contentParts
    expect(contentParts).toHaveLength(1)
    expect(contentParts?.[0]).toEqual({
      type: 'image_url',
      image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
    })

    // 请求序列：config → upload → queue/join → queue/data SSE → 下载 zip，共 5 次。
    expect(mockedRequestUrl).toHaveBeenCalledTimes(5)
    const [config, upload, join, sse, download] =
      mockedRequestUrl.mock.calls.map(requestParams)
    expect(config.url).toBe(`${BASE_URL}/gradio_api/config`)
    expect(config.method).toBe('GET')
    expect(config.headers?.['Authorization']).toBe(API_KEY)
    expect(upload.url).toBe(`${BASE_URL}/gradio_api/upload`)
    expect(upload.method).toBe('POST')
    expect(upload.headers?.['Authorization']).toBe(API_KEY)
    expect(join.url).toBe(`${BASE_URL}/gradio_api/queue/join`)
    expect(join.method).toBe('POST')
    expect(join.headers?.['Authorization']).toBe(API_KEY)
    const joinBody = JSON.parse(
      typeof join.body === 'string'
        ? join.body
        : new TextDecoder().decode(join.body),
    ) as { fn_index: number; session_hash: string }
    expect(joinBody.fn_index).toBe(6)
    expect(sse.url).toBe(
      `${BASE_URL}/gradio_api/queue/data?session_hash=${joinBody.session_hash}`,
    )
    expect(sse.method).toBe('GET')
    expect(download.url).toBe(`${BASE_URL}/gradio_api/file=zip-1`)
    expect(download.method).toBe('GET')
  })

  it('同文件二次读：内容 hash 缓存命中，无新网络请求', async () => {
    mockZipConversion()
    const first = await readFs({ paths: [PDF_PATH] })
    expect(mockedRequestUrl).toHaveBeenCalledTimes(5)
    const firstResults = parseSuccessResults(first)

    mockedRequestUrl.mockClear()
    const second = await readFs({ paths: [PDF_PATH] })

    expect(mockedRequestUrl).not.toHaveBeenCalled()
    const secondResults = parseSuccessResults(second)
    expect(secondResults[0]).toEqual(firstResults[0])
  })

  it('接口挂（requestUrl 抛错）→ 回退原流程（extractPdfText 结果）', async () => {
    mockedRequestUrl.mockRejectedValue(new Error('connection refused'))

    const result = await readFs({ paths: [PDF_PATH] })

    const results = parseSuccessResults(result)
    expect(results[0]).toEqual(
      expect.objectContaining({
        path: PDF_PATH,
        ok: true,
        // legacy 页文本提取结果（行号 = 页号语义）。
        content: expect.stringContaining('Legacy fallback page text'),
      }),
    )
    expect(mockedExtractPdfText).toHaveBeenCalledTimes(1)
  })

  it('累计 3 次失败 → 会话熔断（isMinerUEnabled=false，后续不再尝试转换）', async () => {
    // 前三次转换都失败（每次触发 markMinerUFailure，累计计数）。
    for (let i = 0; i < 3; i += 1) {
      mockedRequestUrl.mockRejectedValue(new Error(`mineru down #${i}`))
      const result = await readFs({ paths: [PDF_PATH] })
      expect(parseSuccessResults(result)[0]?.ok).toBe(true) // 回退成功
    }
    expect(isMinerUEnabled(MINERU_SETTINGS)).toBe(false)

    // 第四次：熔断生效，不再发起任何转换请求，直接走 legacy。
    mockedRequestUrl.mockClear()
    const fourth = await readFs({ paths: [PDF_PATH] })
    expect(mockedRequestUrl).not.toHaveBeenCalled()
    const fourthResults = parseSuccessResults(fourth)
    expect(fourthResults[0]?.content).toEqual(
      expect.stringContaining('Legacy fallback page text'),
    )
  })

  it('lines 范围请求保持分页语义：不启用 MinerU，走 legacy 切片提取', async () => {
    mockZipConversion()

    const result = await readFs({
      paths: [PDF_PATH],
      startLine: 1,
      endLine: 1,
    })

    expect(mockedRequestUrl).not.toHaveBeenCalled()
    const results = parseSuccessResults(result)
    expect(results[0]).toEqual(
      expect.objectContaining({
        path: PDF_PATH,
        ok: true,
        returnedRange: { startLine: 1, endLine: 1 },
        content: expect.stringContaining('<page 1>'),
      }),
    )
    expect(mockedExtractPdfText).toHaveBeenCalledTimes(1)
  })
})
