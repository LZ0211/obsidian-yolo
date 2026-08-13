import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { App, FileSystemAdapter, normalizePath, TFile, TFolder } from 'obsidian'

import { executeSingleTurn } from '../ai/single-turn'
import { getEmbeddingModelClient } from '../../core/rag/embedding'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { loadMemorySourceSnapshot, memoryAdd } from './memoryManager'
import { openMemoryIndexStore } from './memoryIndex'
import { getMemoryIndexRuntimeHandle, closeMemoryIndexRuntime } from './memoryIndexRuntime'

jest.mock('../../database/json/chat/promptSnapshotStore', () => ({
  readPromptSnapshotEntries: jest.fn(async () => ({})),
}))

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

jest.mock('../../core/rag/embedding', () => ({
  getEmbeddingModelClient: jest.fn(() => ({
    getEmbedding: jest.fn(async () => Array(8).fill(0.1)),
  })),
}))

jest.mock('../../core/skills/liteSkills', () => ({
  ...jest.requireActual('../../core/skills/liteSkills'),
  getLiteSkillDocument: jest.fn(),
  listLiteSkillEntries: jest.fn(async () => []),
}))

jest.mock('./memoryJiebaTokenizer', () => ({
  cutForSearchWithJieba: jest.fn(async () => ['极简']),
}))

const executeSingleTurnMock = executeSingleTurn as jest.Mock

class TempFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }
  override getBasePath(): string {
    return this.basePath
  }
}

const makeVaultApp = (rootDir: string): App => {
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
    cachedRead: jest.fn(async (file: { path: string }) => files.get(file.path) ?? ''),
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

describe('memory wiring integration (extract → persist → reconcile → recall)', () => {
  let rootDir: string
  let app: App
  let settings: { yolo: { baseDir: string } }

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-wiring-'))
    app = makeVaultApp(rootDir)
    ;(app.vault as { adapter: unknown }).adapter = new TempFileSystemAdapter(rootDir)
    settings = {
      yolo: { baseDir: 'YOLO' },
      advancedMemoryIndexEnabled: true,
      systemPrompt: '',
      memoryAgentModelId: '',
      embeddingModelId: 'test-embed',
      currentAssistantId: undefined,
      assistants: [],
      skills: { disabledSkillIds: [] },
    } as never
    executeSingleTurnMock.mockReset()
    ;(getEmbeddingModelClient as jest.Mock).mockClear()
  })

  afterEach(async () => {
    await closeMemoryIndexRuntime(app)
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('hidden extraction writes memory, commits to the index, and stays queryable after update', async () => {
    // 1. Extraction: the LLM returns a memory operation JSON.
    executeSingleTurnMock.mockResolvedValue({
      content: JSON.stringify({
        operations: [
          {
            op: 'add',
            category: 'preferences',
            scope: 'global',
            content: '用户偏好极简风格的设计',
            keywords: ['极简风格', '设计'],
          },
        ],
      }),
      toolCalls: [],
    })

    const builder = new RequestContextBuilder(app, settings as never, {
      memoryIndexRuntime: getMemoryIndexRuntimeHandle(app, () => settings),
    })
    const providerClient = {} as never
    const model = { id: 'test-model', model: 'test-model' } as never

    // 2. Run the hidden extraction turn.
    const plainTextState = (text: string) => ({
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
    })
    await builder.processMemoryTurn({
      messages: [
        {
          role: 'user',
          id: 'u1',
          content: plainTextState('我喜欢极简风格的设计'),
          mtime: Date.now(),
        },
        {
          role: 'assistant',
          id: 'a1',
          content: '好的，我记住了。',
          mtime: Date.now(),
        },
      ] as never,
      providerClient,
      model,
      signal: new AbortController().signal,
    })

    // 3. The memory file was written (persistence).
    const memoryFile = 'YOLO/memory/global.md'
    const fileContent = await app.vault.read({
      path: memoryFile,
    } as never)
    expect(fileContent).toContain('极简风格')

    // 4. Manual add + reconcile through the runtime handle (update path).
    const handle = getMemoryIndexRuntimeHandle(app, () => settings)
    const store = await handle.getStore()
    console.log('store capability:', (store as { capability?: string }).capability)
    await memoryAdd({
      app,
      settings,
      content: '用户是前端工程师',
      category: 'profile',
      scope: 'global',
    })
    // Direct reconcile (bypasses the queue) to isolate the failure.
    const snapshot2 = await loadMemorySourceSnapshot({
      app,
      settings: settings as never,
      scope: 'global',
    })
    await (store as { reconcilePartition: (i: never) => Promise<void> }).reconcilePartition({
      partition: { scope: 'global', assistantId: null, partitionKey: 'global' },
      sourcePath: memoryFile,
      sourceFileFingerprint: snapshot2.sourceFileFingerprint,
      parserVersion: snapshot2.parserVersion,
      entries: snapshot2.entries,
    } as never)
    handle.onSourceCommitted({
      partition: { scope: 'global', assistantId: null, partitionKey: 'global' },
      sourcePath: memoryFile,
    })
    await new Promise((resolve) => setTimeout(resolve, 1500))

    // 5. The index reflects the entries (queryable after update).
    const snapshot = await loadMemorySourceSnapshot({
      app,
      settings: settings as never,
      scope: 'global',
    })
    const indexed = await store.query({
      partition: { scope: 'global', assistantId: null, partitionKey: 'global' },
      sourceFileFingerprint: snapshot.sourceFileFingerprint,
      target: {
        query: '前端',
        keywords: ['前端'],
        entities: [],
        categories: ['profile', 'preferences', 'other'],
        scopes: ['global'],
        sector: null,
        confidence: 1,
        isReferential: false,
        source: 'lexical',
      } as never,
      maxEntries: 8,
      maxChars: 3000,
    })
    console.log('indexed entries:', indexed.length, 'fp match:', snapshot.sourceFileFingerprint)
    expect(indexed.length).toBeGreaterThan(0)
    expect(indexed.map((entry) => entry.content)).toEqual(
      expect.arrayContaining(['用户是前端工程师']),
    )
  })

  it('hidden extraction persists an optional reason annotation on added memory', async () => {
    executeSingleTurnMock.mockResolvedValue({
      content: JSON.stringify({
        operations: [
          {
            op: 'add',
            category: 'preferences',
            scope: 'global',
            content: '用户偏好先看结论',
            keywords: ['结论'],
            reason: '用户多次纠正回答结构',
          },
        ],
      }),
      toolCalls: [],
    })

    const builder = new RequestContextBuilder(app, settings as never, {
      memoryIndexRuntime: getMemoryIndexRuntimeHandle(app, () => settings),
    })
    const providerClient = {} as never
    const model = { id: 'test-model', model: 'test-model' } as never
    await builder.processMemoryTurn({
      messages: [
        {
          role: 'user',
          id: 'u1',
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
                      text: '先给我结论，我喜欢这样',
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
          mtime: Date.now(),
        },
        {
          role: 'assistant',
          id: 'a1',
          content: '好的，先给结论。',
          mtime: Date.now(),
        },
      ] as never,
      providerClient,
      model,
      signal: new AbortController().signal,
    })

    const fileContent = await app.vault.read({
      path: 'YOLO/memory/global.md',
    } as never)
    expect(fileContent).toContain('<!-- reason: 用户多次纠正回答结构 -->')
  })

  describe('memory recall embedding query cache', () => {
    it('embeds the same recall query only once across request builds', async () => {
    const memoryFile = 'YOLO/memory/global.md'
    await app.vault.create(memoryFile, '- 用户偏好极简风格的设计')
    await memoryAdd({
      app,
      settings,
      content: '用户偏好极简风格的设计',
      category: 'preferences',
      scope: 'global',
    })

    const handle = getMemoryIndexRuntimeHandle(app, () => ({
      ...settings,
      embeddingModelId: 'test-embed',
    }))
    const store = await handle.getStore()
    const snapshot = await loadMemorySourceSnapshot({
      app,
      settings: { ...settings, embeddingModelId: 'test-embed' } as never,
      scope: 'global',
    })
    await (
      store as { reconcilePartition: (input: never) => Promise<void> }
    ).reconcilePartition({
      partition: { scope: 'global', assistantId: null, partitionKey: 'global' },
      sourcePath: memoryFile,
      sourceFileFingerprint: snapshot.sourceFileFingerprint,
      parserVersion: snapshot.parserVersion,
      entries: snapshot.entries,
    } as never)
    // Reconcile embeds entry content with the same model client; reset the
    // counter so this test isolates the request-side query embedding cache.
    ;(getEmbeddingModelClient as jest.Mock).mockClear()

    const builder = new RequestContextBuilder(
      app,
      { ...settings, embeddingModelId: 'test-embed' } as never,
      { memoryIndexRuntime: handle },
    )
    const model = { id: 'test-model', model: 'test-model' } as never
    const userMessage = {
      role: 'user',
      id: 'u1',
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
                  text: '极简设计',
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
    } as never
    const requestArgs = {
      messages: [userMessage],
      model,
      conversationId: 'conv-cache-test',
      systemPromptSnapshotMode: 'create' as const,
    } as unknown as Parameters<typeof builder.generateRequestSections>[0]

    await builder.generateRequestSections(requestArgs)
    await builder.generateRequestSections(requestArgs)

    // Second identical request hits the in-memory embedding query cache, so
    // the embedding model client is only created once.
    expect(getEmbeddingModelClient).toHaveBeenCalledTimes(1)

    const secondRequestArgs = {
      ...requestArgs,
      messages: [
        {
          ...(userMessage as object),
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
                      text: '另一个主题',
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
          } as never,
        },
      ],
    } as unknown as Parameters<typeof builder.generateRequestSections>[0]
    await builder.generateRequestSections(secondRequestArgs)
    expect(getEmbeddingModelClient).toHaveBeenCalledTimes(2)
  })
  })
})
