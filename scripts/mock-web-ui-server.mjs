import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { MOCK_CHAT_LIST } from './mock-web-fixtures.mjs'

const root = process.cwd()
const dist = path.join(root, 'web-ui', 'dist')
const port = Number(process.env.PORT || 19091)
const WEB_SESSION_HEADER = 'x-yolo-web-session-id'

const settings = {
  version: 72,
  currentAssistantId: 'assistant-web',
  assistants: [
    {
      id: 'assistant-web',
      name: 'Web Assistant',
      systemPrompt: '',
      modelId: 'openai/gpt-5',
      enableTools: true,
      includeBuiltinTools: true,
    },
  ],
  webRuntime: { enabled: true, host: '127.0.0.1', port },
  chatOptions: {
    stream: true,
    continuationModelId: 'openai/gpt-4.1-mini',
    tabCompletionModelId: 'openai/gpt-4.1-mini',
  },
  providers: [
    {
      id: 'openai',
      presetType: 'openai',
      apiType: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '',
    },
  ],
  chatModels: [
    {
      providerId: 'openai',
      id: 'openai/gpt-5',
      model: 'gpt-5',
      enable: true,
    },
    {
      providerId: 'openai',
      id: 'openai/gpt-4.1-mini',
      model: 'gpt-4.1-mini',
      enable: true,
    },
  ],
  chatModelId: 'openai/gpt-5',
  chatTitleModelId: 'openai/gpt-4.1-mini',
  embeddingModelId: '',
  embeddingModels: [],
  mcpServers: [],
  ragOptions: { enabled: false },
  ragBackendSettings: { productionBackend: 'sqlite', rebuildRequired: false },
  workspaceAgents: [
    {
      id: 'assistant-web',
      name: 'Web Assistant',
      disabled: false,
    },
    {
      id: 'assistant-review',
      name: 'Review Assistant',
      disabled: false,
    },
  ],
}

const allowedAgents = settings.workspaceAgents
  .filter((agent) => !agent.disabled)
  .map((agent) => ({ id: agent.id, name: agent.name }))

const vaultEntries = [
  folder('00 Inbox'),
  file(
    '00 Inbox/today.md',
    '# Today\n\n- Review the web runtime shell\n- Check workspace file access\n- Polish the file tree UI\n',
  ),
  file(
    '00 Inbox/quick-note.md',
    '# Quick note\n\nA small note used to preview Markdown rendering in the web file browser.\n',
  ),
  folder('Projects'),
  folder('Projects/Smart RAG'),
  folder('Projects/Smart RAG/specs'),
  folder('Projects/Smart RAG/research'),
  file(
    'Projects/Smart RAG/README.md',
    '# Smart RAG\n\nThis is a mocked vault file.\n\n## Goals\n\n- Web runtime parity\n- Workspace-aware file access\n- Obsidian-like file navigation\n',
  ),
  file(
    'Projects/Smart RAG/specs/web-runtime.md',
    '## Web Runtime\n\nThe web runtime forwards IO and LLM calls to the Obsidian host. UI-only affordances are allowed in the browser shell.\n',
  ),
  file(
    'Projects/Smart RAG/specs/workspace-policy.md',
    '## Workspace Policy\n\nRead and write operations are filtered before tool results are rendered to the user.\n',
  ),
  file(
    'Projects/Smart RAG/research/metadata-search.json',
    JSON.stringify(
      {
        query: 'select title, tags from /Projects where tags contains "rag"',
        rows: [
          { title: 'Smart RAG', tags: ['rag', 'web'] },
          { title: 'Workspace Policy', tags: ['security'] },
        ],
      },
      null,
      2,
    ),
  ),
  folder('References'),
  folder('References/API'),
  file(
    'References/API/web-routes.md',
    '# Web routes\n\n- `/api/vault/index`\n- `/api/vault/read`\n- `/api/vault/read-binary`\n- `/api/vault/write-binary`\n',
  ),
  file(
    'References/API/openapi.json',
    JSON.stringify({ openapi: '3.1.0', info: { title: 'Mock API' } }, null, 2),
  ),
  folder('References/Assets'),
  binaryFile('References/Assets/diagram.png', 'PNG preview placeholder'),
  binaryFile('References/Assets/product-brief.pdf', 'PDF preview placeholder'),
  folder('Uploads'),
  file('Uploads/example.txt', 'Uploaded files will appear here.'),
  file(
    'Uploads/import-log.csv',
    'time,event\n09:00,created mock vault\n09:10,opened web file panel\n',
  ),
  folder('Archive'),
  folder('Archive/2026'),
  file(
    'Archive/2026/release-notes.md',
    '# Release notes\n\nOlder notes stay visible under nested folders.\n',
  ),
]

const fileContents = new Map(
  vaultEntries
    .filter((entry) => entry.kind === 'file')
    .map((entry) => [entry.path, entry.content ?? '']),
)

let currentSessionId = 'mock-session-1'
let authenticated = false
let activeAgentId = allowedAgents[0]?.id ?? 'assistant-web'

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
  setCorsHeaders(res)
  if (req.method === 'OPTIONS') {
    res.statusCode = 204
    res.end()
    return
  }

  try {
    if (url.pathname === '/api/bootstrap') {
      const session = getSession(req)
      writeJson(res, {
        serverUrl: `http://127.0.0.1:${port}`,
        phase: 2,
        authRequired: true,
        workspaceAgentConfigured: true,
        session: session ? { agentId: session.agentId } : null,
        allowedAgents: session ? allowedAgents : [],
        settings: { webRuntimeEnabled: true },
        vaultName: 'Mock Vault',
        activeFile: null,
        pluginInfo: { id: 'smart-rag', name: 'Smart RAG', version: 'mock' },
      })
      return
    }
    if (url.pathname === '/api/web/auth/session') {
      const session = getSession(req)
      if (!session) {
        writeJson(
          res,
          apiError('session_expired', 'The web session has expired.'),
          401,
        )
        return
      }
      res.setHeader(WEB_SESSION_HEADER, currentSessionId)
      writeJson(res, {
        session: { agentId: session.agentId },
        allowedAgents,
      })
      return
    }
    if (url.pathname === '/api/web/auth/login' && req.method === 'POST') {
      const body = await readJsonBody(req)
      if (typeof body?.token !== 'string' || body.token.trim().length === 0) {
        writeJson(res, apiError('unauthenticated', 'Invalid share token.'), 401)
        return
      }
      authenticated = true
      currentSessionId = `mock-session-${Date.now()}`
      res.setHeader(WEB_SESSION_HEADER, currentSessionId)
      writeJson(res, {
        session: { agentId: activeAgentId },
        allowedAgents,
      })
      return
    }
    if (url.pathname === '/api/web/auth/logout' && req.method === 'POST') {
      authenticated = false
      res.setHeader(WEB_SESSION_HEADER, '')
      writeJson(res, { ok: true })
      return
    }
    if (
      url.pathname === '/api/web/auth/switch-agent' &&
      req.method === 'POST'
    ) {
      const session = getSession(req)
      if (!session) {
        writeJson(
          res,
          apiError('session_expired', 'The web session has expired.'),
          401,
        )
        return
      }
      const body = await readJsonBody(req)
      const nextAgentId = typeof body?.agentId === 'string' ? body.agentId : ''
      if (!allowedAgents.some((agent) => agent.id === nextAgentId)) {
        writeJson(res, apiError('forbidden', 'Agent is not available.'), 403)
        return
      }
      activeAgentId = nextAgentId
      res.setHeader(WEB_SESSION_HEADER, currentSessionId)
      writeJson(res, {
        session: { agentId: activeAgentId },
        allowedAgents,
      })
      return
    }
    if (url.pathname === '/api/settings') {
      writeJson(res, settings)
      return
    }
    if (url.pathname === '/api/cli/availability') {
      writeJson(res, {
        'claude-code': false,
        codex: false,
        hermes: false,
        pi: false,
      })
      return
    }
    if (
      /^\/api\/chat-runtime\/[^/]+\/sessions$/.test(url.pathname) &&
      req.method === 'GET'
    ) {
      writeJson(res, { ok: true, sessions: [] })
      return
    }
    if (url.pathname === '/api/vault/index') {
      writeJson(
        res,
        // eslint-disable-next-line no-unused-vars -- rest 解构剔除 content 字段（_content 占位，base no-unused-vars 无 ignore pattern）
        vaultEntries.map(({ content: _content, ...entry }) => entry),
      )
      return
    }
    if (url.pathname === '/api/vault/list') {
      const folderPath = normalize(url.searchParams.get('path') ?? '')
      const items = vaultEntries
        // eslint-disable-next-line no-unused-vars -- rest 解构剔除 content 字段（_content 占位，base no-unused-vars 无 ignore pattern）
        .map(({ content: _content, ...entry }) => entry)
        .filter((entry) => parentPath(entry.path) === folderPath)
      writeJson(res, { items, nextCursor: null, hasMore: false })
      return
    }
    if (url.pathname === '/api/vault/read') {
      const vaultPath = normalize(url.searchParams.get('path') ?? '')
      if (!fileContents.has(vaultPath)) {
        writeJson(
          res,
          { error: { code: 'not_found', message: 'File not found' } },
          404,
        )
        return
      }
      writeJson(res, { content: fileContents.get(vaultPath) })
      return
    }
    if (url.pathname === '/api/vault/read-binary') {
      const vaultPath = normalize(url.searchParams.get('path') ?? '')
      const content = fileContents.get(vaultPath)
      if (content == null) {
        writeJson(
          res,
          { error: { code: 'not_found', message: 'File not found' } },
          404,
        )
        return
      }
      const bytes = Buffer.from(content, 'utf8')
      res.statusCode = 200
      res.setHeader('content-type', 'application/octet-stream')
      res.setHeader(
        'content-disposition',
        `attachment; filename="${path.basename(vaultPath)}"`,
      )
      res.end(bytes)
      return
    }
    if (url.pathname === '/api/vault/search') {
      const query = (url.searchParams.get('query') ?? '').toLowerCase()
      const items = vaultEntries
        // eslint-disable-next-line no-unused-vars -- rest 解构剔除 content 字段（_content 占位，base no-unused-vars 无 ignore pattern）
        .map(({ content: _content, ...entry }) => entry)
        .filter((entry) => entry.path.toLowerCase().includes(query))
      writeJson(res, { items, nextCursor: null, hasMore: false })
      return
    }
    if (url.pathname === '/api/vault/write' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const vaultPath = normalize(body?.path ?? '')
      const content = typeof body?.content === 'string' ? body.content : ''
      const overwrite = body?.overwrite === true
      upsertTextFile(vaultPath, content, overwrite)
      writeJson(res, { ok: true })
      return
    }
    if (url.pathname === '/api/vault/create' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const vaultPath = normalize(body?.path ?? '')
      const content = typeof body?.content === 'string' ? body.content : ''
      const overwrite = body?.overwrite === true
      createFile(vaultPath, content, overwrite)
      writeJson(res, { ok: true })
      return
    }
    if (url.pathname === '/api/vault/create-folder' && req.method === 'POST') {
      const body = await readJsonBody(req)
      const vaultPath = normalize(body?.path ?? '')
      const overwrite = body?.overwrite === true
      createFolder(vaultPath, overwrite)
      writeJson(res, { ok: true })
      return
    }
    if (url.pathname === '/api/vault/rename' && req.method === 'POST') {
      const body = await readJsonBody(req)
      renameOrMove(body?.fromPath, body?.toPath, body?.overwrite === true)
      writeJson(res, { ok: true })
      return
    }
    if (url.pathname === '/api/vault/move' && req.method === 'POST') {
      const body = await readJsonBody(req)
      renameOrMove(body?.fromPath, body?.toPath, body?.overwrite === true)
      writeJson(res, { ok: true })
      return
    }
    if (url.pathname === '/api/vault/delete' && req.method === 'POST') {
      const body = await readJsonBody(req)
      deletePath(body?.path, body?.recursive === true)
      writeJson(res, { ok: true })
      return
    }
    if (url.pathname === '/api/vault/write-binary' && req.method === 'POST') {
      const vaultPath = normalize(url.searchParams.get('path') ?? '')
      const overwrite = url.searchParams.get('overwrite') === '1'
      const data = await readBinaryBody(req)
      upsertTextFile(vaultPath, `[binary ${data.byteLength} bytes]`, overwrite)
      writeJson(res, { ok: true })
      return
    }
    if (url.pathname.startsWith('/api/chat/')) {
      if (url.pathname === '/api/chat/list') {
        const session = getSession(req)
        if (!session) {
          writeJson(
            res,
            apiError('session_expired', 'The web session has expired.'),
            401,
          )
          return
        }
        writeJson(res, MOCK_CHAT_LIST)
        return
      }
      writeJson(
        res,
        { error: { code: 'not_found', message: 'Not found' } },
        404,
      )
      return
    }
    if (url.pathname.startsWith('/api/agent/')) {
      if (url.pathname === '/api/agent/queue/peek') {
        writeJson(res, { messages: [] })
        return
      }
      if (url.pathname === '/api/agent/queue/events') {
        res.statusCode = 200
        res.setHeader('content-type', 'text/event-stream; charset=utf-8')
        res.setHeader('cache-control', 'no-cache, no-transform')
        res.end()
        return
      }
      writeJson(
        res,
        { error: { code: 'not_found', message: 'Not found' } },
        404,
      )
      return
    }

    serveStatic(url.pathname, res)
  } catch (error) {
    writeJson(
      res,
      {
        error: {
          code: 'internal_error',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      500,
    )
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`mock web ui server listening http://127.0.0.1:${port}`)
})

function serveStatic(requestPath, res) {
  const name =
    requestPath === '/' ? 'index.html' : requestPath.replace(/^\/+/, '')
  if (!['index.html', 'index.js', 'app.css', 'styles.css'].includes(name)) {
    writeJson(res, { error: { code: 'not_found', message: 'Not found' } }, 404)
    return
  }
  const filePath = path.join(dist, name)
  if (!fs.existsSync(filePath)) {
    writeJson(res, { error: { code: 'not_found', message: 'Not found' } }, 404)
    return
  }
  res.statusCode = 200
  res.setHeader('content-type', contentType(name))
  res.setHeader('cache-control', 'no-store')
  fs.createReadStream(filePath).pipe(res)
}

function contentType(name) {
  if (name.endsWith('.html')) return 'text/html; charset=utf-8'
  if (name.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (name.endsWith('.css')) return 'text/css; charset=utf-8'
  return 'application/octet-stream'
}

function writeJson(res, body, statusCode = 200) {
  setCorsHeaders(res)
  res.statusCode = statusCode
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(body))
}

function setCorsHeaders(res) {
  res.setHeader('access-control-allow-origin', '*')
  res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS')
  res.setHeader(
    'access-control-allow-headers',
    'Authorization, Content-Type, Accept, x-yolo-web-session-id',
  )
}

function normalize(value) {
  return value.replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '')
}

function parentPath(value) {
  const normalized = normalize(value)
  const index = normalized.lastIndexOf('/')
  return index < 0 ? '' : normalized.slice(0, index)
}

function getSession(req) {
  const header = req.headers[WEB_SESSION_HEADER]
  const sessionId = Array.isArray(header) ? header[0] : header
  if (!authenticated) return null
  if (sessionId && sessionId !== currentSessionId) return null
  return { id: currentSessionId, agentId: activeAgentId }
}

async function readJsonBody(req) {
  const text = await readTextBody(req)
  if (!text) return {}
  return JSON.parse(text)
}

async function readTextBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readBinaryBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }
  return Buffer.concat(chunks)
}

function apiError(code, message) {
  return { error: { code, message } }
}

function ensureParentExists(vaultPath) {
  const parent = parentPath(vaultPath)
  if (!parent) return
  if (
    !vaultEntries.some(
      (entry) => entry.kind === 'folder' && entry.path === parent,
    )
  ) {
    throw new Error('Parent folder not found')
  }
}

function findEntry(vaultPath) {
  return vaultEntries.find((entry) => entry.path === vaultPath)
}

function ensurePathWritable(vaultPath, overwrite) {
  const existing = findEntry(vaultPath)
  if (existing && !overwrite) {
    throw new Error('Path already exists')
  }
  if (existing && overwrite) {
    deletePath(vaultPath, existing.kind === 'folder')
  }
}

function upsertTextFile(vaultPath, content, overwrite) {
  const normalized = normalize(vaultPath)
  const existing = findEntry(normalized)
  if (!existing) {
    createFile(normalized, content, overwrite)
    return
  }
  if (existing.kind !== 'file') {
    throw new Error('Path is not a file')
  }
  existing.stat = {
    ctime: existing.stat?.ctime ?? Date.now(),
    mtime: Date.now(),
    size: Buffer.byteLength(content),
  }
  fileContents.set(normalized, content)
}

function createFile(vaultPath, content, overwrite) {
  const normalized = normalize(vaultPath)
  ensureParentExists(normalized)
  ensurePathWritable(normalized, overwrite)
  vaultEntries.push(file(normalized, content))
  fileContents.set(normalized, content)
}

function createFolder(vaultPath, overwrite) {
  const normalized = normalize(vaultPath)
  ensureParentExists(normalized)
  ensurePathWritable(normalized, overwrite)
  vaultEntries.push(folder(normalized))
}

function renameOrMove(fromPath, toPath, overwrite) {
  const from = normalize(fromPath ?? '')
  const to = normalize(toPath ?? '')
  const target = findEntry(from)
  if (!target) throw new Error('Not found')
  if (from === to) return
  ensureParentExists(to)
  ensurePathWritable(to, overwrite)

  if (target.kind === 'folder') {
    const affected = vaultEntries.filter(
      (entry) => entry.path === from || entry.path.startsWith(`${from}/`),
    )
    for (const entry of affected) {
      const nextPath =
        entry.path === from ? to : `${to}/${entry.path.slice(from.length + 1)}`
      if (entry.kind === 'file') {
        const text = fileContents.get(entry.path)
        if (text != null) {
          fileContents.delete(entry.path)
          fileContents.set(nextPath, text)
        }
      }
      entry.path = nextPath
      entry.name = path.posix.basename(nextPath)
      entry.basename = entry.name.replace(/\.[^.]+$/, '')
      entry.extension = entry.name.includes('.')
        ? entry.name.split('.').pop()
        : ''
      if (entry.stat) entry.stat.mtime = Date.now()
    }
    return
  }

  const text = fileContents.get(from)
  if (text != null) {
    fileContents.delete(from)
    fileContents.set(to, text)
  }
  target.path = to
  target.name = path.posix.basename(to)
  target.basename = target.name.replace(/\.[^.]+$/, '')
  target.extension = target.name.includes('.')
    ? target.name.split('.').pop()
    : ''
  if (target.stat) target.stat.mtime = Date.now()
}

function deletePath(vaultPath, recursive) {
  const normalized = normalize(vaultPath)
  const target = findEntry(normalized)
  if (!target) throw new Error('Not found')
  if (target.kind === 'folder') {
    const descendants = vaultEntries.filter((entry) =>
      entry.path.startsWith(`${normalized}/`),
    )
    if (descendants.length > 0 && !recursive) {
      throw new Error('Folder is not empty')
    }
    for (let index = vaultEntries.length - 1; index >= 0; index -= 1) {
      const current = vaultEntries[index]
      if (
        current.path === normalized ||
        current.path.startsWith(`${normalized}/`)
      ) {
        fileContents.delete(current.path)
        vaultEntries.splice(index, 1)
      }
    }
    return
  }
  fileContents.delete(normalized)
  const index = vaultEntries.findIndex((entry) => entry.path === normalized)
  if (index >= 0) {
    vaultEntries.splice(index, 1)
  }
}

function folder(vaultPath) {
  const name = path.posix.basename(vaultPath)
  return {
    kind: 'folder',
    path: vaultPath,
    name,
    basename: name,
    extension: '',
  }
}

function file(vaultPath, content) {
  const name = path.posix.basename(vaultPath)
  const dot = name.lastIndexOf('.')
  return {
    kind: 'file',
    path: vaultPath,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot >= 0 ? name.slice(dot + 1) : '',
    stat: {
      ctime: Date.now(),
      mtime: Date.now(),
      size: Buffer.byteLength(content),
    },
    content,
  }
}

function binaryFile(vaultPath, label) {
  const entry = file(vaultPath, label)
  entry.binary = true
  return entry
}
