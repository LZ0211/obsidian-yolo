import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

import { AbstractJsonRepository } from '../base'
import {
  SUBAGENT_SESSION_SCHEMA_VERSION,
  SubagentRun,
  SubagentMessageIntent,
  SubagentSession,
} from '../../../core/agent/subagent/session-types'
import { AgentFileChange, ChatMessage } from '../../../types/chat'

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
  constructor(readonly currentRevision: number) {
    super(`Subagent session revision conflict: expected ${currentRevision}`)
  }
}

export class SubagentSessionStore extends AbstractJsonRepository<
  StoredSubagentSession,
  SubagentSessionMeta
> {
  constructor(app: App, dataDir: string, options?: SubagentSessionStoreOptions) {
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

  public async readById(sessionId: string): Promise<StoredSubagentSession | null> {
    return this.read(`v${SUBAGENT_SESSION_SCHEMA_VERSION}_${sessionId}.json`)
  }

  /**
   * Compare-and-swap write (R2). The base class serializes writes but not
   * reads, so a naive read→update can overwrite a newer row with a stale
   * one while revision still increments. Comparing inside the write queue
   * closes that race.
   */
  public async compareAndUpdate(
    expectedRow: StoredSubagentSession,
    nextRow: StoredSubagentSession,
  ): Promise<void> {
    await this.enqueueWrite(async () => {
      const fileName = this.generateFileName(nextRow)
      const filePath = normalizePath(path.join(this.dataDir, fileName))
      const current = await this.read(fileName)
      if (
        current &&
        current.session.revision !== expectedRow.session.revision
      ) {
        throw new RevisionConflictError(current.session.revision)
      }
      await this.writeFile(filePath, JSON.stringify(nextRow, null, 2))
    })
  }
}
