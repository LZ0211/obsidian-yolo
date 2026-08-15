/* eslint-disable no-restricted-globals -- 浏览器运行时使用 Web 平台 API（localStorage 会话 id / fetch 传输），Obsidian 桌面端禁令不适用 */
import type { Assistant } from '../../types/assistant.types'

export type WebBootstrapPayload = {
  serverUrl: string
  phase: 1 | 2
  authRequired: boolean
  workspaceAgentConfigured: boolean
  session?: { agentId: string } | null
  // Bootstrap surfaces the workspace agents the current session is allowed
  // to switch into. `agentModeAllowed` mirrors the resolver's
  // PublicWorkspaceAgentSummary so the chat UI can gate the mode dropdown
  // without a second round-trip. Optional on the wire for back-compat —
  // chat falls back to "allowed" when absent.
  allowedAgents?: Array<{
    id: string
    name?: string
    agentModeAllowed?: boolean
    unavailable?: boolean
  }>
  /** Vault-absolute path of the active agent's workspace root. Empty / absent
   *  means the agent has no workspace scope and the whole vault is visible.
   *  When set, the web-ui scopes the file tree and mention picker to this
   *  folder (the user's "home"). */
  workspaceRoot?: string
  settings: {
    webRuntimeEnabled: boolean
  }
  pluginInfo?: {
    id: string
    name: string
    version: string
    dir?: string
  }
  language?: string
  vaultName?: string
  activeFile?: {
    path: string
    name: string
    basename: string
    extension: string
    stat?: {
      ctime: number
      mtime: number
      size: number
    }
  } | null
}

export type WebSessionState = {
  agentId: string
}

export type WebAuthState = {
  session: WebSessionState
  allowedAgents: Array<{
    id: string
    name?: string
    agentModeAllowed?: boolean
    unavailable?: boolean
  }>
}

export type WebVaultListItem = {
  kind: 'file' | 'folder'
  path: string
  name: string
  basename?: string
  extension?: string
  stat?: {
    ctime: number
    mtime: number
    size: number
  }
}

export type WebVaultListResponse = {
  items: WebVaultListItem[]
  nextCursor: string | null
  hasMore: boolean
}

export type WebVaultSearchResponse = {
  items: WebVaultListItem[]
  nextCursor: string | null
  hasMore: boolean
}

export type WebLiteSkillEntry = {
  name: string
  description: string
  mode: 'lazy' | 'always'
  path: string
}

const WEB_SESSION_HEADER = 'x-yolo-web-session-id'

export class WebApiClient {
  readonly baseUrl: string
  private static readonly SESSION_STORAGE_KEY = 'yolo-web-session-id'
  private _sessionId: string | null = null

  get currentSessionId(): string | null {
    return this._sessionId
  }

  private get sessionId(): string | null { return this._sessionId }
  private set sessionId(value: string | null) {
    this._sessionId = value
    try {
      if (value) localStorage.setItem(WebApiClient.SESSION_STORAGE_KEY, value)
      else localStorage.removeItem(WebApiClient.SESSION_STORAGE_KEY)
    } catch { /* localStorage unavailable */ }
  }

  constructor({ baseUrl }: { baseUrl: string }) {
    this.baseUrl = baseUrl.replace(/\/+$/, '')
    try {
      this._sessionId = localStorage.getItem(WebApiClient.SESSION_STORAGE_KEY) || null
    } catch { /* localStorage unavailable */ }
  }

  async getBootstrap(signal?: AbortSignal): Promise<WebBootstrapPayload> {
    return this.getJson<WebBootstrapPayload>('/api/bootstrap', signal)
  }

  async getSettings(signal?: AbortSignal): Promise<unknown> {
    return this.getJson('/api/settings', signal)
  }

  async getAgents(signal?: AbortSignal): Promise<Assistant[]> {
    return this.getJson<Assistant[]>('/api/agents', signal)
  }

  async getSkills(signal?: AbortSignal): Promise<WebLiteSkillEntry[]> {
    return this.getJson<WebLiteSkillEntry[]>('/api/skills', signal)
  }

  async loginWithShareToken(token: string): Promise<WebAuthState> {
    const response = await this.request('/api/web/auth/login', {
      method: 'POST',
      body: JSON.stringify({ token }),
    })
    return this.readJson<WebAuthState>(response)
  }

  async logout(): Promise<void> {
    await this.request('/api/web/auth/logout', { method: 'POST' })
    this.sessionId = null
  }

  async getWebSession(): Promise<WebSessionState | null> {
    try {
      const auth = await this.getJson<WebAuthState>('/api/web/auth/session')
      return auth.session
    } catch (error) {
      if (isHttpStatusError(error, 401)) {
        this.sessionId = null
        return null
      }
      throw error
    }
  }

  async getWebAuthState(): Promise<WebAuthState | null> {
    try {
      return await this.getJson<WebAuthState>('/api/web/auth/session')
    } catch (error) {
      if (isHttpStatusError(error, 401)) {
        this.sessionId = null
        return null
      }
      throw error
    }
  }

  async switchAgent(agentId: string): Promise<WebAuthState> {
    const response = await this.request('/api/web/auth/switch-agent', {
      method: 'POST',
      body: JSON.stringify({ agentId }),
    })
    return this.readJson<WebAuthState>(response)
  }

  async listVaultFolder(
    path: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<WebVaultListResponse> {
    const search = new URLSearchParams({ path })
    if (options?.limit != null) search.set('limit', String(options.limit))
    if (options?.cursor) search.set('cursor', options.cursor)
    const response = await this.getJson<unknown>(`/api/vault/list?${search.toString()}`)
    return normalizePagedVaultResponse(response)
  }

  async listVaultIndex(
    options?: { limit?: number; cursor?: string },
  ): Promise<WebVaultListResponse> {
    const search = new URLSearchParams()
    if (options?.limit != null) search.set('limit', String(options.limit))
    if (options?.cursor) search.set('cursor', options.cursor)
    const suffix = search.size > 0 ? `?${search.toString()}` : ''
    const response = await this.getJson<unknown>(`/api/vault/index${suffix}`)
    return normalizePagedVaultResponse(response)
  }

  async previewVaultText(path: string): Promise<string> {
    return this.readVaultText(path)
  }

  async readVaultText(path: string): Promise<string> {
    const response = await this.getJson<{ content: string }>(
      `/api/vault/read?path=${encodeURIComponent(path)}`,
    )
    return response.content
  }

  async readVaultBinary(path: string): Promise<Blob> {
    const response = await this.request(
      `/api/vault/read-binary?path=${encodeURIComponent(path)}`,
      { method: 'GET' },
    )
    return response.blob()
  }

  async downloadVaultFile(path: string): Promise<Blob> {
    const response = await this.request(
      `/api/vault/read-binary?path=${encodeURIComponent(path)}&download=1`,
      { method: 'GET' },
    )
    return response.blob()
  }

  async resolveCitation(
    citationId: string,
    conversationId: string,
  ): Promise<{ path?: string | null }> {
    const search = new URLSearchParams({ conversationId })
    return this.getJson<{ path?: string | null }>(
      `/api/citation/${encodeURIComponent(citationId)}?${search.toString()}`,
    )
  }

  async searchVault(
    query: string,
    options?: { limit?: number; cursor?: string },
  ): Promise<WebVaultSearchResponse> {
    const search = new URLSearchParams({ query })
    if (options?.limit != null) search.set('limit', String(options.limit))
    if (options?.cursor) search.set('cursor', options.cursor)
    const response = await this.getJson<unknown>(
      `/api/vault/search?${search.toString()}`,
    )
    return normalizePagedVaultResponse(response)
  }

  async writeVaultText(
    path: string,
    content: string,
    overwrite = false,
  ): Promise<void> {
    await this.postJson('/api/vault/write', { path, content, overwrite })
  }

  async writeVaultBinary(
    path: string,
    data: ArrayBuffer,
    overwrite = false,
  ): Promise<void> {
    const search = new URLSearchParams({ path })
    if (overwrite) search.set('overwrite', '1')
    await this.request(`/api/vault/write-binary?${search.toString()}`, {
      method: 'POST',
      body: data,
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    })
  }

  async createVaultFile(
    path: string,
    content = '',
    overwrite = false,
  ): Promise<void> {
    await this.postJson('/api/vault/create', { path, content, overwrite })
  }

  async createVaultFolder(path: string, overwrite = false): Promise<void> {
    await this.postJson('/api/vault/create-folder', { path, overwrite })
  }

  async renameVaultPath(
    fromPath: string,
    toPath: string,
    overwrite = false,
  ): Promise<void> {
    await this.postJson('/api/vault/rename', { fromPath, toPath, overwrite })
  }

  async moveVaultPath(
    fromPath: string,
    toPath: string,
    overwrite = false,
  ): Promise<void> {
    await this.postJson('/api/vault/move', { fromPath, toPath, overwrite })
  }

  async deleteVaultFile(path: string): Promise<void> {
    await this.postJson('/api/vault/delete', { path, recursive: false })
  }

  async deleteVaultFolder(path: string, recursive = false): Promise<void> {
    await this.postJson('/api/vault/delete', { path, recursive })
  }

  async uploadVaultFiles(
    files: Array<{ path: string; data: ArrayBuffer; overwrite?: boolean }>,
  ): Promise<Array<{ path: string; ok: true } | { path: string; ok: false; error: string }>> {
    const results: Array<
      { path: string; ok: true } | { path: string; ok: false; error: string }
    > = []
    for (const file of files) {
      try {
        await this.writeVaultBinary(file.path, file.data, file.overwrite ?? false)
        results.push({ path: file.path, ok: true })
      } catch (error) {
        results.push({
          path: file.path,
          ok: false,
          error: error instanceof Error ? error.message : 'Upload failed',
        })
      }
    }
    return results
  }

  async getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
    const response = await this.request(path, { method: 'GET', signal })
    return this.readJson<T>(response)
  }

  async getJsonOrNull<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    try {
      const response = await this.request(path, { method: 'GET', signal })
      if (response.status === 204) return null
      return this.readJson<T>(response)
    } catch (error) {
      // A 404 means "no such resource" (e.g. a not-yet-created conversation).
      // Callers like chat.get treat that as null rather than an exception —
      // this also matches webMockTransport's getJsonOrNull semantics.
      if (isHttpStatusError(error, 404)) return null
      throw error
    }
  }

  async postJson<T>(
    path: string,
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<T> {
    const response = await this.request(path, {
      method: 'POST',
      body: JSON.stringify(body),
      signal,
    })
    return this.readJson<T>(response)
  }

  async openSseFetch(path: string, signal?: AbortSignal): Promise<Response> {
    return this.request(path, {
      method: 'GET',
      signal,
      headers: {
        Accept: 'text/event-stream',
      },
    })
  }

  private async request(
    path: string,
    init: RequestInit & { headers?: Record<string, string> },
  ): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (
      typeof init.body === 'string' &&
      init.body.length > 0 &&
      !headers.has('Content-Type')
    ) {
      headers.set('Content-Type', 'application/json')
    }
    if (this.sessionId) {
      headers.set(WEB_SESSION_HEADER, this.sessionId)
    }
    const response = await fetch(this.toUrl(path), {
      ...init,
      headers,
    })
    this.captureSessionHeader(response)
    if (!response.ok) {
      throw await HttpStatusError.fromResponse(response)
    }
    return response
  }

  private toUrl(path: string): string {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`
  }

  private captureSessionHeader(response: Response): void {
    const header = response.headers.get(WEB_SESSION_HEADER)
    if (header != null) {
      this.sessionId = header || null
    }
  }

  private async readJson<T>(response: Response): Promise<T> {
    if (response.status === 204) return null as T
    return (await response.json()) as T
  }
}

function normalizePagedVaultResponse(value: unknown): WebVaultListResponse {
  if (Array.isArray(value)) {
    return {
      items: value as WebVaultListItem[],
      nextCursor: null,
      hasMore: false,
    }
  }
  const record = value as Partial<WebVaultListResponse> | null
  return {
    items: Array.isArray(record?.items)
      ? (record.items)
      : [],
    nextCursor:
      typeof record?.nextCursor === 'string' ? record.nextCursor : null,
    hasMore: record?.hasMore === true,
  }
}

class HttpStatusError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }

  static async fromResponse(response: Response): Promise<HttpStatusError> {
    let message = `Request failed with ${response.status}`
    try {
      const payload = (await response.json()) as {
        error?: { message?: string }
      }
      if (payload?.error?.message) {
        message = payload.error.message
      }
    } catch {
      // Ignore non-JSON error bodies.
    }
    return new HttpStatusError(response.status, message)
  }
}

function isHttpStatusError(error: unknown, status: number): boolean {
  return error instanceof HttpStatusError && error.status === status
}
