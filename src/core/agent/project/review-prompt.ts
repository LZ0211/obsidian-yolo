import type { TaskRecord } from './types'

export type ReviewPromptInput = {
  task: TaskRecord
  body: string
  delivery: string
  history: string
}

/**
 * Composes the prompt for an independent reviewer subagent. The reviewer must
 * not mutate project state; it returns a strict structured verdict that the
 * parent records via the project_review tool.
 */
export const buildReviewPrompt = ({
  task,
  body,
  delivery,
  history,
}: ReviewPromptInput): string =>
  [
    `# Review task: ${task.taskId} — ${task.title}`,
    `Status: ${task.status}`,
    '',
    task.acceptanceCriteria.length > 0
      ? `## Acceptance criteria\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}`
      : null,
    body ? `## Task background\n\n${body}` : null,
    delivery ? `## Delivered work\n\n${delivery}` : null,
    history ? `## Prior review history\n\n${history}` : null,
    '',
    '## Review instructions',
    'Independently verify the delivered work against the acceptance criteria. You are a reviewer, not an implementer — do not change files.',
    'Return ONLY a strict structured verdict in this exact shape:',
    '```',
    'decision: approved | rework | escalated',
    'findings:',
    '  - reference: <file or test or claim being checked>',
    '    summary: <what you verified and the result>',
    '    confidence: <high | medium | low>',
    'comments:',
    '  - <actionable comment>',
    '```',
    'Rules:',
    '- `approved` requires concrete verification evidence in findings.',
    '- `rework` requires at least one actionable comment.',
    '- `escalated` means the work needs human judgment beyond the criteria.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n\n')
