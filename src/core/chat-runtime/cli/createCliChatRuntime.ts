import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { ChatMessage } from '../../../types/chat'
import { stampUserMessageTimeContext } from '../../../utils/prompt/timeContext'
import { resolveCliAssistantBinding } from '../../cli-runtime/assistant-binding'
import type { CliConversationController } from '../../cli-runtime/conversation-controller'
import type { CliRuntimeScope } from '../../cli-runtime/coordinator'
import { buildCliTurnContent } from '../../cli-runtime/turn-input'
import type { CliRuntime, CliSessionRef } from '../../cli-runtime/types'
import type { McpManager } from '../../mcp/mcpManager'
import { deriveMcpSharingCapability } from '../../mcp/sharing/mcpSharingCapability'
import type {
  ChatRuntime,
  ChatRuntimeCapabilities,
  ChatSlashCommand,
} from '../contract'

import { CliChatRuntimeAdapter } from './CliChatRuntimeAdapter'
import type {
  CliBackend,
  CliBackendEvent,
  CliBackendSessionRef,
  CliBackendSnapshot,
} from './CliRuntimeBackend'

/**
 * 按实例派生 CLI 能力（codex / claude-code 的能力差异集中点）。
 *
 * 未来两个 provider 若结构性分叉（提交语义、会话模型、事件流），拆 adapter 的
 * 改动面就是这个函数 + 工厂返回分支；契约 `ChatRuntime` 与 UI 不受影响。
 */
export function deriveCliCapabilities(
  runtimeId: 'claude-code' | 'codex',
): ChatRuntimeCapabilities {
  return {
    transport: 'local',
    hostHistory: { supported: true, info: { source: 'gateway' } },
    providerSessions: { supported: true, info: { scope: 'provider-native' } },
    agentPlanMode: { supported: true },
    approvalFlow: { supported: true },
    subagents: { supported: true },
    skills: { supported: true },
    modelConfig: { supported: true },
    reasoningEffort: { supported: true },
    compaction: { supported: true },
    contextUsage: { supported: true },
    rewrite: { supported: true },
    sessionPin: { supported: true },
    // compact 按实例派生：仅 claude_code 声明支持（provider CLI 能力差异）。
    compact: {
      supported: runtimeId === 'claude-code',
      reason:
        runtimeId === 'claude-code'
          ? undefined
          : 'codex CLI does not expose compaction in this version',
    },
    // mcpSharing 按实例派生（MCP 共享实例 plan Task 5）：claude SDK 透传 /
    // codex 注入已接线（coordinator getMcpSharing → 进程选项），工厂在
    // createCliChatRuntime 中按 McpManager 注册表派生后覆盖此字段。
    mcpSharing: {
      supported: false,
      reason: 'no shared MCP servers configured',
    },
    // CLI 运行时自己处理 prompt 命令；MoA 聚合 v1 仅 native。
    moa: {
      supported: false,
      reason:
        'MoA aggregation is native-only in v1; CLI runs its own prompt commands',
    },
    // 斜杠命令注册表：CLI 命令为 provider 原生，列表后续经 CliRuntime.listSlashCommands 填充。
    commands: { supported: true, info: { commands: [] } },
    cliSurface: { supported: true },
  }
}

function toBackendRef(ref: CliSessionRef): CliBackendSessionRef {
  return ref
}

function emitSnapshotDiff(
  previous: ReturnType<CliConversationController['getSnapshot']>,
  snapshot: ReturnType<CliConversationController['getSnapshot']>,
  toBackendRef: (ref: CliSessionRef) => CliBackendSessionRef,
  listener: (event: CliBackendEvent) => void,
): void {
  // epoch 变化 = 新 run 开始，事件身份由 adapter 经 backend.getSnapshot() 的
  // conversationEpoch（controller.getConversationEpoch()）派生 runId 覆盖。
  if (
    snapshot.sessionRef?.nativeSessionId !==
    previous.sessionRef?.nativeSessionId
  ) {
    if (snapshot.sessionRef) {
      listener({
        type: 'session_bound',
        ref: toBackendRef(snapshot.sessionRef),
      })
    }
  }
  if (snapshot.runState !== previous.runState) {
    listener({
      type: 'run_state',
      state: snapshot.runState,
      ...(snapshot.error ? { error: snapshot.error } : {}),
    })
  }
  const previousIds = new Set(previous.messages.map((message) => message.id))
  const nextIds = new Set(snapshot.messages.map((message) => message.id))
  const previousById = new Map(
    previous.messages.map((message) => [message.id, message]),
  )
  for (const message of snapshot.messages) {
    const previousMessage = previousById.get(message.id)
    if (previousMessage === undefined || previousMessage !== message) {
      // 乐观 user 消息被 provider 原生消息替换：对账完成 → accepted。
      if (previousMessage === undefined) {
        const reconciled = findReconciledUserMessage(previous.messages, message)
        if (reconciled) {
          listener({
            type: 'submission.accepted',
            optimisticMessageId: reconciled,
            nativeMessageId: message.id,
          })
        }
      }
      // 新增或同 ID 流式更新（对象引用变化）都发 upsert。
      listener({ type: 'message_upsert', message })
    }
  }
  for (const id of previousIds) {
    if (!nextIds.has(id)) {
      listener({ type: 'message_remove', messageId: id })
    }
  }
}

function findReconciledUserMessage(
  previous: readonly ChatMessage[],
  nextUserMessage: ChatMessage,
): string | null {
  for (const message of previous) {
    if (
      message.role === 'user' &&
      message.id !== nextUserMessage.id &&
      'promptContent' in message &&
      nextUserMessage.role === 'user' &&
      'promptContent' in nextUserMessage &&
      message.promptContent === nextUserMessage.promptContent
    ) {
      return message.id
    }
  }
  return null
}

function createBackendFromScope(
  scope: CliRuntimeScope,
  runtimeId: 'claude-code' | 'codex',
  context?: { app?: App; settings?: YoloSettings },
): CliBackend {
  const controller = scope.selectConversationRuntime(runtimeId)
  const runtime: CliRuntime = scope.resolveRuntime(runtimeId)

  // 只消费 controller 的稳定快照：乐观消息、provider ID 对账、stale submission
  // 保护都在 controller 内完成，禁止旁路订阅 raw CliRuntime 事件。
  let lastSnapshot = controller.getSnapshot()
  return {
    subscribe: (listener) =>
      controller.subscribe(() => {
        const snapshot = controller.getSnapshot()
        emitSnapshotDiff(lastSnapshot, snapshot, toBackendRef, listener)
        lastSnapshot = snapshot
      }),
    getSnapshot: (): CliBackendSnapshot => {
      const snapshot = controller.getSnapshot()
      return {
        surfaceId: snapshot.surfaceId,
        conversationEpoch: controller.getConversationEpoch(),
        messages: snapshot.messages,
        sessionRef: snapshot.sessionRef
          ? toBackendRef(snapshot.sessionRef)
          : null,
        runState: snapshot.runState,
        error: snapshot.error,
        configuration: snapshot.configuration ?? null,
      }
    },
    sendTurn: async (input) => {
      if (input.assistantId && context?.app && context?.settings) {
        const assistant = await resolveCliAssistantBinding({
          app: context.app,
          settings: context.settings,
          assistantId: input.assistantId,
        })
        await controller.ensureReady(undefined, assistant)
      }
      // 吸收 submitCliComposerTurn 语义：时间戳 + buildCliTurnContent 编码
      // （@提及/skills/timeContext）+ 会话 overlay 记录；assistant 绑定与
      // coordinator 状态机随契约字段扩展后接入（见 plan 7d）。
      const stampedUserMessage = stampUserMessageTimeContext(
        {
          role: 'user',
          id: input.userMessageId ?? `cli-msg-${Date.now()}`,
          content: null,
          promptContent: input.content,
          mentionables: [...(input.mentionables ?? [])],
          selectedSkills: input.selectedSkills
            ? input.selectedSkills.map((skill) => ({
                name: skill.name,
                description: skill.description ?? '',
                path: skill.path ?? '',
              }))
            : [],
        },
        false,
      )
      const content = buildCliTurnContent({
        runtimeId,
        text: input.content,
        mentionables: stampedUserMessage.mentionables,
        selectedSkills: stampedUserMessage.selectedSkills,
        timeContext: stampedUserMessage.timeContext,
      })
      await controller.sendTurn({
        userMessage: { ...stampedUserMessage, promptContent: content },
        content,
      })
      const snapshot = controller.getSnapshot()
      if (snapshot.sessionRef) {
        try {
          await scope.sessionService.recordOpenedSession({
            ref: snapshot.sessionRef,
            messages: [...snapshot.messages],
            compactionBoundaries: [...(snapshot.compactionBoundaries ?? [])],
          })
        } catch {
          // overlay 失败不阻断提交（submitCliComposerTurn 语义：overlayError 上报）
        }
      }
    },
    rewriteTurn: async (input) => {
      await controller.rewriteTurn({
        userMessage: {
          role: 'user',
          id: input.userMessageId ?? `cli-msg-${Date.now()}`,
          content: null,
          promptContent: input.content,
          mentionables: [],
        },
        content: input.content,
        ...(input.selectedSkills
          ? {
              selectedSkills: input.selectedSkills.map((skill) => ({
                name: skill.name,
                description: skill.description ?? '',
                path: skill.path ?? '',
              })),
            }
          : {}),
        sourceUserMessageId: input.sourceUserMessageId,
      })
    },
    // fork 适配：master cli-runtime 尚无 controller.rollbackToTurn（backup 有）；
    // 显式抛错（fail-fast），由后续 rollback 移植任务补齐后再透传。
    rollbackToTurn: async (sourceUserMessageId) => {
      throw new Error(
        `CLI rollback is not supported in this build (runtime: ${runtimeId}, message: ${sourceUserMessageId})`,
      )
    },
    // controller 已包装 cancel（含 staged turn 与并发守卫），必须走 controller，
    // 不能旁路 raw runtime。
    cancel: () => controller.cancel(),
    // approval/question 是 provider 面向命令，controller 未包装，保持 runtime。
    respondApproval: async (response) => {
      await runtime.respondApproval(response)
    },
    respondQuestion: async (response) => {
      await runtime.respondQuestion(response)
    },
    updateConfiguration: async (update) => {
      await runtime.updateConfiguration(update)
    },
    updatePermissionProfile: async (update) => {
      // CliChatMode 只有 agent/plan；契约允许的 'ask' 是 native 专属模式，
      // CLI 侧映射到 agent（UI 对 CLI 不会下发 ask）。
      await (runtime.updatePermissionProfile?.({
        mode: update.mode === 'ask' ? 'agent' : update.mode,
        yoloEnabled: update.yoloEnabled,
      }) ?? Promise.resolve())
    },
    listSessions: async () =>
      scope.sessionService.discoverSessions().then((discovery) =>
        discovery.sessions.map((session) => ({
          ref: toBackendRef(session.ref),
          title: session.title,
          preview: session.preview,
          updatedAt: session.updatedAt,
          isPinned: session.isPinned,
        })),
      ),
    openSession: async (ref) => {
      const controller = scope.selectConversationSession(ref)
      const hydration = await controller.hydrateSession(ref)
      if (hydration === null) {
        throw new Error('CLI session hydration was superseded.')
      }
    },
    renameSession: (ref, title) =>
      scope.sessionService.renameSession(ref, title),
    // 现有 UI 的「删除 CLI 会话」= 移除本地 overlay 记录（provider 原生会话
    // 不删除），保持等价。
    deleteSession: async (ref) => {
      await scope.sessionService.removeOverlay(ref)
    },
    setSessionTitle: (ref, title) =>
      runtime.setSessionTitle?.(ref, title) ?? Promise.resolve(),
    setSessionPinned: (ref, pinned) =>
      scope.sessionService.setPinned(ref, pinned),
    compact: () => runtime.compact?.() ?? Promise.resolve(),
    readSubagent: async (ref) => (await runtime.readSubagent?.(ref)) ?? [],
    // scope 生命周期由插件/协调器管理，backend dispose 只做占位。
    dispose: async () => undefined,
  }
}

export async function createCliChatRuntime(
  scope: CliRuntimeScope,
  runtimeId: 'claude-code' | 'codex',
  context?: {
    app?: App
    settings?: YoloSettings
    getMcpManager?: () => Promise<McpManager>
  },
): Promise<ChatRuntime> {
  const backend = createBackendFromScope(scope, runtimeId, context)
  const capabilities = deriveCliCapabilities(runtimeId)
  // mcpSharing 按实例派生：进程级投影注入已接线（coordinator getMcpSharing），
  // 能力按当前 McpManager 注册表的共享 server 派生。
  let mcpSharing = deriveMcpSharingCapability([], runtimeId, {
    processInjectionWired: true,
  })
  try {
    const manager = context?.getMcpManager
      ? await context.getMcpManager()
      : null
    if (manager) {
      mcpSharing = deriveMcpSharingCapability(manager.getServers(), runtimeId, {
        processInjectionWired: true,
      })
    }
  } catch {
    // McpManager 不可用时保持默认（supported false）。
  }
  // 对齐 Claudian：命令目录按官方 SDK/CLI 探测（claude 走 supportedCommands、
  // codex 走官方目录），探测失败降级为空目录（provider 仍可自行解释 / 命令）。
  let slashCommands: readonly ChatSlashCommand[] = []
  try {
    const runtime = scope.resolveRuntime(runtimeId)
    slashCommands = (await runtime.listSlashCommands?.()) ?? []
  } catch {
    slashCommands = []
  }
  return new CliChatRuntimeAdapter(backend, runtimeId, {
    ...capabilities,
    mcpSharing,
    commands: { supported: true, info: { commands: slashCommands } },
  })
}
