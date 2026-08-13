/**
 * Web 浏览器侧的 subagent durable session 服务 facade（Task 11 web 接线）。
 *
 * 浏览器进程没有本地会话 store——真实 SubagentSessionService 在服务端
 * （registerWebServerRoutes 的 initWebSubagentSessionRuntime 接线）。本
 * facade 实现 UI 消费面（SubagentCard 的 session 状态行/恢复/resend/drop 与
 * runSubagentSessionAction 的续跑投递）所需的方法，经 /api/subagent/* 转发：
 * - query → GET  /api/subagent/session
 * - recover → POST /api/subagent/recover
 * - resumeAfterRecovery → POST /api/subagent/resume-recovery
 * - queueRecovery → POST /api/subagent/queue-recovery
 * - deliverQueuedIntents → POST /api/subagent/deliver-queued-intents
 *
 * 由 createWebYoloRuntime 经 initWebSubagentSessionService 挂载为进程单例；
 * 类型上以 Pick 子集 + 单点 cast 接入（session-service 内注释同款），运行
 * 时不触碰桌面在进程内才能实现的方法。
 */
import type {
  SubagentQueryOptions,
  SubagentQueueRecoveryInput,
  SubagentQueueRecoveryResult,
  SubagentRecoverInput,
  SubagentRecoverResult,
  SubagentResumeAfterRecoveryResult,
  SubagentSessionSnapshot,
} from '../../core/agent/subagent/session-types'

import type { WebApiClient } from './WebApiClient'

export class WebSubagentSessionService {
  constructor(private readonly api: WebApiClient) {}

  async query(
    sessionId: string,
    _options?: SubagentQueryOptions,
  ): Promise<SubagentSessionSnapshot | null> {
    return this.api.getJsonOrNull<SubagentSessionSnapshot>(
      `/api/subagent/session?sessionId=${encodeURIComponent(sessionId)}`,
    )
  }

  async recover(
    input: SubagentRecoverInput,
  ): Promise<SubagentRecoverResult> {
    return this.api.postJson<SubagentRecoverResult>(
      '/api/subagent/recover',
      input,
    )
  }

  async queueRecovery(
    input: SubagentQueueRecoveryInput,
  ): Promise<SubagentQueueRecoveryResult> {
    return this.api.postJson<SubagentQueueRecoveryResult>(
      '/api/subagent/queue-recovery',
      input,
    )
  }

  async resumeAfterRecovery(
    sessionId: string,
  ): Promise<SubagentResumeAfterRecoveryResult> {
    return this.api.postJson<SubagentResumeAfterRecoveryResult>(
      '/api/subagent/resume-recovery',
      { sessionId },
    )
  }

  async deliverQueuedIntents(sessionId: string): Promise<void> {
    await this.api.postJson<{ ok: boolean }>(
      '/api/subagent/deliver-queued-intents',
      { sessionId },
    )
  }
}
