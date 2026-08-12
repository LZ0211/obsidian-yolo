jest.mock('obsidian')

/* eslint-disable import/no-nodejs-modules -- 测试文件允许直接引入 node 内置模块进行 mock */

import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'

import { TFile, TFolder } from 'obsidian'

import { WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import { type VaultRoutesContext, registerVaultRoutes } from './vaultRoutes'

describe('vaultRoutes workspace scope', () => {
  it('paginates folder listings with items, nextCursor, and hasMore', async () => {
    const router = new WebRouter()
    const context = createScopedContext('/Allowed', [
      makeFile('Allowed/b.md'),
      makeFile('Allowed/c.md'),
    ])
    registerVaultRoutes(router, context)

    const first = await dispatch(
      router,
      'GET',
      '/api/vault/list?path=/Allowed&limit=1',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )

    expect(first.statusCode).toBe(200)
    expect(first.jsonBody).toEqual(
      expect.objectContaining({
        items: [expect.objectContaining({ path: 'Allowed/a.md' })],
        hasMore: true,
        nextCursor: expect.any(String),
      }),
    )
  })

  it('searches readable file content and returns bounded search result metadata', async () => {
    const router = new WebRouter()
    const context = createScopedContext('/Allowed', [
      makeFile('Allowed/alpha.md'),
      makeFile('Allowed/beta.md'),
    ])
    context.vault.read = jest.fn(async (file: TFile) =>
      file.path.endsWith('beta.md')
        ? 'This note contains needle-token in the body.'
        : `content:${file.path}`,
    )
    registerVaultRoutes(router, context)

    const res = await dispatch(
      router,
      'GET',
      '/api/vault/search?query=needle-token&limit=1',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({
            path: 'Allowed/beta.md',
            title: 'beta.md',
            preview: expect.stringContaining('needle-token'),
            score: expect.any(Number),
          }),
        ],
        hasMore: false,
        nextCursor: null,
      }),
    )
    expect(context.vault.read).not.toHaveBeenCalledWith(
      expect.objectContaining({ path: 'Private/secret.md' }),
    )
  })

  it('rejects create conflicts with 409 responses when overwrite is false', async () => {
    const router = new WebRouter()
    registerVaultRoutes(router, createScopedContext('/Allowed'))

    const createRes = await dispatch(
      router,
      'POST',
      '/api/vault/create',
      {
        path: 'a.md',
        content: 'new',
        overwrite: false,
      },
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )

    expect(createRes.statusCode).toBe(409)
    expect(createRes.jsonBody).toEqual({
      error: {
        code: 'conflict',
        message: 'Path already exists',
      },
    })
  })

  it('serves html and svg binary reads as attachment only', async () => {
    const router = new WebRouter()
    const context = createScopedContext('/Allowed', [
      makeFile('Allowed/page.html'),
      makeFile('Allowed/vector.svg'),
    ])
    registerVaultRoutes(router, context)

    const htmlRes = await dispatch(
      router,
      'GET',
      '/api/vault/read-binary?path=page.html',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )
    expect(htmlRes.statusCode).toBe(200)
    expect(htmlRes.headers['content-disposition']).toContain('attachment')
    expect(htmlRes.headers['content-type']).not.toContain('text/html')

    const svgRes = await dispatch(
      router,
      'GET',
      '/api/vault/read-binary?path=vector.svg',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )
    expect(svgRes.statusCode).toBe(200)
    expect(svgRes.headers['content-disposition']).toContain('attachment')
  })
  it('filters index and folder listings to the session active agent workspace scope', async () => {
    const router = new WebRouter()
    registerVaultRoutes(router, createScopedContext())

    const indexRes = await dispatch(
      router,
      'GET',
      '/api/vault/index',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )
    expect(indexRes.statusCode).toBe(200)
    expect((indexRes.jsonBody as { items: unknown[] }).items).toEqual([
      expect.objectContaining({ kind: 'folder', path: 'Allowed' }),
      expect.objectContaining({ kind: 'file', path: 'Allowed/a.md' }),
    ])
    expect(JSON.stringify(indexRes.jsonBody)).not.toContain('Private')

    const listRes = await dispatch(
      router,
      'GET',
      '/api/vault/list?path=/',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )
    expect(listRes.statusCode).toBe(200)
    expect(listRes.jsonBody).toEqual(
      expect.objectContaining({
        items: [
          expect.objectContaining({ kind: 'file', path: 'Allowed/a.md' }),
        ],
        hasMore: false,
        nextCursor: null,
      }),
    )
  })

  it('resolves "/" list to workspace root contents', async () => {
    const router = new WebRouter()
    registerVaultRoutes(router, createScopedContext('/Projects/Allowed'))

    const res = await dispatch(
      router,
      'GET',
      '/api/vault/list?path=/',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )

    expect(res.statusCode).toBe(200)
    expect(res.jsonBody).toEqual(
      expect.objectContaining({
        items: [],
        hasMore: false,
        nextCursor: null,
      }),
    )
    expect(JSON.stringify(res.jsonBody)).not.toContain('Private')
  })

  it('rejects scoped read and write requests outside the active workspace scope', async () => {
    const router = new WebRouter()
    const context = createScopedContext()
    registerVaultRoutes(router, context)

    const readRes = await dispatch(
      router,
      'GET',
      '/api/vault/read?path=/Private/secret.md',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )
    expect(readRes.statusCode).toBe(404)
    expect(readRes.jsonBody).toEqual({
      error: {
        code: 'not_found',
        message: 'File not found',
      },
    })

    const writeRes = await dispatch(
      router,
      'POST',
      '/api/vault/write',
      {
        path: 'Private/new.md',
        content: 'no',
      },
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )
    expect(writeRes.statusCode).toBe(403)
    expect(context.vault.adapter.write).not.toHaveBeenCalled()
  })

  it('checks read policy before existence so unreadable absolute paths do not leak content', async () => {
    const router = new WebRouter()
    registerVaultRoutes(router, createScopedContext())

    const res = await dispatch(
      router,
      'GET',
      '/api/vault/read?path=/Private/missing.md',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )

    expect(res.statusCode).toBe(404)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'not_found',
        message: 'File not found',
      },
    })
  })

  it('serves readable binary files with download metadata headers', async () => {
    const router = new WebRouter()
    registerVaultRoutes(router, createScopedContext())

    const res = await dispatch(
      router,
      'GET',
      '/api/vault/read-binary?path=a.md',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )

    expect(res.statusCode).toBe(200)
    expect(res.headers['content-type']).toBe('text/markdown; charset=utf-8')
    expect(res.headers['content-disposition']).toBeUndefined()
    expect(res.rawBody).toBe('binary:Allowed/a.md')
  })

  it('rejects oversized binary writes before calling the adapter', async () => {
    const router = new WebRouter()
    const context = createScopedContext()
    registerVaultRoutes(router, context)

    const resolved = router.resolve(
      'POST',
      '/api/vault/write-binary?path=upload.bin',
    )
    if (!resolved) throw new Error('missing write-binary route')
    const req = Readable.from([Buffer.alloc(51 * 1024 * 1024)]) as Readable &
      EventEmitter & {
        method?: string
        url?: string
        headers: Record<string, string>
      }
    req.method = 'POST'
    req.url = '/api/vault/write-binary?path=upload.bin'
    req.headers = {
      [WEB_SESSION_HEADER]: 'session-allowed',
    }
    const res = createResponse()

    await resolved.handler(req as never, res as never, {})

    expect(res.statusCode).toBe(413)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'request_too_large',
        message: 'Binary body is too large',
      },
    })
    expect(context.vault.adapter.writeBinary).not.toHaveBeenCalled()
  })

  it('rejects client-supplied assistant and workspace selectors on protected routes', async () => {
    const router = new WebRouter()
    registerVaultRoutes(router, createScopedContext())

    const getRes = await dispatch(
      router,
      'GET',
      '/api/vault/index?assistantId=a1',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )
    expect(getRes.statusCode).toBe(400)
    expect(getRes.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message:
          'assistantId, workspaceId, workspaceRoot, and client workspace policy fields are not allowed on protected vault routes',
      },
    })

    const postRes = await dispatch(
      router,
      'POST',
      '/api/vault/write',
      {
        path: 'Allowed/new.md',
        content: 'ok',
        workspaceRoot: '/Private',
      },
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )
    expect(postRes.statusCode).toBe(400)
    expect(postRes.jsonBody).toEqual({
      error: {
        code: 'invalid_request',
        message:
          'assistantId, workspaceId, workspaceRoot, and client workspace policy fields are not allowed on protected vault routes',
      },
    })
  })

  it('requires an authenticated web session for protected vault routes', async () => {
    const router = new WebRouter()
    registerVaultRoutes(router, createScopedContext())

    const res = await dispatch(router, 'GET', '/api/vault/index')

    expect(res.statusCode).toBe(401)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'session_expired',
        message: 'The web session has expired.',
      },
    })
  })

  it('applies realpath policy checks before reading files', async () => {
    const router = new WebRouter()
    const linkFile = makeFile('Allowed/link.md')
    const context = createScopedContext('/Allowed', [linkFile])
    context.vault.realpath = (path) =>
      path === '/Allowed/link.md' || path === 'Allowed/link.md'
        ? '/Private/secret.md'
        : `/${path.replace(/^\/+/, '')}`
    registerVaultRoutes(router, context)

    const res = await dispatch(
      router,
      'GET',
      '/api/vault/read?path=link.md',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )

    expect(res.statusCode).toBe(404)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'not_found',
        message: 'File not found',
      },
    })
    expect(context.vault.read).not.toHaveBeenCalled()
  })

  it('rejects recursive folder deletion when descendants are denied', async () => {
    const router = new WebRouter()
    const context = createScopedContext('/Allowed')
    context.vault.listDescendants = jest.fn(async () => [
      '/Allowed/a.md',
      '/Allowed/Private/locked.md',
    ])
    context.vault.adapter.rmdir = jest.fn()
    registerVaultRoutes(router, context)

    const res = await dispatch(
      router,
      'POST',
      '/api/vault/rmdir',
      {
        path: 'Allowed',
        recursive: true,
      },
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )

    expect(res.statusCode).toBe(403)
    expect(res.jsonBody).toEqual({
      error: {
        code: 'forbidden',
        message: 'Forbidden',
      },
    })
    expect(context.vault.adapter.rmdir).not.toHaveBeenCalled()
  })

  it('caches the computed vault index within the TTL window to avoid recomputation', async () => {
    const router = new WebRouter()
    const context = createScopedContext()
    registerVaultRoutes(router, context)

    const first = await dispatch(router, 'GET', '/api/vault/index', undefined, {
      [WEB_SESSION_HEADER]: 'session-allowed',
    })
    const second = await dispatch(
      router,
      'GET',
      '/api/vault/index',
      undefined,
      {
        [WEB_SESSION_HEADER]: 'session-allowed',
      },
    )

    expect(first.statusCode).toBe(200)
    expect(second.jsonBody).toEqual(first.jsonBody)
    expect(context.vault.getFiles).toHaveBeenCalledTimes(1)
    expect(context.vault.getAllFolders).toHaveBeenCalledTimes(1)
  })

  it('recomputes the vault index once the cache TTL has expired', async () => {
    const nowSpy = jest.spyOn(Date, 'now')
    try {
      const router = new WebRouter()
      const context = createScopedContext()
      registerVaultRoutes(router, context)

      nowSpy.mockReturnValue(1_000)
      await dispatch(router, 'GET', '/api/vault/index', undefined, {
        [WEB_SESSION_HEADER]: 'session-allowed',
      })

      nowSpy.mockReturnValue(1_000 + 3_001)
      await dispatch(router, 'GET', '/api/vault/index', undefined, {
        [WEB_SESSION_HEADER]: 'session-allowed',
      })

      expect(context.vault.getFiles).toHaveBeenCalledTimes(2)
      expect(context.vault.getAllFolders).toHaveBeenCalledTimes(2)
    } finally {
      nowSpy.mockRestore()
    }
  })

  it('keeps separate vault index cache entries per workspace policy fingerprint', async () => {
    const router = new WebRouter()
    const allowedFile = makeFile('Allowed/a.md')
    const otherFile = makeFile('Other/b.md')
    const getFiles = jest.fn(() => [allowedFile, otherFile])
    const getAllFolders = jest.fn(() => [])
    const policyByToken: Record<string, string> = {
      'session-a': '/Allowed',
      'session-b': '/Other',
    }
    const context: VaultRoutesContext = {
      vault: {
        getFiles,
        getAllFolders,
        getAbstractFileByPath: () => null,
        read: jest.fn(),
        adapter: {},
      },
      workspace: {},
      resolveActiveAgentPolicy: (sessionId) => {
        const workspaceRoot = sessionId ? policyByToken[sessionId] : undefined
        return workspaceRoot
          ? {
              ok: true,
              policy: {
                workspaceRoot,
                readAllowlist: [],
                readDenylist: [],
                writeDenylist: [],
              },
            }
          : {
              ok: false,
              statusCode: 401,
              body: {
                error: {
                  code: 'session_expired',
                  message: 'The web session has expired.',
                },
              },
            }
      },
    }
    registerVaultRoutes(router, context)

    const resA = await dispatch(router, 'GET', '/api/vault/index', undefined, {
      [WEB_SESSION_HEADER]: 'session-a',
    })
    const resB = await dispatch(router, 'GET', '/api/vault/index', undefined, {
      [WEB_SESSION_HEADER]: 'session-b',
    })

    expect(getFiles).toHaveBeenCalledTimes(2)
    expect(
      (resA.jsonBody as { items: Array<{ path: string }> }).items.map(
        (item) => item.path,
      ),
    ).toEqual(['Allowed/a.md'])
    expect(
      (resB.jsonBody as { items: Array<{ path: string }> }).items.map(
        (item) => item.path,
      ),
    ).toEqual(['Other/b.md'])
  })

  it('preserves multi-page pagination semantics against the cached sorted index', async () => {
    const router = new WebRouter()
    const extraFiles = Array.from({ length: 5 }, (_, index) =>
      makeFile(`Allowed/note-${index}.md`),
    )
    const context = createScopedContext('/Allowed', extraFiles)
    registerVaultRoutes(router, context)

    const first = await dispatch(
      router,
      'GET',
      '/api/vault/index?limit=2',
      undefined,
      { [WEB_SESSION_HEADER]: 'session-allowed' },
    )
    expect(first.statusCode).toBe(200)
    const firstBody = first.jsonBody as {
      items: Array<{ path: string }>
      nextCursor: string | null
      hasMore: boolean
    }
    expect(firstBody.hasMore).toBe(true)
    expect(firstBody.nextCursor).not.toBeNull()

    const second = await dispatch(
      router,
      'GET',
      `/api/vault/index?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor as string)}`,
      undefined,
      { [WEB_SESSION_HEADER]: 'session-allowed' },
    )
    expect(second.statusCode).toBe(200)
    const secondBody = second.jsonBody as { items: Array<{ path: string }> }

    const allPaths = [...firstBody.items, ...secondBody.items].map(
      (item) => item.path,
    )
    expect(new Set(allPaths).size).toBe(allPaths.length)
    expect(allPaths).toEqual([...allPaths].sort((a, b) => a.localeCompare(b)))
  })
})

function createScopedContext(
  workspaceRoot = '/Allowed',
  extraEntries: Array<TFile | TFolder> = [],
): VaultRoutesContext {
  const allowedFolder = makeFolder('Allowed')
  const privateFolder = makeFolder('Private')
  const projectsFolder = makeFolder('Projects')
  const projectAllowedFolder = makeFolder('Projects/Allowed')
  const projectPrivateFolder = makeFolder('Projects/Private')
  const allowedFile = makeFile('Allowed/a.md')
  const privateFile = makeFile('Private/secret.md')
  allowedFolder.children = [
    allowedFile,
    ...extraEntries.filter((entry) => entry.path.startsWith('Allowed/')),
  ]
  privateFolder.children = [privateFile]
  projectsFolder.children = [projectAllowedFolder, projectPrivateFolder]
  for (const child of allowedFolder.children) {
    child.parent = allowedFolder
  }
  privateFile.parent = privateFolder
  projectAllowedFolder.parent = projectsFolder
  projectPrivateFolder.parent = projectsFolder
  const root = makeFolder('/', [allowedFolder, privateFolder, projectsFolder])
  allowedFolder.parent = root
  privateFolder.parent = root
  projectsFolder.parent = root
  const entries = new Map(
    [
      root,
      allowedFolder,
      privateFolder,
      projectsFolder,
      projectAllowedFolder,
      projectPrivateFolder,
      allowedFile,
      privateFile,
      ...extraEntries,
    ].map((entry) => [entry.path, entry]),
  )

  return {
    vault: {
      getFiles: jest.fn(() =>
        [allowedFile, privateFile, ...extraEntries].filter(
          (entry): entry is TFile => entry instanceof TFile,
        ),
      ),
      getAllFolders: jest.fn(() =>
        [root, allowedFolder, privateFolder].concat(
          extraEntries.filter(
            (entry): entry is TFolder => entry instanceof TFolder,
          ),
        ),
      ),
      getAbstractFileByPath: (path) => entries.get(path) ?? null,
      getFileByPath: (path) => {
        const entry = entries.get(path)
        return entry instanceof TFile ? entry : null
      },
      read: jest.fn(async (file: TFile) => `content:${file.path}`),
      readBinary: jest.fn(async (file: TFile) => {
        const buf = Buffer.from(`binary:${file.path}`, 'utf8')
        return buf.buffer.slice(
          buf.byteOffset,
          buf.byteOffset + buf.byteLength,
        ) as ArrayBuffer
      }),
      adapter: {
        write: jest.fn(),
        writeBinary: jest.fn(),
      },
    },
    workspace: {
      getActiveFile: () => allowedFile,
    },
    resolveActiveAgentPolicy: (sessionId) =>
      sessionId === 'session-allowed'
        ? {
            ok: true,
            policy: {
              workspaceRoot,
              readAllowlist: [],
              readDenylist: [],
              writeDenylist: [`${workspaceRoot}/Private`],
            },
          }
        : {
            ok: false,
            statusCode: 401,
            body: {
              error: {
                code: 'session_expired',
                message: 'The web session has expired.',
              },
            },
          },
  }
}

function makeFile(path: string): TFile {
  const name = path.split('/').pop() ?? path
  const dot = name.lastIndexOf('.')
  return Object.assign(new TFile(), {
    path,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot >= 0 ? name.slice(dot + 1) : '',
    stat: { ctime: 1, mtime: 2, size: 3 },
  })
}

function makeFolder(
  path: string,
  children: Array<TFile | TFolder> = [],
): TFolder {
  const name = path === '/' ? '/' : (path.split('/').pop() ?? path)
  return Object.assign(new TFolder(), {
    path,
    name,
    children,
  })
}

async function dispatch(
  router: WebRouter,
  method: 'GET' | 'POST',
  url: string,
  body?: unknown,
  headers?: Record<string, string>,
) {
  const resolved = router.resolve(method, url)
  if (!resolved) throw new Error(`missing route: ${method} ${url}`)
  const req = createRequest({ method, url, body, headers })
  const res = createResponse()
  await resolved.handler(req as never, res as never, {})
  return res
}

function createRequest({
  method,
  url,
  body,
  headers,
}: {
  method: string
  url: string
  body?: unknown
  headers?: Record<string, string>
}) {
  const chunks =
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  const stream = Readable.from(chunks) as Readable &
    EventEmitter & {
      method?: string
      url?: string
      headers: Record<string, string>
    }
  stream.method = method
  stream.url = url
  stream.headers = headers ?? {}
  return stream
}

function createResponse() {
  let rawBody = ''
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number
    writableEnded: boolean
    headers: Record<string, string>
    setHeader: (_name: string, _value: string) => void
    end: (chunk?: string | Buffer) => void
    jsonBody: unknown
    rawBody: string
  }
  response.statusCode = 200
  response.writableEnded = false
  response.headers = {}
  response.setHeader = (name, value) => {
    response.headers[name.toLowerCase()] = value
  }
  response.end = (chunk) => {
    if (chunk)
      rawBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk
    response.writableEnded = true
  }
  Object.defineProperty(response, 'jsonBody', {
    get() {
      return rawBody ? (JSON.parse(rawBody) as unknown) : null
    },
  })
  Object.defineProperty(response, 'rawBody', {
    get() {
      return rawBody
    },
  })
  return response
}
