/**
 * Component tests for sqlite-engine. Self-contained (no host imports):
 * the facade semantics and the exact DDL/embedding shapes the memory index
 * uses, verified against the real sql.js engine inlined in the component.
 */

import type { SqliteJsRuntimeFacade, SqliteJsVaultAdapter } from './entry'

// entry.ts registers itself on import via the host bridge; capture the
// registration and require the module after the bridge exists (a runtime
// import would hoist above the bridge assignment, so use requireActual).
const registeredComponents: Array<{ id: string; create: () => unknown }> = []
;(
  globalThis as { __yolo_register_runtime_component__?: unknown }
).__yolo_register_runtime_component__ = (definition: {
  id: string
  create: () => unknown
}) => {
  registeredComponents.push(definition)
}
const { openSqliteJsRuntime }: typeof import('./entry') =
  jest.requireActual('./entry')

class MemoryAdapter implements SqliteJsVaultAdapter {
  readonly files = new Map<string, Uint8Array>()

  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path))
  }

  readBinary(path: string): Promise<ArrayBuffer> {
    const bytes = this.files.get(path)
    if (!bytes) {
      return Promise.reject(new Error(`file not found: ${path}`))
    }
    return Promise.resolve(bytes.buffer.slice(0) as ArrayBuffer)
  }

  writeBinary(path: string, data: ArrayBuffer): Promise<void> {
    this.files.set(path, new Uint8Array(data))
    return Promise.resolve()
  }

  rename(oldPath: string, newPath: string): Promise<void> {
    const bytes = this.files.get(oldPath)
    if (!bytes) {
      return Promise.reject(new Error(`file not found: ${oldPath}`))
    }
    this.files.delete(oldPath)
    this.files.set(newPath, bytes)
    return Promise.resolve()
  }
}

const DB_PATH = '.yolo/memory/index.sqlite'

const open = (adapter: MemoryAdapter, flushDebounceMs = 1000) =>
  openSqliteJsRuntime({
    relativePath: DB_PATH,
    adapter,
    flushDebounceMs,
  })

describe('sqlite-engine runtime', () => {
  it('creates a fresh database when the file does not exist', async () => {
    const adapter = new MemoryAdapter()
    const runtime = await open(adapter)
    runtime.exec('create table t (id integer primary key, v text);')
    runtime.exec('insert into t (v) values (?)', ['hello'])
    expect(runtime.query<{ v: string }>('select v from t')).toEqual([
      { v: 'hello' },
    ])
    runtime.close()
  })

  it('round-trips f32 blobs like memory embeddings', async () => {
    const adapter = new MemoryAdapter()
    const runtime = await open(adapter)
    runtime.exec(
      'create table emb (memory_key text primary key, embedding blob not null, dimension integer not null);',
    )
    const values = [1.5, -2.25, 3.75]
    const buffer = new ArrayBuffer(values.length * 4)
    new Float32Array(buffer).set(values)
    runtime.exec(
      'insert into emb (memory_key, embedding, dimension) values (?, ?, ?)',
      ['k1', new Uint8Array(buffer), values.length],
    )
    const row = runtime.queryOne<{ embedding: Uint8Array }>(
      'select embedding from emb where memory_key = ?',
      ['k1'],
    )
    expect(row).toBeDefined()
    const back = new Float32Array(
      row!.embedding.buffer,
      row!.embedding.byteOffset,
      row!.embedding.byteLength / 4,
    )
    expect(Array.from(back)).toEqual(values)
    runtime.close()
  })

  it('supports the memory-index DDL shapes (checks, fk, on conflict)', async () => {
    const adapter = new MemoryAdapter()
    const runtime = await open(adapter)
    runtime.exec(`
      create table if not exists memory_index (
        partition_key text not null,
        memory_key text not null unique,
        category text not null check (category in ('profile', 'preferences', 'other')),
        content text not null,
        salience real not null default 0.5 check (salience >= 0 and salience <= 1),
        primary key (partition_key, memory_key)
      );`)
    runtime.exec(`
      create table if not exists memory_embeddings (
        partition_key text not null,
        memory_key text not null,
        embedding blob not null,
        dimension integer not null,
        primary key (partition_key, memory_key),
        foreign key (partition_key, memory_key)
          references memory_index(partition_key, memory_key) on delete cascade
      );`)
    runtime.exec(
      `insert into memory_index (partition_key, memory_key, category, content, salience)
       values (?, ?, 'preferences', ?, 0.8)
       on conflict(partition_key, memory_key) do update set content = excluded.content`,
      ['p1', 'p1::a', 'prefers dark mode'],
    )
    runtime.exec(
      `insert into memory_embeddings (partition_key, memory_key, embedding, dimension)
       values (?, ?, ?, ?)`,
      ['p1', 'p1::a', new Uint8Array([1, 2, 3]), 3],
    )
    // FK cascade fires on delete.
    runtime.exec('delete from memory_index where memory_key = ?', ['p1::a'])
    expect(runtime.query('select * from memory_embeddings')).toEqual([])
    runtime.close()
  })

  it('commits transactions and rolls back on throw', async () => {
    const adapter = new MemoryAdapter()
    const runtime = await open(adapter)
    runtime.exec('create table t (id integer primary key);')
    runtime.transaction(() => {
      runtime.exec('insert into t (id) values (1)')
    })
    expect(() =>
      runtime.transaction(() => {
        runtime.exec('insert into t (id) values (2)')
        throw new Error('boom')
      }),
    ).toThrow('boom')
    expect(
      runtime.query<{ id: number }>('select id from t order by id'),
    ).toEqual([{ id: 1 }])
    runtime.close()
  })

  it('supports prepared statement all/get/run', async () => {
    const adapter = new MemoryAdapter()
    const runtime = await open(adapter)
    runtime.exec('create table t (id integer primary key, v text);')
    const statement = runtime.prepare('insert into t (v) values (?)')
    statement.run('a')
    statement.run('b')
    expect(runtime.prepare('select v from t order by id').all()).toEqual([
      { v: 'a' },
      { v: 'b' },
    ])
    expect(runtime.prepare('select v from t where id = ?').get(2)).toEqual({
      v: 'b',
    })
    runtime.close()
  })

  it('persists to the vault file on flush and reloads it', async () => {
    const adapter = new MemoryAdapter()
    const first = await open(adapter, 60_000) // disable debounce for this test
    first.exec('create table t (id integer primary key, v text, b blob);')
    first.exec('insert into t (v, b) values (?, ?)', [
      'persisted',
      new Uint8Array([1, 2, 3]),
    ])
    await first.flush()
    first.close()

    const second = await open(adapter, 60_000)
    const rows = second.query<{ v: string; b: Uint8Array }>(
      'select v, b from t',
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].v).toBe('persisted')
    expect(Array.from(rows[0].b)).toEqual([1, 2, 3])
    second.close()
  })

  it('rotates a corrupt database aside and starts fresh', async () => {
    const adapter = new MemoryAdapter()
    adapter.files.set(DB_PATH, new Uint8Array([1, 2, 3, 4, 5]))
    const runtime = await open(adapter)
    runtime.exec('create table t (id integer primary key);')
    runtime.exec('insert into t (id) values (1)')
    await runtime.flush()
    runtime.close()

    expect(adapter.files.has(DB_PATH)).toBe(true)
    const corruptFiles = [...adapter.files.keys()].filter((path) =>
      path.includes('.corrupt-'),
    )
    expect(corruptFiles).toHaveLength(1)
    const reloaded = await open(adapter, 60_000)
    expect(reloaded.query('select id from t')).toEqual([{ id: 1 }])
    reloaded.close()
  })

  it('debounce flushes after mutations', async () => {
    const adapter = new MemoryAdapter()
    const runtime = await open(adapter, 50)
    runtime.exec('create table t (id integer primary key);')
    expect(adapter.files.has(DB_PATH)).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(adapter.files.has(DB_PATH)).toBe(true)
    runtime.close()
  })

  it('throws after close', async () => {
    const adapter = new MemoryAdapter()
    const runtime = await open(adapter)
    runtime.exec('create table t (id integer primary key);')
    runtime.close()
    expect(() => runtime.exec('select 1')).toThrow('closed')
  })
})

describe('sqlite-engine type surface', () => {
  it('exposes a facade with flush/status', async () => {
    const adapter = new MemoryAdapter()
    const runtime: SqliteJsRuntimeFacade = await open(adapter)
    expect(typeof runtime.flush).toBe('function')
    expect(runtime.getStatus()).toMatchObject({
      status: 'ready',
      dbPath: DB_PATH,
      isOpen: true,
    })
    runtime.close()
    expect(runtime.getStatus().isOpen).toBe(false)
  })
})
