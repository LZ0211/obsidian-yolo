import type { App } from 'obsidian'

import { RagCoordinator } from './ragCoordinator'

describe('RagCoordinator ready capability', () => {
  it('does not initialize while reading readiness', () => {
    const coordinator = new RagCoordinator({
      app: {} as App,
      getSettings: () => ({}) as never,
      getDbManager: jest.fn(),
      t: (_key, fallback) => fallback ?? '',
    })

    expect(coordinator.getReadyRagEngine()).toBeNull()
    expect(coordinator.getWarmupState()).toBe('not_started')
  })
})
