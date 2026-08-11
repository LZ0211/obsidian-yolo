import type { ChatConversationMetadata } from '../database/json/chat/types'
import type { WebChatBinding } from '../runtime/web/webConversationTypes'

import type { AllowedAgent } from './webShellTypes'

// master 的 ChatConversationMetadata 无 webBinding 字段（backup 的
// ChatWebBinding 由 web 会话记录持有）；mock 传输在本地扩一份，保持
// canUseWebConversation 过滤语义与生产一致。
export type MockChatConversationMetadata = ChatConversationMetadata & {
  webBinding?: WebChatBinding | null
}

export const MOCK_ALLOWED_AGENTS: AllowedAgent[] = [
  { id: 'mock-agent', name: 'Mock Agent' },
  { id: 'review-agent', name: 'Review Agent' },
]

const DAY = 24 * 60 * 60 * 1000
const base = (offsetMs: number) => Date.now() - offsetMs

// webBinding tags so listChats can filter by the session's active agent
// (matching the production /api/chat/list which gates on
// webBinding.activeAgentId; see canUseWebConversation in
// registerWebServerRoutes.ts). conv-11 carries an 'orphaned' binding so the
// filter exercises that branch too. conv-12 has no binding at all (legacy
// chat) and stays hidden under web semantics.
const MOCK_ROOT_HASH = 'mock-root'
const bindFor = (agentId: 'mock-agent' | 'review-agent'): WebChatBinding => ({
  initialAgentId: agentId,
  activeAgentId: agentId,
  rootHash: MOCK_ROOT_HASH,
  accessState: 'active',
})

export const MOCK_CHAT_LIST: MockChatConversationMetadata[] = [
  {
    id: 'conv-1',
    title: 'Stage 5-7 shell review',
    updatedAt: base(2 * 60 * 60 * 1000),
    schemaVersion: 1,
    isPinned: true,
    pinnedAt: base(2 * 60 * 60 * 1000),
    webBinding: bindFor('mock-agent'),
  },
  {
    id: 'conv-2',
    title: 'Preview pane spacing',
    updatedAt: base(5 * 60 * 60 * 1000),
    schemaVersion: 1,
    webBinding: bindFor('mock-agent'),
  },
  {
    id: 'conv-3',
    title: 'File tree indent fix',
    updatedAt: base(26 * 60 * 60 * 1000),
    schemaVersion: 1,
    webBinding: bindFor('review-agent'),
  },
  {
    id: 'conv-4',
    title: 'Auth modal centering',
    updatedAt: base(3 * DAY),
    schemaVersion: 1,
    webBinding: bindFor('mock-agent'),
  },
  {
    id: 'conv-5',
    title: 'History pane grouping',
    updatedAt: base(6 * DAY),
    schemaVersion: 1,
    webBinding: bindFor('review-agent'),
  },
  {
    id: 'conv-6',
    title: 'Tab close button icon',
    updatedAt: base(10 * DAY),
    schemaVersion: 1,
    webBinding: bindFor('mock-agent'),
  },
  {
    id: 'conv-7',
    title: 'Mock server port cleanup',
    updatedAt: base(18 * DAY),
    schemaVersion: 1,
    webBinding: bindFor('review-agent'),
  },
  {
    id: 'conv-8',
    title: 'Web runtime bootstrap',
    updatedAt: base(28 * DAY),
    schemaVersion: 1,
    webBinding: bindFor('mock-agent'),
  },
  {
    id: 'conv-9',
    title: 'Agent service shim',
    updatedAt: base(40 * DAY),
    schemaVersion: 1,
    webBinding: bindFor('mock-agent'),
  },
  {
    id: 'conv-10',
    title: 'Initial chat mount',
    updatedAt: base(70 * DAY),
    schemaVersion: 1,
    webBinding: bindFor('review-agent'),
  },
  {
    id: 'conv-11',
    title: 'Sidebar ribbon layout (orphaned)',
    updatedAt: base(95 * DAY),
    schemaVersion: 1,
    webBinding: {
      initialAgentId: 'mock-agent',
      activeAgentId: 'mock-agent',
      rootHash: MOCK_ROOT_HASH,
      accessState: 'orphaned',
      orphanedReason: 'agent_deleted',
    },
  },
  {
    id: 'conv-12',
    title: 'Old archive note (no binding)',
    updatedAt: base(400 * DAY),
    schemaVersion: 1,
  },
]

/** Build a deterministic user/assistant pair for long timeline browser QA. */
export function buildMockLongTimelineMessages(
  turns: number,
): Array<Record<string, unknown>> {
  const count = Math.max(0, Math.min(500, Math.trunc(turns)))
  const messages: Array<Record<string, unknown>> = []
  for (let turn = 1; turn <= count; turn += 1) {
    const suffix = String(turn).padStart(3, '0')
    messages.push({
      role: 'user',
      id: `timeline-u-${suffix}`,
      content: null,
      promptContent: `Review timeline turn ${turn} and confirm the next implementation step.`,
      mentionables: [],
      selectedSkills: [],
      selectedModelIds: [],
    })

    const longContent = turn % 10 === 0
    messages.push({
      role: 'assistant',
      id: `timeline-a-${suffix}`,
      content: longContent
        ? `## Timeline turn ${turn}\n\nThis deterministic fixture exercises long Markdown rendering.\n\n\`\`\`ts\nexport function timelineTurn${turn}(): string {\n  return 'timeline-${suffix}'\n}\n\`\`\`\n\n- Stable message id: timeline-a-${suffix}\n- Repeated content keeps browser measurements comparable.`
        : `Timeline turn ${turn} acknowledged. The mock response remains deterministic for browser measurements.`,
      metadata: { generationState: 'completed', durationMs: 1000 + turn },
    })
  }
  return messages
}
