import type {
  ChatCommandResult,
  ChatRuntime,
} from '../../core/chat-runtime/contract'
import type {
  ChatRuntimeActionResult,
  ChatRuntimeActions,
  ChatRuntimeQuestionActionResult,
} from '../../core/cli-runtime'

const HANDLED = { kind: 'handled' } as const
const STALE = { kind: 'stale' } as const

const toActionResult = (result: ChatCommandResult): ChatRuntimeActionResult =>
  result.ok ? HANDLED : STALE

/**
 * 把 Task 4 的契约 ChatRuntime（Web 端由组装层经 buildRuntime 注入，
 * RemoteChatRuntimeAdapter 背书）适配成 master 主面消费的 ChatRuntimeActions。
 *
 * 语义对齐 backup NativeChatRuntimeAdapter 的契约命令映射（requestId 即
 * toolCallId；cancel(requestId?) 按 requestId 命中模式分发）：
 * - cancelRun        → cancel()（缺省整轮取消）
 * - approveTool      → respondApproval(approve_once / approve_for_session)
 * - rejectTool       → respondApproval(reject)
 * - abortTool        → cancel(toolCallId)（命中 tool call 走 abortToolCall）
 * - answerQuestion   → respondQuestion（answer 透传 payload）
 * - cancelQuestion   → cancel(toolCallId)（命中 question 走 cancelAskUserQuestion）
 *
 * readSubagent/watchSubagent 省略（actions 面可选成员，web yolo 面不消费）。
 * conversation 入参不使用：注入的契约 runtime 在组装层按会话绑定，命令天然
 * 落在绑定会话上（与 createYoloChatRuntimeActions 按 ConversationRef 取
 * conversationId 的桌面路径语义等价）。
 */
export const adaptContractRuntimeToActions = (
  runtime: ChatRuntime,
): ChatRuntimeActions => ({
  async cancelRun() {
    await runtime.cancel()
  },

  async approveTool(action) {
    return toActionResult(
      await runtime.respondApproval({
        requestId: action.toolCallId,
        decision: action.allowForConversation
          ? 'approve_for_session'
          : 'approve_once',
      }),
    )
  },

  async rejectTool(action) {
    return toActionResult(
      await runtime.respondApproval({
        requestId: action.toolCallId,
        decision: 'reject',
      }),
    )
  },

  async abortTool(action) {
    return toActionResult(await runtime.cancel(action.toolCallId))
  },

  async answerQuestion(action): Promise<ChatRuntimeQuestionActionResult> {
    return toActionResult(
      await runtime.respondQuestion({
        requestId: action.toolCallId,
        answer: action.payload,
      }),
    )
  },

  async cancelQuestion(action) {
    return toActionResult(await runtime.cancel(action.toolCallId))
  },
})
