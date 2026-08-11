import { WebApiClient } from './WebApiClient'

describe('WebApiClient', () => {
  const originalFetch = global.fetch

  beforeEach(() => {
    global.fetch = jest.fn()
  })

  afterEach(() => {
    global.fetch = originalFetch
    jest.resetAllMocks()
  })

  it('posts login tokens in the body and captures the session header', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { agentId: 'agent-1' } }), {
          status: 200,
          headers: { 'x-yolo-web-session-id': 'session-1' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { agentId: 'agent-1' } }), {
          status: 200,
        }),
      )

    const client = new WebApiClient({ baseUrl: 'https://example.test' })
    await client.loginWithShareToken('share-token-123')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/web/auth/login',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ token: 'share-token-123' }),
      }),
    )
    expect(fetchMock.mock.calls[0][0]).not.toContain('share-token-123')
    await expect(client.getWebSession()).resolves.toEqual({ agentId: 'agent-1' })
  })

  it('sends session header on authenticated requests without selector fields', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ session: { agentId: 'agent-1' } }), {
          status: 200,
          headers: { 'x-yolo-web-session-id': 'session-1' },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })))

    const client = new WebApiClient({ baseUrl: 'https://example.test' })
    await client.loginWithShareToken('share-token-123')

    await client.switchAgent('agent-2')

    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://example.test/api/web/auth/switch-agent',
    )
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ agentId: 'agent-2' }),
      }),
    )
    expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toBeInstanceOf(
      Headers,
    )
    const headers = (fetchMock.mock.calls[1][1] as RequestInit).headers
    expect(headers instanceof Headers ? headers.get('x-yolo-web-session-id') : null)
      .toBe('session-1')
    expect(JSON.stringify(fetchMock.mock.calls[1][1])).not.toMatch(
      /assistantId|workspaceId|workspaceRoot|policy/,
    )
  })

  it('lists vault folders with pagination', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [{ kind: 'file', path: 'note.md', name: 'note.md' }],
          nextCursor: 'cursor-2',
          hasMore: true,
        }),
      ),
    )

    const client = new WebApiClient({ baseUrl: 'https://example.test' })
    const result = await client.listVaultFolder('/', { limit: 10, cursor: 'cursor-1' })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/vault/list?path=%2F&limit=10&cursor=cursor-1',
      expect.anything(),
    )
    expect(result).toEqual({
      items: [{ kind: 'file', path: 'note.md', name: 'note.md' }],
      nextCursor: 'cursor-2',
      hasMore: true,
    })
  })

  it('reads text preview and searches without selector fields', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: 'hello' })))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [{ path: 'hello.md' }] })),
      )

    const client = new WebApiClient({ baseUrl: 'https://example.test' })

    await expect(client.previewVaultText('hello.md')).resolves.toBe('hello')
    await expect(client.searchVault('hello', { limit: 5, cursor: 'c1' })).resolves.toEqual(
      { items: [{ path: 'hello.md' }], nextCursor: null, hasMore: false },
    )

    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://example.test/api/vault/read?path=hello.md',
    )
    expect(fetchMock.mock.calls[1][0]).toBe(
      'https://example.test/api/vault/search?query=hello&limit=5&cursor=c1',
    )
  })

  it('posts vault mutation methods to the expected routes', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockImplementation(async () =>
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    )

    const client = new WebApiClient({ baseUrl: 'https://example.test' })

    await client.createVaultFile('Allowed/new.md', 'hello', false)
    await client.createVaultFolder('Allowed/new-folder', false)
    await client.writeVaultText('Allowed/new.md', 'updated', true)
    await client.writeVaultBinary('Allowed/new.bin', new Uint8Array([1, 2, 3]).buffer, true)
    await client.renameVaultPath('Allowed/new.md', 'Allowed/renamed.md', false)
    await client.moveVaultPath('Allowed/renamed.md', 'Allowed/nested/renamed.md', true)
    await client.deleteVaultFile('Allowed/nested/renamed.md')
    await client.deleteVaultFolder('Allowed/nested', true)

    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      'https://example.test/api/vault/create',
      'https://example.test/api/vault/create-folder',
      'https://example.test/api/vault/write',
      'https://example.test/api/vault/write-binary?path=Allowed%2Fnew.bin&overwrite=1',
      'https://example.test/api/vault/rename',
      'https://example.test/api/vault/move',
      'https://example.test/api/vault/delete',
      'https://example.test/api/vault/delete',
    ])
  })

  it('downloads files through fetch-to-blob with download=1', async () => {
    const blob = new Blob(['file-bytes'])
    const response = new Response(blob, {
      headers: { 'content-type': 'text/plain' },
    })
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValueOnce(response)

    const client = new WebApiClient({ baseUrl: 'https://example.test' })
    const result = await client.downloadVaultFile('docs/report.txt')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/vault/read-binary?path=docs%2Freport.txt&download=1',
      expect.objectContaining({ method: 'GET' }),
    )
    expect(result).toBeInstanceOf(Blob)
  })

  it('resolves citations with conversation id through the guarded citation route', async () => {
    const fetchMock = jest.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: 'notes/today.md' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    global.fetch = fetchMock as never

    const client = new WebApiClient({ baseUrl: 'https://example.test' })
    const result = await client.resolveCitation('cite-1', 'conv-1')

    expect(result).toEqual({ path: 'notes/today.md' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.test/api/citation/cite-1?conversationId=conv-1',
      expect.objectContaining({ method: 'GET' }),
    )
  })

  it('returns null from getJsonOrNull when the resource is missing (404)', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Not found' } }), {
        status: 404,
      }),
    )

    const client = new WebApiClient({ baseUrl: 'https://example.test' })
    await expect(client.getJsonOrNull('/api/chat/get/missing')).resolves.toBeNull()
  })

  it('still throws from getJsonOrNull on non-404 failures', async () => {
    const fetchMock = global.fetch as jest.Mock
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Boom' } }), {
        status: 500,
      }),
    )

    const client = new WebApiClient({ baseUrl: 'https://example.test' })
    await expect(client.getJsonOrNull('/api/chat/get/missing')).rejects.toThrow(
      /Boom/,
    )
  })
})
