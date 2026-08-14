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
    const respondApproval = jest.fn(async () => undefined)
    const respondQuestion = jest.fn(async () => undefined)
    const updateConfiguration = jest.fn(async () => configuration)
    const updatePermissionProfile = jest.fn(async () => undefined)
    const setSessionTitle = jest.fn(async () => undefined)
    const readSubagent = jest.fn(async () => [])
    const unsubscribeController = jest.fn()
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
      subscribe: () => unsubscribeController,
      hydrateSession,
      ensureReady: async () => undefined,
      sendTurn: async () => undefined,
      rewriteTurn: async () => undefined,
      cancel: async () => undefined,
      respondApproval,
      respondQuestion,
      updateConfiguration,
      updatePermissionProfile,
      setSessionTitle,
      readSubagent,
    }
    const configuration = {
      models: [],
      modelId: null,
      reasoningEffort: null,
    }
    const globalRespondApproval = jest.fn(async () => true)
    const globalRespondQuestion = jest.fn(async () => true)
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
      respondApproval: globalRespondApproval,
      respondQuestion: globalRespondQuestion,
      subscribe: () => () => undefined,
      dispose: async () => undefined,
    }
    const selectConversationRuntime = jest.fn(() => controller)
    const scope = {
      sessionService: {},
      chatRuntimeActions: {},
      resolveRuntime: () => runtime,
      selectConversationRuntime,
      createConversationRuntime: () => controller,
      selectConversationSession: jest.fn(() => controller),
      getModelCatalogSnapshot: () => new Map(),
      subscribeToModelCatalog: () => () => undefined,
      warmModelCatalog: async () => undefined,
      warmConversationRuntime: async () => undefined,
      dispose: async () => undefined,
    } as unknown as CliRuntimeScope

    const chatRuntime = await createCliChatRuntime(scope, 'codex', {
      workingDirectory: '/Projects/foo',
    })

    await expect(chatRuntime.openSession(ref)).resolves.toEqual({ ok: true })
    expect(selectConversationRuntime).toHaveBeenCalledWith('codex', {
      workingDirectory: '/Projects/foo',
    })
    expect(scope.selectConversationSession).toHaveBeenCalledWith(ref, {
      workingDirectory: '/Projects/foo',
    })
    expect(hydrateSession).toHaveBeenCalledWith(ref)

    await chatRuntime.respondApproval({
      requestId: 'approval-1',
      decision: 'approve_once',
    })
    await chatRuntime.respondQuestion({
      requestId: 'question-1',
      answer: 'yes',
    })
    await chatRuntime.updateConfiguration({ modelId: 'gpt-5' })
    await chatRuntime.updatePermissionProfile({
      mode: 'agent',
      yoloEnabled: false,
    })
    await chatRuntime.setSessionTitle(ref, 'Renamed')
    await chatRuntime.readSubagent({
      parentSessionRef: ref,
      toolCallId: 'tool-1',
      subagentId: 'subagent-1',
    })

    expect(respondApproval).toHaveBeenCalledWith({
      requestId: 'approval-1',
      decision: 'approve_once',
    })
    expect(respondQuestion).toHaveBeenCalledWith({
      requestId: 'question-1',
      answer: 'yes',
    })
    expect(updateConfiguration).toHaveBeenCalledWith({ modelId: 'gpt-5' })
    expect(updatePermissionProfile).toHaveBeenCalledWith({
      mode: 'agent',
      yoloEnabled: false,
    })
    expect(setSessionTitle).toHaveBeenCalled()
    expect(readSubagent).toHaveBeenCalled()
    expect(globalRespondApproval).not.toHaveBeenCalled()
    expect(globalRespondQuestion).not.toHaveBeenCalled()
    await chatRuntime.dispose()
    expect(unsubscribeController).toHaveBeenCalledTimes(1)
  })
})
