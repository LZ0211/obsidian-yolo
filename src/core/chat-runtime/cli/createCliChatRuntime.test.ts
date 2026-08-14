import type { CliRuntimeScope } from '../../cli-runtime/coordinator'
import type { CliRuntime, CliSessionRef } from '../../cli-runtime/types'

import { createCliChatRuntime } from './createCliChatRuntime'

describe('createCliChatRuntime session commands', () => {
  test('hydrates the selected controller instead of only changing coordinator selection', async () => {
    const ref: CliSessionRef = {
      runtimeId: 'codex',
      nativeSessionId: 'thread-1',
    }
    const hydrateSession = jest.fn(async (sessionRef: CliSessionRef) => ({
      ref: sessionRef,
      messages: [],
      compactionBoundaries: [],
    }))
    const controller = {
      getSnapshot: () => ({
        surfaceId: 'surface-1',
        conversationEpoch: 0,
        messages: [],
        sessionRef: null,
        runState: 'idle',
        error: null,
        configuration: null,
      }),
      getConversationEpoch: () => 0,
      subscribe: () => () => undefined,
      hydrateSession,
      ensureReady: async () => undefined,
      sendTurn: async () => undefined,
      rewriteTurn: async () => undefined,
      cancel: async () => undefined,
      respondApproval: async () => undefined,
      respondQuestion: async () => undefined,
    }
    const configuration = {
      models: [],
      modelId: null,
      reasoningEffort: null,
    }
    const runtime: CliRuntime = {
      runtimeId: 'codex',
      ensureReady: async () => undefined,
      openSession: async (sessionRef) => ({
        ref: sessionRef,
        messages: [],
        compactionBoundaries: [],
      }),
      getConfiguration: async () => configuration,
      updateConfiguration: async () => configuration,
      sendTurn: async () => undefined,
      rewriteTurn: async () => undefined,
      cancel: async () => undefined,
      respondApproval: async () => true,
      respondQuestion: async () => true,
      subscribe: () => () => undefined,
      dispose: async () => undefined,
    }
    const scope = {
      sessionService: {},
      chatRuntimeActions: {},
      resolveRuntime: () => runtime,
      selectConversationRuntime: () => controller,
      createConversationRuntime: () => controller,
      selectConversationSession: jest.fn(() => controller),
      getModelCatalogSnapshot: () => new Map(),
      subscribeToModelCatalog: () => () => undefined,
      warmModelCatalog: async () => undefined,
      warmConversationRuntime: async () => undefined,
      dispose: async () => undefined,
    } as unknown as CliRuntimeScope

    const chatRuntime = await createCliChatRuntime(scope, 'codex')

    await expect(chatRuntime.openSession(ref)).resolves.toEqual({ ok: true })
    expect(scope.selectConversationSession).toHaveBeenCalledWith(ref)
    expect(hydrateSession).toHaveBeenCalledWith(ref)
    await chatRuntime.dispose()
  })
})
