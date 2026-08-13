import type { App } from 'obsidian'

import { RagCoordinator } from './ragCoordinator'

jest.mock('./ragEngine', () => ({
  RAGEngine: jest.fn(function RAGEngine(this: { engineCreated: boolean }) {
    this.engineCreated = true
  }),
}))

import { RAGEngine } from './ragEngine'

const mockRAGEngine = RAGEngine as unknown as jest.Mock

describe('RagCoordinator', () => {
  beforeEach(() => {
    mockRAGEngine.mockClear()
  })

  it('creates the engine lazily on getRagEngine', async () => {
    const getDbManager = jest.fn().mockResolvedValue({
      getVectorManager: () => ({}),
      getRetrievalTraceStore: () => null,
    })
    const coordinator = new RagCoordinator({
      app: {} as App,
      getSettings: () => ({}) as never,
      getDbManager,
      t: (_key, fallback) => fallback ?? '',
    })

    expect(getDbManager).not.toHaveBeenCalled()
    expect(mockRAGEngine).not.toHaveBeenCalled()

    await expect(coordinator.getRagEngine()).resolves.toBeDefined()
    expect(getDbManager).toHaveBeenCalledTimes(1)
    expect(mockRAGEngine).toHaveBeenCalledTimes(1)
  })

  it('reuses the same engine across repeated calls', async () => {
    const getDbManager = jest.fn().mockResolvedValue({
      getVectorManager: () => ({}),
      getRetrievalTraceStore: () => null,
    })
    const coordinator = new RagCoordinator({
      app: {} as App,
      getSettings: () => ({}) as never,
      getDbManager,
      t: (_key, fallback) => fallback ?? '',
    })

    const first = await coordinator.getRagEngine()
    const second = await coordinator.getRagEngine()

    expect(first).toBe(second)
    expect(getDbManager).toHaveBeenCalledTimes(1)
    expect(mockRAGEngine).toHaveBeenCalledTimes(1)
  })
})
