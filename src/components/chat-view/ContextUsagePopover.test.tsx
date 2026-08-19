/** @jest-environment jsdom */

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

jest.mock('../../database/json/chat/promptSnapshotStore', () => ({
  readPromptSnapshotEntries: jest.fn(async () => ({})),
}))

jest.mock('../../core/ai/single-turn', () => ({
  executeSingleTurn: jest.fn(),
}))

jest.mock('../../core/rag/embedding', () => {
  // Deterministic text→vector mapping so the real SQLite recall ranks the
  // fixture entries the same way the memory-wiring suites do.
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

// jsdom has no global fetch, so the @anthropic-ai/sdk web shim throws at
// import time. The popover's request path never resolves a chat model client
// (the builder is handed a model directly), so mock the manager seam instead
// of pulling the SDK into the jsdom graph.
jest.mock('../../core/llm/manager', () => ({
  getChatModelClient: jest.fn(),
}))

jest.mock('../../core/memory/memoryJiebaTokenizer', () => ({
  cutForSearchWithJieba: jest.fn(async (text: string) => {
    if (text.includes('数据库') || text.includes('迁移')) {
      return ['数据库', '迁移']
    }
    return ['极简']
  }),
}))

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { act } from 'react'
import { createRoot } from 'react-dom/client'

import {
  TempFileSystemAdapter,
  makeVaultApp,
  parseProductionSettings,
  reconcileGlobalMemoryPartition,
  seedGlobalMemoryFile,
  userMessageWithText,
} from '../../core/memory/__test_utils__/memoryIntegrationHarness'
import {
  closeMemoryIndexRuntime,
  getMemoryIndexRuntimeHandle,
} from '../../core/memory/memoryIndexRuntime'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import { estimateJsonTokens } from '../../utils/llm/contextTokenEstimate'
import { formatTokenCount } from '../../utils/llm/formatTokenCount'

import ContextUsagePopover from './ContextUsagePopover'

// Radix Popper measures its content with ResizeObserver; jsdom does not
// implement it. A no-op stub keeps the popover's measurement effect alive
// (it falls back to offsetWidth/offsetHeight = 0, which is fine for
// assertions on the rendered list rows).
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

// jsdom also lacks WebCrypto (its `crypto` is a prototype getter with
// getRandomValues only, no `subtle`); the memory snapshot loader hashes
// entries with sha256Hex (crypto.subtle.digest). defineProperty shadows the
// getter — plain assignment silently no-ops in strict mode.
if (!(globalThis as { crypto?: { subtle?: unknown } }).crypto?.subtle) {
  Object.defineProperty(globalThis, 'crypto', {
    // eslint-disable-next-line import/no-nodejs-modules -- jsdom test env lacks WebCrypto; same shim style as the global test setup
    value: require('node:crypto').webcrypto,
    configurable: true,
  })
}

const MODEL = { id: 'test-model', model: 'test-model' } as never

describe('ContextUsagePopover (memory bucket consumption)', () => {
  let rootDir: string
  let app: ReturnType<typeof makeVaultApp>
  let adapter: TempFileSystemAdapter
  let container: HTMLDivElement

  beforeAll(() => {
    ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver =
      ResizeObserverStub
    const reactGlobal = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean
    }
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterAll(() => {
    const reactGlobal = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean
    }
    delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
  })

  beforeEach(async () => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-popover-'))
    app = makeVaultApp(rootDir)
    adapter = new TempFileSystemAdapter(rootDir)
    ;(app.vault as { adapter: unknown }).adapter = adapter
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    container.remove()
    await closeMemoryIndexRuntime(app as never)
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('attributes the recalled-memory block to the memory bucket without double-counting it in conversation', async () => {
    await seedGlobalMemoryFile(
      adapter,
      `# User Profile

# Preferences
- Preference_1: 用户偏好极简风格的设计 <!-- keywords: 极简风格,设计 -->
- Preference_2: 用户负责数据库迁移项目 <!-- keywords: 数据库迁移 -->

# Other Memory
`,
    )

    const parsed = parseProductionSettings()
    const handle = getMemoryIndexRuntimeHandle(app as never, () => parsed)
    await reconcileGlobalMemoryPartition({
      app: app as never,
      settings: parsed,
      handle,
    })

    const builder = new RequestContextBuilder(app as never, parsed, {
      memoryIndexRuntime: handle,
    })
    const messages = [userMessageWithText('我喜欢极简设计')]
    const conversationId = 'conv-popover'
    const requestArgs = {
      messages,
      model: MODEL,
      conversationId,
      systemPromptSnapshotMode: 'create' as const,
    }

    // Expected attribution, computed through the SAME production request
    // pipeline the popover's breakdown will run: the dynamic recall block
    // gets its own memory.dynamic.* section and is carved out of the
    // conversation section. The breakdown buckets sum every section of a
    // bucket, so the memory bucket total = stable memory.context + the
    // dynamic block (mirroring estimateContextBreakdown's summation).
    const sections = await builder.generateRequestSections(requestArgs)
    const memorySection = sections.find((section) =>
      section.id.startsWith('memory.dynamic.'),
    )
    expect(memorySection).toBeDefined()
    const block = memorySection?.content
    expect(typeof block).toBe('string')
    expect(block).toContain('<recalled_memory')
    const conversation = sections.find((section) =>
      section.id.startsWith('conversation.'),
    )
    expect(conversation).toBeDefined()
    expect(JSON.stringify(conversation?.content)).not.toContain(
      '<recalled_memory',
    )
    const bucketTokens = async (bucket: string): Promise<number> => {
      const totals = await Promise.all(
        sections
          .filter((section) => section.bucket === bucket)
          .map((section) => estimateJsonTokens(section.content)),
      )
      return totals.reduce((sum, tokens) => sum + tokens, 0)
    }
    const expectedMemoryTokens = await bucketTokens('memory')
    const expectedConversationTokens = await bucketTokens('conversation')
    // The memory bucket carries at least the dynamic block itself.
    expect(expectedMemoryTokens).toBeGreaterThan(
      await estimateJsonTokens(block),
    )
    expect(expectedConversationTokens).toBeGreaterThan(0)

    // Same mcpManager seam as production Chat.tsx (enableTools=false means
    // listAvailableTools is never called; only getJsSandboxSettings is).
    const mcpManager = {
      listAvailableTools: jest.fn(async () => []),
      getJsSandboxSettings: jest.fn(() => ({})),
    }
    const buildInputs = () =>
      ({
        requestContextBuilder: builder,
        mcpManager,
        model: MODEL,
        messages,
        conversationId,
        compaction: null,
        enableTools: false,
        includeBuiltinTools: false,
        apiType: null,
        toolPreferences: {},
        toolServerPreferences: {},
        enableToolDisclosure: false,
      }) as never

    const anchor = document.createElement('div')
    container.appendChild(anchor)
    const root = createRoot(container)
    act(() => {
      root.render(
        <ContextUsagePopover
          promptTokens={0}
          maxContextTokens={null}
          label="test-label"
          anchorRef={{ current: anchor }}
          buildInputs={buildInputs}
        />,
      )
    })

    // Open the popover through its real trigger (the usage ring button).
    const trigger = container.querySelector<HTMLButtonElement>(
      'button.yolo-context-usage-ring',
    )
    expect(trigger).not.toBeNull()
    await act(async () => {
      trigger?.click()
    })

    // The breakdown is computed asynchronously after open; poll the portaled
    // list until the memory row carries a real token count (skeleton gone).
    let memoryRow: HTMLElement | null = null
    let conversationRow: HTMLElement | null = null
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      memoryRow = document.querySelector('li[data-bucket="memory"]')
      conversationRow = document.querySelector('li[data-bucket="conversation"]')
      const tokens = memoryRow?.querySelector(
        '.yolo-context-breakdown__list-tokens',
      )
      if (
        tokens &&
        !tokens.querySelector('.yolo-context-breakdown__list-skeleton') &&
        tokens.textContent
      ) {
        break
      }
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25))
      })
    }

    // The memory bucket renders with the real label (BUCKET_ORDER: memory
    // comes after skills, before reasoning) and the block's own token count.
    expect(memoryRow).not.toBeNull()
    expect(memoryRow?.textContent).toContain('Memory')
    expect(
      memoryRow?.querySelector('.yolo-context-breakdown__list-tokens')
        ?.textContent,
    ).toBe(formatTokenCount(expectedMemoryTokens))

    // The conversation bucket carries only the conversation WITHOUT the
    // recalled-memory block: its token count matches the carved-out section
    // and the block text never appears in the row.
    expect(conversationRow).not.toBeNull()
    expect(conversationRow?.textContent).toContain('Conversation')
    expect(conversationRow?.textContent).not.toContain('<recalled_memory')
    expect(
      conversationRow?.querySelector('.yolo-context-breakdown__list-tokens')
        ?.textContent,
    ).toBe(formatTokenCount(expectedConversationTokens))

    await act(async () => {
      root.unmount()
    })
  })
})
