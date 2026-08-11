/**
 * 统一 Chat 运行时契约（host-internal，v1）。
 *
 * UI 与后端之间的唯一依赖面：UI 只订阅事件、只调用命令、只按能力声明渲染；
 * 后端差异由 adapter 翻译，不允许 UI 出现按 runtimeId 的隐式分支。
 *
 * 权威归属（adapter 必须遵守，UI 不持久化、不对账消息 ID）：
 * - Native adapter：gateway 持久状态为 canonical，活跃 runtime overlay 只覆盖
 *   status 与增量消息；持久化后由 gateway 事件回填。
 * - CLI adapter：乐观消息 + provider ID 对账（乐观 ID → 原生 ID 替换）；
 *   持久化由现有 session overlay/journal 负责。
 * - stale revision 由提交 handle 的 rejected(retryable) 表达。
 */

/**
 * 契约扩展权（P1 约定）：
 * - fork 主面交互语义（ChatTurnInput 的 mode/continuation，见 Task 4）允许扩展，
 *   走显式评审；形状守卫（contract.test.ts）会拦截一切意外变化。
 * - 上游演进而来的数据不允许进类型化字段——在 adapter 内翻译成既有形状
 *   （deriveNativeRunSummaryFromSnapshot 为范式），或留在呈现层 preset。
 */

import { v4 as uuidv4 } from 'uuid'

import type {
  ChatConversationCompaction,
  ChatConversationCompactionLike,
  ChatMessage,
} from '../../types/chat'
import type { ContentPart } from '../../types/llm/request'
import type { Mentionable } from '../../types/mentionable'
import type { ReasoningLevel } from '../../types/reasoning'
import type { ToolCallRequest } from '../../types/tool-call.types'

export type ChatRuntimeId = 'yolo' | 'claude-code' | 'codex'

export type ChatCapabilityId =
  | 'hostHistory'
  | 'providerSessions'
  | 'agentPlanMode'
  | 'approvalFlow'
  | 'subagents'
  | 'skills'
  | 'modelConfig'
  | 'reasoningEffort'
  | 'compaction'
  | 'contextUsage'
  | 'rewrite'
  | 'sessionPin'
  | 'compact'
  | 'mcpSharing'
  | 'moa'
  | 'commands'
  /** 表面是否为 provider 原生 CLI 会话面（native 为 false，CLI adapter 为 true）。 */
  | 'cliSurface'

export type ChatTransport = 'local' | 'remote'

export type ChatCapabilityState<TInfo extends object = object> = Readonly<
  { supported: true; info?: TInfo } | { supported: false; reason?: string }
>

export type ChatRuntimeCapabilities = Readonly<{
  transport: ChatTransport
  hostHistory: ChatCapabilityState<{ source: 'gateway' }>
  providerSessions: ChatCapabilityState<{ scope: 'provider-native' }>
  agentPlanMode: ChatCapabilityState
  approvalFlow: ChatCapabilityState
  subagents: ChatCapabilityState
  skills: ChatCapabilityState
  modelConfig: ChatCapabilityState
  reasoningEffort: ChatCapabilityState
  compaction: ChatCapabilityState
  contextUsage: ChatCapabilityState
  rewrite: ChatCapabilityState
  sessionPin: ChatCapabilityState
  compact: ChatCapabilityState
  mcpSharing: ChatCapabilityState<{
    transports: readonly ('http' | 'ws' | 'sse')[]
  }>
  /** 运行时是否支持 MoA（多模型聚合）命令解析与执行。 */
  moa: ChatCapabilityState<{ commands?: readonly string[] }>
  /**
   * 运行时斜杠命令注册表：UI 的 `/` 菜单与提交前解析按此声明驱动。
   * CLI 运行时命令为 provider 原生（列表后续经 `CliRuntime.listSlashCommands`
   * 填充），v1 先声明 supported + 空列表。
   */
  commands: ChatCapabilityState<{ commands: readonly ChatSlashCommand[] }>
  /** 表面形态：CLI 运行时渲染 CliSurfaceBody，native 走能力块组合渲染。 */
  cliSurface: ChatCapabilityState
}>

export type ChatSlashCommand = Readonly<{
  id: string
  label?: string
  description?: string
  /** 官方 SDK/CLI 探测得到的参数提示（对齐 Claudian probeRuntimeCommands）。 */
  argumentHint?: string
  /** 命令来源：sdk（provider 原生，探测/目录）、user（用户定义）、vault（库级）。 */
  source?: 'sdk' | 'user' | 'vault'
  /** 命令在提交前是否需要 runtime 侧参与解析（如 `/moa`）。 */
  requiresRuntimeParsing?: boolean
}>

export function isChatCapabilitySupported(
  capability: ChatCapabilityState,
): capability is Extract<ChatCapabilityState, { supported: true }> {
  return capability.supported
}

export type ChatCommandError =
  | Readonly<{
      kind: 'unsupported'
      capability: ChatCapabilityId
      reason?: string
    }>
  | Readonly<{ kind: 'busy' }>
  | Readonly<{ kind: 'not_ready' }>
  | Readonly<{ kind: 'cancelled' }>
  | Readonly<{ kind: 'rejected'; reason: string; retryable: boolean }>
  | Readonly<{ kind: 'failed'; message?: string; retryable?: boolean }>

export type ChatCommandResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; error: ChatCommandError }>

export function chatCommandOk(): ChatCommandResult {
  return { ok: true }
}

export function chatCommandUnsupported(
  capability: ChatCapabilityId,
  reason?: string,
): ChatCommandResult {
  return { ok: false, error: { kind: 'unsupported', capability, reason } }
}

export type ChatSubmissionAcceptance =
  | Readonly<{ status: 'received'; receivedAt: number }>
  | Readonly<{
      status: 'durably_accepted'
      acceptedAt: number
      baseRevision?: number
    }>
  | Readonly<{
      status: 'rejected'
      rejectedAt: number
      reason: string
      retryable: boolean
    }>

export class ChatSubmissionTracker {
  private acceptance: ChatSubmissionAcceptance
  private readonly acceptancePromise: Promise<ChatSubmissionAcceptance>
  private resolveAcceptance!: (acceptance: ChatSubmissionAcceptance) => void

  constructor(
    readonly requestId: string,
    readonly messageId: string,
    private readonly now: () => number = Date.now,
  ) {
    this.acceptance = { status: 'received', receivedAt: now() }
    this.acceptancePromise = new Promise<ChatSubmissionAcceptance>(
      (resolve) => {
        this.resolveAcceptance = resolve
      },
    )
  }

  getState(): ChatSubmissionAcceptance {
    return this.acceptance
  }

  getAcceptance(): Promise<ChatSubmissionAcceptance> {
    return this.acceptancePromise
  }

  markDurablyAccepted(options?: { baseRevision?: number }): void {
    if (this.acceptance.status !== 'received') return
    this.acceptance = {
      status: 'durably_accepted',
      acceptedAt: this.now(),
      ...(options?.baseRevision !== undefined
        ? { baseRevision: options.baseRevision }
        : {}),
    }
    this.resolveAcceptance(this.acceptance)
  }

  markRejected(reason: string, retryable: boolean): void {
    if (this.acceptance.status !== 'received') return
    this.acceptance = {
      status: 'rejected',
      rejectedAt: this.now(),
      reason,
      retryable,
    }
    this.resolveAcceptance(this.acceptance)
  }

  cancel(): ChatCommandResult {
    if (this.acceptance.status !== 'received') {
      return { ok: false, error: { kind: 'cancelled' } }
    }
    this.acceptance = {
      status: 'rejected',
      rejectedAt: this.now(),
      reason: 'cancelled',
      retryable: false,
    }
    this.resolveAcceptance(this.acceptance)
    return { ok: true }
  }
}

export type ChatSubmissionHandle = Readonly<{
  requestId: string
  messageId: string
  getState(): ChatSubmissionAcceptance
  acceptance: Promise<ChatSubmissionAcceptance>
  cancel(): Promise<ChatCommandResult>
}>

export type ChatRuntimeRunState =
  | 'idle'
  | 'running'
  | 'waiting_for_approval'
  | 'waiting_for_user'
  | 'completed'
  | 'aborted'
  | 'error'

/**
 * 结构化失效原因（run.state 的 failure.reason）：UI 据此区分死因并驱动恢复
 * 提示，取代对自由文本 error 的猜测。分类在适配链源头完成（ClaudeCliRuntime
 * 的进程退出/流关闭、Native adapter 的会话缺失），中间层只透传。
 */
export type ChatRuntimeRunFailureReason =
  | 'process-exited'
  | 'transport-closed'
  | 'provider-session-missing'
  | 'configuration-changed'
  | 'cancelled'

export type ChatRuntimeRunFailure = Readonly<{
  reason: ChatRuntimeRunFailureReason
  /** 是否为可恢复失效（UI 据此决定展示「重试/恢复」还是「排查提示」）。 */
  recoverable: boolean
}>

export type ChatRuntimeRunStatePayload = Readonly<{
  state: ChatRuntimeRunState
  error?: string
  failure?: ChatRuntimeRunFailure
}>

export type ChatSessionRef = Readonly<{
  runtimeId: ChatRuntimeId
  nativeSessionId: string
  sessionPathHint?: string
}>

export type ChatCompactionBoundary = Readonly<{
  id: string
  afterMessageId: string | null
  trigger?: 'manual' | 'auto'
  preTokens?: number
  postTokens?: number
}>

export type ChatRuntimeContextUsage = Readonly<{
  promptTokens: number
  maxContextTokens: number | null
  cacheHitRate?: number
  categories?: readonly { name: string; tokens: number }[]
}>

export type ChatReasoningEffortOption = Readonly<{
  id: string
  description?: string
}>

export type ChatRuntimeModel = Readonly<{
  id: string
  label: string
  description?: string
  reasoningEfforts: readonly ChatReasoningEffortOption[]
  defaultReasoningEffort?: string
  isDefault?: boolean
}>

export type ChatRuntimeConfiguration = Readonly<{
  models: readonly ChatRuntimeModel[]
  modelId: string | null
  reasoningEffort: string | null
}>

export type ChatSubagentRef = Readonly<{
  parentSessionRef: ChatSessionRef
  toolCallId: string
  subagentId: string
}>

export type ChatRuntimeSnapshot = Readonly<{
  replayCursor: number
  runId: string
  conversationId: string | null
  sessionRef: ChatSessionRef | null
  messages: readonly ChatMessage[]
  runState: ChatRuntimeRunState
  error: string | null
  compactionBoundaries: readonly ChatCompactionBoundary[]
  configuration: ChatRuntimeConfiguration | null
  capabilities: ChatRuntimeCapabilities
}>

export type ChatRuntimeToolRequest = Readonly<{
  requestId: string
  toolCall: ToolCallRequest
  mode: 'approval' | 'question' | 'execution'
}>

export type ChatRuntimeEventMap = {
  snapshot: ChatRuntimeSnapshot
  'message.upsert': { message: ChatMessage }
  'message.remove': { messageId: string }
  'run.state': ChatRuntimeRunStatePayload
  'tool.request': ChatRuntimeToolRequest
  'submission.accepted': {
    requestId: string
    messageId: string
    baseRevision?: number
  }
  'submission.rejected': {
    requestId: string
    messageId: string
    reason: string
    retryable: boolean
  }
  'context.usage': ChatRuntimeContextUsage
  'turn.metrics': { usage?: unknown; durationMs?: number }
  'compaction.state': { isCompacting: boolean }
  'compaction.boundary': { boundary: ChatCompactionBoundary }
  'capability.changed': { capabilities: ChatRuntimeCapabilities }
  'session.changed': { sessionRef: ChatSessionRef | null }
  'subagent.transcript': {
    subagentRef: ChatSubagentRef
    messages: readonly ChatMessage[]
  }
}

export type ChatRuntimeEventType = keyof ChatRuntimeEventMap

/**
 * 判别联合（mapped union）：type 与 payload 一一对应，错误 payload 无法通过
 * 类型检查，不再需要 `as ChatRuntimeEvent` 掩盖。
 */
export type ChatRuntimeEvent = {
  [K in ChatRuntimeEventType]: Readonly<
    ChatRuntimeEventEnvelope & {
      type: K
      payload: ChatRuntimeEventMap[K]
    }
  >
}[ChatRuntimeEventType]

export type ChatRuntimeEventEnvelope = Readonly<{
  eventId: string
  sequence: number
  runId: string
  conversationId: string | null
  sessionRef: ChatSessionRef | null
  timestamp: number
}>

export type ChatRuntimeEventIdentity = Readonly<{
  /** 稳定 surface/conversation 身份；provider session 绑定不改变它。 */
  conversationId: string | null
  /** 当前 run 身份（epoch 递增）；旧 run 的事件按此丢弃。 */
  runId: string
}>

export function isChatRuntimeEventStale(
  event: ChatRuntimeEvent,
  current: ChatRuntimeEventIdentity,
): boolean {
  return (
    event.runId !== current.runId ||
    event.conversationId !== current.conversationId
  )
}

export class ChatRuntimeEventSequencer {
  private sequence = 0

  constructor(
    private currentRunId: string,
    private readonly conversationId: string | null,
    private sessionRef: ChatSessionRef | null,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * 新 run 开始：只更新 runId（epoch），sequence 全局单调递增、绝不重置。
   * Remote 客户端用单一 lastSequence 去重因此始终成立。
   */
  beginRun(runId: string, sessionRef?: ChatSessionRef | null): void {
    this.currentRunId = runId
    if (sessionRef !== undefined) this.sessionRef = sessionRef
  }

  get runId(): string {
    return this.currentRunId
  }

  getCursor(): number {
    return this.sequence
  }

  next<K extends ChatRuntimeEventType>(
    type: K,
    payload: ChatRuntimeEventMap[K],
  ): ChatRuntimeEvent {
    this.sequence += 1
    return {
      eventId: uuidv4(),
      sequence: this.sequence,
      runId: this.currentRunId,
      conversationId: this.conversationId,
      sessionRef: this.sessionRef,
      timestamp: this.now(),
      type,
      payload,
    } as ChatRuntimeEvent
  }
}

export type ChatSkillSelection = Readonly<{
  name: string
  description?: string
  path?: string
}>

/**
 * retry/continue 续跑输入（Task 5 消费）：携带重跑回合的完整消息历史与分支
 * 锚点。native adapter 拆开映射到 agent 运行时；CLI adapter 显式拒绝。
 */
export type ChatTurnContinuation = Readonly<{
  /** 该次 run 的完整消息历史（含被重跑的 user 回合，作为 run 的 messages）。 */
  requestMessages?: readonly ChatMessage[]
  /** 目标分支身份（重跑/续写落到该分支）。 */
  branchId?: string
  /** 分支锚点 user 消息（重跑回合的身份；缺省由 requestMessages 最后一个 user 派生）。 */
  sourceUserMessageId?: string
  /** 被打断的 assistant 消息（agent 运行时 resume 语义，映射 continueAssistantMessageId）。 */
  assistantMessageId?: string
  branchLabel?: string
  modelId?: string
  compaction?: ChatConversationCompactionLike
  /** 冻结的显式 /moa 调用（存在时 agent 运行时直接分派 MoA 聚合）。 */
  moa?: unknown
  /**
   * 续跑档位（P1 白名单扩展，final review 显式评审）：重跑回合的存储档位
   * （UI 侧 resolveReasoningLevelForMessages 派生，缺省回退当前档位）。
   * native 透传 run 请求；CLI 忽略。
   */
  reasoningLevel?: ReasoningLevel
}>

export type ChatTurnInput = Readonly<{
  requestId?: string
  messageId?: string
  baseRevision?: number
  messageGeneration?: number
  conversationId?: string | null
  sessionRef?: ChatSessionRef | null
  content: string | ContentPart[]
  /** 提交携带的 @提及/附件/skills 引用（CLI 经 buildCliTurnContent 编码；native 经 run 消息透传）。 */
  mentionables?: readonly Mentionable[]
  /**
   * 会话 persona/skills 绑定（CLI 经 resolveCliAssistantBinding + ensureReady
   * 应用；native 会话内 run 经 assistantId 直传 AgentService——非默认 assistant
   * 会话的主提交由 useChatDomainActions 以 conversationAssistantId 填充）。
   */
  assistantId?: string
  selectedSkills?: readonly ChatSkillSelection[]
  /**
   * 主面交互模式（P1 豁免白名单字段）：native 透传 run 的权限解析；CLI 忽略
   * （CLI 经 updatePermissionProfile 持自身模式）。
   */
  mode?: 'ask' | 'agent'
  /** retry/continue 续跑输入（native 透传；CLI 显式拒绝）。 */
  continuation?: ChatTurnContinuation
  /**
   * 本次提交的推理档位（P1 白名单扩展，final review 显式评审）：Quick Ask /
   * 主面提交携带面板所选档位（UI 侧已把档位持久化到用户消息），native 透传
   * run 请求；CLI 忽略。续跑经 continuation.reasoningLevel 携带。
   */
  reasoningLevel?: ReasoningLevel
}>

export type ChatRewriteTurnInput = ChatTurnInput &
  Readonly<{ sourceUserMessageId: string; userMessageId: string }>

export type ChatApprovalDecision =
  | 'approve_once'
  | 'approve_for_session'
  | 'reject'

export type ChatApprovalResponse = Readonly<{
  requestId: string
  decision: ChatApprovalDecision
}>

export type ChatQuestionResponse = Readonly<{
  requestId: string
  answer: unknown
}>

export type ChatConfigurationUpdate = Readonly<{
  modelId?: string | null
  reasoningEffort?: string | null
}>

export type ChatPermissionProfileUpdate = Readonly<{
  mode: 'ask' | 'agent' | 'plan'
  yoloEnabled: boolean
}>

export type ChatSessionSummary = Readonly<{
  ref: ChatSessionRef
  title: string
  preview?: string
  updatedAt: number
  /** 会话置顶状态（providerSessions 能力可选携带；不声明视为未置顶）。 */
  isPinned?: boolean
}>

/**
 * 手动压缩（compact）的会话上下文输入（Task 6 扩展）：UI 侧按会话持有的
 * 模型/assistant/mode 状态显式传给 adapter（镜像 WebChatRuntimeAdapter 的
 * CompactConversationInput 先例），adapter 保持无状态、不猜测 UI 偏好。
 * 缺省字段沿 settings 回退链解析。CLI adapter 保持 unsupported，不消费。
 */
export type ChatCompactInput = Readonly<{
  /** 摘要生成所用模型（缺省 assistant.modelId ?? settings.chatModelId）。 */
  modelId?: string
  /** 会话 assistant 绑定（缺省 settings.currentAssistantId）。 */
  assistantId?: string
  /** 会话 chat mode（缺省 'ask'；决定 compact 请求的工具面与 toolCapabilityMode）。 */
  chatMode?: 'ask' | 'agent' | 'plan'
  /** 会话 YOLO（工具自动批准）开关。 */
  yoloEnabled?: boolean
}>

export type ChatSessionListResult =
  | Readonly<{ ok: true; sessions: readonly ChatSessionSummary[] }>
  | Readonly<{ ok: false; error: ChatCommandError }>

export type ChatSubagentReadResult =
  | Readonly<{ ok: true; messages: readonly ChatMessage[] }>
  | Readonly<{ ok: false; error: ChatCommandError }>

export type ChatSubagentWatchResult =
  | Readonly<{ ok: true; unsubscribe: () => void }>
  | Readonly<{ ok: false; error: ChatCommandError }>

export type ChatRuntime = {
  /**
   * 能力一致性规则：`supported: true` 的命令绝不 throw、绝不返回 unsupported；
   * 能力必须按实例真实派生（同一 runtime 因配置可变化，变化经 capability.changed 事件广播）。
   */
  readonly runtimeId: ChatRuntimeId
  readonly capabilities: ChatRuntimeCapabilities

  subscribe(listener: (event: ChatRuntimeEvent) => void): () => void
  getSnapshot(): ChatRuntimeSnapshot

  sendTurn(input: ChatTurnInput): Promise<ChatSubmissionHandle>
  rewriteTurn(input: ChatRewriteTurnInput): Promise<ChatCommandResult>
  rollbackToTurn(sourceUserMessageId: string): Promise<ChatCommandResult>
  cancel(requestId?: string): Promise<ChatCommandResult>
  respondApproval(response: ChatApprovalResponse): Promise<ChatCommandResult>
  respondQuestion(response: ChatQuestionResponse): Promise<ChatCommandResult>
  updateConfiguration(
    update: ChatConfigurationUpdate,
  ): Promise<ChatCommandResult>
  updatePermissionProfile(
    update: ChatPermissionProfileUpdate,
  ): Promise<ChatCommandResult>
  setSessionPinned(
    ref: ChatSessionRef,
    pinned: boolean,
  ): Promise<ChatCommandResult>
  /**
   * 手动压缩：native 成功时返回带 compaction 状态的扩展结果
   * `{ ok: true, compaction }`（UI 据此重建 canonicalCompaction 并提交
   * commit_compaction）；无内容可压缩时返回 `{ ok: true }`（无 compaction）。
   * cli adapter 保持 unsupported，返回值不影响。
   */
  compact(
    input?: ChatCompactInput,
  ): Promise<ChatCommandResult & { compaction?: ChatConversationCompaction }>

  listSessions(): Promise<ChatSessionListResult>
  openSession(ref: ChatSessionRef): Promise<ChatCommandResult>
  renameSession(ref: ChatSessionRef, title: string): Promise<ChatCommandResult>
  deleteSession(ref: ChatSessionRef): Promise<ChatCommandResult>
  setSessionTitle(
    ref: ChatSessionRef,
    title: string,
  ): Promise<ChatCommandResult>

  readSubagent(ref: ChatSubagentRef): Promise<ChatSubagentReadResult>
  watchSubagent(
    ref: ChatSubagentRef,
    listener: (messages: readonly ChatMessage[]) => void,
  ): Promise<ChatSubagentWatchResult>

  dispose(): Promise<void>
}
