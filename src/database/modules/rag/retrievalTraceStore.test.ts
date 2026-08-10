import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemAdapter } from 'obsidian'

import type { RetrievalTrace } from '../../../core/rag/retrievalTraceTypes'
import { DatabaseManager } from '../../DatabaseManager'
import { openSqliteRuntime } from '../../sqlite/sqliteNativeRuntime'

import { RetrievalTraceStore } from './retrievalTraceStore'

function createTempBaseDir() {
  const rootDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'retrieval-trace-store-test-'),
  )
  const baseDir = path.join(rootDir, 'data')
  fs.mkdirSync(baseDir, { recursive: true })
  return { rootDir, baseDir }
}

function removeDirWithRetries(targetDir: string) {
  try {
    fs.rmSync(targetDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') {
      throw error
    }
  }
}

function makeTrace(
  overrides: Partial<RetrievalTrace> &
    Pick<RetrievalTrace, 'queryId' | 'startedAt'>,
): RetrievalTrace {
  return {
    queryId: overrides.queryId,
    backend: 'sqlite',
    modelId: overrides.modelId ?? 'text-embedding-3-large',
    namespaceId: overrides.namespaceId ?? 'namespace-1',
    queryText: overrides.queryText,
    parentTraceId: overrides.parentTraceId,
    stepLabel: overrides.stepLabel,
    queryRole: overrides.queryRole,
    startedAt: overrides.startedAt,
    finishedAt: overrides.finishedAt ?? overrides.startedAt + 25,
    timingsMs: overrides.timingsMs ?? {
      normalizeInput: 2,
      resolveScope: 4,
      embedQuery: 10,
      searchBackend: 5,
      assembleEvidence: 3,
      total: 24,
    },
    evidence: overrides.evidence ?? [
      {
        id: `evidence-${overrides.queryId}`,
        path: `notes/${overrides.queryId}.md`,
        score: 0.9,
      },
    ],
    warningCodes: overrides.warningCodes ?? [],
    errorCode: overrides.errorCode,
    diagnostic: overrides.diagnostic,
  }
}

function insertTraceRow(
  baseDir: string,
  row: {
    queryId: string
    startedAt: number
    finishedAt?: number | null
    timingsJson?: string
    evidenceJson?: string
    warningCodesJson?: string
    diagnosticJson?: string | null
  },
) {
  const diagnosticsPath = path.join(baseDir, 'rag', 'diagnostics.sqlite')
  const runtime = openSqliteRuntime({ dbPath: diagnosticsPath })
  runtime.exec(CREATE_TEST_SCHEMA_SQL)
  runtime.exec(
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
      row.queryId,
      'sqlite',
      'text-embedding-3-large',
      'namespace-1',
      null,
      null,
      null,
      null,
      row.startedAt,
      row.finishedAt ?? row.startedAt + 25,
      row.timingsJson ??
        JSON.stringify({
          normalizeInput: 2,
          resolveScope: 4,
          embedQuery: 10,
          searchBackend: 5,
          assembleEvidence: 3,
          total: 24,
        }),
      row.evidenceJson ??
        JSON.stringify([
          {
            id: `evidence-${row.queryId}`,
            path: `notes/${row.queryId}.md`,
            score: 0.9,
          },
        ]),
      row.warningCodesJson ?? JSON.stringify([]),
      null,
      row.diagnosticJson ?? null,
    ],
  )
  runtime.close()
}

const CREATE_TEST_SCHEMA_SQL = `
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

class TestFileSystemAdapter extends FileSystemAdapter {
  constructor(private readonly basePath: string) {
    super()
  }

  override getBasePath(): string {
    return this.basePath
  }
}

describe('RetrievalTraceStore', () => {
  test('persists traces across close/reopen and prunes to newest rows by started_at desc, query_id desc', async () => {
    const { rootDir, baseDir } = createTempBaseDir()

    try {
      const store = new RetrievalTraceStore({ baseDir, retentionLimit: 2 })
      await store.open()

      await store.insertTrace(
        makeTrace({ queryId: 'rq-100-a', startedAt: 100 }),
      )
      await store.insertTrace(
        makeTrace({ queryId: 'rq-200-a', startedAt: 200 }),
      )
      await store.insertTrace(
        makeTrace({ queryId: 'rq-200-z', startedAt: 200 }),
      )

      const diagnosticsPath = path.join(baseDir, 'rag', 'diagnostics.sqlite')
      expect(fs.existsSync(diagnosticsPath)).toBe(true)

      await store.close()

      const reopened = new RetrievalTraceStore({ baseDir, retentionLimit: 2 })
      await reopened.open()

      await expect(reopened.listTraces()).resolves.toEqual([
        makeTrace({ queryId: 'rq-200-z', startedAt: 200 }),
        makeTrace({ queryId: 'rq-200-a', startedAt: 200 }),
      ])
      await expect(reopened.listTraces(1)).resolves.toEqual([
        makeTrace({ queryId: 'rq-200-z', startedAt: 200 }),
      ])
      await expect(reopened.getLatestTrace()).resolves.toEqual(
        makeTrace({ queryId: 'rq-200-z', startedAt: 200 }),
      )

      await reopened.close()
    } finally {
      removeDirWithRetries(rootDir)
    }
  })

  test('persists query text and reserved agentic fields', async () => {
    const { rootDir, baseDir } = createTempBaseDir()

    try {
      const store = new RetrievalTraceStore({ baseDir, retentionLimit: 10 })
      await store.open()

      await store.insertTrace(
        makeTrace({
          queryId: 'q-query-fields',
          startedAt: 10,
          queryText: 'final retrieval query',
          parentTraceId: 'parent-1',
          stepLabel: 'rewrite 1',
          queryRole: 'rewritten_query',
        }),
      )

      await expect(store.getLatestTrace()).resolves.toMatchObject({
        queryId: 'q-query-fields',
        queryText: 'final retrieval query',
        parentTraceId: 'parent-1',
        stepLabel: 'rewrite 1',
        queryRole: 'rewritten_query',
      })

      await store.close()
    } finally {
      removeDirWithRetries(rootDir)
    }
  })

  test('old schema migration preserves existing rows and exposes new fields as undefined', async () => {
    const { rootDir, baseDir } = createTempBaseDir()

    try {
      const diagnosticsPath = path.join(baseDir, 'rag', 'diagnostics.sqlite')
      const runtime = openSqliteRuntime({ dbPath: diagnosticsPath })
      runtime.exec(`
        create table if not exists retrieval_traces (
          query_id text primary key,
          backend text not null,
          model_id text not null,
          namespace_id text not null,
          started_at integer not null,
          finished_at integer,
          timings_json text not null,
          evidence_json text not null,
          warning_codes_json text not null,
          error_code text,
          diagnostic_json text
        );
      `)
      runtime.exec(
        `
          insert into retrieval_traces(
            query_id,
            backend,
            model_id,
            namespace_id,
            started_at,
            finished_at,
            timings_json,
            evidence_json,
            warning_codes_json,
            error_code,
            diagnostic_json
          ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          'old-row',
          'sqlite',
          'text-embedding-3-large',
          'namespace-1',
          123,
          148,
          JSON.stringify({
            normalizeInput: 2,
            resolveScope: 4,
            embedQuery: 10,
            searchBackend: 5,
            assembleEvidence: 3,
            total: 24,
          }),
          JSON.stringify([
            { id: 'evidence-old', path: 'notes/old.md', score: 0.4 },
          ]),
          JSON.stringify([]),
          null,
          null,
        ],
      )
      runtime.close()

      const store = new RetrievalTraceStore({ baseDir, retentionLimit: 10 })
      await store.open()

      await expect(store.getLatestTrace()).resolves.toEqual({
        queryId: 'old-row',
        backend: 'sqlite',
        modelId: 'text-embedding-3-large',
        namespaceId: 'namespace-1',
        queryText: undefined,
        parentTraceId: undefined,
        stepLabel: undefined,
        queryRole: undefined,
        startedAt: 123,
        finishedAt: 148,
        timingsMs: {
          normalizeInput: 2,
          resolveScope: 4,
          embedQuery: 10,
          searchBackend: 5,
          assembleEvidence: 3,
          total: 24,
        },
        evidence: [{ id: 'evidence-old', path: 'notes/old.md', score: 0.4 }],
        warningCodes: [],
        errorCode: undefined,
        diagnostic: undefined,
      })

      await store.close()
    } finally {
      removeDirWithRetries(rootDir)
    }
  })

  test('applies list limit defaults, clamp, non-positive behavior, and deterministic ordering', async () => {
    const { rootDir, baseDir } = createTempBaseDir()

    try {
      const store = new RetrievalTraceStore({ baseDir, retentionLimit: 250 })
      await store.open()

      for (let i = 0; i < 205; i += 1) {
        await store.insertTrace(
          makeTrace({
            queryId: `q-${String(i).padStart(3, '0')}`,
            startedAt: 1000 + i,
          }),
        )
      }

      await expect(store.listTraces(0)).resolves.toEqual([])
      await expect(store.listTraces(-5)).resolves.toEqual([])
      await expect(store.listTraces()).resolves.toHaveLength(50)
      await expect(store.listTraces(999)).resolves.toHaveLength(200)

      const [first] = await store.listTraces(1)
      expect(first.queryId).toBe('q-204')

      await store.close()
    } finally {
      removeDirWithRetries(rootDir)
    }
  })

  test('listTraces skips a row with corrupt timings_json and keeps other valid rows', async () => {
    const { rootDir, baseDir } = createTempBaseDir()
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      insertTraceRow(baseDir, { queryId: 'valid-row', startedAt: 100 })
      insertTraceRow(baseDir, {
        queryId: 'corrupt-row',
        startedAt: 200,
        timingsJson: '{bad json',
      })

      const store = new RetrievalTraceStore({ baseDir, retentionLimit: 10 })
      await store.open()

      await expect(store.listTraces(10)).resolves.toEqual([
        makeTrace({ queryId: 'valid-row', startedAt: 100 }),
      ])
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('query_id=corrupt-row'),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('field=timings_json'),
      )

      await store.close()
    } finally {
      warnSpy.mockRestore()
      removeDirWithRetries(rootDir)
    }
  })

  test('listTraces backfills valid rows after corrupt rows to satisfy the requested limit', async () => {
    const { rootDir, baseDir } = createTempBaseDir()
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      insertTraceRow(baseDir, { queryId: 'older-valid-row', startedAt: 100 })
      insertTraceRow(baseDir, { queryId: 'newer-valid-row', startedAt: 200 })
      insertTraceRow(baseDir, {
        queryId: 'latest-corrupt-row',
        startedAt: 300,
        timingsJson: '{bad json',
      })

      const store = new RetrievalTraceStore({ baseDir, retentionLimit: 10 })
      await store.open()

      await expect(store.listTraces(2)).resolves.toEqual([
        makeTrace({ queryId: 'newer-valid-row', startedAt: 200 }),
        makeTrace({ queryId: 'older-valid-row', startedAt: 100 }),
      ])

      await store.close()
    } finally {
      warnSpy.mockRestore()
      removeDirWithRetries(rootDir)
    }
  })

  test('getLatestTrace skips a corrupt latest row and returns the next valid trace', async () => {
    const { rootDir, baseDir } = createTempBaseDir()
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})

    try {
      insertTraceRow(baseDir, { queryId: 'older-valid-row', startedAt: 100 })
      insertTraceRow(baseDir, {
        queryId: 'latest-corrupt-row',
        startedAt: 200,
        evidenceJson: '{bad json',
      })

      const store = new RetrievalTraceStore({ baseDir, retentionLimit: 10 })
      await store.open()

      await expect(store.getLatestTrace()).resolves.toEqual(
        makeTrace({ queryId: 'older-valid-row', startedAt: 100 }),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('query_id=latest-corrupt-row'),
      )
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('field=evidence_json'),
      )

      await store.close()
    } finally {
      warnSpy.mockRestore()
      removeDirWithRetries(rootDir)
    }
  })

  test('deletes one trace without touching other trace rows', async () => {
    const { rootDir, baseDir } = createTempBaseDir()

    try {
      const store = new RetrievalTraceStore({ baseDir, retentionLimit: 10 })
      await store.open()

      await store.insertTrace(makeTrace({ queryId: 'keep', startedAt: 1 }))
      await store.insertTrace(makeTrace({ queryId: 'delete-me', startedAt: 2 }))

      await store.deleteTrace('delete-me')
      await store.deleteTrace('missing-row')

      await expect(store.listTraces(10)).resolves.toMatchObject([
        { queryId: 'keep' },
      ])

      await store.close()
    } finally {
      removeDirWithRetries(rootDir)
    }
  })

  test('clears all retrieval trace rows without failing when already empty', async () => {
    const { rootDir, baseDir } = createTempBaseDir()

    try {
      const store = new RetrievalTraceStore({ baseDir, retentionLimit: 10 })
      await store.open()

      await store.insertTrace(makeTrace({ queryId: 'q-clear', startedAt: 1 }))
      await store.clearTraces()
      await store.clearTraces()

      await expect(store.listTraces()).resolves.toEqual([])

      await store.close()
    } finally {
      removeDirWithRetries(rootDir)
    }
  })

  test('DatabaseManager owns the trace store lifecycle and closes it during cleanup', async () => {
    const vaultRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'retrieval-trace-manager-test-'),
    )
    const app = {
      vault: {
        adapter: new TestFileSystemAdapter(vaultRoot),
      },
    } as never

    try {
      const manager = await DatabaseManager.create(
        app,
        { yolo: { baseDir: '.yolo-test' } },
        '.obsidian/plugins/obsidian-yolo',
      )

      const traceStore = manager.getRetrievalTraceStore()
      expect(traceStore).not.toBeNull()

      await traceStore!.insertTrace(
        makeTrace({ queryId: 'rq-cleanup', startedAt: 300 }),
      )

      const diagnosticsPath = path.join(
        vaultRoot,
        '.yolo-test',
        'rag',
        'diagnostics.sqlite',
      )
      expect(fs.existsSync(diagnosticsPath)).toBe(true)

      await manager.cleanup()

      await expect(traceStore!.listTraces()).rejects.toThrow(
        'retrieval trace store is not open',
      )
      expect(manager.getRetrievalTraceStore()).toBeNull()
    } finally {
      removeDirWithRetries(vaultRoot)
    }
  })
})
