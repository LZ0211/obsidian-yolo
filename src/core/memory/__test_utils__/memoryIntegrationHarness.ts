import * as fs from 'node:fs'
import * as path from 'node:path'

import { App, FileSystemAdapter, TFile, TFolder } from 'obsidian'

import { SETTINGS_SCHEMA_VERSION } from '../../../settings/schema/migrations/version'
import { parseYoloSettings } from '../../../settings/schema/settings'
import { buildMemoryPartition } from '../memoryIndex'
import type { MemoryIndexMaintenanceStore } from '../memoryIndex'
import type { MemoryIndexRuntimeHandle } from '../memoryIndexRuntime'
import { loadMemorySourceSnapshot } from '../memoryManager'

/**
 * Shared harness for headless memory integration tests (real disk markdown →
 * real snapshot loader → real SQLite index → real recall). Both
 * `memoryWiring.integration.test.ts` and `memoryProductionWiring.integration
 * .test.ts` (plus the chat-view popover consumption test) reuse these pieces
 * so the production-wiring assertions run against the same seams.
 *
 * The vault-relative path conventions mirror production: memory lives at
 * `YOLO/memory/global.md` and the SQLite index at `<adapter base>/YOLO/memory/
 * index.sqlite`.
 */

export const GLOBAL_MEMORY_VAULT_PATH = 'YOLO/memory/global.md'

/**
 * A REAL `FileSystemAdapter` over a temp directory: `read`/`write`/`stat`
 * hit the actual filesystem (vault-relative paths resolve under the base
 * path). Files written here are deliberately kept OUT of the mock vault's
 * in-memory file map, so the memory pipeline reads them through
 * `readVaultFileCached`'s production adapter-fallback branch (memoryManager.ts
 * `readVaultFileCached`) — the "real vault files" verification without a
 * machine.
 */
export class TempFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }
  override getBasePath(): string {
    return this.basePath
  }
  private resolve(vaultRelativePath: string): string {
    return path.join(this.basePath, ...vaultRelativePath.split('/'))
  }
  async read(vaultRelativePath: string): Promise<string> {
    return await fs.promises.readFile(this.resolve(vaultRelativePath), 'utf8')
  }
  async write(vaultRelativePath: string, content: string): Promise<void> {
    const absolute = this.resolve(vaultRelativePath)
    await fs.promises.mkdir(path.dirname(absolute), { recursive: true })
    await fs.promises.writeFile(absolute, content, 'utf8')
  }
  async stat(vaultRelativePath: string): Promise<{
    type: 'file' | 'folder'
    ctime: number
    mtime: number
    size: number
  } | null> {
    try {
      const stat = await fs.promises.stat(this.resolve(vaultRelativePath))
      return {
        type: stat.isDirectory() ? 'folder' : 'file',
        ctime: stat.ctimeMs,
        mtime: stat.mtimeMs,
        size: stat.size,
      }
    } catch {
      return null
    }
  }
}

/**
 * Mock vault with an in-memory files Map + jest.fn vault methods. The
 * production memory adapter (`TempFileSystemAdapter`) is installed separately
 * so files seeded on REAL DISK stay invisible to `getAbstractFileByPath` and
 * flow through the adapter-fallback branch.
 */
export const makeVaultApp = (rootDir: string): App => {
  const files = new Map<string, string>()
  const directories = new Set<string>([rootDir])
  const vault = {
    getAbstractFileByPath: jest.fn((p: string) => {
      const absolute = path.join(rootDir, p)
      if (directories.has(absolute)) {
        return Object.assign(new TFolder(), { path: p, children: [] })
      }
      if (files.has(p)) {
        return Object.assign(new TFile(), {
          path: p,
          basename: path.basename(p),
          extension: p.split('.').pop() ?? '',
          stat: { size: files.get(p)?.length ?? 0, mtime: Date.now() },
        })
      }
      return null
    }),
    read: jest.fn(async (file: { path: string }) => files.get(file.path) ?? ''),
    cachedRead: jest.fn(
      async (file: { path: string }) => files.get(file.path) ?? '',
    ),
    create: jest.fn(async (p: string, content: string) => {
      files.set(p, content)
      return {
        path: p,
        basename: path.basename(p),
        extension: p.split('.').pop() ?? '',
        stat: { size: content.length, mtime: Date.now() },
      }
    }),
    modify: jest.fn(async (file: { path: string }, content: string) => {
      files.set(file.path, content)
    }),
    createFolder: jest.fn(async (p: string) => {
      directories.add(path.join(rootDir, p))
    }),
    getFiles: jest.fn(() => []),
    getMarkdownFiles: jest.fn(() => []),
    getRoot: jest.fn(() => null),
    on: jest.fn(() => () => undefined),
    offref: jest.fn(),
  }
  return {
    vault,
    workspace: { getLeavesOfType: jest.fn(() => []) },
    metadataCache: { getFileCache: jest.fn(() => null) },
  } as unknown as App
}

export const installTempFileSystemAdapter = (
  app: App,
  rootDir: string,
): TempFileSystemAdapter => {
  const adapter = new TempFileSystemAdapter(rootDir)
  ;(app.vault as { adapter: unknown }).adapter = adapter
  return adapter
}

/** Write the global memory markdown file to REAL DISK (out of the vault map). */
export const seedGlobalMemoryFile = async (
  adapter: TempFileSystemAdapter,
  content: string,
): Promise<void> => {
  await adapter.write(GLOBAL_MEMORY_VAULT_PATH, content)
}

/**
 * Reconcile the global partition through the production snapshot loader + the
 * real SQLite store. The snapshot is read from REAL DISK via the
 * adapter-fallback branch of `readVaultFileCached`.
 */
export const reconcileGlobalMemoryPartition = async ({
  app,
  settings,
  handle,
}: {
  app: App
  settings: Parameters<typeof loadMemorySourceSnapshot>[0]['settings']
  handle: MemoryIndexRuntimeHandle
}): Promise<{ entries: number; sourcePath: string }> => {
  const store = await handle.getStore()
  if (store.capability !== 'sqlite') {
    throw new Error('Expected a real SQLite memory index for the harness')
  }
  const snapshot = await loadMemorySourceSnapshot({
    app,
    settings,
    scope: 'global',
  })
  await store.reconcilePartition({
    partition: buildMemoryPartition({ scope: 'global' }),
    sourcePath: snapshot.sourcePath,
    sourceFileFingerprint: snapshot.sourceFileFingerprint,
    parserVersion: snapshot.parserVersion,
    entries: snapshot.entries,
  } as never)
  return { entries: snapshot.entries.length, sourcePath: snapshot.sourcePath }
}

/** Editor-state ChatMessage whose plain text is `text` (same shape as the
 *  existing wiring tests; the `never` return makes `[userMessageWithText(x)]`
 *  assignable to `ChatMessage[]` exactly like the memoryWiring harness). */
export const userMessageWithText = (text: string): never =>
  ({
    role: 'user',
    id: `u-${text}`,
    content: {
      root: {
        children: [
          {
            children: [
              {
                detail: 0,
                format: 0,
                mode: 'normal',
                style: '',
                text,
                type: 'text',
                version: 1,
              },
            ],
            direction: 'ltr',
            format: '',
            indent: 0,
            type: 'paragraph',
            version: 1,
          },
        ],
        direction: 'ltr',
        format: '',
        indent: 0,
        type: 'root',
        version: 1,
      },
    },
    promptContent: null,
    mentionables: [],
    mtime: Date.now(),
  }) as never

export const RECALLED_MEMORY_BLOCK_RE =
  /<recalled_memory(?:\s[^>]*)?>[\s\S]*?<\/recalled_memory>/

export const getSystemContent = (
  requestMessages: Array<{ role: string; content: unknown }>,
): string => {
  const system = requestMessages.find((message) => message.role === 'system')
  if (!system || typeof system.content !== 'string') {
    throw new Error('Expected a string system message')
  }
  return system.content
}

export const getLastUserContent = (
  requestMessages: Array<{ role: string; content: unknown }>,
): string => {
  const user = [...requestMessages]
    .reverse()
    .find((message) => message.role === 'user')
  if (!user) {
    throw new Error('Expected a user message')
  }
  // Editor-state messages compile to a single text ContentPart[] (the C4
  // dynamic block merges in as an extra text part); promptContent-based
  // messages stay a plain string. Join the text parts for both shapes.
  if (typeof user.content === 'string') {
    return user.content
  }
  if (Array.isArray(user.content)) {
    return user.content
      .filter((part) => part?.type === 'text')
      .map((part) => (part as { text: string }).text)
      .join('')
  }
  throw new Error('Expected a string or ContentPart[] user message')
}

/** Raw SQLite read of one `memory_index` row (S1 reinforcement assertions). */
export type MemoryIndexRowSnapshot = {
  salience: number
  last_recalled_at: number | null
  last_reinforced_at: number | null
}

export const readMemoryIndexRow = async ({
  store,
  partitionKey,
  localId,
}: {
  store: MemoryIndexMaintenanceStore
  partitionKey: string
  localId: string
}): Promise<MemoryIndexRowSnapshot | null> => {
  const runtime = await store.getRuntime()
  return (
    runtime.queryOne<MemoryIndexRowSnapshot>(
      `select salience, last_recalled_at, last_reinforced_at
       from memory_index where partition_key = ? and local_id = ?`,
      [partitionKey, localId],
    ) ?? null
  )
}

/** Poll the raw SQLite row until `matches` holds (recall reinforcement is
 *  fire-and-forget inside the orchestrator, so the test waits for the store's
 *  serialized operationChain to flush). */
export const waitForMemoryIndexRow = async ({
  store,
  partitionKey,
  localId,
  matches,
  timeoutMs = 5000,
  pollMs = 25,
}: {
  store: MemoryIndexMaintenanceStore
  partitionKey: string
  localId: string
  matches: (row: MemoryIndexRowSnapshot) => boolean
  timeoutMs?: number
  pollMs?: number
}): Promise<MemoryIndexRowSnapshot> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const row = await readMemoryIndexRow({ store, partitionKey, localId })
    if (row && matches(row)) return row
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(
    `Timed out waiting for memory_index row ${partitionKey}::${localId}`,
  )
}

/**
 * Realistic settings payload parsed through the PRODUCTION schema
 * (`yoloSettingsSchema` via `parseYoloSettings`), not hand-built. The payload
 * deliberately omits `memoryExtractionQualityGate` so the legacy default
 * ('shadow') is exercised; `advancedMemoryIndexEnabled` and
 * `embeddingModelId` mirror the memoryWiring harness so the SQLite index and
 * the deterministic embedding mock stay active.
 */
export const buildProductionSettingsPayload = (): Record<string, unknown> => ({
  version: SETTINGS_SCHEMA_VERSION,
  providers: [{ id: 'openai', presetType: 'openai', apiKey: 'test-token' }],
  chatModels: [
    { providerId: 'openai', id: 'openai/gpt-5', model: 'gpt-5', enable: true },
  ],
  chatModelId: 'openai/gpt-5',
  memoryAgentModelId: 'openai/gpt-5-mini',
  embeddingModels: [
    {
      providerId: 'openai',
      id: 'test-embed',
      model: 'test-embed',
      name: 'test-embed',
      dimension: 8,
    },
  ],
  embeddingModelId: 'test-embed',
  advancedMemoryIndexEnabled: true,
  memoryReflectionEnabled: false,
  systemPrompt: '',
  yolo: { baseDir: 'YOLO' },
})

export const parseProductionSettings = (): ReturnType<
  typeof parseYoloSettings
> => parseYoloSettings(buildProductionSettingsPayload())
