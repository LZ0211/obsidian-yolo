import { useCallback, useEffect, useState } from 'react'

import { getSubagentSessionService } from '../core/agent/subagent/session-service'
import type { SubagentSessionSnapshot } from '../core/agent/subagent/session-types'

/**
 * 拉取 durable session snapshot（Task 10）。会话服务无订阅机制（query 是
 * 一次读），所以调用方传入 refreshKey（如 registry status/run 序号变化）
 * 触发重查；`refresh()` 由动作回调在 settle 后主动调用（恢复/resend/drop
 * 只改 store，registry 不感知，必须手动重查刷新恢复条/queued 按钮）。
 * 无 service（宿主未初始化）或查不到时返回 null。
 *
 * 返回 `[snapshot, refresh]`。refreshKey 变化时保留旧快照直到新结果到达
 * （避免状态行闪烁）；仅 sessionId 变化才清空旧快照；query 读 I/O 失败时
 * console.warn 记录且保留上次快照（不产生 unhandled rejection）。
 */
export function useSubagentSessionSnapshot(
  sessionId: string | undefined,
  refreshKey?: unknown,
): [SubagentSessionSnapshot | null, () => void] {
  const [snapshot, setSnapshot] = useState<SubagentSessionSnapshot | null>(null)
  const [tick, setTick] = useState(0)
  const refresh = useCallback(() => setTick((current) => current + 1), [])

  useEffect(() => {
    let cancelled = false
    // 仅 sessionId 变化时清空旧快照；refreshKey/tick 变化保留旧快照直到
    // 新结果到达（状态行/恢复条不闪烁）。
    setSnapshot((previous) =>
      previous !== null && previous.session.sessionId === sessionId
        ? previous
        : null,
    )
    if (!sessionId) return
    const service = getSubagentSessionService()
    if (!service) return
    void service
      .query(sessionId)
      .then((result) => {
        if (cancelled) return
        setSnapshot(result)
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // store 读 I/O 失败：不静默，保留上次快照（视觉不闪断）。
        console.warn('[YOLO] Subagent session snapshot query failed', {
          sessionId,
          error,
        })
      })
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshKey, tick])

  return [snapshot, refresh]
}
