import type { McpManager } from '../../mcp/mcpManager'
import type { NativeAgentRuntime } from '../native-runtime'

/**
 * Session-level registry that maps a running subagent's `taskId` to its live
 * runtime + the parent-conversation context needed to route approval signals
 * back into it. Used by the approval-routing flow:
 *
 *   1. `runChildAgent` registers an entry on start; unregisters on finalize.
 *   2. While a subagent's tool call is in `PendingApproval`, the SubagentCard
 *      renders an inline approval block whose buttons call into
 *      `AgentService.approveToolCall` / `rejectToolCall`.
 *   3. The service first checks this registry by `toolCallId`; if a match is
 *      found, the approval action targets the subagent's runtime directly —
 *      bypassing the parent-conversation continuation path.
 *
 * See `docs/plans/2026-06-18-subagent-tool-approval-routing.md`.
 */
export type SubagentRuntimeEntry = {
  taskId: string
  runtime: NativeAgentRuntime
  /**
   * The McpManager the subagent runs against (forwarded from the parent
   * context). The service uses this for `callTool` / `allowToolForConversation`
   * during approval handling.
   */
  mcpManager: McpManager
  /** Parent conversation id — used as the approval scope for `mcpManager`. */
  parentConversationId: string
  /** Parent toolCallId hosting this subagent's SubagentCard, for back-refs. */
  parentToolCallId: string
  /**
   * Continue running the subagent loop once every call in the paused parallel
   * batch is settled. Safe to call after each individual decision; the child
   * runner no-ops while another call is pending or running.
   */
  resumeRun: () => Promise<void>
  /** Durable session identity (aligned with backup runtime-registry.ts). */
  sessionId?: string
  runSequence?: number
  runKey?: string
}

export type SubagentRunIdentity = {
  sessionId: string
  runSequence: number
  runKey: string
}

class SubagentRuntimeRegistry {
  private readonly byTaskId = new Map<string, SubagentRuntimeEntry>()
  private readonly bySessionId = new Map<string, SubagentRuntimeEntry>()
  private readonly reservationsByRunKey = new Map<string, SubagentRunIdentity>()
  private readonly reservationRunKeyBySessionId = new Map<string, string>()

  register(entry: SubagentRuntimeEntry): void {
    this.byTaskId.set(entry.taskId, entry)
    this.bySessionId.set(entry.sessionId ?? entry.taskId, entry)
  }

  unregister(taskId: string): void {
    const entry = this.byTaskId.get(taskId)
    this.byTaskId.delete(taskId)
    if (entry) {
      const sessionKey = entry.sessionId ?? taskId
      if (this.bySessionId.get(sessionKey) === entry) {
        this.bySessionId.delete(sessionKey)
      }
    }
  }

  getByTaskId(taskId: string): SubagentRuntimeEntry | undefined {
    return this.byTaskId.get(taskId)
  }

  /**
   * Claim exclusive run ownership for a session before the runtime registers.
   * Throws when the session already has an active (registered or reserved)
   * run. Released with `releaseReservation` once the run settles or fails.
   */
  reserve(identity: SubagentRunIdentity): void {
    if (this.reservationsByRunKey.has(identity.runKey)) {
      throw new Error(`Subagent run ${identity.runKey} is already reserved.`)
    }
    if (
      this.bySessionId.has(identity.sessionId) ||
      this.reservationRunKeyBySessionId.has(identity.sessionId)
    ) {
      throw new Error(
        `Subagent session ${identity.sessionId} already has an active run.`,
      )
    }
    this.reservationsByRunKey.set(identity.runKey, identity)
    this.reservationRunKeyBySessionId.set(
      identity.sessionId,
      identity.runKey,
    )
  }

  /** Release a reservation by run key or session id. No-op when unknown. */
  releaseReservation(runKeyOrSessionId: string): void {
    const runKey = this.reservationsByRunKey.has(runKeyOrSessionId)
      ? runKeyOrSessionId
      : this.reservationRunKeyBySessionId.get(runKeyOrSessionId)
    if (!runKey) return
    const reservation = this.reservationsByRunKey.get(runKey)
    if (!reservation) return
    this.reservationsByRunKey.delete(runKey)
    if (
      this.reservationRunKeyBySessionId.get(reservation.sessionId) === runKey
    ) {
      this.reservationRunKeyBySessionId.delete(reservation.sessionId)
    }
  }

  /**
   * Active (registered) runtime entry for a durable session. Legacy entries
   * without a session id are findable by their task id.
   */
  getActiveForSession(sessionId: string): SubagentRuntimeEntry | undefined {
    return this.bySessionId.get(sessionId)
  }

  /**
   * Find the registry entry whose runtime currently hosts a tool call with
   * this id. Walks each runtime's messages — there are at most a handful of
   * concurrent subagents per session, so an O(N) scan is fine. Returns
   * `undefined` if the toolCallId is not in any subagent's transcript (the
   * caller falls back to the parent-conversation path).
   */
  findByToolCallId(toolCallId: string): SubagentRuntimeEntry | undefined {
    for (const entry of this.byTaskId.values()) {
      if (entry.runtime.findToolCall(toolCallId)) {
        return entry
      }
    }
    return undefined
  }

  list(): SubagentRuntimeEntry[] {
    return [...this.byTaskId.values()]
  }
}

export const subagentRuntimeRegistry = new SubagentRuntimeRegistry()
