import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  countSqliteTableRows,
  formatSqliteExplorerValue,
  inspectSqliteDatabase,
  runReadOnlySql,
} from './sqliteDatabaseExplorer'
import { openSqliteRuntime } from './sqliteNativeRuntime'

describe('sqliteDatabaseExplorer', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-explorer-'))
  const runtime = openSqliteRuntime({ dbPath: path.join(root, 'test.sqlite') })

  beforeAll(() => {
    runtime.exec(
      'create table records (id integer primary key, name text not null)',
    )
    runtime.exec(
      "insert into records (name) values ('one'), ('two'), ('three')",
    )
    runtime.exec('create table many_rows (value integer not null)')
    runtime.exec('insert into many_rows (value) values (1), (2), (3)')
  })

  afterAll(() => {
    runtime.close()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('loads a page without counting and reports whether another page exists', () => {
    const result = inspectSqliteDatabase(runtime, {
      table: 'records',
      cursor: '2',
      pageSize: 2,
    })
    expect(result.tables).toEqual([])
    expect(result.table).toMatchObject({
      name: 'records',
      columns: ['id', 'name'],
      nextCursor: null,
      pageSize: 2,
      hasNextPage: false,
    })
    expect(result.table?.rows).toEqual([{ id: 3, name: 'three' }])
    expect(result.table).not.toHaveProperty('totalRows')
    expect(countSqliteTableRows(runtime, 'records')).toBe(3)
  })

  it('uses cached columns, a one-row lookahead, and a rowid keyset cursor', () => {
    expect(
      inspectSqliteDatabase(runtime, {
        table: 'records',
        columns: ['id', 'name'],
        cursor: null,
        pageSize: 2,
      }).table,
    ).toMatchObject({
      columns: ['id', 'name'],
      rows: [
        { id: 1, name: 'one' },
        { id: 2, name: 'two' },
      ],
      nextCursor: '2',
      hasNextPage: true,
    })
  })

  it('allows a single read-only SQL statement and rejects writes', () => {
    expect(
      runReadOnlySql(runtime, 'select name from records order by id'),
    ).toEqual({
      columns: ['name'],
      rows: [{ name: 'one' }, { name: 'two' }, { name: 'three' }],
      truncated: false,
    })
    expect(() =>
      runReadOnlySql(runtime, 'delete from records where id = 1'),
    ).toThrow('Only read-only SQL statements are allowed.')
    expect(() => runReadOnlySql(runtime, 'select 1; select 2')).toThrow(
      'Only one SQL statement is allowed.',
    )
  })

  it('caps read-only SQL output and reports truncation', () => {
    expect(
      runReadOnlySql(runtime, 'select value from many_rows order by value', 2),
    ).toEqual({
      columns: ['value'],
      rows: [{ value: 1 }, { value: 2 }],
      truncated: true,
    })
  })

  it('renders BLOB values as byte counts instead of expanding their contents', () => {
    expect(formatSqliteExplorerValue(new Uint8Array([1, 2, 3]))).toBe(
      'BLOB (3 bytes)',
    )
    expect(formatSqliteExplorerValue({ value: 'kept' })).toBe(
      '{"value":"kept"}',
    )
  })
})
