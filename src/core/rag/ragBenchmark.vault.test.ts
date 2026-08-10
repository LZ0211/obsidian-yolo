import * as fs from 'node:fs'
import * as path from 'node:path'

import {
  type SqliteNativeRuntimeFacade,
  openSqliteRuntime,
} from '../../database/sqlite/sqliteNativeRuntime'
import { type SuperSearchResult, fuseRrfHybrid } from '../search/hybridSearch'

import { getEmbeddingModelClient } from './embedding'

type RecallCase = {
  id: string
  query: string
  anchors: readonly string[]
}

type RecallMetrics = {
  recall20: number
  mrr: number
  precisionAt1: number
}

const vaultPath = process.env.YOLO_RAG_BENCHMARK_VAULT ?? 'D:/Obsidian/个人笔记'
const ragDbPath =
  process.env.YOLO_RAG_BENCHMARK_DB ??
  path.join(vaultPath, 'YOLO/rag/qwen3-embedding-8b-d1024/rag.sqlite')
const settingsPath =
  process.env.YOLO_RAG_BENCHMARK_SETTINGS ??
  path.join(vaultPath, '.obsidian/plugins/yolo/data.json')
const benchmarkReady = fs.existsSync(ragDbPath) && fs.existsSync(settingsPath)
const describeVaultBenchmark = benchmarkReady ? describe : describe.skip

const recallCases: readonly RecallCase[] = [
  {
    id: 'full-tab-np-design',
    query: '全极耳电芯 N/P 比设计',
    anchors: ['全极耳', 'N/P'],
  },
  {
    id: 'electrolyte-additive-cycle',
    query: '电解液添加剂与循环寿命',
    anchors: ['电解液', '添加剂', '循环'],
  },
  {
    id: 'solid-interface-impedance',
    query: '固态电解质界面阻抗',
    anchors: ['固态电解质', '界面阻抗'],
  },
  {
    id: '4680-thermal-management',
    query: '4680 电芯热管理方案',
    anchors: ['4680', '热管理'],
  },
  {
    id: 'anode-fast-charge',
    query: '负极析锂与快充性能',
    anchors: ['负极', '析锂', '快充'],
  },
  {
    id: 'formation-sei',
    query: '化成工艺与 SEI 膜形成',
    anchors: ['化成', 'SEI'],
  },
  {
    id: 'eis-aging',
    query: 'EIS 阻抗分析与电池衰减',
    anchors: ['EIS', '衰减'],
  },
  {
    id: 'thermal-safety',
    query: '电池热失控与防护措施',
    anchors: ['热失控', '防护'],
  },
  {
    id: 'filling-wetting',
    query: '注液工艺与电解液浸润',
    anchors: ['注液', '浸润'],
  },
  {
    id: 'conductive-rate',
    query: '导电剂种类与倍率性能',
    anchors: ['导电剂', '倍率'],
  },
  {
    id: 'coating-cycle',
    query: '正极包覆改性与循环稳定性',
    anchors: ['包覆', '循环'],
  },
  {
    id: 'high-nickel-safety',
    query: '高镍正极材料与安全性',
    anchors: ['高镍', '安全性'],
  },
  {
    id: 'cell-consistency',
    query: '电池一致性与分容配组',
    anchors: ['一致性', '分容'],
  },
  {
    id: 'patent-puncture',
    query: '过针刺测试与电池安全专利',
    anchors: ['针刺', '专利'],
  },
]

const benchmarkTokens = (query: string): string[] => {
  const trimmed = query.trim()
  if (!trimmed) return []
  return trimmed.split(/\s+/).filter(Boolean)
}
let rag: SqliteNativeRuntimeFacade
let embed: ((text: string) => Promise<number[]>) | null = null
let embeddingRequestCount = 0
let coarseRows: Array<{ rowid: number; embedding: Float32Array }> = []

const cosine = (left: ArrayLike<number>, right: ArrayLike<number>): number => {
  const length = Math.min(left.length, right.length)
  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }
  return leftNorm > 0 && rightNorm > 0
    ? dot / Math.sqrt(leftNorm * rightNorm)
    : 0
}

const average = (values: readonly number[]): number =>
  values.length === 0
    ? 0
    : values.reduce((total, value) => total + value, 0) / values.length

const percentile = (
  values: readonly number[],
  percentileValue: number,
): number => {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor((sorted.length * percentileValue) / 100)] ?? 0
}

const asFloat32Array = (value: Uint8Array): Float32Array =>
  new Float32Array(
    value.buffer,
    value.byteOffset,
    Math.floor(value.byteLength / Float32Array.BYTES_PER_ELEMENT),
  )

const loadCoarseRows = (): void => {
  if (coarseRows.length > 0) return
  coarseRows = rag
    .query<{
      rowid: number
      embedding: Uint8Array
    }>('select rowid, embedding from rag_coarse_embeddings')
    .map((row) => ({
      rowid: Number(row.rowid),
      embedding: asFloat32Array(row.embedding),
    }))
}

const directKeywordPaths = (query: string, limit = 20): string[] => {
  const tokens = benchmarkTokens(query).slice(0, 16)
  if (tokens.length === 0) return []
  const clauses = tokens.map(() => 'lower(text) like lower(?)').join(' or ')
  const scoreExpression = tokens
    .map(() => 'case when lower(text) like lower(?) then 1 else 0 end')
    .join(' + ')
  return [
    ...new Set(
      rag
        .query<{ path: string }>(
          `select path, sum(${scoreExpression}) as keyword_score
             from rag_chunks
            where ${clauses}
            group by path
            order by keyword_score desc, path collate binary
            limit ?`,
          [
            ...tokens.map((token) => `%${token}%`),
            ...tokens.map((token) => `%${token}%`),
            limit,
          ],
        )
        .map((row) => row.path)
        .filter(Boolean),
    ),
  ]
}

const toContentResults = (
  paths: readonly string[],
  source: 'keyword' | 'rag',
): SuperSearchResult[] =>
  paths.map((pathValue) => ({
    kind: 'content',
    path: pathValue,
    source,
  }))

const fuseRankedPaths = (
  keywordPaths: readonly string[],
  ragPaths: readonly string[],
  limit = 20,
): string[] =>
  fuseRrfHybrid({
    keywordResults: toContentResults(keywordPaths, 'keyword'),
    ragResults: toContentResults(ragPaths, 'rag'),
    maxResults: limit,
  }).map((result) => result.path)

const vectorPaths = async (query: string, limit = 20): Promise<string[]> => {
  if (!embed) return []
  loadCoarseRows()
  const queryVector = await embed(query)
  const coarseTopRows = coarseRows
    .map((row) => ({
      rowid: row.rowid,
      score: cosine(queryVector, row.embedding),
    }))
    .sort((left, right) => right.score - left.score || left.rowid - right.rowid)
    .slice(0, Math.max(limit * 4, 64))
  if (coarseTopRows.length === 0) return []

  const rows = rag.query<{ path: string; embedding: Uint8Array }>(
    `select chunks.path, embeddings.embedding
       from rag_chunks chunks
       join rag_embeddings embeddings on embeddings.rowid = chunks.rowid
      where chunks.rowid in (${coarseTopRows.map(() => '?').join(',')})
        and embeddings.embedding is not null`,
    coarseTopRows.map((row) => row.rowid),
  )
  const rowScores = rows
    .map((row) => ({
      path: row.path,
      score: cosine(queryVector, asFloat32Array(row.embedding)),
    }))
    .sort((left, right) => right.score - left.score)
  return [...new Set(rowScores.map((row) => row.path).filter(Boolean))].slice(
    0,
    limit,
  )
}

const oraclePaths = (anchors: readonly string[]): string[] => {
  const clauses = anchors.map(() => 'lower(text) like lower(?)').join(' and ')
  return [
    ...new Set(
      rag
        .query<{ path: string }>(
          `select distinct path from rag_chunks where ${clauses} order by path collate binary`,
          anchors.map((anchor) => `%${anchor}%`),
        )
        .map((row) => row.path)
        .filter(Boolean),
    ),
  ]
}

const measureRecall = (
  rankedPaths: readonly string[],
  relevantPaths: readonly string[],
): RecallMetrics => {
  const relevant = new Set(relevantPaths)
  const firstRelevantRank = rankedPaths.findIndex((pathValue) =>
    relevant.has(pathValue),
  )
  const recalled = new Set(
    rankedPaths.slice(0, 20).filter((pathValue) => relevant.has(pathValue)),
  )
  return {
    recall20: relevant.size === 0 ? 0 : recalled.size / relevant.size,
    mrr: firstRelevantRank < 0 ? 0 : 1 / (firstRelevantRank + 1),
    precisionAt1:
      rankedPaths.length > 0 && relevant.has(rankedPaths[0]) ? 1 : 0,
  }
}

describeVaultBenchmark('Real-vault RAG recall benchmark', () => {
  beforeAll(() => {
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    rag = openSqliteRuntime({ dbPath: ragDbPath })
    try {
      const client = getEmbeddingModelClient({
        settings,
        embeddingModelId: settings.embeddingModelId,
      })
      embed = async (text: string) => {
        embeddingRequestCount += 1
        return client.getEmbedding(text)
      }
    } catch {
      embed = null
    }
  })

  afterAll(() => {
    rag?.close()
  })

  it('reports the real RAG inventory', () => {
    const chunks = rag.queryOne<{ count: number }>(
      'select count(*) as count from rag_chunks',
    )
    const embeddings = rag.queryOne<{ count: number }>(
      'select count(*) as count from rag_embeddings',
    )
    const files = rag.queryOne<{ count: number }>(
      'select count(*) as count from rag_files',
    )
    console.debug(
      `  RAG: ${chunks?.count} chunks, ${embeddings?.count} embeddings, ${files?.count} files`,
    )
    expect(Number(chunks?.count ?? 0)).toBeGreaterThan(0)
    expect(Number(embeddings?.count ?? 0)).toBeGreaterThan(0)
  })

  it('compares direct keyword recall with real embedding recall', async () => {
    const keywordMetrics: RecallMetrics[] = []
    const vectorMetrics: RecallMetrics[] = []
    const unionMetrics: RecallMetrics[] = []
    const keywordTimings: number[] = []
    const vectorTimings: number[] = []

    for (const recallCase of recallCases) {
      const relevantPaths = oraclePaths(recallCase.anchors)
      if (relevantPaths.length === 0) continue

      const keywordStartedAt = performance.now()
      const keyword = directKeywordPaths(recallCase.query)
      keywordTimings.push(performance.now() - keywordStartedAt)
      keywordMetrics.push(measureRecall(keyword, relevantPaths))

      const vectorStartedAt = performance.now()
      const vector = await vectorPaths(recallCase.query)
      vectorTimings.push(performance.now() - vectorStartedAt)
      vectorMetrics.push(measureRecall(vector, relevantPaths))
      unionMetrics.push(
        measureRecall(fuseRankedPaths(keyword, vector), relevantPaths),
      )
      console.debug(
        `  ${recallCase.id}: oracle=${relevantPaths.length}, keyword@20=${(keywordMetrics.at(-1)?.recall20 ?? 0).toFixed(2)}, vector@20=${(vectorMetrics.at(-1)?.recall20 ?? 0).toFixed(2)}`,
      )
    }

    expect(keywordMetrics.length).toBeGreaterThan(0)
    console.debug(
      `  Keyword: R@20=${(average(keywordMetrics.map((metric) => metric.recall20)) * 100).toFixed(1)}%, MRR=${average(keywordMetrics.map((metric) => metric.mrr)).toFixed(3)}, P@1=${(average(keywordMetrics.map((metric) => metric.precisionAt1)) * 100).toFixed(1)}%, avg=${average(keywordTimings).toFixed(1)}ms`,
    )
    console.debug(
      `  Vector(real request x${embeddingRequestCount}): R@20=${(average(vectorMetrics.map((metric) => metric.recall20)) * 100).toFixed(1)}%, MRR=${average(vectorMetrics.map((metric) => metric.mrr)).toFixed(3)}, P@1=${(average(vectorMetrics.map((metric) => metric.precisionAt1)) * 100).toFixed(1)}%, avg=${average(vectorTimings).toFixed(1)}ms, p95=${percentile(vectorTimings, 95).toFixed(1)}ms`,
    )
    console.debug(
      `  Keyword+Vector union: R@20=${(average(unionMetrics.map((metric) => metric.recall20)) * 100).toFixed(1)}%`,
    )
    if (process.env.YOLO_REQUIRE_REAL_EMBEDDING === '1') {
      expect(embeddingRequestCount).toBe(recallCases.length)
    }
  }, 300000)
})
