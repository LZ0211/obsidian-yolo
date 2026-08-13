import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

import {
  SUBAGENT_SESSION_SCHEMA_VERSION,
  SubagentMessageIntent,
  SubagentRun,
  SubagentSession,
} from '../../../core/agent/subagent/session-types'
import { AgentFileChange, ChatMessage } from '../../../types/chat'
import { AbstractJsonRepository } from '../base'

export type StoredSubagentSession = {
  schemaVersion: typeof SUBAGENT_SESSION_SCHEMA_VERSION
  session: SubagentSession
  runs: SubagentRun[]
  intents: SubagentMessageIntent[]
  latestTranscript?: ChatMessage[]
  changes?: AgentFileChange[]
}

export type SubagentSessionMeta = {
  sessionId: string
  schemaVersion: number
  lastActiveAt: number
}

type SubagentSessionStoreOptions = {
  prepareDataDir?: () => Promise<string>
}

export class RevisionConflictError extends Error {
  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Subagent session revision conflict: expected ${expectedRevision}, found ${currentRevision}`,
    )
  }
}

export class SubagentSessionStore extends AbstractJsonRepository<
  StoredSubagentSession,
  SubagentSessionMeta
> {
  constructor(
    app: App,
    dataDir: string,
    options?: SubagentSessionStoreOptions,
  ) {
    super(app, dataDir, options)
  }

  protected generateFileName(row: StoredSubagentSession): string {
    return `v${row.schemaVersion}_${row.session.sessionId}.json`
  }

  protected parseFileName(fileName: string): SubagentSessionMeta | null {
    const match = fileName.match(/^v(\d+)_([0-9a-zA-Z_-]+)\.json$/)
    if (!match) return null
    return {
      schemaVersion: Number(match[1]),
      sessionId: match[2],
      lastActiveAt: 0, // 仅文件名解析；完整时间从 read 的会话内容取
    }
  }

  public async readById(
    sessionId: string,
  ): Promise<StoredSubagentSession | null> {
    return this.read(`v${SUBAGENT_SESSION_SCHEMA_VERSION}_${sessionId}.json`)
  }

  /**
   * Compare-and-swap write (R2). The base class serializes writes but not
   * reads, so a naive read→update can overwrite a newer row with a stale
   * one while revision still increments. Comparing inside the write queue
   * closes that race.
   *
   * Implicit contract:
   * - The file name is derived from `nextRow` only. Callers must keep
   *   `sessionId` unchanged between the two rows, otherwise the disk row
   *   compared against is not the one the caller has in mind.
   * - When the file does not exist there is no disk revision to compare, so
   *   the CAS silently writes it (create semantics).
   *
   * The read-compare-write all happen inside a single enqueueWrite callback;
   * the write goes straight to the adapter instead of `this.writeFile`,
   * because writeFile enqueues again and the inner op would chain behind
   * this op's own queue tail — a self-wait that never resolves. `this.read`
   * already ran `ensureRepositoryDir` (including any prepareDataDir
   * re-resolution), so the directory exists and `this.dataDir` is current
   * when the file path is built after it.
   */
  public async compareAndUpdate(
    expectedRow: StoredSubagentSession,
    nextRow: StoredSubagentSession,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const fileName = this.generateFileName(nextRow)
      const current = await this.read(fileName)
      if (
        current &&
        current.session.revision !== expectedRow.session.revision
      ) {
        throw new RevisionConflictError(
          expectedRow.session.revision,
          current.session.revision,
        )
      }
      const filePath = normalizePath(path.join(this.dataDir, fileName))
      await this.app.vault.adapter.write(
        filePath,
        JSON.stringify(nextRow, null, 2),
      )
    })
  }
}
