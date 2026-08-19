import {
  clearFlightLog,
  getFlightEvents,
  setFlightLogEnabled,
} from '../../utils/debug/flightLog'

import {
  MAX_REFLECTION_PROMPT_CHARS,
  MEMORY_REFLECTION_PROMPT_VERSION,
  type MemoryReflectionSource,
  buildMemoryReflectionIdentity,
  buildMemoryReflectionPrompt,
  parseMemoryReflectionOutput,
  runMemoryReflectionModel,
  selectMemoryReflectionSources,
  shouldRunMemoryReflection,
} from './reflection'

const source = (
  memoryKey: string,
  sector: MemoryReflectionSource['sector'],
  overrides: Partial<MemoryReflectionSource> = {},
): MemoryReflectionSource => ({
  memoryKey,
  content: `content for ${memoryKey}`,
  sector,
  salience: 0.5,
  updatedAt: 100,
  entryFingerprint: `${memoryKey}-fingerprint`,
  ...overrides,
})

describe('memory reflection contract', () => {
  it('runs only for eligible generic user-memory partitions after threshold and debounce', () => {
    const day = 24 * 60 * 60 * 1000
    expect(
      shouldRunMemoryReflection({
        partition: {
          scope: 'global',
          assistantId: null,
          partitionKey: 'global',
        },
        sourceCount: 31,
        lastReflectionAt: 1,
        nowMs: day + 1,
      }),
    ).toBe(true)
    expect(
      shouldRunMemoryReflection({
        partition: {
          scope: 'global',
          assistantId: null,
          partitionKey: 'global',
        },
        sourceCount: 30,
        lastReflectionAt: null,
        nowMs: day,
      }),
    ).toBe(false)
    expect(
      shouldRunMemoryReflection({
        partition: {
          scope: 'global',
          assistantId: null,
          partitionKey: 'global',
        },
        sourceCount: 31,
        lastReflectionAt: 2,
        nowMs: day + 1,
      }),
    ).toBe(false)
    expect(
      shouldRunMemoryReflection({
        partition: {
          scope: 'assistant',
          assistantId: 'a',
          partitionKey: 'assistant:YQ',
        },
        sourceCount: 99,
        lastReflectionAt: null,
        nowMs: day,
      }),
    ).toBe(false)
  })

  it('selects at most three sector groups, four sources each, twelve total, and 6000 source chars', () => {
    const sectors: MemoryReflectionSource['sector'][] = [
      'episodic',
      'semantic',
      'procedural',
      'emotional',
    ]
    const sources = sectors.flatMap((sector, sectorIndex) =>
      Array.from({ length: 8 }, (_, index) =>
        source(`${sector}-${index}`, sector, {
          content: `${sector}-${index}:${'x'.repeat(590)}`,
          salience: sectorIndex === 3 ? 0.1 : 1 - sectorIndex * 0.1,
          updatedAt: 1_000 - index,
        }),
      ),
    )
    const selected = selectMemoryReflectionSources(sources)
    const counts = new Map<string, number>()
    for (const item of selected) {
      counts.set(item.sector, (counts.get(item.sector) ?? 0) + 1)
    }

    expect(selected.length).toBeLessThanOrEqual(12)
    expect([...counts.keys()]).toHaveLength(3)
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(4)
    expect(
      selected.reduce((total, item) => total + item.content.length, 0),
    ).toBeLessThanOrEqual(6000)
    expect(selected.map(({ memoryKey }) => memoryKey)).toContain('episodic-0')
    expect(selected.map(({ memoryKey }) => memoryKey)).not.toContain(
      'emotional-0',
    )
  })

  it('builds a bounded prompt containing only selected source keys', () => {
    const selected = selectMemoryReflectionSources(
      Array.from({ length: 20 }, (_, index) =>
        source(`key-${index}`, index % 2 === 0 ? 'semantic' : 'episodic', {
          content: 'z'.repeat(1_000),
        }),
      ),
    )
    const prompt = buildMemoryReflectionPrompt(selected)

    expect(prompt.length).toBeLessThanOrEqual(MAX_REFLECTION_PROMPT_CHARS)
    for (const item of selected) expect(prompt).toContain(item.memoryKey)
    expect(prompt).not.toContain('key-19')
    expect(prompt).toContain(MEMORY_REFLECTION_PROMPT_VERSION)
  })

  it('strictly validates reflection JSON and source references', () => {
    const valid = JSON.stringify({
      content: 'The user consistently prefers concise explanations.',
      sector: 'reflective',
      sourceKeys: ['global::Memory_1', 'global::Memory_2'],
    })
    expect(
      parseMemoryReflectionOutput(valid, [
        'global::Memory_1',
        'global::Memory_2',
      ]),
    ).toEqual({
      content: 'The user consistently prefers concise explanations.',
      sector: 'reflective',
      sourceKeys: ['global::Memory_1', 'global::Memory_2'],
    })

    const invalid = [
      `${valid}\ntrailing`,
      JSON.stringify({
        content: 'valid',
        sector: 'reflective',
        sourceKeys: ['global::Memory_1'],
        extra: true,
      }),
      JSON.stringify({
        content: 'x'.repeat(513),
        sector: 'reflective',
        sourceKeys: ['global::Memory_1'],
      }),
      JSON.stringify({
        content: `${'x'.repeat(512)} `,
        sector: 'reflective',
        sourceKeys: ['global::Memory_1'],
      }),
      JSON.stringify({
        content: 'valid',
        sector: 'semantic',
        sourceKeys: ['global::Memory_1'],
      }),
      JSON.stringify({
        content: 'valid',
        sector: 'reflective',
        sourceKeys: [],
      }),
      JSON.stringify({
        content: 'valid',
        sector: 'reflective',
        sourceKeys: ['global::Memory_3'],
      }),
      JSON.stringify({
        content: 'valid',
        sector: 'reflective',
        sourceKeys: ['global::Memory_1', 'global::Memory_1'],
      }),
    ]
    for (const output of invalid) {
      expect(
        parseMemoryReflectionOutput(output, [
          'global::Memory_1',
          'global::Memory_2',
        ]),
      ).toBeNull()
    }
  })

  it('derives stable identities from partition, sorted keys, source fingerprints, and prompt version', async () => {
    const first = [
      source('global::B', 'semantic', { entryFingerprint: 'b-v1' }),
      source('global::A', 'episodic', { entryFingerprint: 'a-v1' }),
    ]
    const reversed = [...first].reverse()
    const identity = await buildMemoryReflectionIdentity('global', first)

    expect(await buildMemoryReflectionIdentity('global', reversed)).toEqual(
      identity,
    )
    expect(identity.promptVersion).toBe(MEMORY_REFLECTION_PROMPT_VERSION)
    expect(identity.reflectionId).toMatch(/^[a-f0-9]{64}$/u)
    expect(identity.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(
      await buildMemoryReflectionIdentity('global', [
        first[0],
        { ...first[1], entryFingerprint: 'a-v2' },
      ]),
    ).not.toEqual(identity)
  })

  it('aborts a model call after a bounded timeout', async () => {
    let observedSignal: AbortSignal | null = null
    await expect(
      runMemoryReflectionModel(
        (_prompt, signal) => {
          observedSignal = signal
          return new Promise<string>(() => undefined)
        },
        'prompt',
        5,
      ),
    ).rejects.toThrow('timed out')
    expect(observedSignal).not.toBeNull()
    expect((observedSignal as unknown as AbortSignal).aborted).toBe(true)
  })
})

describe('memory reflection flight span', () => {
  beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    setFlightLogEnabled(true)
    clearFlightLog()
  })

  afterEach(() => {
    setFlightLogEnabled(false)
    clearFlightLog()
    jest.restoreAllMocks()
  })

  it('records a reflection span with the model outcome', async () => {
    await runMemoryReflectionModel(async () => '{"ok":true}', 'prompt')

    const events = getFlightEvents()
    expect(events.map((event) => event.event)).toEqual([
      'span:reflection:start',
      'span:reflection:done',
    ])
  })

  it('records a reflection span with error detail on failure', async () => {
    await expect(
      runMemoryReflectionModel(
        async () => {
          throw new Error('model down')
        },
        'prompt',
      ),
    ).rejects.toThrow('model down')

    const done = getFlightEvents().find(
      (event) => event.event === 'span:reflection:done',
    )
    expect(done?.detail).toContain('model down')
  })
})
