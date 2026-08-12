import { useEffect, useState } from 'react'

import { getSubagentSessionService } from '../core/agent/subagent/session-service'
import type { SubagentSessionSnapshot } from '../core/agent/subagent/session-types'

/**
 * 一次性拉取 durable session snapshot（Task 10）。会话服务无订阅机制
 * （query 是一次读），所以调用方传入 refreshKey（如 registry status/run
 * 序号变化）触发重查；无 service（宿主未初始化）或查不到时返回 null。
 */
export function useSubagentSessionSnapshot(
  sessionId: string | undefined,
  refreshKey?: unknown,
): SubagentSessionSnapshot | null {
  const [snapshot, setSnapshot] = useState<SubagentSessionSnapshot | null>(null)

  useEffect(() => {
    let cancelled = false
    setSnapshot(null)
    if (!sessionId) return
    const service = getSubagentSessionService()
    if (!service) return
    void service.query(sessionId).then((result) => {
      if (!cancelled && result) setSnapshot(result)
    })
    return () => {
      cancelled = true
    }
  }, [sessionId, refreshKey])

  return snapshot
}
