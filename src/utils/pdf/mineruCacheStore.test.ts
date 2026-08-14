import * as JSZipModule from 'jszip'
import {
  type App,
  type RequestUrlResponse,
  type RequestUrlResponsePromise,
  type TFile,
  requestUrl,
} from 'obsidian'

import { arrayBufferToBase64 } from '../base64'
import { sha256Hex, sha256HexSync } from '../common/content-hash'

import { convertPdfViaMinerU, getMineruCacheDir } from './mineruCacheStore'

const endpointHashFor = (baseUrl: string, apiKey: string): string =>
  sha256HexSync(`${baseUrl}${String.fromCharCode(0)}${apiKey}`).slice(0, 12)

type JSZipConstructor = typeof import('jszip')
type JSZipInstance = InstanceType<JSZipConstructor>

const JSZip =
  (JSZipModule as unknown as { default?: JSZipConstructor }).default ??
  JSZipModule

const mockedRequestUrl = requestUrl as jest.MockedFunction<typeof requestUrl>

const BASE_URL = 'http://mineru.test'
const OPTIONS = { enabled: true, baseUrl: BASE_URL, apiKey: 'Bearer xxx' }
const MARKDOWN = '# Cached\n\n![](images/1.png)\n'
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])
const PDF_BYTES = new TextEncoder().encode('%PDF-1.4 mock')

class MockAdapter {
  private readonly files = new Map<string, string | ArrayBuffer>()
  private readonly folders = new Set<string>()

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

const buildZip = async (
  files: Record<string, string | Uint8Array>,
): Promise<ArrayBuffer> => {
  const zip: JSZipInstance = new JSZip()
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content)
  }
  return await zip.generateAsync({ type: 'arraybuffer' })
}

const responseWithText = (text: string, status = 200) => ({
  status,
  headers: {},
  arrayBuffer: new TextEncoder().encode(text).buffer,
  json: null,
  text,
})

const responseWithArrayBuffer = (arrayBuffer: ArrayBuffer) => ({
  status: 200,
  headers: {},
  arrayBuffer,
  json: null,
  text: '',
})

const waitUntil = async (
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> => {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

let adapter: MockAdapter
let app: App
let file: TFile
let zipBuffer: ArrayBuffer

/** Queues the full mock requestUrl conversation for one zip conversion. */
const mockZipConversion = (): void => {
  mockedRequestUrl
    .mockResolvedValueOnce(
      responseWithText(JSON.stringify({ event_id: 'evt-1' })),
    )
    .mockResolvedValueOnce(
      responseWithText(
        [
          'data: {"type":"heartbeat"}',
          '',
          `data: {"type":"complete","output":{"data":[${JSON.stringify({
            path: '/tmp/x.zip',
            url: `${BASE_URL}/gradio_api/file=zip`,
            orig_name: 'x.zip',
            meta: { _type: 'gradio.FileData' },
          })}]}}`,
        ].join('\n\n'),
      ),
    )
    .mockResolvedValueOnce(responseWithArrayBuffer(zipBuffer))
}

beforeEach(async () => {
  mockedRequestUrl.mockReset()
  adapter = new MockAdapter()
  app = {
    vault: {
      readBinary: jest.fn(async () => PDF_BYTES.buffer),
      adapter,
    },
  } as unknown as App
  // eslint-disable-next-line obsidianmd/no-tfile-tfolder-cast -- test mock, not a real TFile instance
  file = { path: 'notes/paper.pdf', name: 'paper.pdf' } as unknown as TFile

  zipBuffer = await buildZip({
    'result.md': MARKDOWN,
    'images/1.png': PNG_BYTES,
  })
  mockZipConversion()
})

const expectedHash16 = async (): Promise<string> =>
  (await sha256Hex(arrayBufferToBase64(PDF_BYTES.buffer))).slice(0, 16)

describe('getMineruCacheDir', () => {
  it('resolves under the default Projects dir', () => {
    expect(getMineruCacheDir('abc123def4567890')).toBe(
      'Projects/mineru-cache/abc123def4567890',
    )
  })

  it('honors a configured projectsDir', () => {
    expect(
      getMineruCacheDir('abc123def4567890', {
        yolo: { projectsDir: 'My Projects' },
      }),
    ).toBe('My Projects/mineru-cache/abc123def4567890')
  })
})

describe('convertPdfViaMinerU', () => {
  const expectedCacheDir = async (): Promise<string> =>
    `Projects/mineru-cache/${await expectedHash16()}-${endpointHashFor(
      OPTIONS.baseUrl,
      OPTIONS.apiKey,
    )}`

  it('persists result.md, images and manifest.json under the vault cache dir', async () => {
    const cacheDir = await expectedCacheDir()

    const result = await convertPdfViaMinerU({ app, file, options: OPTIONS })

    expect(result.markdown).toBe(MARKDOWN)
    expect(result.images).toEqual([
      { name: '1.png', vaultPath: `${cacheDir}/images/1.png` },
    ])

    expect(await adapter.exists(`${cacheDir}/result.md`)).toBe(true)
    expect(await adapter.read(`${cacheDir}/result.md`)).toBe(MARKDOWN)
    expect(await adapter.exists(`${cacheDir}/images/1.png`)).toBe(true)
    expect(await adapter.readBinary(`${cacheDir}/images/1.png`)).toEqual(
      PNG_BYTES.buffer,
    )
    expect(await adapter.exists(`${cacheDir}/manifest.json`)).toBe(true)
    const manifest = JSON.parse(
      await adapter.read(`${cacheDir}/manifest.json`),
    ) as {
      version: number
      createdAt: string
      images: { name: string; vaultPath: string }[]
    }
    expect(manifest.version).toBe(1)
    expect(typeof manifest.createdAt).toBe('string')
    expect(manifest.images).toEqual([
      { name: '1.png', vaultPath: `${cacheDir}/images/1.png` },
    ])
  })

  it('serves a second conversion of the same content from the cache without hitting the network', async () => {
    const first = await convertPdfViaMinerU({ app, file, options: OPTIONS })
    expect(mockedRequestUrl).toHaveBeenCalledTimes(3)

    mockedRequestUrl.mockClear()

    const second = await convertPdfViaMinerU({ app, file, options: OPTIONS })

    expect(mockedRequestUrl).not.toHaveBeenCalled()
    expect(second).toEqual(first)
  })

  it('deduplicates concurrent conversions of the same content into one network round-trip', async () => {
    const [a, b] = await Promise.all([
      convertPdfViaMinerU({ app, file, options: OPTIONS }),
      convertPdfViaMinerU({ app, file, options: OPTIONS }),
    ])

    expect(a).toEqual(b)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(3)
  })

  it('re-converts when the cache is incomplete (a listed image is missing)', async () => {
    const cacheDir = await expectedCacheDir()
    await convertPdfViaMinerU({ app, file, options: OPTIONS })
    await adapter.remove(`${cacheDir}/images/1.png`)

    mockedRequestUrl.mockClear()
    mockZipConversion()
    await convertPdfViaMinerU({ app, file, options: OPTIONS })

    expect(mockedRequestUrl).toHaveBeenCalledTimes(3)
  })

  it('isolates the cache and in-flight dedup by endpoint (baseUrl+apiKey)', async () => {
    const otherOptions = {
      ...OPTIONS,
      baseUrl: 'http://mineru-other.test',
      apiKey: 'Bearer other',
    }
    const otherDir = `Projects/mineru-cache/${await expectedHash16()}-${endpointHashFor(
      otherOptions.baseUrl,
      otherOptions.apiKey,
    )}`

    const first = await convertPdfViaMinerU({ app, file, options: OPTIONS })
    expect(await adapter.exists(otherDir)).toBe(false)

    // 并发同 PDF、不同端点：不得共享首个调用的转换结果/配置。
    mockedRequestUrl.mockClear()
    mockZipConversion()
    const other = await convertPdfViaMinerU({
      app,
      file,
      options: otherOptions,
    })

    expect(other.markdown).toBe(first.markdown)
    expect(other.images[0]?.name).toBe('1.png')
    expect(mockedRequestUrl).toHaveBeenCalledTimes(3)
    expect(
      (mockedRequestUrl.mock.calls[0]?.[0] as { url?: string }).url,
    ).toContain('http://mineru-other.test')
    expect(await adapter.exists(`${otherDir}/result.md`)).toBe(true)

    // 端点隔离：切回原端点后原缓存仍然命中（不因其他端点的转换被污染）。
    mockedRequestUrl.mockClear()
    await convertPdfViaMinerU({ app, file, options: OPTIONS })
    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })

  it('an aborted caller does not cancel a shared in-flight conversion of the same content', async () => {
    const controllerA = new AbortController()
    const controllerB = new AbortController()
    let resolveStart: ((response: RequestUrlResponse) => void) | undefined
    mockedRequestUrl.mockReset()
    mockedRequestUrl.mockImplementationOnce(
      () =>
        new Promise<RequestUrlResponse>((resolve) => {
          resolveStart = resolve
        }) as unknown as RequestUrlResponsePromise,
    )
    const zipBody = await buildZip({
      'result.md': MARKDOWN,
      'images/1.png': PNG_BYTES,
    })
    mockedRequestUrl
      .mockResolvedValueOnce(
        responseWithText(
          [
            'data: {"type":"heartbeat"}',
            '',
            `data: {"type":"complete","output":{"data":[${JSON.stringify({
              path: '/tmp/x.zip',
              url: `${BASE_URL}/gradio_api/file=zip-shared`,
              orig_name: 'x.zip',
              meta: { _type: 'gradio.FileData' },
            })}]}}`,
          ].join('\n\n'),
        ),
      )
      .mockResolvedValueOnce(responseWithArrayBuffer(zipBody))

    const promiseA = convertPdfViaMinerU({
      app,
      file,
      options: OPTIONS,
      signal: controllerA.signal,
    })
    await waitUntil(() => mockedRequestUrl.mock.calls.length === 1)
    const promiseB = convertPdfViaMinerU({
      app,
      file,
      options: OPTIONS,
      signal: controllerB.signal,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(mockedRequestUrl).toHaveBeenCalledTimes(1)

    // A 取消：只拒绝 A 自己的 promise，共享任务继续，B 不受影响。
    controllerA.abort()
    await expect(promiseA).rejects.toMatchObject({ name: 'AbortError' })

    resolveStart?.(responseWithText(JSON.stringify({ event_id: 'evt-shared' })))
    await expect(promiseB).resolves.toMatchObject({ markdown: MARKDOWN })
  })

  it('cancels and releases the shared conversion after its final caller aborts', async () => {
    mockedRequestUrl.mockReset()
    mockedRequestUrl.mockImplementation(
      () =>
        new Promise<RequestUrlResponse>(() => {}) as RequestUrlResponsePromise,
    )
    const controllerA = new AbortController()

    const promiseA = convertPdfViaMinerU({
      app,
      file,
      options: OPTIONS,
      signal: controllerA.signal,
    })
    await waitUntil(() => mockedRequestUrl.mock.calls.length === 1)

    controllerA.abort()
    await expect(promiseA).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    await Promise.resolve()

    const controllerC = new AbortController()
    const promiseC = convertPdfViaMinerU({
      app,
      file,
      options: OPTIONS,
      signal: controllerC.signal,
    })
    await waitUntil(() => mockedRequestUrl.mock.calls.length >= 2)
    expect(mockedRequestUrl).toHaveBeenCalledTimes(2)
    controllerC.abort()
    await expect(promiseC).rejects.toMatchObject({ name: 'AbortError' })

    const cacheDir = await expectedCacheDir()
    expect(await adapter.exists(`${cacheDir}/manifest.json`)).toBe(false)
  })

  it('throws when MinerU is disabled or has no base url', async () => {
    await expect(
      convertPdfViaMinerU({
        app,
        file,
        options: { ...OPTIONS, enabled: false },
      }),
    ).rejects.toThrow(/disabled/i)
    await expect(
      convertPdfViaMinerU({
        app,
        file,
        options: { ...OPTIONS, baseUrl: '' },
      }),
    ).rejects.toThrow(/baseurl/i)

    expect(mockedRequestUrl).not.toHaveBeenCalled()
  })
})
