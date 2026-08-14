import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import { useMcp } from '../../contexts/mcp-context'
import { usePlugin } from '../../contexts/plugin-context'
import { useSettings } from '../../contexts/settings-context'
import type { Assistant } from '../../types/assistant.types'
import type { ChatMessage } from '../../types/chat'
import {
  type ToolCallRequest,
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

import {
  resolveRecoveryExecutionWorkspaceAccessPolicy,
  useChatDomainActions,
} from './useChatDomainActions'

jest.mock('@tanstack/react-query', () => ({
  useMutation: jest.fn(() => ({ isPending: false, mutate: jest.fn() })),
}))
jest.mock('../../contexts/app-context', () => ({ useApp: jest.fn() }))
jest.mock('../../contexts/language-context', () => ({
  useLanguage: jest.fn(),
}))
jest.mock('../../contexts/mcp-context', () => ({ useMcp: jest.fn() }))
jest.mock('../../contexts/plugin-context', () => ({ usePlugin: jest.fn() }))
jest.mock('../../contexts/settings-context', () => ({
  useSettings: jest.fn(),
}))

const snapshotPolicy = {
  enabled: true,
  workspaceRoot: '04-专利',
  readExtraIncludes: [],
  readExcludes: [],
  writeExcludes: ['04-专利/archive'],
}

const otherPolicy = {
  enabled: true,
  workspaceRoot: '00-Email',
  readExtraIncludes: [],
  readExcludes: [],
  writeExcludes: [],
}

const makeRequest = (
  metadata?: ToolCallRequest['metadata'],
): ToolCallRequest => ({
  id: 'tool-1',
  name: 'yolo_local__bash',
  arguments: createCompleteToolCallArguments({ value: { command: 'ls' } }),
  metadata,
})

const selectedAssistant = {
  id: 'wa-2',
  workspaceAccessPolicy: otherPolicy,
} as unknown as Assistant

describe('resolveRecoveryExecutionWorkspaceAccessPolicy', () => {
  it('runs the approval with the policy snapshot from tool-call creation, not the current assistant', () => {
    // The call was emitted under agent A (snapshotPolicy); the user switched
    // to agent B (otherPolicy) before approving.
    const policy = resolveRecoveryExecutionWorkspaceAccessPolicy({
      chatMode: 'agent',
      request: makeRequest({ workspaceAccessPolicy: snapshotPolicy }),
      selectedAssistant,
    })

    expect(policy).toEqual(snapshotPolicy)
  })

  it('falls back to the live policy composition for historical calls without a snapshot', () => {
    const policy = resolveRecoveryExecutionWorkspaceAccessPolicy({
      chatMode: 'agent',
      request: makeRequest({}),
      selectedAssistant,
    })

    expect(policy).toEqual(otherPolicy)
  })

  it('returns undefined for non-agent chat modes', () => {
    const policy = resolveRecoveryExecutionWorkspaceAccessPolicy({
      chatMode: 'ask',
      request: makeRequest({ workspaceAccessPolicy: snapshotPolicy }),
      selectedAssistant,
    })

    expect(policy).toBeUndefined()
  })
})

describe('useChatDomainActions pending tool recovery', () => {
  it('passes the persisted execution constraints to callTool', async () => {
    const request = makeRequest({
      executionConstraints: {
        bashApprovalMode: 'dangerous_only',
        allowedSkillPaths: ['Skills/review/SKILL.md'],
        bashReadOnly: true,
      },
    })
    const toolMessage = {
      role: 'tool',
      id: 'tool-message-1',
      toolCalls: [
        {
          request,
          response: { status: ToolCallResponseStatus.PendingApproval },
        },
      ],
    } satisfies ChatMessage
    const chatMessagesStateRef = { current: [toolMessage] as ChatMessage[] }
    const callTool = jest.fn().mockResolvedValue({
      status: ToolCallResponseStatus.Success,
      data: { type: 'text', text: 'ok' },
    })
    const agentService = {
      replaceConversationMessages: jest.fn(),
      registerForegroundToolAborter: jest.fn(() => jest.fn()),
      getPendingApprovalSubagentParentContext: jest.fn(),
    }

    jest.mocked(useApp).mockReturnValue({} as never)
    jest.mocked(useLanguage).mockReturnValue({
      language: 'en',
      t: (_key, fallback) => fallback ?? '',
    })
    jest.mocked(useMcp).mockReturnValue({
      getMcpManager: jest.fn().mockResolvedValue({
        callTool,
        abortToolCall: jest.fn(),
        allowToolForConversation: jest.fn(),
      }),
    } as never)
    jest.mocked(usePlugin).mockReturnValue({
      getAgentService: () => agentService,
    } as never)
    jest.mocked(useSettings).mockReturnValue({ settings: {} } as never)

    const actionsRef: {
      current?: ReturnType<typeof useChatDomainActions>
    } = {}
    const HookProbe = () => {
      actionsRef.current = useChatDomainActions({
        chatMessages: chatMessagesStateRef.current,
        chatMessagesStateRef,
        setChatMessages: jest.fn(),
        currentConversationId: 'conversation-1',
        conversationOverrides: null,
        conversationModelId: 'model-1',
        chatMode: 'agent',
        yoloEnabled: false,
        effectiveCompactionState: [],
        setCompactionState: jest.fn(),
        assistantGroupBoundaryMessageIds: [],
        activeBranchByUserMessageIdRef: { current: new Map() },
        messageModelMap: new Map(),
        reasoningLevel: 'off',
        conversationReasoningLevelRef: { current: new Map() },
        selectedAssistant: null,
        setQueryProgress: jest.fn(),
        setUndoingEditSummaryTarget: jest.fn(),
        activeApplyRequestKey: null,
        setActiveApplyRequestKey: jest.fn(),
        applyAbortControllerRef: { current: null },
        forceScrollToBottom: jest.fn(),
        runtimeNavigationGenerationRef: { current: 0 },
        getEditorViewForFile: jest.fn(() => null),
        persistConversationImmediately: jest.fn().mockResolvedValue(true),
        normalizeAssistantGroupBoundaryMessageIds: jest.fn(() => []),
        serializeMessageModelMap: jest.fn(),
        createOrUpdateConversation: jest.fn(),
        generateConversationTitle: jest.fn(),
        submitChatMutation: { mutate: jest.fn() } as never,
        abortConversationRun: jest.fn(),
        requestContextBuilder: {} as never,
        chatManager: {} as never,
        normalizeReasoningLevel: jest.fn(() => null),
      })
      return null
    }

    renderToStaticMarkup(React.createElement(HookProbe))
    const renderedActions = actionsRef.current
    if (!renderedActions) {
      throw new Error('Hook probe did not render')
    }
    await renderedActions.handleRecoverPendingToolCall({
      conversationId: 'conversation-1',
      toolMessageId: toolMessage.id,
      request,
    })

    expect(callTool).toHaveBeenCalledWith(
      expect.objectContaining({
        bashApprovalMode: 'dangerous_only',
        allowedSkillPaths: ['Skills/review/SKILL.md'],
        bashReadOnly: true,
      }),
    )
  })
})
