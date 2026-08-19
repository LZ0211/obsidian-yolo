import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { App, FileSystemAdapter, normalizePath, TFile, TFolder } from 'obsidian'

import { executeSingleTurn } from '../ai/single-turn'
import { SystemPromptSnapshotStore } from '../../core/agent/systemPromptSnapshotStore'
import { getEmbeddingModelClient } from '../../core/rag/embedding'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { loadMemorySourceSnapshot, memoryAdd } from './memoryManager'
import { MemoryExtractionQueue } from './memoryExtractionQueue'
import { openMemoryIndexStore } from './memoryIndex'
import { cutForSearchWithJieba } from './memoryJiebaTokenizer'
import {
  getMemoryIndexRuntimeHandle,
  closeMemoryIndexRuntime,
} from './memoryIndexRuntime'

jest.mock('../../database/json/chat/promptSnapshotStore', () => ({
  readPromptSnapshotEntries: jest.fn(async () => ({})),
}))

jest.mock('../ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

jest.mock('../../core/rag/embedding', () => {
  // Deterministic text→vector mapping so recall can tell the fixture entries
  // apart: "极简"-shaped texts embed as [1,0,…], "数据库/迁移"-shaped texts as
  // [0,1,…]. The C4 layering tests rely on the two queries producing different
  // vector-path orderings (cosine 1 vs 0).
  const vectorForRecallText = (text: string): number[] => {
    if (text.includes('数据库') || text.includes('迁移')) {
      return [0, 1, 0, 0, 0, 0, 0, 0]
    }
    return [1, 0, 0, 0, 0, 0, 0, 0]
  }
  return {
    getEmbeddingModelClient: jest.fn(() => ({
      getEmbedding: jest.fn(async (text: string) => vectorForRecallText(text)),
    })),
    withEmbeddingTimeout: jest.fn(
      async (
        client: { getEmbedding: (text: string) => Promise<number[]> },
        text: string,
      ) => client.getEmbedding(text),
    ),
  }
})

jest.mock('../../core/skills/liteSkills', () => ({
  ...jest.requireActual('../../core/skills/liteSkills'),
  getLiteSkillDocument: jest.fn(),
  listLiteSkillEntries: jest.fn(async () => []),
}))

jest.mock('./memoryJiebaTokenizer', () => ({
  // Query-dependent keywords so the C4 tests can observe lexical recall
  // following the *latest* query instead of a frozen keyword set.
  cutForSearchWithJieba: jest.fn(async (text: string) => {
    if (text.includes('数据库') || text.includes('迁移')) {
      return ['数据库', '迁移']
    }
    if (text.includes('主题')) {
      return ['主题']
    }
    return ['极简']
  }),
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

describe('memory wiring integration (extract → persist → reconcile → recall)', () => {
  let rootDir: string
  let app: App
  let settings: { yolo: { baseDir: string } }

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-wiring-'))
    app = makeVaultApp(rootDir)
    ;(app.vault as { adapter: unknown }).adapter = new TempFileSystemAdapter(
      rootDir,
    )
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
    console.log(
      'store capability:',
      (store as { capability?: string }).capability,
    )
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
    await (
      store as { reconcilePartition: (i: never) => Promise<void> }
    ).reconcilePartition({
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
    console.log(
      'indexed entries:',
      indexed.length,
      'fp match:',
      snapshot.sourceFileFingerprint,
    )
    expect(indexed.length).toBeGreaterThan(0)
    expect(indexed.map((entry) => entry.content)).toEqual(
      expect.arrayContaining(['用户是前端工程师']),
    )
  })

  it('runs a completed conversation through the queue and persists tolerant extraction output', async () => {
    executeSingleTurnMock.mockResolvedValue({
      content:
        '提取结果：```json\n{"operations":[{"op":"add","content":"用户正在处理工作流","category":"semantic","scope":"global",}]}\n```',
      toolCalls: [],
    })

    const builder = new RequestContextBuilder(app, settings as never, {
      memoryIndexRuntime: getMemoryIndexRuntimeHandle(app, () => settings),
    })
    const providerClient = {} as never
    const model = { id: 'test-model', model: 'test-model' } as never
    const messages = [
      {
        role: 'user',
        id: 'u-no-keyword',
        content: {
          root: {
            children: [
              {
                children: [
                  {
                    text: '帮我打开这个文件',
                    type: 'text',
                  },
                ],
                type: 'paragraph',
              },
            ],
            type: 'root',
          },
        },
        mtime: Date.now(),
      },
      {
        role: 'assistant',
        id: 'a-no-keyword',
        content: '文件已打开。',
        mtime: Date.now(),
      },
    ] as never
    const queue = new MemoryExtractionQueue(async (_task, signal) => {
      await builder.processMemoryTurn({
        messages,
        providerClient,
        model,
        signal,
      })
    })

    queue.enqueue({ assistantId: 'assistant-1', id: 'turn-1' })
    await queue.drain()

    const memoryFile = app.vault.getAbstractFileByPath('YOLO/memory/global.md')
    expect(memoryFile).not.toBeNull()
    expect(await app.vault.read(memoryFile as never)).toContain(
      '用户正在处理工作流',
    )
    expect(executeSingleTurnMock).toHaveBeenCalledTimes(1)
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
        partition: {
          scope: 'global',
          assistantId: null,
          partitionKey: 'global',
        },
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

  describe('C4 memory layering (stable snapshot / dynamic user block)', () => {
    const memoryFile = 'YOLO/memory/global.md'
    const model = { id: 'test-model', model: 'test-model' } as never
    const RECALLED_MEMORY_BLOCK_RE =
      /<recalled_memory(?:\s[^>]*)?>[\s\S]*?<\/recalled_memory>/

    const userMessageWithText = (text: string) =>
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

    const getSystemContent = (
      requestMessages: Array<{ role: string; content: unknown }>,
    ): string => {
      const system = requestMessages.find(
        (message) => message.role === 'system',
      )
      if (!system || typeof system.content !== 'string') {
        throw new Error('Expected a string system message')
      }
      return system.content
    }

    const getLastUserContent = (
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

    const reconcileTwoEntries = async () => {
      await memoryAdd({
        app,
        settings,
        content: '用户偏好极简风格的设计',
        category: 'preferences',
        scope: 'global',
      })
      await memoryAdd({
        app,
        settings,
        content: '用户负责数据库迁移项目',
        category: 'preferences',
        scope: 'global',
      })
      const handle = getMemoryIndexRuntimeHandle(app, () => settings)
      const store = await handle.getStore()
      const snapshot = await loadMemorySourceSnapshot({
        app,
        settings: settings as never,
        scope: 'global',
      })
      await (
        store as { reconcilePartition: (i: never) => Promise<void> }
      ).reconcilePartition({
        partition: {
          scope: 'global',
          assistantId: null,
          partitionKey: 'global',
        },
        sourcePath: memoryFile,
        sourceFileFingerprint: snapshot.sourceFileFingerprint,
        parserVersion: snapshot.parserVersion,
        entries: snapshot.entries,
      } as never)
      return handle
    }

    it('keeps the system prompt frozen across queries while refreshing the dynamic recall block per query (C4)', async () => {
      const handle = await reconcileTwoEntries()
      // Reconcile embeds entry content with the same factory; reset the counter
      // and the embedding cache so the two request builds are what we measure.
      ;(getEmbeddingModelClient as jest.Mock).mockClear()

      const builder = new RequestContextBuilder(app, settings as never, {
        memoryIndexRuntime: handle,
        systemPromptSnapshotStore: new SystemPromptSnapshotStore(),
      })

      const roundOne = await builder.generateRequestMessages({
        messages: [userMessageWithText('我喜欢极简设计')],
        model,
        conversationId: 'conv-c4-layering',
        systemPromptSnapshotMode: 'create',
      })
      const roundTwo = await builder.generateRequestMessages({
        messages: [userMessageWithText('请推荐数据库迁移方案')],
        model,
        conversationId: 'conv-c4-layering',
        systemPromptSnapshotMode: 'create',
      })

      const systemOne = getSystemContent(roundOne)
      const systemTwo = getSystemContent(roundTwo)
      // The stable system prompt is frozen for the conversation lifetime.
      expect(systemOne).toBe(systemTwo)
      // Stable profile/preferences still live in the system message.
      expect(systemOne).toContain('<global>')
      expect(systemOne).toContain('用户偏好极简风格的设计')
      // RED before C4: the dynamic block is built inside the system path, so
      // the frozen system snapshot carries `<recalled_memory>`.
      expect(systemOne).not.toContain('<recalled_memory')
      expect(systemTwo).not.toContain('<recalled_memory')

      // Both rounds carry the dynamic block in the latest real user message.
      const userOne = getLastUserContent(roundOne)
      const userTwo = getLastUserContent(roundTwo)
      expect(userOne).toContain('我喜欢极简设计')
      expect(userOne).toContain('<recalled_memory')
      expect(userTwo).toContain('请推荐数据库迁移方案')
      expect(userTwo).toContain('<recalled_memory')

      // The recall follows the *latest* query: query 1 ranks the minimalist
      // entry first, query 2 ranks the database-migration entry first.
      const blockOne = userOne.match(RECALLED_MEMORY_BLOCK_RE)?.[0]
      const blockTwo = userTwo.match(RECALLED_MEMORY_BLOCK_RE)?.[0]
      expect(blockOne).toBeDefined()
      expect(blockTwo).toBeDefined()
      expect(blockOne).not.toBe(blockTwo)
      // Both entries must be present in each block before comparing offsets —
      // otherwise the indexOf comparisons could pass vacuously.
      expect(blockOne).toContain('用户偏好极简风格的设计')
      expect(blockOne).toContain('用户负责数据库迁移项目')
      expect(blockTwo).toContain('用户偏好极简风格的设计')
      expect(blockTwo).toContain('用户负责数据库迁移项目')
      expect(blockOne?.indexOf('用户偏好极简风格的设计')).toBeLessThan(
        blockOne?.indexOf('用户负责数据库迁移项目') ?? -1,
      )
      expect(blockTwo?.indexOf('用户负责数据库迁移项目')).toBeLessThan(
        blockTwo?.indexOf('用户偏好极简风格的设计') ?? -1,
      )
    })

    it('injects the Markdown bounded fallback into the current user message when SQLite is unavailable (C4)', async () => {
      await memoryAdd({
        app,
        settings,
        content: '用户偏好极简风格的设计',
        category: 'preferences',
        scope: 'global',
      })
      // A second entry far beyond the 2000-char per-scope budget: the bounded
      // fallback render must drop it, not balloon the request.
      const overBudgetContent = `超长记忆条目标记${'x'.repeat(2400)}`
      await memoryAdd({
        app,
        settings,
        content: overBudgetContent,
        category: 'preferences',
        scope: 'global',
      })
      const noIndexSettings = {
        ...settings,
        advancedMemoryIndexEnabled: false,
      } as never

      const builder = new RequestContextBuilder(app, noIndexSettings, {
        memoryIndexRuntime: getMemoryIndexRuntimeHandle(
          app,
          () => noIndexSettings,
        ),
        systemPromptSnapshotStore: new SystemPromptSnapshotStore(),
      })

      const roundOne = await builder.generateRequestMessages({
        messages: [userMessageWithText('我喜欢极简设计')],
        model,
        conversationId: 'conv-c4-fallback',
        systemPromptSnapshotMode: 'create',
      })
      const roundTwo = await builder.generateRequestMessages({
        messages: [userMessageWithText('请推荐数据库迁移方案')],
        model,
        conversationId: 'conv-c4-fallback',
        systemPromptSnapshotMode: 'create',
      })

      const systemOne = getSystemContent(roundOne)
      const systemTwo = getSystemContent(roundTwo)
      expect(systemOne).toBe(systemTwo)
      // RED before C4: with SQLite unavailable the bounded markdown memory is
      // frozen inside the system snapshot instead of flowing with the request.
      expect(systemOne).not.toContain('<global>')
      expect(systemOne).not.toContain('<recalled_memory')

      // The fallback block lands in the current user message, not in the
      // frozen system prompt.
      const userTwo = getLastUserContent(roundTwo)
      expect(userTwo).toContain('<recalled_memory source="markdown-fallback"')
      expect(userTwo).toContain('用户偏好极简风格的设计')
      // The 2000-char per-scope bound applies to the fallback: the first
      // (short) entry fits, the over-budget entry is dropped.
      expect(userTwo).not.toContain('超长记忆条目标记')
    })

    it('omits only the dynamic index recall when the embedding provider fails, keeping stable memory and conversation intact (C4)', async () => {
      const handle = await reconcileTwoEntries()
      const embeddingFactory = getEmbeddingModelClient as jest.Mock
      const defaultFactory = embeddingFactory.getMockImplementation()
      const messages = [userMessageWithText('极简设计')]
      const inputCopy = structuredClone(messages)

      try {
        embeddingFactory.mockImplementation(() => ({
          getEmbedding: jest.fn(async () => {
            throw new Error('embedding provider down')
          }),
        }))

        const builder = new RequestContextBuilder(app, settings as never, {
          memoryIndexRuntime: handle,
        })
        const requestMessages = await builder.generateRequestMessages({
          messages,
          model,
          conversationId: 'conv-c4-embedding-failure',
          systemPromptSnapshotMode: 'create',
        })

        const systemContent = getSystemContent(requestMessages)
        // RED before C4: the degraded lexical recall still lands inside the
        // system message instead of being omitted from it.
        expect(systemContent).not.toContain('<recalled_memory')
        // Stable memory and the original conversation survive the failure.
        expect(systemContent).toContain('<global>')
        expect(systemContent).toContain('用户偏好极简风格的设计')
        expect(getLastUserContent(requestMessages)).toContain('极简设计')
        expect(messages).toEqual(inputCopy)
      } finally {
        embeddingFactory.mockImplementation(defaultFactory)
      }
    })

    it('omits the dynamic block entirely when indexed recall fails at execution time — no markdown-fallback substitution (C4)', async () => {
      const handle = await reconcileTwoEntries()
      const jiebaMock = cutForSearchWithJieba as jest.Mock
      const defaultJieba = jiebaMock.getMockImplementation()
      const messages = [userMessageWithText('召回故障')]
      const inputCopy = structuredClone(messages)

      try {
        // A failure inside the recall execution itself (jieba tokenization),
        // as opposed to index unavailability: spec 4.2 says this must omit
        // the dynamic block only — no fallback substitution.
        jiebaMock.mockImplementation(async (text: string) => {
          if (text.includes('召回故障')) {
            throw new Error('jieba tokenizer down')
          }
          return defaultJieba?.(text)
        })

        const builder = new RequestContextBuilder(app, settings as never, {
          memoryIndexRuntime: handle,
          systemPromptSnapshotStore: new SystemPromptSnapshotStore(),
        })
        const requestMessages = await builder.generateRequestMessages({
          messages,
          model,
          conversationId: 'conv-c4-recall-failure',
          systemPromptSnapshotMode: 'create',
        })

        // Stable memory stays in the system snapshot.
        const systemContent = getSystemContent(requestMessages)
        expect(systemContent).toContain('<global>')
        expect(systemContent).toContain('用户偏好极简风格的设计')
        expect(systemContent).not.toContain('<recalled_memory')
        // The dynamic block is omitted entirely: neither the indexed recall
        // nor the bounded markdown fallback reaches the user message.
        const userContent = getLastUserContent(requestMessages)
        expect(userContent).toContain('召回故障')
        expect(userContent).not.toContain('<recalled_memory')
        expect(userContent).not.toContain('markdown-fallback')
        expect(messages).toEqual(inputCopy)
      } finally {
        jiebaMock.mockImplementation(defaultJieba)
      }
    })

    it('re-runs recall per query even when the system snapshot is frozen — one embedding client per distinct query (C4)', async () => {
      const handle = await reconcileTwoEntries()
      ;(getEmbeddingModelClient as jest.Mock).mockClear()

      const builder = new RequestContextBuilder(app, settings as never, {
        memoryIndexRuntime: handle,
        systemPromptSnapshotStore: new SystemPromptSnapshotStore(),
      })
      const requestArgs = {
        messages: [userMessageWithText('极简设计')],
        model,
        conversationId: 'conv-c4-sections',
        systemPromptSnapshotMode: 'create',
      } as unknown as Parameters<typeof builder.generateRequestSections>[0]

      const sectionsOne = await builder.generateRequestSections(requestArgs)
      await builder.generateRequestSections(requestArgs)
      // Identical query → the query-embedding cache serves the second build.
      expect(getEmbeddingModelClient).toHaveBeenCalledTimes(1)

      const sectionsThree = await builder.generateRequestSections({
        ...requestArgs,
        messages: [userMessageWithText('请推荐数据库迁移方案')],
      } as unknown as Parameters<typeof builder.generateRequestSections>[0])
      // RED before C4: the snapshot freezes the dynamic recall, so a new query
      // never reaches the embedding factory.
      expect(getEmbeddingModelClient).toHaveBeenCalledTimes(2)

      const blockOf = (
        sections: Array<{ id: string; content: unknown }>,
      ): string | undefined => {
        const dynamic = sections.find((section) =>
          section.id.startsWith('memory.dynamic.'),
        )
        return typeof dynamic?.content === 'string'
          ? dynamic.content
          : undefined
      }
      const dynamicSections = sectionsThree.filter((section) =>
        section.id.startsWith('memory.dynamic.'),
      )
      // The dynamic block gets exactly one dedicated memory section.
      expect(dynamicSections).toHaveLength(1)
      expect(dynamicSections[0]?.bucket).toBe('memory')
      expect(blockOf(sectionsThree)).toContain('<recalled_memory')
      // The stable section keeps its snapshot identity.
      expect(
        sectionsThree.some((section) => section.id === 'memory.context'),
      ).toBe(true)
      // The conversation section must not double-count the block.
      const conversation = sectionsThree.find((section) =>
        section.id.startsWith('conversation.'),
      )
      expect(conversation).toBeDefined()
      expect(JSON.stringify(conversation?.content)).not.toContain(
        '<recalled_memory',
      )
      // Lexical recall re-ran on the new query: the third block differs from
      // the first one (query 2 ranks the migration entry first). Both entries
      // must be present before comparing offsets — otherwise the indexOf
      // comparison could pass vacuously.
      const blockOne = blockOf(sectionsOne)
      const blockThree = blockOf(sectionsThree)
      expect(blockOne).toBeDefined()
      expect(blockOne).not.toBe(blockThree)
      expect(blockThree).toContain('用户负责数据库迁移项目')
      expect(blockThree).toContain('用户偏好极简风格的设计')
      expect(blockThree?.indexOf('用户负责数据库迁移项目')).toBeLessThan(
        blockThree?.indexOf('用户偏好极简风格的设计') ?? -1,
      )
    })
  })
})
