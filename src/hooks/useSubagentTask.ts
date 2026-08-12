import { useSyncExternalStore } from 'react'

import { subagentTaskRegistry } from '../core/agent/subagent/task-registry'
import type { SubagentTaskSummary } from '../core/agent/subagent/types'
import type { ChatMessage } from '../types/chat'

export function useSubagentTask(
  taskId: string | undefined,
): SubagentTaskSummary | null {
  return useSyncExternalStore(
    (onStoreChange) => subagentTaskRegistry.subscribe(() => onStoreChange()),
    () => (taskId ? (subagentTaskRegistry.get(taskId) ?? null) : null),
    () => null,
  )
}

/**
 * 运行中的实时 transcript（registry 侧 map 旁路，Task 10 C1 恢复）。
 * 索引摘要不携带 liveTranscript（summary 形态），但 runner 仍按每次运行时
 * 快照推送——此 hook 让 SubagentCard 恢复审批块/实时摘要/详情弹窗镜像。
 */
export function useSubagentLiveTranscript(
  taskId: string | undefined,
): readonly ChatMessage[] | undefined {
  return useSyncExternalStore(
    (onStoreChange) => subagentTaskRegistry.subscribe(() => onStoreChange()),
    () => (taskId ? subagentTaskRegistry.getLiveTranscript(taskId) : undefined),
    () => undefined,
  )
}
