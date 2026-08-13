import type { MemoryRecallTargetInput } from '../memoryRecallTarget'

export type MemoryRecallEvalCase = {
  name: string
  input: MemoryRecallTargetInput
  expectedEntity?: string
  expectedPersistedAlias?: string
  expectedMissingKeyword?: string
}

export const MEMORY_RECALL_EVAL_CASES: MemoryRecallEvalCase[] = [
  {
    name: 'explicit bilingual entity',
    input: {
      latestQuery: '解释 Obsidian memoryAgent 的生命周期',
      recentUserMessages: [],
    },
    expectedEntity: 'obsidian',
  },
  {
    name: 'persisted English alias',
    input: {
      latestQuery: '继续 Smart RAG 的配置',
      recentUserMessages: [],
      knownMemoryKeywords: ['Smart RAG'],
    },
    expectedPersistedAlias: 'smart rag',
  },
  {
    name: 'referential Chinese query',
    input: {
      latestQuery: '继续那个方案',
      recentUserMessages: ['讨论了迁移方案'],
    },
  },
  {
    name: 'high-confidence zero-hit morphology',
    input: {
      latestQuery: 'Explain Smart RAG integration morphology',
      recentUserMessages: [
        'We configured the Smart RAG integration yesterday.',
      ],
    },
  },
  {
    name: 'alias-free synonym gap',
    input: {
      latestQuery: '帮助我配置知识库检索',
      recentUserMessages: [],
      knownMemoryKeywords: ['Smart RAG'],
    },
    expectedMissingKeyword: 'smart rag',
  },
  {
    name: 'unrelated negative',
    input: { latestQuery: '上海明天天气怎么样？', recentUserMessages: [] },
  },
]
