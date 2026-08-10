import * as path from 'node:path'

import type { RetrievalTrace } from '../../../core/rag/retrievalTraceTypes'
import {
  type SqliteNativeRuntimeFacade,
  openSqliteRuntime,
} from '../../sqlite/sqliteNativeRuntime'

type RetrievalTraceStoreOptions = {
  baseDir: string
  retentionLimit?: number
}

type RetrievalTraceRow = {
  query_id: string
  backend: RetrievalTrace['backend']
  model_id: string
  namespace_id: string
  query_text: string | null
  parent_trace_id: string | null
  step_label: string | null
  query_role: NonNullable<RetrievalTrace['queryRole']> | null
  started_at: number
  finished_at: number | null
  timings_json: string
  evidence_json: string
  warning_codes_json: string
  error_code: RetrievalTrace['errorCode'] | null
  diagnostic_json: string | null
}

type JsonFieldName =
  | 'timings_json'
  | 'evidence_json'
  | 'warning_codes_json'
  | 'diagnostic_json'

const DEFAULT_RETENTION_LIMIT = 200
const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const CREATE_SCHEMA_SQL = `
  create table if not exists retrieval_traces (
    query_id text primary key,
    backend text not null,
    model_id text not null,
    namespace_id text not null,
    query_text text,
    parent_trace_id text,
    step_label text,
    query_role text,
    started_at integer not null,
    finished_at integer,
    timings_json text not null,
    evidence_json text not null,
    warning_codes_json text not null,
    error_code text,
    diagnostic_json text
  );
`
const RETRIEVAL_TRACE_SELECT_SQL = `
  select
    query_id,
    backend,
    model_id,
    namespace_id,
    query_text,
    parent_trace_id,
    step_label,
    query_role,
    started_at,
    finished_at,
    timings_json,
    evidence_json,
    warning_codes_json,
    error_code,
    diagnostic_json
  from retrieval_traces
  order by started_at desc, query_id desc
`

type SqliteTableInfoRow = {
  name: string
}

const OPTIONAL_COLUMNS: Array<{ name: string; sql: string }> = [
  {
    name: 'query_text',
    sql: 'alter table retrieval_traces add column query_text text',
  },
  {
    name: 'parent_trace_id',
    sql: 'alter table retrieval_traces add column parent_trace_id text',
  },
  {
    name: 'step_label',
    sql: 'alter table retrieval_traces add column step_label text',
  },
  {
    name: 'query_role',
    sql: 'alter table retrieval_traces add column query_role text',
  },
]

export class RetrievalTraceStore {
  private readonly dbPath: string
  private readonly retentionLimit: number
  private runtime: SqliteNativeRuntimeFacade | null = null

  constructor(options: RetrievalTraceStoreOptions) {
    this.dbPath = path.join(options.baseDir, 'rag', 'diagnostics.sqlite')
    this.retentionLimit = options.retentionLimit ?? DEFAULT_RETENTION_LIMIT
  }

  async open(): Promise<void> {
    if (this.runtime != null) return
    this.runtime = openSqliteRuntime({ dbPath: this.dbPath })
    this.runtime.exec(CREATE_SCHEMA_SQL)
    this.ensureOptionalColumns(this.runtime)
  }

  async close(): Promise<void> {
    this.runtime?.close()
    this.runtime = null
  }

  async insertTrace(trace: RetrievalTrace): Promise<void> {
    const runtime = this.assertOpen()
    runtime.transaction((db) => {
      db.exec(
        `
          insert into retrieval_traces(
            query_id,
            backend,
            model_id,
            namespace_id,
            query_text,
            parent_trace_id,
            step_label,
            query_role,
            started_at,
            finished_at,
            timings_json,
            evidence_json,
            warning_codes_json,
            error_code,
            diagnostic_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          trace.queryId,
          trace.backend,
          trace.modelId,
          trace.namespaceId,
          trace.queryText ?? null,
          trace.parentTraceId ?? null,
          trace.stepLabel ?? null,
          trace.queryRole ?? null,
          trace.startedAt,
          trace.finishedAt ?? null,
          JSON.stringify(trace.timingsMs),
          JSON.stringify(trace.evidence),
          JSON.stringify(trace.warningCodes),
          trace.errorCode ?? null,
          trace.diagnostic == null ? null : JSON.stringify(trace.diagnostic),
        ],
      )

      db.exec(
        `
          delete from retrieval_traces
          where query_id not in (
            select query_id
            from retrieval_traces
            order by started_at desc, query_id desc
            limit ?
          )
        `,
        [this.retentionLimit],
      )
    })
  }

  async listTraces(limit?: number): Promise<RetrievalTrace[]> {
    const runtime = this.assertOpen()
    const effectiveLimit =
      limit == null ? DEFAULT_LIST_LIMIT : Math.min(limit, MAX_LIST_LIMIT)

    if (effectiveLimit <= 0) {
      return []
    }

    const rows = runtime.query<RetrievalTraceRow>(RETRIEVAL_TRACE_SELECT_SQL)

    const traces: RetrievalTrace[] = []
    for (const row of rows) {
      const trace = this.fromRow(row)
      if (trace != null) {
        traces.push(trace)
        if (traces.length >= effectiveLimit) {
          break
        }
      }
    }

    return traces
  }

  async getLatestTrace(): Promise<RetrievalTrace | null> {
    const runtime = this.assertOpen()
    const rows = runtime.query<RetrievalTraceRow>(RETRIEVAL_TRACE_SELECT_SQL)

    for (const row of rows) {
      const trace = this.fromRow(row)
      if (trace != null) {
        return trace
      }
    }

    return null
  }

  async deleteTrace(queryId: string): Promise<void> {
    const runtime = this.assertOpen()
    runtime.exec('delete from retrieval_traces where query_id = ?', [queryId])
  }

  async clearTraces(): Promise<void> {
    const runtime = this.assertOpen()
    runtime.exec('delete from retrieval_traces')
  }

  private assertOpen(): SqliteNativeRuntimeFacade {
    if (this.runtime == null) {
      throw new Error('retrieval trace store is not open')
    }
    return this.runtime
  }

  private fromRow(row: RetrievalTraceRow): RetrievalTrace | null {
    const timingsMs = this.parseJsonField<RetrievalTrace['timingsMs']>(
      row,
      'timings_json',
      row.timings_json,
    )
    if (timingsMs == null) {
      return null
    }

    const evidence = this.parseJsonField<RetrievalTrace['evidence']>(
      row,
      'evidence_json',
      row.evidence_json,
    )
    if (evidence == null) {
      return null
    }

    const warningCodes = this.parseJsonField<RetrievalTrace['warningCodes']>(
      row,
      'warning_codes_json',
      row.warning_codes_json,
    )
    if (warningCodes == null) {
      return null
    }

    let diagnostic: RetrievalTrace['diagnostic'] | undefined
    if (row.diagnostic_json != null) {
      const parsedDiagnostic = this.parseJsonField<
        RetrievalTrace['diagnostic']
      >(row, 'diagnostic_json', row.diagnostic_json)
      if (parsedDiagnostic == null) {
        return null
      }
      diagnostic = parsedDiagnostic
    }
    if (row.diagnostic_json != null && diagnostic == null) {
      return null
    }

    return {
      queryId: row.query_id,
      backend: row.backend,
      modelId: row.model_id,
      namespaceId: row.namespace_id,
      queryText: row.query_text ?? undefined,
      parentTraceId: row.parent_trace_id ?? undefined,
      stepLabel: row.step_label ?? undefined,
      queryRole: row.query_role ?? undefined,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      timingsMs,
      evidence,
      warningCodes,
      errorCode: row.error_code ?? undefined,
      diagnostic,
    }
  }

  private parseJsonField<T>(
    row: Pick<RetrievalTraceRow, 'query_id'>,
    fieldName: JsonFieldName,
    value: string,
  ): T | null {
    try {
      return JSON.parse(value) as T
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      console.warn(
        `Skipping corrupt retrieval trace row query_id=${row.query_id} field=${fieldName}: ${message}`,
      )
      return null
    }
  }

  private ensureOptionalColumns(runtime: SqliteNativeRuntimeFacade): void {
    const existingColumns = new Set(
      runtime
        .query<SqliteTableInfoRow>('pragma table_info(retrieval_traces)')
        .map((row) => row.name),
    )

    for (const column of OPTIONAL_COLUMNS) {
      if (!existingColumns.has(column.name)) {
        runtime.exec(column.sql)
      }
    }
  }
}
