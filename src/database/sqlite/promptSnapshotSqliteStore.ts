import {
  type SqliteNativeRuntimeFacade,
  openSqliteRuntime,
} from './sqliteNativeRuntime'

export type PromptSnapshotContent = string | unknown[]

type PromptSnapshotRow = {
  conversation_id: string
  content_hash: string
  content: string
  created_at: number
  updated_at: number
}

const CREATE_SCHEMA_SQL = `
  create table if not exists prompt_snapshots (
    conversation_id text not null,
    content_hash text not null,
    content text not null,
    created_at integer not null,
    updated_at integer not null,
    primary key (conversation_id, content_hash)
  );
`

const serializeContent = (content: unknown): string => JSON.stringify(content)

const parseContent = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

export class PromptSnapshotSqliteStore {
  private runtime: SqliteNativeRuntimeFacade | null = null

  constructor(private readonly dbPath: string) {}

  private get db(): SqliteNativeRuntimeFacade {
    if (this.runtime) return this.runtime
    const runtime = openSqliteRuntime({ dbPath: this.dbPath })
    runtime.exec(CREATE_SCHEMA_SQL)
    this.runtime = runtime
    return runtime
  }

  readFullEntries(
    conversationId: string,
  ): Record<
    string,
    { content: unknown; createdAt: number; updatedAt: number }
  > {
    const rows = this.db.query<PromptSnapshotRow>(
      `select conversation_id, content_hash, content, created_at, updated_at
       from prompt_snapshots where conversation_id = ?`,
      [conversationId],
    )
    const entries: Record<
      string,
      { content: unknown; createdAt: number; updatedAt: number }
    > = {}
    for (const row of rows) {
      entries[row.content_hash] = {
        content: parseContent(row.content),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    }
    return entries
  }

  readContent(conversationId: string, hash: string): unknown {
    const row = this.db.queryOne<PromptSnapshotRow>(
      `select conversation_id, content_hash, content, created_at, updated_at
       from prompt_snapshots where conversation_id = ? and content_hash = ?`,
      [conversationId, hash],
    )
    return row == null ? null : parseContent(row.content)
  }

  replace(
    conversationId: string,
    entries: Readonly<
      Record<
        string,
        { hash: string; content: unknown; createdAt: number; updatedAt: number }
      >
    >,
    keepHashes: ReadonlySet<string>,
  ): void {
    this.db.transaction((database) => {
      database.exec(`delete from prompt_snapshots where conversation_id = ?`, [
        conversationId,
      ])
      for (const entry of Object.values(entries)) {
        if (!keepHashes.has(entry.hash)) continue
        database.exec(
          `insert into prompt_snapshots (conversation_id, content_hash, content, created_at, updated_at)
           values (?, ?, ?, ?, ?)`,
          [
            conversationId,
            entry.hash,
            serializeContent(entry.content),
            entry.createdAt,
            entry.updatedAt,
          ],
        )
      }
    })
  }

  clearConversation(conversationId: string): void {
    this.db.exec(`delete from prompt_snapshots where conversation_id = ?`, [
      conversationId,
    ])
  }

  clearAll(): void {
    this.db.exec(`delete from prompt_snapshots`)
  }

  close(): void {
    this.runtime?.close()
    this.runtime = null
  }
}
