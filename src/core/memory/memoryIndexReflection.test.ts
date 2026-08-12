jest.mock('obsidian')

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemAdapter } from 'obsidian'

import { openSqliteRuntime } from '../../database/sqlite/sqliteNativeRuntime'

import { buildMemoryPartition, openMemoryIndexStore } from './memoryIndex'
import type { MemorySourceSnapshot } from './memoryManager'

class TestFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }

  override getBasePath(): string {
    return this.basePath
  }
}

const day = 24 * 60 * 60 * 1000

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const createFixture = async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-reflection-'))
  const partition = buildMemoryPartition({ scope: 'global' })
  const sourcePath = path.join(root, 'global.md')
  const markdown = '# Memory\n\n' + 'durable source\n'.repeat(31)
  fs.writeFileSync(sourcePath, markdown)
  const entries = Array.from({ length: 31 }, (_, index) => ({
    localId: `Memory_${index}`,
    content: `Durable memory ${index}`,
    keywords: [`keyword-${index}`],
    category: 'other' as const,
    partition,
    sourcePath: 'global.md',
    entryFingerprint: `entry-${index}-v1`,
  }))
  const snapshot: MemorySourceSnapshot = {
    partition,
    sourcePath: 'global.md',
    sourceFileFingerprint: 'file-v1',
    parserVersion: 'parser-v1',
    entries,
    valid: true,
  }
  let nowMs = day
  const app = {
    vault: { adapter: new TestFileSystemAdapter(root) },
  } as never
  const store = await openMemoryIndexStore({
    app,
    getSettings: () => ({ yolo: { baseDir: 'YOLO' } }),
    getSourceSnapshot: async () => snapshot,
    clock: () => nowMs,
  })
  const reconcile = async (): Promise<void> => {
    await store.reconcilePartition({
      partition,
      sourcePath: snapshot.sourcePath,
      sourceFileFingerprint: snapshot.sourceFileFingerprint,
      parserVersion: snapshot.parserVersion,
      entries: snapshot.entries,
      sectorHints: Object.fromEntries(
        entries.map(({ localId }) => [`global::${localId}`, 'semantic']),
      ),
    })
  }
  return {
    root,
    sourcePath,
    markdown,
    partition,
    entries,
    snapshot,
    store,
    reconcile,
    dbPath: path.join(root, 'YOLO', 'memory', 'index.sqlite'),
    advanceDay: () => {
      nowMs += day
      return nowMs
    },
    now: () => nowMs,
  }
}

describe('sqlite memory reflection integration', () => {
  it('does not block query or reconciliation while the reflection model is pending', async () => {
    const fixture = await createFixture()
    const modelStarted = deferred<void>()
    const modelResult = deferred<string>()
    try {
      await fixture.reconcile()
      const reflectionPromise = fixture.store.runReflection({
        partition: fixture.partition,
        nowMs: fixture.now(),
        runModel: async () => {
          modelStarted.resolve()
          return await modelResult.promise
        },
      })
      await modelStarted.promise

      const foregroundWork = Promise.all([
        fixture.store.query({
          partition: fixture.partition,
          sourceFileFingerprint: fixture.snapshot.sourceFileFingerprint,
          target: {
            query: 'durable',
            keywords: ['durable'],
            entities: [],
            categories: ['other'],
            scopes: ['global'],
            sector: null,
            confidence: 1,
            isReferential: false,
            source: 'lexical',
          },
          maxEntries: 8,
          maxChars: 3000,
        }),
        fixture.reconcile(),
      ])
      const winner = await Promise.race([
        foregroundWork.then(() => 'foreground'),
        new Promise<'blocked'>((resolve) =>
          setTimeout(() => resolve('blocked'), 50),
        ),
      ])
      modelResult.resolve(
        JSON.stringify({
          content: 'Completed after foreground work.',
          sector: 'reflective',
          sourceKeys: ['global::Memory_0'],
        }),
      )
      await reflectionPromise
      await foregroundWork

      expect(winner).toBe('foreground')
    } finally {
      await fixture.store.close?.()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('persists one idempotent reflection without changing source rows or Markdown', async () => {
    const fixture = await createFixture()
    const runModel = jest.fn(async () =>
      JSON.stringify({
        content: 'The user retains a broad set of durable facts.',
        sector: 'reflective',
        sourceKeys: ['global::Memory_0'],
      }),
    )
    try {
      await fixture.reconcile()
      await fixture.store.runReflection({
        partition: fixture.partition,
        nowMs: fixture.now(),
        runModel,
      })

      const runtime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        const reflections = runtime.query<{
          reflection_id: string
          content: string
          sector: string
          source_keys_json: string
          source_fingerprint: string
          prompt_version: string
        }>('select * from memory_reflections')
        expect(reflections).toEqual([
          expect.objectContaining({
            reflection_id: expect.stringMatching(/^[a-f0-9]{64}$/u),
            content: 'The user retains a broad set of durable facts.',
            sector: 'reflective',
            source_keys_json: JSON.stringify(['global::Memory_0']),
            source_fingerprint: 'file-v1',
            prompt_version: 'memory-reflection-v1',
          }),
        ])
        expect(
          runtime.queryOne<{ last_reflection_at: number }>(
            'select last_reflection_at from memory_partition_state where partition_key = ?',
            ['global'],
          )?.last_reflection_at,
        ).toBe(fixture.now())
        expect(
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_index where partition_key = ?',
            ['global'],
          )?.count,
        ).toBe(31)
      } finally {
        runtime.close()
      }
      expect(fs.readFileSync(fixture.sourcePath, 'utf8')).toBe(fixture.markdown)

      fixture.advanceDay()
      await fixture.store.runReflection({
        partition: fixture.partition,
        nowMs: fixture.now(),
        runModel,
      })
      const idempotencyRuntime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        expect(
          idempotencyRuntime.queryOne<{ count: number }>(
            'select count(*) as count from memory_reflections',
          )?.count,
        ).toBe(1)
      } finally {
        idempotencyRuntime.close()
      }
      expect(runModel).toHaveBeenCalledTimes(2)
    } finally {
      await fixture.store.close?.()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('isolates invalid output and model failures in bounded maintenance logs', async () => {
    const fixture = await createFixture()
    try {
      await fixture.reconcile()
      await expect(
        fixture.store.runReflection({
          partition: fixture.partition,
          nowMs: fixture.now(),
          runModel: async () =>
            JSON.stringify({
              content: 'invalid extra field',
              sector: 'reflective',
              sourceKeys: ['global::Memory_0'],
              extra: true,
            }),
        }),
      ).resolves.toBeUndefined()
      fixture.advanceDay()
      await expect(
        fixture.store.runReflection({
          partition: fixture.partition,
          nowMs: fixture.now(),
          runModel: async () => {
            throw new Error('provider secret that must not escape')
          },
        }),
      ).resolves.toBeUndefined()

      const runtime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        expect(
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_reflections',
          )?.count,
        ).toBe(0)
        const logs = runtime.query<{ operation: string; status: string }>(
          `select operation, status from memory_maintenance_log
           where operation = 'reflection' order by id`,
        )
        expect(logs).toEqual([
          { operation: 'reflection', status: 'failed' },
          { operation: 'reflection', status: 'failed' },
        ])
        expect(
          runtime.queryOne<{ last_reflection_at: number | null }>(
            'select last_reflection_at from memory_partition_state where partition_key = ?',
            ['global'],
          )?.last_reflection_at,
        ).toBeNull()
        expect(
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_maintenance_log where partition_key = ?',
            ['global'],
          )?.count,
        ).toBeLessThanOrEqual(256)
      } finally {
        runtime.close()
      }
    } finally {
      await fixture.store.close?.()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('aborts an in-flight reflection without writing a result', async () => {
    const fixture = await createFixture()
    const controller = new AbortController()
    const modelStarted = deferred<void>()
    let modelSignal: AbortSignal | null = null
    try {
      await fixture.reconcile()
      const reflectionPromise = fixture.store.runReflection({
        partition: fixture.partition,
        nowMs: fixture.now(),
        signal: controller.signal,
        runModel: async (_prompt, signal) => {
          modelSignal = signal
          modelStarted.resolve()
          return await new Promise<string>(() => undefined)
        },
      })
      await modelStarted.promise
      controller.abort()
      await reflectionPromise
      expect((modelSignal as unknown as AbortSignal).aborted).toBe(true)

      const runtime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        expect(
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_reflections',
          )?.count,
        ).toBe(0)
        expect(
          runtime.queryOne<{ status: string }>(
            `select status from memory_maintenance_log
             where operation = 'reflection' order by id desc limit 1`,
          )?.status,
        ).toBe('failed')
      } finally {
        runtime.close()
      }
    } finally {
      await fixture.store.close?.()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('records a bounded failure when the reflection model times out', async () => {
    const fixture = await createFixture()
    let observedSignal: AbortSignal | null = null
    try {
      await fixture.reconcile()
      jest.useFakeTimers()
      const reflectionPromise = fixture.store.runReflection({
        partition: fixture.partition,
        nowMs: fixture.now(),
        runModel: async (_prompt, signal) => {
          observedSignal = signal
          return await new Promise<string>(() => undefined)
        },
      })
      while (!observedSignal) await Promise.resolve()
      jest.advanceTimersByTime(30_000)
      await reflectionPromise
      jest.useRealTimers()

      const runtime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        expect((observedSignal as unknown as AbortSignal).aborted).toBe(true)
        expect(
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_reflections',
          )?.count,
        ).toBe(0)
        expect(
          runtime.queryOne<{ count: number }>(
            `select count(*) as count from memory_maintenance_log
             where operation = 'reflection' and status = 'failed'`,
          )?.count,
        ).toBe(1)
        expect(
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_maintenance_log where partition_key = ?',
            ['global'],
          )?.count,
        ).toBeLessThanOrEqual(256)
      } finally {
        runtime.close()
      }
    } finally {
      jest.useRealTimers()
      await fixture.store.close?.()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('retains only the 64 newest reflections per partition', async () => {
    const fixture = await createFixture()
    try {
      await fixture.reconcile()
      const runtime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        for (let index = 0; index < 65; index += 1) {
          runtime.exec(
            `insert into memory_reflections
             (partition_key, reflection_id, content, sector, source_keys_json,
              source_fingerprint, prompt_version, created_at, updated_at)
             values (?, ?, ?, 'reflective', ?, ?, ?, ?, ?)`,
            [
              'global',
              `seed-${index}`,
              `reflection ${index}`,
              JSON.stringify(['global::Memory_0']),
              `seed-fingerprint-${index}`,
              'memory-reflection-v1',
              index,
              index,
            ],
          )
        }
      } finally {
        runtime.close()
      }

      await fixture.store.runReflection({
        partition: fixture.partition,
        nowMs: fixture.now(),
        runModel: async () =>
          JSON.stringify({
            content: 'Newest reflection.',
            sector: 'reflective',
            sourceKeys: ['global::Memory_0'],
          }),
      })

      const verifyRuntime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        expect(
          verifyRuntime.queryOne<{ count: number }>(
            'select count(*) as count from memory_reflections where partition_key = ?',
            ['global'],
          )?.count,
        ).toBe(64)
        expect(
          verifyRuntime.queryOne<{ reflection_id: string }>(
            'select reflection_id from memory_reflections where reflection_id = ?',
            ['seed-0'],
          ),
        ).toBeUndefined()
      } finally {
        verifyRuntime.close()
      }
    } finally {
      await fixture.store.close?.()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rolls back the reflection when last-reflection state cannot commit', async () => {
    const fixture = await createFixture()
    try {
      await fixture.reconcile()
      const runtime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        runtime.exec(
          `create trigger reject_reflection_timestamp
           before update of last_reflection_at on memory_partition_state
           begin select raise(abort, 'reject timestamp'); end`,
        )
      } finally {
        runtime.close()
      }

      await fixture.store.runReflection({
        partition: fixture.partition,
        nowMs: fixture.now(),
        runModel: async () =>
          JSON.stringify({
            content: 'Must roll back.',
            sector: 'reflective',
            sourceKeys: ['global::Memory_0'],
          }),
      })

      const verifyRuntime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        expect(
          verifyRuntime.queryOne<{ count: number }>(
            'select count(*) as count from memory_reflections',
          )?.count,
        ).toBe(0)
        expect(
          verifyRuntime.queryOne<{ last_reflection_at: number | null }>(
            'select last_reflection_at from memory_partition_state where partition_key = ?',
            ['global'],
          )?.last_reflection_at,
        ).toBeNull()
        expect(
          verifyRuntime.queryOne<{ status: string }>(
            `select status from memory_maintenance_log
             where operation = 'reflection' order by id desc limit 1`,
          )?.status,
        ).toBe('failed')
      } finally {
        verifyRuntime.close()
      }
    } finally {
      await fixture.store.close?.()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('rebuilds reflections after database loss', async () => {
    const fixture = await createFixture()
    const runModel = async () =>
      JSON.stringify({
        content: 'A rebuilt reflection.',
        sector: 'reflective',
        sourceKeys: ['global::Memory_0'],
      })
    try {
      await fixture.reconcile()
      await fixture.store.runReflection({
        partition: fixture.partition,
        nowMs: fixture.now(),
        runModel,
      })
      await fixture.store.close?.()
      fs.rmSync(path.join(fixture.root, 'YOLO'), {
        recursive: true,
        force: true,
      })

      fixture.advanceDay()
      await fixture.reconcile()
      await fixture.store.runReflection({
        partition: fixture.partition,
        nowMs: fixture.now(),
        runModel,
      })

      const runtime = openSqliteRuntime({ dbPath: fixture.dbPath })
      try {
        expect(
          runtime.queryOne<{ count: number }>(
            'select count(*) as count from memory_reflections',
          )?.count,
        ).toBe(1)
      } finally {
        runtime.close()
      }
    } finally {
      await fixture.store.close?.()
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })

  it('is a no-op when the sqlite store becomes unavailable', async () => {
    const fixture = await createFixture()
    const runModel = jest.fn(async () => '{}')
    try {
      fixture.store.forceClose?.()
      await expect(
        fixture.store.runReflection({
          partition: fixture.partition,
          nowMs: fixture.now(),
          runModel,
        }),
      ).resolves.toBeUndefined()
      expect(runModel).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true })
    }
  })
})
