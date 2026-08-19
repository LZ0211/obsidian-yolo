import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { App } from 'obsidian'

import { SystemPromptSnapshotStore } from '../../core/agent/systemPromptSnapshotStore'
import { getEmbeddingModelClient } from '../../core/rag/embedding'
import { RequestContextBuilder } from '../../utils/chat/requestContextBuilder'
import {
  clearFlightLog,
  getFlightEvents,
  setFlightLogEnabled,
} from '../../utils/debug/flightLog'
import { estimateTextTokens } from '../../utils/llm/contextTokenEstimate'
import { executeSingleTurn } from '../ai/single-turn'

import {
  GLOBAL_MEMORY_VAULT_PATH,
  RECALLED_MEMORY_BLOCK_RE,
  type TempFileSystemAdapter,
  getLastUserContent,
  getSystemContent,
  installTempFileSystemAdapter,
  makeVaultApp,
  parseProductionSettings,
  reconcileGlobalMemoryPartition,
  seedGlobalMemoryFile,
  userMessageWithText,
  waitForMemoryIndexRow,
} from './__test_utils__/memoryIntegrationHarness'
import { runMemoryAgentAfterTurn } from './memoryAgent'
import {
  type MemoryIndexMaintenanceStore,
  buildMemoryPartition,
} from './memoryIndex'
import {
  closeMemoryIndexRuntime,
  getMemoryIndexRuntimeHandle,
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
  // [0,1,…]. Same seam as the memoryWiring harness.
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
    return ['极简']
  }),
}))

const executeSingleTurnMock = executeSingleTurn as jest.Mock

/** The real memory markdown source format (as written by `memoryAdd`). */
const TWO_ENTRY_GLOBAL_MEMORY = `# User Profile

# Preferences
- Preference_1: 用户偏好极简风格的设计 <!-- keywords: 极简风格,设计 -->
- Preference_2: 用户负责数据库迁移项目 <!-- keywords: 数据库迁移 -->

# Other Memory
`

const MODEL = { id: 'test-model', model: 'test-model' } as never

const globalPartition = buildMemoryPartition({ scope: 'global' })

describe('memory production wiring integration (real disk + schema settings + real sqlite + real tokenizer)', () => {
  let rootDir: string
  let app: App
  let adapter: TempFileSystemAdapter

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-production-'))
    app = makeVaultApp(rootDir)
    adapter = installTempFileSystemAdapter(app, rootDir)
    executeSingleTurnMock.mockReset()
    ;(getEmbeddingModelClient as jest.Mock).mockClear()
  })

  afterEach(async () => {
    await closeMemoryIndexRuntime(app)
    fs.rmSync(rootDir, { recursive: true, force: true })
  })

  it('parses the production settings schema with the legacy shadow default and realistic memory fields', () => {
    const parsed = parseProductionSettings()
    // Legacy default: a payload without memoryExtractionQualityGate must not
    // change the hidden-extraction behavior (shadow keeps calling the LLM).
    expect(parsed.memoryExtractionQualityGate).toBe('shadow')
    expect(parsed.advancedMemoryIndexEnabled).toBe(true)
    expect(parsed.memoryAgentModelId).toBe('openai/gpt-5-mini')
    expect(parsed.embeddingModelId).toBe('test-embed')
    expect(parsed.yolo.baseDir).toBe('YOLO')
  })

  it('C4: multi-turn request layering over real disk, real sqlite, real tokenizer', async () => {
    // Seed the global memory markdown file on REAL DISK (kept out of the mock
    // vault's file map): the snapshot loader then reads it through the
    // production adapter-fallback branch of readVaultFileCached.
    await seedGlobalMemoryFile(adapter, TWO_ENTRY_GLOBAL_MEMORY)

    const parsed = parseProductionSettings()
    const handle = getMemoryIndexRuntimeHandle(app, () => parsed)
    const reconciled = await reconcileGlobalMemoryPartition({
      app,
      settings: parsed,
      handle,
    })
    // The snapshot really came from disk: two entries under the production
    // vault-relative memory path.
    expect(reconciled.sourcePath).toBe(GLOBAL_MEMORY_VAULT_PATH)
    expect(reconciled.entries).toBe(2)

    const builder = new RequestContextBuilder(app, parsed, {
      memoryIndexRuntime: handle,
      systemPromptSnapshotStore: new SystemPromptSnapshotStore(),
    })

    const turnOneInput = [userMessageWithText('我喜欢极简设计')]
    const turnOneInputCopy = structuredClone(turnOneInput)
    const roundOne = await builder.generateRequestMessages({
      messages: turnOneInput,
      model: MODEL,
      conversationId: 'conv-production-c4',
      systemPromptSnapshotMode: 'create',
    })

    const turnTwoInput = [userMessageWithText('请推荐数据库迁移方案')]
    const turnTwoInputCopy = structuredClone(turnTwoInput)
    const roundTwo = await builder.generateRequestMessages({
      messages: turnTwoInput,
      model: MODEL,
      conversationId: 'conv-production-c4',
      systemPromptSnapshotMode: 'create',
    })

    // (a) The stable system message is frozen for the conversation lifetime —
    // identical content AND reference (the snapshot store serves the same
    // frozen string to both turns).
    const systemOne = getSystemContent(roundOne)
    const systemTwo = getSystemContent(roundTwo)
    expect(systemOne).toBe(systemTwo)

    // (b) Stable profile/preferences live in the system message.
    expect(systemOne).toContain('<global>')
    expect(systemOne).toContain('用户偏好极简风格的设计')
    expect(systemOne).toContain('用户负责数据库迁移项目')

    // (c) The dynamic recall never freezes into the system snapshot.
    expect(systemOne).not.toContain('<recalled_memory')
    expect(systemTwo).not.toContain('<recalled_memory')

    // (d) Each turn carries its own dynamic block in the last real user
    // message; the blocks differ because recall follows the latest query.
    const userOne = getLastUserContent(roundOne)
    const userTwo = getLastUserContent(roundTwo)
    expect(userOne).toContain('我喜欢极简设计')
    expect(userOne).toContain('<recalled_memory')
    expect(userTwo).toContain('请推荐数据库迁移方案')
    expect(userTwo).toContain('<recalled_memory')
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
    expect(blockOne?.indexOf('用户偏好极简风格的设计') ?? -1).toBeLessThan(
      blockOne?.indexOf('用户负责数据库迁移项目') ?? -1,
    )
    expect(blockTwo?.indexOf('用户负责数据库迁移项目') ?? -1).toBeLessThan(
      blockTwo?.indexOf('用户偏好极简风格的设计') ?? -1,
    )

    // (e) The cl100k token packer holds the real-token budget.
    expect(await estimateTextTokens(blockOne ?? '')).toBeLessThanOrEqual(768)
    expect(await estimateTextTokens(blockTwo ?? '')).toBeLessThanOrEqual(768)

    // (f) Section attribution: exactly one memory.dynamic.* section whose
    // content is the block carried by the request's user message; the stable
    // memory.context section stays in the system; the conversation section
    // does not double-count the block.
    const sectionsTwo = await builder.generateRequestSections({
      messages: turnTwoInput,
      model: MODEL,
      conversationId: 'conv-production-c4',
      systemPromptSnapshotMode: 'create',
    })
    const dynamicSections = sectionsTwo.filter((section) =>
      section.id.startsWith('memory.dynamic.'),
    )
    expect(dynamicSections).toHaveLength(1)
    expect(dynamicSections[0]?.bucket).toBe('memory')
    expect(dynamicSections[0]?.content).toBe(blockTwo)
    expect(sectionsTwo.some((section) => section.id === 'memory.context')).toBe(
      true,
    )
    const conversation = sectionsTwo.find((section) =>
      section.id.startsWith('conversation.'),
    )
    expect(conversation).toBeDefined()
    expect(JSON.stringify(conversation?.content)).not.toContain(
      '<recalled_memory',
    )

    // (g) The input ChatMessage arrays are never mutated.
    expect(turnOneInput).toEqual(turnOneInputCopy)
    expect(turnTwoInput).toEqual(turnTwoInputCopy)
  })

  it('C5: schema-parsed settings drive the extraction quality gate (shadow runs, enabled skips, blank always skips)', async () => {
    setFlightLogEnabled(true)
    clearFlightLog()
    const consoleDebugSpy = jest
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined)
    try {
      const parsed = parseProductionSettings()
      const onSourceCommitted = jest.fn()
      const baseInput = {
        app,
        assistantId: undefined,
        assistantText: '好的。',
        providerClient: {} as never,
        model: MODEL,
        onSourceCommitted,
      }

      // Shadow (the schema default for legacy payloads): the punctuation-only
      // turn still calls the hidden extraction LLM and records the quality
      // outcome event — behavior is unchanged until the user opts in.
      executeSingleTurnMock.mockResolvedValue({
        content: '{"operations":[]}',
        toolCalls: [],
      })
      await runMemoryAgentAfterTurn({
        ...baseInput,
        settings: parsed,
        userText: '   !!!   ',
      })
      expect(executeSingleTurnMock).toHaveBeenCalledTimes(1)
      expect(
        getFlightEvents().some(
          (event) =>
            event.scope === 'memory' &&
            event.event === 'extraction-quality-outcome',
        ),
      ).toBe(true)

      // Enabled: the same turn skips the LLM entirely, records the skip, and
      // neither writes memory nor notifies a reconcile.
      executeSingleTurnMock.mockClear()
      clearFlightLog()
      await runMemoryAgentAfterTurn({
        ...baseInput,
        settings: { ...parsed, memoryExtractionQualityGate: 'enabled' },
        userText: '   !!!   ',
      })
      expect(executeSingleTurnMock).not.toHaveBeenCalled()
      expect(
        getFlightEvents().some(
          (event) =>
            event.scope === 'memory' && event.event === 'extraction-skipped',
        ),
      ).toBe(true)
      expect(onSourceCommitted).not.toHaveBeenCalled()
      const adapter = app.vault.adapter as {
        stat: (p: string) => Promise<unknown>
      }
      expect(await adapter.stat(GLOBAL_MEMORY_VAULT_PATH)).toBeNull()

      // Blank input + off (from the parsed base): skip in every mode.
      executeSingleTurnMock.mockClear()
      clearFlightLog()
      await runMemoryAgentAfterTurn({
        ...baseInput,
        settings: { ...parsed, memoryExtractionQualityGate: 'off' },
        userText: '   ',
      })
      expect(executeSingleTurnMock).not.toHaveBeenCalled()
      expect(
        getFlightEvents().some(
          (event) =>
            event.scope === 'memory' && event.event === 'extraction-skipped',
        ),
      ).toBe(true)
      expect(onSourceCommitted).not.toHaveBeenCalled()
    } finally {
      setFlightLogEnabled(false)
      clearFlightLog()
      consoleDebugSpy.mockRestore()
    }
  })

  it('S1: recall reinforcement bumps salience once per interval through the real recall path', async () => {
    await seedGlobalMemoryFile(
      adapter,
      `# User Profile

# Preferences
- Preference_1: 用户偏好极简风格的设计 <!-- keywords: 极简风格,设计 -->

# Other Memory
`,
    )

    const parsed = parseProductionSettings()
    const handle = getMemoryIndexRuntimeHandle(app, () => parsed)
    const store = (await handle.getStore()) as MemoryIndexMaintenanceStore
    await reconcileGlobalMemoryPartition({ app, settings: parsed, handle })

    // The reconciled row starts at the default salience with no recall history.
    const initialRow = await waitForMemoryIndexRow({
      store,
      partitionKey: globalPartition.partitionKey,
      localId: 'Preference_1',
      matches: (row) => Math.abs(row.salience - 0.5) < 1e-9,
    })
    expect(initialRow.last_recalled_at).toBeNull()
    expect(initialRow.last_reinforced_at).toBeNull()

    const builder = new RequestContextBuilder(app, parsed, {
      memoryIndexRuntime: handle,
    })
    const requestArgs = {
      messages: [userMessageWithText('我喜欢极简设计')],
      model: MODEL,
      conversationId: 'conv-s1-reinforce',
      systemPromptSnapshotMode: 'create' as const,
    }

    // First recall: salience bumps +0.05 and the reinforcement window opens.
    await builder.generateRequestMessages(requestArgs)
    const afterFirstRecall = await waitForMemoryIndexRow({
      store,
      partitionKey: globalPartition.partitionKey,
      localId: 'Preference_1',
      matches: (row) => Math.abs(row.salience - 0.55) < 1e-9,
    })
    expect(afterFirstRecall.last_recalled_at).not.toBeNull()
    expect(afterFirstRecall.last_reinforced_at).not.toBeNull()

    // Second recall inside the one-hour interval: last_recalled_at refreshes,
    // but salience stays bumped-once and last_reinforced_at is untouched.
    await builder.generateRequestMessages(requestArgs)
    const afterSecondRecall = await waitForMemoryIndexRow({
      store,
      partitionKey: globalPartition.partitionKey,
      localId: 'Preference_1',
      matches: (row) =>
        row.last_recalled_at !== null &&
        row.last_recalled_at !== afterFirstRecall.last_recalled_at,
    })
    expect(Math.abs(afterSecondRecall.salience - 0.55)).toBeLessThan(1e-9)
    expect(afterSecondRecall.last_reinforced_at).toBe(
      afterFirstRecall.last_reinforced_at,
    )
  })
})
