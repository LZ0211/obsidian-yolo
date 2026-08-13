import * as React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { SubagentSessionSnapshot } from '../../../core/agent/subagent/session-types'
import type { SubagentTaskSummary } from '../../../core/agent/subagent/types'
import { SUBAGENT_SESSION_STATUS } from '../../../core/state/statuses'

import {
  buildSubagentCardSessionProps,
  formatQueuedIntentLine,
  formatSessionStatus,
  runSubagentSessionAction,
} from './subagentCardUtils'
import { SubagentCardView } from './SubagentCardView'

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

jest.mock('clsx', () => ({
  __esModule: true,
  default: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

jest.mock('./SubagentDetailModal', () => ({
  SubagentDetailModal: () => null,
}))

// runSubagentSessionAction 经动态 import 取 session-service（与 main.ts 同款
// 避免静态边），测试侧 mock 掉整个模块：既避免 node env 加载 obsidian，也
// 让 deliverQueuedIntents 调用可断言。
const mockedDeliverQueuedIntents = jest.fn(async () => undefined)
jest.mock('../../../core/agent/subagent/session-service', () => ({
  getSubagentSessionService: () => ({
    deliverQueuedIntents: mockedDeliverQueuedIntents,
  }),
}))

const t = (_key: string, fallback?: string): string => fallback ?? ''

const taskRecord = (overrides: Partial<SubagentTaskSummary> = {}) =>
  ({
    taskId: 'sub_abc123',
    sessionId: 'sub_abc123',
    runSequence: 2,
    mode: 'persistent',
    status: 'running',
    createdAt: 1,
    prompt: 'prompt',
    abortController: undefined,
    ...overrides,
  }) as SubagentTaskSummary

const snapshot = (
  overrides: Partial<SubagentSessionSnapshot> = {},
): SubagentSessionSnapshot => ({
  session: {
    sessionId: 'sub_abc123',
    parentConversationId: 'conv-1',
    originAssistantMessageId: 'assistant-1',
    originToolCallId: 'tool-1',
    title: 'Count files',
    mode: 'persistent',
    status: SUBAGENT_SESSION_STATUS.RUNNING,
    revision: 3,
    nextRunSequence: 3,
    memoryAssistantId: 'yolo',
    createdAt: 1,
    lastActiveAt: 2,
  },
  recentRuns: [],
  ...overrides,
})

describe('formatQueuedIntentLine', () => {
  it('formats a queued intent line for the detail modal', () => {
    expect(formatQueuedIntentLine({ text: 'hello', state: 'pending' })).toBe(
      'pending · hello',
    )
  })

  it('keeps recovery-required state visible in the line', () => {
    expect(
      formatQueuedIntentLine({
        text: 'Count vault files',
        state: 'recovery_required',
      }),
    ).toBe('recovery_required · Count vault files')
  })
})

describe('formatSessionStatus', () => {
  it('maps every session status to an i18n label', () => {
    expect(formatSessionStatus(SUBAGENT_SESSION_STATUS.IDLE, t)).toBe('Idle')
    expect(formatSessionStatus(SUBAGENT_SESSION_STATUS.RUNNING, t)).toBe(
      'Running',
    )
    expect(formatSessionStatus(SUBAGENT_SESSION_STATUS.CLOSING, t)).toBe(
      'Closing',
    )
    expect(formatSessionStatus(SUBAGENT_SESSION_STATUS.NEEDS_RESUME, t)).toBe(
      'Needs resume',
    )
    expect(formatSessionStatus(SUBAGENT_SESSION_STATUS.ORPHANED, t)).toBe(
      'Orphaned',
    )
    expect(formatSessionStatus(SUBAGENT_SESSION_STATUS.ARCHIVED, t)).toBe(
      'Archived',
    )
  })
})

describe('buildSubagentCardSessionProps', () => {
  it('returns no session props when there is no snapshot', () => {
    expect(buildSubagentCardSessionProps(null, taskRecord(), t)).toEqual({})
  })

  it('returns no session props when the task record has no session', () => {
    expect(
      buildSubagentCardSessionProps(
        snapshot(),
        taskRecord({ sessionId: undefined }),
        t,
      ),
    ).toEqual({})
  })

  it('ignores a snapshot that belongs to a different session', () => {
    expect(
      buildSubagentCardSessionProps(
        snapshot({
          session: {
            ...snapshot().session,
            sessionId: 'sub_other',
          },
        }),
        taskRecord(),
        t,
      ),
    ).toEqual({})
  })

  it('maps session status, queued count and queued messages', () => {
    const props = buildSubagentCardSessionProps(
      snapshot({
        session: {
          ...snapshot().session,
          status: SUBAGENT_SESSION_STATUS.IDLE,
        },
        intents: [
          {
            requestId: 'req-1',
            sessionId: 'sub_abc123',
            messageId: 'msg-1',
            text: 'hello',
            delivery: 'after_run',
            state: 'pending',
            createdAt: 10,
          },
          {
            requestId: 'req-2',
            sessionId: 'sub_abc123',
            messageId: 'msg-2',
            text: 'Count vault files',
            delivery: 'after_run',
            state: 'recovery_required',
            createdAt: 20,
          },
          {
            requestId: 'req-3',
            sessionId: 'sub_abc123',
            messageId: 'msg-3',
            text: 'already delivered',
            delivery: 'after_run',
            state: 'committed',
            createdAt: 30,
          },
        ],
      }),
      taskRecord(),
      t,
    )

    expect(props).toEqual({
      sessionStatus: 'Idle',
      queuedCount: 2,
      needsResume: false,
      queuedMessages: [
        { messageId: 'msg-1', text: 'hello', state: 'pending' },
        {
          messageId: 'msg-2',
          text: 'Count vault files',
          state: 'recovery_required',
        },
      ],
      recoveryRequired: true,
    })
  })

  it('flags needsResume for a needs_resume session', () => {
    const props = buildSubagentCardSessionProps(
      snapshot({
        session: {
          ...snapshot().session,
          status: SUBAGENT_SESSION_STATUS.NEEDS_RESUME,
        },
      }),
      taskRecord(),
      t,
    )
    expect(props.needsResume).toBe(true)
    expect(props.sessionStatus).toBe('Needs resume')
  })
})

describe('runSubagentSessionAction', () => {
  let warnSpy: jest.SpyInstance

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    mockedDeliverQueuedIntents.mockClear()
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('refreshes after an accepted action without warning', async () => {
    const onSettled = jest.fn()
    await runSubagentSessionAction(
      'recover',
      Promise.resolve({ accepted: true, status: 'idle', sessionRevision: 2 }),
      onSettled,
      'sub_abc123',
    )
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()
  })

  it('does not deliver queued intents after an accepted recover (R14: resumeAfterRecovery delivers internally)', async () => {
    // recover 的一键恢复走 service.resumeAfterRecovery——内部完成
    // RECOVERY_REQUIRED → PENDING 的 CAS 写 + 投递；此处不再二次投递，
    // 避免 onIntentRunRequested 在续跑 beginRun 前双触发
    await runSubagentSessionAction(
      'recover',
      Promise.resolve({ accepted: true, recovered: 1, sessionRevision: 2 }),
      jest.fn(),
      'sub_abc123',
    )
    expect(mockedDeliverQueuedIntents).not.toHaveBeenCalled()
  })

  it('delivers queued intents after an accepted resend', async () => {
    await runSubagentSessionAction(
      'resend',
      Promise.resolve({
        accepted: true,
        state: 'pending',
        sessionRevision: 2,
      }),
      jest.fn(),
      'sub_abc123',
    )
    expect(mockedDeliverQueuedIntents).toHaveBeenCalledWith('sub_abc123')
  })

  it('does not deliver queued intents after a drop', async () => {
    await runSubagentSessionAction(
      'drop',
      Promise.resolve({
        accepted: true,
        state: 'dropped',
        sessionRevision: 2,
      }),
      jest.fn(),
      'sub_abc123',
    )
    expect(mockedDeliverQueuedIntents).not.toHaveBeenCalled()
  })

  it('does not throw when queued intent delivery itself fails', async () => {
    mockedDeliverQueuedIntents.mockRejectedValueOnce(new Error('read failed'))
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const onSettled = jest.fn()
    await expect(
      runSubagentSessionAction(
        'resend',
        Promise.resolve({
          accepted: true,
          state: 'pending',
          sessionRevision: 2,
        }),
        onSettled,
        'sub_abc123',
      ),
    ).resolves.toBeUndefined()
    expect(onSettled).toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledWith(
      '[YOLO] Subagent queued intent delivery failed',
      expect.objectContaining({ sessionId: 'sub_abc123' }),
    )
    warnSpy.mockRestore()
  })

  it('warns with the errorCode on rejection and still refreshes', async () => {
    const onSettled = jest.fn()
    await runSubagentSessionAction(
      'drop',
      Promise.resolve({
        accepted: false,
        errorCode: 'revision_conflict',
        retryable: true,
        current: snapshot(),
      }),
      onSettled,
      'sub_abc123',
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[YOLO] Subagent session action rejected',
      { action: 'drop', errorCode: 'revision_conflict', retryable: true },
    )
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(mockedDeliverQueuedIntents).not.toHaveBeenCalled()
  })

  it('warns when the action call itself fails and still refreshes', async () => {
    const onSettled = jest.fn()
    await runSubagentSessionAction(
      'resend',
      Promise.reject(new Error('store read failed')),
      onSettled,
      'sub_abc123',
    )
    expect(warnSpy).toHaveBeenCalledWith(
      '[YOLO] Subagent session action failed',
      expect.objectContaining({ action: 'resend' }),
    )
    expect(onSettled).toHaveBeenCalledTimes(1)
    expect(mockedDeliverQueuedIntents).not.toHaveBeenCalled()
  })
})

describe('SubagentCardView session line smoke', () => {
  it('renders session status and queued count into the card markup', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubagentCardView, {
        title: 'Count files',
        subtitle: 'Planning next moves',
        status: 'running',
        sessionStatus: 'Needs resume',
        queuedCount: 2,
        needsResume: true,
        queuedMessages: [
          { messageId: 'msg-1', text: 'hello', state: 'pending' },
          {
            messageId: 'msg-2',
            text: 'Count vault files',
            state: 'recovery_required',
          },
        ],
        onRecover: () => {},
        onQueueResend: () => {},
        onQueueDrop: () => {},
      }),
    )
    expect(markup).toContain('yolo-subagent-card__session-status')
    expect(markup).toContain('Needs resume')
    expect(markup).toContain('yolo-subagent-card__session-queued')
    expect(markup).toContain('2 queued')
  })

  it('renders no session line when no session props are provided', () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubagentCardView, {
        title: 'Count files',
        subtitle: 'No activity yet.',
        status: 'dispatched',
      }),
    )
    expect(markup).not.toContain('yolo-subagent-card__session')
  })
})
