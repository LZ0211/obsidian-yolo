import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { openSqliteRuntime } from './sqliteNativeRuntime'

describe('sqliteNativeRuntime', () => {
  test('does not rely on direct eval to load node:sqlite', () => {
    const source = fs.readFileSync(
      path.join(__dirname, 'sqliteNativeRuntime.ts'),
      'utf8',
    )

    expect(source).not.toContain("eval('require')")
  })

  test('enables foreign key enforcement for every opened connection', () => {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sqlite-runtime-test-'),
    )
    const dbPath = path.join(rootDir, 'runtime.sqlite')

    const first = openSqliteRuntime({ dbPath })
    const second = openSqliteRuntime({ dbPath })

    try {
      type ForeignKeysRow = {
        foreign_keys?: number
        pragma_foreign_keys?: number
      }
      const firstForeignKeys = first.queryOne<ForeignKeysRow>(
        'PRAGMA foreign_keys',
      )
      const secondForeignKeys = second.queryOne<ForeignKeysRow>(
        'PRAGMA foreign_keys',
      )

      expect(
        firstForeignKeys?.foreign_keys ?? firstForeignKeys?.pragma_foreign_keys,
      ).toBe(1)
      expect(
        secondForeignKeys?.foreign_keys ??
          secondForeignKeys?.pragma_foreign_keys,
      ).toBe(1)
    } finally {
      first.close()
      second.close()
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('rolls back DML and DDL when a transaction migration fails', () => {
    const rootDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sqlite-runtime-test-'),
    )
    const dbPath = path.join(rootDir, 'runtime.sqlite')
    const runtime = openSqliteRuntime({ dbPath })

    try {
      runtime.exec(
        'create table ddl_probe (id integer primary key, value text not null)',
      )

      expect(() =>
        runtime.transaction((transaction) => {
          transaction.exec(
            "insert into ddl_probe(id, value) values (1, 'before migration')",
          )
          transaction.exec('alter table ddl_probe add column migrated text')
          transaction.exec('alter table ddl_probe add column migrated text')
        }),
      ).toThrow()

      expect(
        runtime.queryOne<{ count: number }>(
          'select count(*) as count from ddl_probe',
        )?.count,
      ).toBe(0)
      expect(
        runtime
          .query<{ name: string }>('pragma table_info(ddl_probe)')
          .map((column) => column.name),
      ).toEqual(['id', 'value'])
    } finally {
      runtime.close()
      fs.rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
