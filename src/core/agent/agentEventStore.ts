import {
  type SqliteNativeRuntimeFacade,
  openSqliteRuntime,
} from '../../database/sqlite/sqliteNativeRuntime'
import type { AgentRunTerminalStatus } from '../../types/agentRun'
import { loadDesktopNodeModuleSync } from '../../utils/platform/desktopNodeModule'

export type AgentRunRow = {
  runId: string
  conversationId: string
  workspaceId: string | null
  agentInstanceId: string | null
  status: AgentRunTerminalStatus
  startedAtMs: number
  finishedAtMs: number | null
  toolCallCount: number
}

export type AgentEventRow = {
  eventId: number
  runId: string
  sequence: number
  eventType: string
  eventJson: unknown
  createdAtMs: number
}

type AgentRunDbRow = {
  run_id: string
  conversation_id: string
  workspace_id: string | null
  agent_instance_id: string | null
  status: AgentRunTerminalStatus
  started_at_ms: number
  finished_at_ms: number | null
  tool_call_count: number
}

type AgentEventDbRow = {
  event_id: number
  run_id: string
  sequence: number
  event_type: string
  event_json: string
  created_at_ms: number
}

type CreateRunInput = Omit<AgentRunRow, 'finishedAtMs' | 'toolCallCount'> & {
  finishedAtMs?: number | null
  toolCallCount?: number
}

type InsertEventInput = Omit<AgentEventRow, 'eventId'>

const CREATE_SCHEMA_SQL = `
  create table if not exists agent_runs (
    run_id text primary key,
    conversation_id text not null,
    workspace_id text,
    agent_instance_id text,
    status text not null check (status in ('running', 'completed', 'aborted', 'error')),
    started_at_ms integer not null,
    finished_at_ms integer,
    tool_call_count integer not null default 0
  );

  create table if not exists agent_events (
    event_id integer primary key autoincrement,
    run_id text not null references agent_runs(run_id) on delete cascade,
    sequence integer not null,
    event_type text not null,
    event_json text not null,
    created_at_ms integer not null,
    unique(run_id, sequence)
  );

  create index if not exists idx_agent_events_run
    on agent_events(run_id, sequence);

  create index if not exists idx_agent_runs_workspace
    on agent_runs(workspace_id, started_at_ms desc);

  create index if not exists idx_agent_runs_agent_instance
    on agent_runs(agent_instance_id);
`

export class AgentEventStore {
  private runtime: SqliteNativeRuntimeFacade | null = null

  constructor(private readonly rootDir: string) {}

  open(): void {
    if (this.runtime != null) return
    const path =
      loadDesktopNodeModuleSync<typeof import('node:path')>('node:path')
    this.runtime = openSqliteRuntime({
      dbPath: path.join(this.rootDir, 'agent.sqlite'),
    })
    this.runtime.exec(CREATE_SCHEMA_SQL)
  }

  close(): void {
    this.runtime?.close()
    this.runtime = null
  }

  get isOpen(): boolean {
    return this.runtime != null
  }

  createRun(row: CreateRunInput): void {
    this.db.exec(
      `
        insert into agent_runs(
          run_id, conversation_id, workspace_id, agent_instance_id, status,
          started_at_ms, finished_at_ms, tool_call_count
        ) values (?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        row.runId,
        row.conversationId,
        row.workspaceId,
        row.agentInstanceId,
        row.status,
        row.startedAtMs,
        row.finishedAtMs ?? null,
        row.toolCallCount ?? 0,
      ],
    )
  }

  updateRunStatus(
    runId: string,
    status: AgentRunTerminalStatus,
    finishedAtMs: number | null = null,
  ): void {
    this.db.exec(
      `
        update agent_runs
        set status = ?, finished_at_ms = ?
        where run_id = ?
      `,
      [status, finishedAtMs, runId],
    )
  }

  insertEvent(event: InsertEventInput): void {
    this.db.exec(
      `
        insert into agent_events(
          run_id, sequence, event_type, event_json, created_at_ms
        ) values (?, ?, ?, ?, ?)
      `,
      [
        event.runId,
        event.sequence,
        event.eventType,
        JSON.stringify(event.eventJson),
        event.createdAtMs,
      ],
    )
  }

  getRunEvents(runId: string, afterSequence?: number): AgentEventRow[] {
    const rows =
      afterSequence == null
        ? this.db.query<AgentEventDbRow>(
            `
              select event_id, run_id, sequence, event_type, event_json, created_at_ms
              from agent_events
              where run_id = ?
              order by sequence asc
            `,
            [runId],
          )
        : this.db.query<AgentEventDbRow>(
            `
              select event_id, run_id, sequence, event_type, event_json, created_at_ms
              from agent_events
              where run_id = ? and sequence > ?
              order by sequence asc
            `,
            [runId, afterSequence],
          )
    return rows.map(fromEventDbRow)
  }

  getRun(runId: string): AgentRunRow | null {
    const row = this.db.queryOne<AgentRunDbRow>(
      `
        select run_id, conversation_id, workspace_id, agent_instance_id,
               status, started_at_ms, finished_at_ms, tool_call_count
        from agent_runs
        where run_id = ?
      `,
      [runId],
    )
    return row == null ? null : fromRunDbRow(row)
  }

  listRuns(options: { workspaceId?: string | null } = {}): AgentRunRow[] {
    const rows =
      options.workspaceId === undefined
        ? this.db.query<AgentRunDbRow>(
            `
              select run_id, conversation_id, workspace_id, agent_instance_id,
                     status, started_at_ms, finished_at_ms, tool_call_count
              from agent_runs
              order by started_at_ms desc, run_id desc
            `,
          )
        : this.db.query<AgentRunDbRow>(
            `
              select run_id, conversation_id, workspace_id, agent_instance_id,
                     status, started_at_ms, finished_at_ms, tool_call_count
              from agent_runs
              where workspace_id is ?
              order by started_at_ms desc, run_id desc
            `,
            [options.workspaceId],
          )
    return rows.map(fromRunDbRow)
  }

  deleteRun(runId: string): void {
    this.db.exec('delete from agent_runs where run_id = ?', [runId])
  }

  deleteRunsByWorkspace(workspaceId: string): void {
    this.db.exec('delete from agent_runs where workspace_id = ?', [workspaceId])
  }

  listRunsByAgent(agentInstanceId: string): AgentRunRow[] {
    const rows = this.db.query<AgentRunDbRow>(
      `
        select run_id, conversation_id, workspace_id, agent_instance_id,
               status, started_at_ms, finished_at_ms, tool_call_count
        from agent_runs
        where agent_instance_id = ?
        order by started_at_ms desc, run_id desc
      `,
      [agentInstanceId],
    )
    return rows.map(fromRunDbRow)
  }

  deleteRunsByAgent(agentInstanceId: string): void {
    this.db.exec('delete from agent_runs where agent_instance_id = ?', [
      agentInstanceId,
    ])
  }

  deleteRunsByConversation(conversationId: string): void {
    this.db.exec('delete from agent_runs where conversation_id = ?', [
      conversationId,
    ])
  }

  /**
   * 删除超过保留 TTL 的终态 run（events 级联）（E6-F5）。返回清理条数。
   */
  sweepExpiredRuns(nowMs: number, ttlMs: number): number {
    const cutoff = nowMs - ttlMs
    const expired = this.db.query<{ run_id: string }>(
      `
        select run_id from agent_runs
        where finished_at_ms is not null and finished_at_ms < ?
      `,
      [cutoff],
    )
    if (expired.length === 0) return 0
    const runIds = expired.map((row) => row.run_id)
    const placeholders = runIds.map(() => '?').join(', ')
    this.db.exec(
      `delete from agent_runs where run_id in (${placeholders})`,
      runIds,
    )
    return runIds.length
  }

  private get db(): SqliteNativeRuntimeFacade {
    if (this.runtime == null) {
      throw new Error('agent event store is not open')
    }
    return this.runtime
  }
}

export function createAgentEventStore(rootDir: string): AgentEventStore {
  const store = new AgentEventStore(rootDir)
  store.open()
  return store
}

function fromRunDbRow(row: AgentRunDbRow): AgentRunRow {
  return {
    runId: row.run_id,
    conversationId: row.conversation_id,
    workspaceId: row.workspace_id,
    agentInstanceId: row.agent_instance_id,
    status: row.status,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms,
    toolCallCount: row.tool_call_count,
  }
}

function fromEventDbRow(row: AgentEventDbRow): AgentEventRow {
  try {
    return {
      eventId: row.event_id,
      runId: row.run_id,
      sequence: row.sequence,
      eventType: row.event_type,
      eventJson: JSON.parse(row.event_json) as unknown,
      createdAtMs: row.created_at_ms,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`corrupt agent event row ${row.event_id}: ${message}`)
  }
}
