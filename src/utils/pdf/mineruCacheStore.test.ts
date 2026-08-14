import * as JSZipModule from 'jszip'
import { type App, type TFile, requestUrl } from 'obsidian'

import { arrayBufferToBase64 } from '../base64'
import { sha256Hex } from '../common/content-hash'

import { convertPdfViaMinerU, getMineruCacheDir } from './mineruCacheStore'

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
  it('persists result.md, images and manifest.json under the vault cache dir', async () => {
    const cacheDir = `Projects/mineru-cache/${await expectedHash16()}`

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
    const cacheDir = `Projects/mineru-cache/${await expectedHash16()}`
    await convertPdfViaMinerU({ app, file, options: OPTIONS })
    await adapter.remove(`${cacheDir}/images/1.png`)

    mockedRequestUrl.mockClear()
    mockZipConversion()
    await convertPdfViaMinerU({ app, file, options: OPTIONS })

    expect(mockedRequestUrl).toHaveBeenCalledTimes(3)
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
