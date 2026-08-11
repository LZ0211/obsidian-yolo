import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { openSqliteRuntime } from '../../database/sqlite/sqliteNativeRuntime'

import {
  MEMORY_INDEX_SCHEMA_VERSION,
  MemoryIndexUnavailableError,
  initializeMemoryIndexSchema,
  trimMemoryMaintenanceLog,
} from './memoryIndexSchema'

describe('memory index schema', () => {
  let root = ''
  let runtime: ReturnType<typeof openSqliteRuntime>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-index-schema-'))
    runtime = openSqliteRuntime({ dbPath: path.join(root, 'index.sqlite') })
    initializeMemoryIndexSchema(runtime)
  })

  afterEach(() => {
    runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('creates every version-one table idempotently', () => {
    initializeMemoryIndexSchema(runtime)
    const names = runtime
      .query<{
        name: string
      }>(
        "select name from sqlite_master where type = 'table' and name like 'memory_%'",
      )
      .map((row) => row.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'memory_schema_meta',
        'memory_index',
        'memory_keywords',
        'memory_edges',
        'memory_reflections',
        'memory_partition_state',
        'memory_maintenance_log',
      ]),
    )
    expect(
      runtime.queryOne<{ value: string }>(
        "select value from memory_schema_meta where key = 'schema_version'",
      )?.value,
    ).toBe(String(MEMORY_INDEX_SCHEMA_VERSION))
  })

  it('rejects incompatible versions with a typed unavailable error', () => {
    runtime.exec(
      "update memory_schema_meta set value = '99' where key = 'schema_version'",
    )
    expect(() => initializeMemoryIndexSchema(runtime)).toThrow(
      MemoryIndexUnavailableError,
    )
  })

  it('bounds maintenance log rows per partition', () => {
    for (let index = 0; index < 300; index += 1) {
      runtime.exec(
        'insert into memory_maintenance_log (partition_key, operation, status, created_at) values (?, ?, ?, ?)',
        ['global', 'test', 'completed', index],
      )
    }
    trimMemoryMaintenanceLog(runtime, 'global')
    expect(
      runtime.queryOne<{ count: number }>(
        'select count(*) as count from memory_maintenance_log where partition_key = ?',
        ['global'],
      )?.count,
    ).toBe(256)
  })
})
