// eslint-disable-next-line import/no-nodejs-modules -- type-only import，编译后消失，无运行时 node 依赖
import type { IncomingMessage } from 'node:http'

import { TAbstractFile, TFile, TFolder } from 'obsidian'

import type { WorkspaceAgentPolicy } from '../../../settings/schema/setting.types'
import { chunkArray } from '../../../utils/common/chunk-array'
import {
  type WorkspacePermissionDecision,
  decideWorkspacePathAccess,
  isHiddenSharedWebPath,
  isPathWithinSegmentAware,
  normalizeVaultRootPath,
} from '../../workspace/workspacePermissionEngine'
import { writeJson } from '../WebHttpServer'
import { type WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import { apiError, readJsonBody } from './routeUtils'

const DEFAULT_BINARY_BODY_MAX_BYTES = 50 * 1024 * 1024
const DEFAULT_PAGE_LIMIT = 500
const MAX_PAGE_LIMIT = 5000
const VAULT_INDEX_CACHE_TTL_MS = 3000
const VAULT_INDEX_CHUNK_SIZE = 2000
const SAFE_INLINE_CONTENT_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'text/plain; charset=utf-8',
  'text/markdown; charset=utf-8',
  'text/csv; charset=utf-8',
  'application/json; charset=utf-8',
  'application/pdf',
])

type VaultLike = {
  getName?: () => string
  getFiles: () => TFile[]
  getAllFolders?: (includeRoot?: boolean) => TFolder[]
  getAbstractFileByPath: (path: string) => TAbstractFile | null
  getFileByPath?: (path: string) => TFile | null
  read: (file: TFile) => Promise<string>
  readBinary?: (file: TFile) => Promise<ArrayBuffer>
  modify?: (file: TFile, content: string) => Promise<void>
  create?: (path: string, content: string) => Promise<TFile>
  createFolder?: (path: string) => Promise<unknown>
  delete?: (file: TAbstractFile) => Promise<void>
  listDescendants?: (path: string) => Promise<string[]>
  realpath?: (path: string) => string | null
  adapter: {
    list?: (path: string) => Promise<{ files: string[]; folders: string[] }>
    stat?: (path: string) => Promise<unknown>
    write?: (path: string, data: string) => Promise<void>
    writeBinary?: (path: string, data: ArrayBuffer) => Promise<void>
    mkdir?: (path: string) => Promise<void>
    remove?: (path: string) => Promise<void>
    rmdir?: (path: string, recursive?: boolean) => Promise<void>
  }
}

type WorkspaceLike = {
  getActiveFile?: () => TFile | null
}

type FileManagerLike = {
  trashFile?: (file: TAbstractFile) => Promise<void>
  renameFile?: (file: TAbstractFile, newPath: string) => Promise<void>
}

export type VaultRoutesContext = {
  vault: VaultLike
  workspace: WorkspaceLike
  fileManager?: FileManagerLike
  resolveActiveAgentPolicy: (sessionId: string | null) =>
    | {
        ok: true
        policy: WorkspaceAgentPolicy
      }
    | {
        ok: false
        statusCode: number
        body:
          | ReturnType<typeof apiError>
          | { error: { code: string; message: string } }
      }
}

type BodyShape = Record<string, unknown>
type ListedEntry =
  | ReturnType<typeof toFileEntry>
  | ReturnType<typeof toFolderEntry>
type SearchEntry = ReturnType<typeof toSearchEntry>

const CLIENT_SELECTOR_REJECTION_MESSAGE =
  'assistantId, workspaceId, workspaceRoot, and client workspace policy fields are not allowed on protected vault routes'

const DISALLOWED_SELECTOR_FIELDS = new Set([
  'assistantId',
  'workspaceId',
  'workspaceRoot',
  'workspacePolicy',
  'policy',
  'readAllowlist',
  'readDenylist',
  'writeDenylist',
  'enabled',
  'readExtraIncludes',
  'readExcludes',
  'writeExcludes',
])

export function registerVaultRoutes(
  router: WebRouter,
  context: VaultRoutesContext,
): void {
  const vaultIndexCache = new Map<string, VaultIndexCacheEntry>()

  router.get('/api/vault/index', async (req, res) => {
    const policy = resolvePolicyForRequest(context, req, res)
    if (!policy) return
    const limit = parseLimit(req.url, res)
    if (limit == null) return
    const cursor = getQueryParam(req.url, 'cursor')
    const sortedItems = await getCachedVaultIndexItems(
      context,
      policy,
      vaultIndexCache,
    )
    writeJson(res, 200, paginateSortedItems(sortedItems, limit, cursor))
  })

  router.get('/api/vault/active-file', (req, res) => {
    const policy = resolvePolicyForRequest(context, req, res)
    if (!policy) return
    const file = context.workspace.getActiveFile?.() ?? null
    writeJson(
      res,
      200,
      file && isReadablePathSafe(file.path, policy) ? toFileEntry(file) : null,
    )
  })

  router.get('/api/vault/read', async (req, res) => {
    const policy = resolvePolicyForRequest(context, req, res)
    if (!policy) return
    const path = getQueryParam(req.url, 'path')
    if (!path) {
      writeJson(res, 400, apiError('invalid_request', 'path is required'))
      return
    }
    const resolved = resolveReadableRoutePath(
      context,
      res,
      path,
      policy,
      'read',
    )
    if (resolved == null) return
    const file = resolveFile(context.vault, resolved)
    if (!file) {
      writeJson(res, 404, apiError('not_found', 'File not found'))
      return
    }
    writeJson(res, 200, { content: await context.vault.read(file) })
  })

  router.get('/api/vault/read-binary', async (req, res) => {
    const policy = resolvePolicyForRequest(context, req, res)
    if (!policy) return
    const path = getQueryParam(req.url, 'path')
    if (!path) {
      writeJson(res, 400, apiError('invalid_request', 'path is required'))
      return
    }
    const resolved = resolveReadableRoutePath(
      context,
      res,
      path,
      policy,
      'download',
    )
    if (resolved == null) return
    const file = resolveFile(context.vault, resolved)
    if (!file) {
      writeJson(res, 404, apiError('not_found', 'File not found'))
      return
    }
    if (!context.vault.readBinary) {
      writeJson(
        res,
        501,
        apiError('unsupported', 'Binary read is not available'),
      )
      return
    }
    const bytes = Buffer.from(await context.vault.readBinary(file))
    const contentType = getContentType(file.path)
    const wantsDownload = getQueryParam(req.url, 'download') === '1'
    const shouldAttach =
      wantsDownload || !SAFE_INLINE_CONTENT_TYPES.has(contentType)
    res.statusCode = 200
    res.setHeader(
      'content-type',
      shouldAttach ? safeAttachmentContentType(contentType) : contentType,
    )
    res.setHeader('content-length', String(bytes.byteLength))
    res.setHeader('x-content-type-options', 'nosniff')
    if (shouldAttach) {
      res.setHeader('content-disposition', buildContentDisposition(file.name))
    }
    res.end(bytes)
  })

  router.get('/api/vault/list', async (req, res) => {
    const policy = resolvePolicyForRequest(context, req, res)
    if (!policy) return
    const path = getQueryParam(req.url, 'path')
    if (!path) {
      writeJson(res, 400, apiError('invalid_request', 'path is required'))
      return
    }
    const limit = parseLimit(req.url, res)
    if (limit == null) return
    const cursor = getQueryParam(req.url, 'cursor')
    const resolvedPath = resolveReadableRoutePath(
      context,
      res,
      path,
      policy,
      'read',
      {
        allowFolderAncestor: true,
        notFoundMessage: 'Folder not found',
      },
    )
    if (resolvedPath == null) return

    const items = context.vault.adapter.list
      ? listingToItems(
          filterListing(
            await context.vault.adapter.list(resolvedPath),
            policy,
            context.vault,
          ),
        )
      : listFolderChildren(context, resolvedPath, policy, res)
    if (items == null) return
    writeJson(res, 200, paginateItems(items, limit, cursor))
  })

  router.get('/api/vault/stat', async (req, res) => {
    const policy = resolvePolicyForRequest(context, req, res)
    if (!policy) return
    const path = getQueryParam(req.url, 'path')
    if (!path) {
      writeJson(res, 400, apiError('invalid_request', 'path is required'))
      return
    }
    const resolved = resolveReadableRoutePath(
      context,
      res,
      path,
      policy,
      'read',
      {
        notFoundMessage: 'Path not found',
      },
    )
    if (resolved == null) return
    const file = context.vault.getAbstractFileByPath(resolved)
    const stat = context.vault.adapter.stat
      ? await context.vault.adapter.stat(resolved)
      : file instanceof TFile
        ? file.stat
        : null
    if (!stat) {
      writeJson(res, 404, apiError('not_found', 'Path not found'))
      return
    }
    writeJson(res, 200, stat)
  })

  router.get('/api/vault/search', async (req, res) => {
    const policy = resolvePolicyForRequest(context, req, res)
    if (!policy) return
    const rawQuery = getQueryParam(req.url, 'query')?.trim() ?? ''
    const query = rawQuery.toLowerCase()
    if (!query) {
      writeJson(res, 400, apiError('invalid_request', 'query is required'))
      return
    }
    const limit = parseLimit(req.url, res, 50, 200)
    if (limit == null) return
    const cursor = getQueryParam(req.url, 'cursor')
    const readableFiles = context.vault
      .getFiles()
      .filter((file) =>
        isReadablePathSafe(file.path, policy, 'search', context.vault.realpath),
      )
    const results: SearchEntry[] = []
    for (const file of readableFiles) {
      const pathMatch = file.path.toLowerCase().includes(query)
      let content: string | null = null
      let contentIndex = -1
      if (isTextSearchable(file)) {
        try {
          content = await context.vault.read(file)
          contentIndex = content.toLowerCase().indexOf(query)
        } catch {
          content = null
        }
      }
      if (!pathMatch && contentIndex < 0) continue
      results.push(
        toSearchEntry(file, {
          preview:
            contentIndex >= 0 && content != null
              ? makeSearchPreview(content, contentIndex, rawQuery.length)
              : '',
          score: contentIndex >= 0 ? 2 : 1,
        }),
      )
    }
    writeJson(res, 200, paginateItems(results, limit, cursor))
  })

  router.post('/api/vault/write', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const policy = resolvePolicyForRequest(context, req, res, body.value)
    if (!policy) return
    const parsed = parsePathContentBody(body.value)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    const resolved = resolveWritableRoutePath(
      context,
      res,
      parsed.path,
      policy,
      'write',
    )
    if (resolved == null) return
    if (
      !readOverwrite(body.value) &&
      context.vault.getAbstractFileByPath(resolved)
    ) {
      writeJson(res, 409, apiError('conflict', 'Path already exists'))
      return
    }
    await writeText(context.vault, resolved, parsed.content, {
      createIfMissing: true,
    })
    writeJson(res, 200, { ok: true })
  })

  router.post('/api/vault/write-binary', async (req, res) => {
    const policy = resolvePolicyForRequest(context, req, res)
    if (!policy) return
    const path = getQueryParam(req.url, 'path')
    if (!path) {
      writeJson(res, 400, apiError('invalid_request', 'path is required'))
      return
    }
    const overwrite = getQueryParam(req.url, 'overwrite') === '1'
    const resolved = resolveWritableRoutePath(
      context,
      res,
      path,
      policy,
      'upload',
    )
    if (resolved == null) return
    if (!overwrite && context.vault.getAbstractFileByPath(resolved)) {
      writeJson(res, 409, apiError('conflict', 'Path already exists'))
      return
    }
    const body = await readBinaryBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    if (context.vault.adapter.writeBinary) {
      await context.vault.adapter.writeBinary(resolved, body.value)
      writeJson(res, 200, { ok: true })
      return
    }
    writeJson(
      res,
      501,
      apiError('unsupported', 'Binary write is not available'),
    )
  })

  router.post('/api/vault/create', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const policy = resolvePolicyForRequest(context, req, res, body.value)
    if (!policy) return
    const parsed = parsePathContentBody(body.value)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    const resolved = resolveWritableRoutePath(
      context,
      res,
      parsed.path,
      policy,
      'create',
    )
    if (resolved == null) return
    if (
      context.vault.getAbstractFileByPath(resolved) &&
      !readOverwrite(body.value)
    ) {
      writeJson(res, 409, apiError('conflict', 'Path already exists'))
      return
    }
    await writeText(context.vault, resolved, parsed.content, {
      createIfMissing: true,
    })
    writeJson(res, 200, { ok: true })
  })

  router.post('/api/vault/create-folder', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const policy = resolvePolicyForRequest(context, req, res, body.value)
    if (!policy) return
    const path = parsePathBody(body.value)
    if (!path.ok) {
      writeJson(res, 400, apiError('invalid_request', path.message))
      return
    }
    const overwrite = readOverwrite(body.value)
    const resolved = resolveWritableRoutePath(
      context,
      res,
      path.path,
      policy,
      'create',
    )
    if (resolved == null) return
    const existing = context.vault.getAbstractFileByPath(resolved)
    if (existing && !(overwrite && existing instanceof TFolder)) {
      writeJson(res, 409, apiError('conflict', 'Path already exists'))
      return
    }
    if (existing) {
      // overwrite=true 且路径已是目录：幂等成功。Obsidian 的 createFolder/
      // adapter.mkdir 对已存在目录会抛 "Folder already exists."，不能依赖它们
      // 的覆盖语义。
      writeJson(res, 200, { ok: true })
      return
    }
    if (context.vault.createFolder) {
      await context.vault.createFolder(resolved)
    } else if (context.vault.adapter.mkdir) {
      await context.vault.adapter.mkdir(resolved)
    } else {
      writeJson(
        res,
        501,
        apiError('unsupported', 'Create folder is not available'),
      )
      return
    }
    writeJson(res, 200, { ok: true })
  })

  router.post('/api/vault/rename', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const policy = resolvePolicyForRequest(context, req, res, body.value)
    if (!policy) return
    const parsed = parseMoveBody(body.value)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    const fromPath = resolveWritableRoutePath(
      context,
      res,
      parsed.fromPath,
      policy,
      'delete',
    )
    const toPath = resolveWritableMoveTarget(
      context,
      res,
      parsed.toPath,
      policy,
    )
    if (fromPath == null || toPath == null) return
    if (!parsed.overwrite && context.vault.getAbstractFileByPath(toPath)) {
      writeJson(res, 409, apiError('conflict', 'Path already exists'))
      return
    }
    const source = context.vault.getAbstractFileByPath(fromPath)
    if (!source) {
      writeJson(res, 404, apiError('not_found', 'Path not found'))
      return
    }
    if (!context.fileManager?.renameFile) {
      writeJson(res, 501, apiError('unsupported', 'Rename is not available'))
      return
    }
    await context.fileManager.renameFile(source, toPath)
    writeJson(res, 200, { ok: true })
  })

  router.post('/api/vault/move', async (req, res) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const policy = resolvePolicyForRequest(context, req, res, body.value)
    if (!policy) return
    const parsed = parseMoveBody(body.value)
    if (!parsed.ok) {
      writeJson(res, 400, apiError('invalid_request', parsed.message))
      return
    }
    const fromPath = resolveWritableRoutePath(
      context,
      res,
      parsed.fromPath,
      policy,
      'delete',
    )
    const toPath = resolveWritableMoveTarget(
      context,
      res,
      parsed.toPath,
      policy,
    )
    if (fromPath == null || toPath == null) return
    if (!parsed.overwrite && context.vault.getAbstractFileByPath(toPath)) {
      writeJson(res, 409, apiError('conflict', 'Path already exists'))
      return
    }
    const source = context.vault.getAbstractFileByPath(fromPath)
    if (!source) {
      writeJson(res, 404, apiError('not_found', 'Path not found'))
      return
    }
    if (!context.fileManager?.renameFile) {
      writeJson(res, 501, apiError('unsupported', 'Move is not available'))
      return
    }
    await context.fileManager.renameFile(source, toPath)
    writeJson(res, 200, { ok: true })
  })

  const handleDelete = async (
    req: IncomingMessage,
    res: Parameters<typeof writeJson>[0],
  ) => {
    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }
    const policy = resolvePolicyForRequest(context, req, res, body.value)
    if (!policy) return
    const path = parsePathBody(body.value)
    if (!path.ok) {
      writeJson(res, 400, apiError('invalid_request', path.message))
      return
    }
    const recursive =
      body.value.recursive === undefined
        ? false
        : typeof body.value.recursive === 'boolean'
          ? body.value.recursive
          : null
    if (recursive === null) {
      writeJson(res, 400, apiError('invalid_request', 'recursive is invalid'))
      return
    }
    const entry = context.vault.getAbstractFileByPath(path.path)
    if (entry instanceof TFolder) {
      if (!context.vault.adapter.rmdir) {
        writeJson(
          res,
          501,
          apiError('unsupported', 'Remove folder is not available'),
        )
        return
      }
      const resolved = await resolveDeleteRoutePath(
        context,
        res,
        path.path,
        policy,
        {
          recursive,
        },
      )
      if (resolved == null) return
      await context.vault.adapter.rmdir(resolved, recursive)
      writeJson(res, 200, { ok: true })
      return
    }
    const resolved = resolveWritableRoutePath(
      context,
      res,
      path.path,
      policy,
      'delete',
    )
    if (resolved == null) return
    if (context.vault.adapter.remove) {
      await context.vault.adapter.remove(resolved)
    } else {
      const file = context.vault.getAbstractFileByPath(resolved)
      if (!file) {
        writeJson(res, 404, apiError('not_found', 'Path not found'))
        return
      }
      if (!context.vault.delete) {
        writeJson(res, 501, apiError('unsupported', 'Remove is not available'))
        return
      }
      await context.vault.delete(file)
    }
    writeJson(res, 200, { ok: true })
  }

  router.post('/api/vault/delete', handleDelete)
  router.post('/api/vault/rmdir', handleDelete)
}

function listFolderChildren(
  context: VaultRoutesContext,
  resolvedPath: string,
  policy: WorkspaceAgentPolicy,
  res: Parameters<typeof writeJson>[0],
): ListedEntry[] | null {
  const folder = context.vault.getAbstractFileByPath(resolvedPath)
  if (!(folder instanceof TFolder)) {
    writeJson(res, 404, apiError('not_found', 'Folder not found'))
    return null
  }
  const fileEntries = folder.children
    .filter((child): child is TFile => child instanceof TFile)
    .filter((child) =>
      isReadablePathSafe(child.path, policy, 'read', context.vault.realpath),
    )
    .map((child) => toFileEntry(child))
  const folderEntries = folder.children
    .filter((child): child is TFolder => child instanceof TFolder)
    .filter((child) => isFolderVisibleInPolicy(child.path, policy))
    .map((child) => toFolderEntry(child))
  return [...folderEntries, ...fileEntries]
}

function listingToItems(listing: {
  fileEntries: ReturnType<typeof toFileEntry>[]
  folderEntries: ReturnType<typeof toFolderEntry>[]
}): ListedEntry[] {
  return [...listing.folderEntries, ...listing.fileEntries]
}

function paginateItems<T extends { path: string }>(
  items: T[],
  limit: number,
  cursor: string | null,
) {
  const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path))
  return paginateSortedItems(sorted, limit, cursor)
}

function paginateSortedItems<T extends { path: string }>(
  sorted: T[],
  limit: number,
  cursor: string | null,
) {
  const start = cursor
    ? sorted.findIndex((item) => item.path === cursor) + 1
    : 0
  const page = sorted.slice(Math.max(start, 0), Math.max(start, 0) + limit)
  const nextItem = sorted[Math.max(start, 0) + limit]
  return {
    items: page,
    nextCursor: nextItem?.path ?? null,
    hasMore: nextItem != null,
  }
}

type VaultIndexCacheEntry = {
  items: ListedEntry[]
  timestamp: number
}

async function getCachedVaultIndexItems(
  context: VaultRoutesContext,
  policy: WorkspaceAgentPolicy,
  cache: Map<string, VaultIndexCacheEntry>,
): Promise<ListedEntry[]> {
  const key = computeVaultPolicyFingerprint(policy)
  const cached = cache.get(key)
  const now = Date.now()
  if (cached && now - cached.timestamp < VAULT_INDEX_CACHE_TTL_MS) {
    return cached.items
  }
  const items = await computeSortedVaultIndexItems(context, policy)
  cache.set(key, { items, timestamp: now })
  return items
}

async function computeSortedVaultIndexItems(
  context: VaultRoutesContext,
  policy: WorkspaceAgentPolicy,
): Promise<ListedEntry[]> {
  const folderEntries: ListedEntry[] = []
  for (const chunk of chunkArray(
    context.vault.getAllFolders?.() ?? [],
    VAULT_INDEX_CHUNK_SIZE,
  )) {
    for (const folder of chunk) {
      if (folder.path === '/') continue
      if (!isFolderVisibleInPolicy(folder.path, policy)) continue
      folderEntries.push(toFolderEntry(folder))
    }
    await yieldToEventLoop()
  }

  const fileEntries: ListedEntry[] = []
  for (const chunk of chunkArray(
    context.vault.getFiles(),
    VAULT_INDEX_CHUNK_SIZE,
  )) {
    for (const file of chunk) {
      if (!isReadablePathSafe(file.path, policy)) continue
      fileEntries.push(toFileEntry(file))
    }
    await yieldToEventLoop()
  }

  const combined = [...folderEntries, ...fileEntries]
  combined.sort((a, b) => a.path.localeCompare(b.path))
  return combined
}

function computeVaultPolicyFingerprint(policy: WorkspaceAgentPolicy): string {
  return JSON.stringify({
    workspaceRoot: policy.workspaceRoot,
    readAllowlist: [...policy.readAllowlist].sort(),
    readDenylist: [...policy.readDenylist].sort(),
    writeDenylist: [...policy.writeDenylist].sort(),
  })
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function parseLimit(
  requestUrl: string | undefined,
  res: Parameters<typeof writeJson>[0],
  defaultValue = DEFAULT_PAGE_LIMIT,
  maxValue = MAX_PAGE_LIMIT,
): number | null {
  const raw = getQueryParam(requestUrl, 'limit')
  if (raw == null || raw === '') return defaultValue
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0 || value > maxValue) {
    writeJson(res, 400, apiError('invalid_request', 'limit is invalid'))
    return null
  }
  return value
}

function readOverwrite(value: BodyShape): boolean {
  return value.overwrite === true
}

function parseMoveBody(
  value: BodyShape,
):
  | { ok: true; fromPath: string; toPath: string; overwrite: boolean }
  | { ok: false; message: string } {
  if (typeof value.fromPath !== 'string' || value.fromPath.length === 0) {
    return { ok: false, message: 'fromPath is required' }
  }
  if (typeof value.toPath !== 'string' || value.toPath.length === 0) {
    return { ok: false, message: 'toPath is required' }
  }
  return {
    ok: true,
    fromPath: value.fromPath,
    toPath: value.toPath,
    overwrite: value.overwrite === true,
  }
}

function resolveWritableMoveTarget(
  context: VaultRoutesContext,
  res: Parameters<typeof writeJson>[0],
  path: string,
  policy: WorkspaceAgentPolicy,
): string | null {
  const decision = decideWorkspacePathAccess({
    policy,
    operation: 'move',
    path,
    targetPath: path,
    realpath: context.vault.realpath,
  })
  if (decision.ok) return fromDecisionPath(decision.path)
  writePermissionDecisionError(res, decision, 'Path not found')
  return null
}

function resolveFile(vault: VaultLike, path: string): TFile | null {
  const direct =
    vault.getFileByPath?.(path) ?? vault.getAbstractFileByPath(path)
  return direct instanceof TFile ? direct : null
}

function toFileEntry(file: TFile) {
  return {
    kind: 'file' as const,
    path: file.path,
    name: file.name,
    basename: file.basename,
    extension: file.extension,
    stat: file.stat,
  }
}

function toFolderEntry(folder: TFolder) {
  return {
    kind: 'folder' as const,
    path: folder.path,
    name: folder.name,
    basename: folder.name,
    extension: '',
  }
}

function getQueryParam(
  requestUrl: string | undefined,
  key: string,
): string | null {
  const url = new URL(requestUrl ?? '/', 'http://localhost')
  return url.searchParams.get(key)
}

function normalizeVaultRoutePath(path: string): string {
  const normalized = path.replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '')
  return normalized.length > 0 ? normalized : '/'
}

function isReadablePathSafe(
  path: string,
  policy: WorkspaceAgentPolicy,
  operation: 'read' | 'search' = 'read',
  realpath?: (path: string) => string | null,
): boolean {
  return decideWorkspacePathAccess({
    policy,
    operation,
    path: toDecisionPath(path),
    realpath,
  }).ok
}

function isFolderVisibleInPolicy(
  folderPath: string,
  policy: WorkspaceAgentPolicy,
): boolean {
  const normalizedFolder = toDecisionPath(folderPath)
  if (isHiddenSharedWebPath(normalizedFolder)) return false
  if (
    decideWorkspacePathAccess({
      policy,
      operation: 'list',
      path: normalizedFolder,
    }).ok
  ) {
    return true
  }
  return readableRoots(policy).some((root) =>
    isPathWithinSegmentAware(normalizedFolder, root),
  )
}

function filterListing(
  listing: { files: string[]; folders: string[] },
  policy: WorkspaceAgentPolicy,
  vault: VaultLike,
): {
  files: string[]
  folders: string[]
  fileEntries: ReturnType<typeof toFileEntry>[]
  folderEntries: ReturnType<typeof toFolderEntry>[]
} {
  const files = listing.files.filter((path) =>
    isReadablePathSafe(path, policy, 'search'),
  )
  const folders = listing.folders.filter((path) =>
    isFolderVisibleInPolicy(path, policy),
  )
  return {
    files,
    folders,
    fileEntries: files.map((path) => {
      const file = resolveFile(vault, path)
      return file ? toFileEntry(file) : toSyntheticFileEntry(path)
    }),
    folderEntries: folders.map((path) => {
      const folder = vault.getAbstractFileByPath(path)
      return folder instanceof TFolder
        ? toFolderEntry(folder)
        : toSyntheticFolderEntry(path)
    }),
  }
}

function resolveReadableRoutePath(
  context: VaultRoutesContext,
  res: Parameters<typeof writeJson>[0],
  path: string,
  policy: WorkspaceAgentPolicy,
  operation: 'read' | 'download',
  options?: { allowFolderAncestor?: boolean; notFoundMessage?: string },
): string | null {
  const decision = decideWorkspacePathAccess({
    policy,
    operation,
    path,
    realpath: context.vault.realpath,
  })
  if (decision.ok) {
    return fromDecisionPath(decision.path)
  }
  if (options?.allowFolderAncestor) {
    const ancestor = resolveAllowedListAncestor(path, policy)
    if (ancestor) return fromDecisionPath(ancestor)
  }
  writePermissionDecisionError(
    res,
    decision,
    options?.notFoundMessage ?? 'File not found',
  )
  return null
}

function resolveWritableRoutePath(
  context: VaultRoutesContext,
  res: Parameters<typeof writeJson>[0],
  path: string,
  policy: WorkspaceAgentPolicy,
  operation: 'create' | 'write' | 'upload' | 'delete',
): string | null {
  const decision = decideWorkspacePathAccess({
    policy,
    operation,
    path,
    realpath: context.vault.realpath,
  })
  if (decision.ok) {
    return fromDecisionPath(decision.path)
  }
  writePermissionDecisionError(res, decision, 'Path not found')
  return null
}

async function resolveDeleteRoutePath(
  context: VaultRoutesContext,
  res: Parameters<typeof writeJson>[0],
  path: string,
  policy: WorkspaceAgentPolicy,
  options: { recursive?: boolean },
): Promise<string | null> {
  const decision = decideWorkspacePathAccess({
    policy,
    operation: 'delete',
    path,
    realpath: context.vault.realpath,
  })
  if (!decision.ok) {
    writePermissionDecisionError(res, decision, 'Path not found')
    return null
  }

  if (!options.recursive) {
    return fromDecisionPath(decision.path)
  }

  if (!context.vault.listDescendants) {
    writeJson(res, 403, apiError('forbidden', 'Forbidden'))
    return null
  }

  const childPaths = await context.vault.listDescendants(
    fromDecisionPath(decision.path),
  )
  const recursiveDecision = decideWorkspacePathAccess({
    policy,
    operation: 'delete',
    path: decision.path,
    childPaths,
    recursiveDelete: true,
    realpath: context.vault.realpath,
  })
  if (!recursiveDecision.ok) {
    writePermissionDecisionError(res, recursiveDecision, 'Path not found')
    return null
  }

  return fromDecisionPath(recursiveDecision.path)
}

async function writeText(
  vault: VaultLike,
  path: string,
  content: string,
  options: { createIfMissing: boolean },
): Promise<void> {
  const existing = resolveFile(vault, path)
  if (existing && vault.modify) {
    await vault.modify(existing, content)
    return
  }
  if (vault.adapter.write) {
    await vault.adapter.write(path, content)
    return
  }
  if (!existing && options.createIfMissing && vault.create) {
    await vault.create(path, content)
    return
  }
  throw new Error('Text write is not available')
}

function parsePathBody(
  value: Record<string, unknown>,
): { ok: true; path: string } | { ok: false; message: string } {
  if (typeof value.path !== 'string' || value.path.length === 0) {
    return { ok: false, message: 'path is required' }
  }
  return { ok: true, path: value.path }
}

function parsePathContentBody(
  value: Record<string, unknown>,
):
  | { ok: true; path: string; content: string }
  | { ok: false; message: string } {
  const path = parsePathBody(value)
  if (!path.ok) return path
  if (typeof value.content !== 'string') {
    return { ok: false, message: 'content is required' }
  }
  return { ok: true, path: path.path, content: value.content }
}

async function readBinaryBody(
  req: AsyncIterable<Uint8Array | string>,
  options?: { maxBytes?: number },
): Promise<
  | { ok: true; value: ArrayBuffer }
  | { ok: false; statusCode: number; body: ReturnType<typeof apiError> }
> {
  const maxBytes = options?.maxBytes ?? DEFAULT_BINARY_BODY_MAX_BYTES
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > maxBytes) {
      return {
        ok: false,
        statusCode: 413,
        body: apiError('request_too_large', 'Binary body is too large'),
      }
    }
    chunks.push(buffer)
  }
  const buffer = Buffer.concat(chunks)
  const view = new Uint8Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength,
  )
  return {
    ok: true,
    // Buffer.concat 的底层 buffer 是普通 ArrayBuffer（非共享内存），
    // TS 5.9 的 ArrayBufferLike 细化需要显式断言。
    value: view.buffer as ArrayBuffer,
  }
}

function toSyntheticFileEntry(path: string) {
  const normalizedPath = normalizeVaultRoutePath(path)
  const name = normalizedPath.split('/').pop() ?? normalizedPath
  const dot = name.lastIndexOf('.')
  return {
    kind: 'file' as const,
    path: normalizedPath,
    name,
    basename: dot > 0 ? name.slice(0, dot) : name,
    extension: dot >= 0 ? name.slice(dot + 1) : '',
    stat: { ctime: 0, mtime: 0, size: 0 },
  }
}

function resolvePolicyForRequest(
  context: VaultRoutesContext,
  req: IncomingMessage,
  res: Parameters<typeof writeJson>[0],
  body?: Record<string, unknown>,
): WorkspaceAgentPolicy | null {
  if (hasDisallowedSelectors(req.url, body)) {
    writeJson(
      res,
      400,
      apiError('invalid_request', CLIENT_SELECTOR_REJECTION_MESSAGE),
    )
    return null
  }
  const resolved = context.resolveActiveAgentPolicy(getSessionId(req))
  if (!resolved.ok) {
    writeJson(res, resolved.statusCode, resolved.body)
    return null
  }
  return resolved.policy
}

function hasDisallowedSelectors(
  requestUrl: string | undefined,
  body?: Record<string, unknown>,
): boolean {
  const url = new URL(requestUrl ?? '/', 'http://localhost')
  for (const key of url.searchParams.keys()) {
    if (DISALLOWED_SELECTOR_FIELDS.has(key)) {
      return true
    }
  }
  if (!body) return false
  return Object.keys(body).some((key) => DISALLOWED_SELECTOR_FIELDS.has(key))
}

function getSessionId(req: IncomingMessage): string | null {
  const value = req.headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}

function readableRoots(policy: WorkspaceAgentPolicy): string[] {
  return [policy.workspaceRoot, ...policy.readAllowlist].map((path) =>
    normalizeVaultRootPath(path),
  )
}

function toDecisionPath(path: string): string {
  const normalized = normalizeVaultRoutePath(path)
  return normalized === '/' ? '/' : `/${normalized}`
}

function fromDecisionPath(path: string): string {
  const normalized = normalizeVaultRootPath(path)
  return normalized === '/' ? '/' : normalized.replace(/^\/+/, '')
}

function resolveAllowedListAncestor(
  path: string,
  policy: WorkspaceAgentPolicy,
): string | null {
  let normalized: string
  try {
    normalized = normalizeVaultRootPath(path)
  } catch {
    return null
  }
  if (isHiddenSharedWebPath(normalized)) return null
  return readableRoots(policy).some((root) =>
    isPathWithinSegmentAware(normalized, root),
  )
    ? normalized
    : null
}

function writePermissionDecisionError(
  res: Parameters<typeof writeJson>[0],
  decision: Extract<WorkspacePermissionDecision, { ok: false }>,
  notFoundMessage: string,
): void {
  if (decision.code === 'invalid_path') {
    writeJson(res, 400, apiError('invalid_request', 'Invalid path'))
    return
  }
  if (decision.code === 'not_found') {
    writeJson(res, 404, apiError('not_found', notFoundMessage))
    return
  }
  writeJson(res, 403, apiError('forbidden', 'Forbidden'))
}

function toSyntheticFolderEntry(path: string) {
  const normalizedPath = normalizeVaultRoutePath(path)
  const name =
    normalizedPath === '/'
      ? '/'
      : (normalizedPath.split('/').pop() ?? normalizedPath)
  return {
    kind: 'folder' as const,
    path: normalizedPath,
    name,
    basename: name,
    extension: '',
  }
}
function escapeHeaderValue(value: string): string {
  return value.replace(/["\r\n]/g, '_')
}

// Node's http header validation rejects any character outside \t and
// \x20-\xff, so a raw non-Latin1 filename (e.g. Chinese characters) throws
// ERR_INVALID_CHAR from res.setHeader and surfaces as a 500. Use an
// ASCII-safe `filename` fallback plus the RFC 5987 `filename*` extended
// parameter for the real UTF-8 name, per RFC 6266.
function buildContentDisposition(filename: string): string {
  const asciiFallback = escapeHeaderValue(
    filename.replace(/[^\x20-\x7e]/g, '_'),
  )
  const encoded = encodeURIComponent(filename)
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`
}

function toSearchEntry(
  file: TFile,
  options: { preview: string; score: number },
) {
  return {
    ...toFileEntry(file),
    title: file.name,
    preview: options.preview,
    score: options.score,
  }
}

function isTextSearchable(file: TFile): boolean {
  const extension = file.extension.toLowerCase()
  return [
    '',
    'md',
    'markdown',
    'txt',
    'csv',
    'json',
    'yaml',
    'yml',
    'ts',
    'tsx',
    'js',
    'jsx',
    'css',
    'html',
  ].includes(extension)
}

function makeSearchPreview(
  content: string,
  start: number,
  length: number,
): string {
  const radius = 80
  const from = Math.max(0, start - radius)
  const to = Math.min(content.length, start + Math.max(length, 1) + radius)
  const prefix = from > 0 ? '...' : ''
  const suffix = to < content.length ? '...' : ''
  return `${prefix}${content.slice(from, to).replace(/\s+/g, ' ').trim()}${suffix}`
}

function safeAttachmentContentType(contentType: string): string {
  if (contentType.startsWith('text/html')) return 'text/plain; charset=utf-8'
  if (contentType === 'image/svg+xml') return 'application/octet-stream'
  return contentType === 'application/octet-stream' ? contentType : contentType
}

function getContentType(path: string): string {
  const extension = path.split('.').pop()?.toLowerCase() ?? ''
  switch (extension) {
    case 'md':
    case 'markdown':
      return 'text/markdown; charset=utf-8'
    case 'txt':
    case 'log':
      return 'text/plain; charset=utf-8'
    case 'csv':
      return 'text/csv; charset=utf-8'
    case 'json':
      return 'application/json; charset=utf-8'
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'pdf':
      return 'application/pdf'
    case 'html':
    case 'htm':
      return 'text/html; charset=utf-8'
    default:
      return 'application/octet-stream'
  }
}
