import { App, Notice, TFolder } from 'obsidian'
import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'
import { v4 as uuidv4 } from 'uuid'

import { DEFAULT_ASSISTANT_ID } from '../../core/agent/default-assistant'
import {
  findUnifiedAgentById,
  getUnifiedAgentList,
} from '../../core/agent/workspaceAgentResolver'
import {
  type ChatRuntimeId,
  type CliChatMode,
  type CliConversationController,
  type CliRuntimeId,
  type CliRuntimeModel,
  type CliRuntimeScope,
} from '../../core/cli-runtime'
import {
  isAgentCompatibleWithDirectory,
  normalizeConversationWorkingDirectory,
} from '../../core/workspace/conversationFileScope'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { ReasoningLevel } from '../../types/reasoning'
import { AcknowledgementModal } from '../modals/AcknowledgementModal'
import { FolderPickerModal } from '../settings/modals/FolderPickerModal'

import { type ChatMode } from './chat-input/ChatModeSelect'
import {
  beginChatRuntimeNavigation,
  resolveChatRuntimeId,
} from './cliChatIntegration'
import {
  type CliModePreference,
  type PrePlanCliModeEntry,
  resolveCliModePreference,
  resolveCliRuntimePreference,
} from './cliRuntimePreferences'
import {
  ConversationPreferencesController,
  type ConversationPreferencesControllerDeps,
  type ConversationPreferencesSnapshot,
} from './ConversationPreferencesController'

function useLatestRef<T>(value: T) {
  const ref = useRef(value)
  ref.current = value
  return ref
}

/**
 * `handleRuntimeChange` 的运行时切换编排与 CLI 编排 hook（在本 hook 之后
 * 才调用）纠缠——这部分不是「偏好」的所有权问题，是 hooks 顺序本身的
 * 依赖倒置，架构治理第三步分期 B 的范围之外（见设计文档约束 6）。继续用
 * 与 `useChatInputController.lateStateRef` 相同的惯例经 late ref 注入，
 * 但只承载 CLI 编排相关的量——偏好六件套已经改由
 * `ConversationPreferencesController` 直接持有,不再需要 late 绑定。
 *
 * fork 扩展：工作目录领域（backup 语义）的四个量仍然晚于本 hook 产生
 * （依赖 Chat.tsx 的 chatMessages/isLoadingConversation 与 conversationOverrides
 * 状态），继续经同一 late ref 注入。
 */
export type CliRuntimeSwitchLateState = {
  cliPreferenceSettingsRef: MutableRefObject<YoloSettings>
  cliModelCatalog: ReadonlyMap<CliRuntimeId, readonly CliRuntimeModel[]>
  setCliConversationController: Dispatch<
    SetStateAction<CliConversationController | null>
  >
  setCliConversationId: Dispatch<SetStateAction<string | null>>
  setCliChatMode: Dispatch<SetStateAction<CliChatMode>>
  setCliYoloEnabled: Dispatch<SetStateAction<boolean>>
  transitionCliSession: (
    action: (isCurrent: () => boolean) => void | Promise<void>,
  ) => Promise<boolean>
  activeHistoryConversationId: string
  // 工作目录领域（fork 特有扩展——backup 语义，非上游字段）
  conversationWorkingDirectoryLocked: boolean
  conversationWorkingDirectory: string | undefined
  setConversationWorkingDirectory: (directory: string | undefined) => void
  selectedAssistantFilePolicy: WorkspaceAccessPolicy | undefined
}

export type UseChatRuntimePreferencesParams = {
  app: App
  t: (keyPath: string, fallback?: string) => string
  settings: YoloSettings
  setSettings: (settings: YoloSettings) => Promise<boolean>
  cliRuntimeScope: CliRuntimeScope | undefined
  cliRuntimeAvailable: boolean
  chatMountedRef: MutableRefObject<boolean>

  // 运行时切换初始值：仅首次渲染读取
  seededActiveRuntimeId: ChatRuntimeId | undefined
  hasInitialConversationId: boolean

  // 会话身份——由 Chat.tsx 持有，本 hook 调用时已可用
  currentConversationId: string

  // pop-out 重建：偏好六件套的种子快照，只在挂载时读取一次。用
  // `Partial<ConversationPreferencesSnapshot>` 而不是 Chat.tsx 的
  // `ChatRuntimeSnapshot`（后者字段更多、且反向 import 会与
  // `Chat.tsx -> useChatRuntimePreferences.ts` 的既有依赖方向成环）。
  seededPreferences: Partial<ConversationPreferencesSnapshot> | undefined

  // 偏好六件套里 reasoningLevel / conversationModelId 的默认值计算依赖
  // settings，在 Chat.tsx 里于本 hook 调用之前算好传入,避免本 hook 又要
  // 反过来经 lateStateRef 拿这两个值（消灭原环 1 的反向依赖之一）。
  initialReasoningLevel: ReasoningLevel
  getReasoningLevelForModelId: (modelId?: string | null) => ReasoningLevel
}

function computeInitialSnapshot(
  settings: YoloSettings,
  seeded: Partial<ConversationPreferencesSnapshot> | undefined,
  initialReasoningLevel: ReasoningLevel,
): ConversationPreferencesSnapshot {
  const conversationAssistantId =
    seeded?.conversationAssistantId ??
    settings.currentAssistantId ??
    DEFAULT_ASSISTANT_ID
  const chatMode: ChatMode =
    seeded?.chatMode ?? settings.chatOptions.chatMode ?? 'agent'
  const yoloEnabled =
    seeded?.yoloEnabled ?? settings.chatOptions.agentYoloEnabled ?? false
  const conversationModelId =
    seeded?.conversationModelId ??
    (() => {
      const initialAssistantId =
        settings.currentAssistantId ?? DEFAULT_ASSISTANT_ID
      const initialAssistant = findUnifiedAgentById(
        settings,
        initialAssistantId,
      )
      return initialAssistant?.modelId ?? settings.chatModelId
    })()
  const reasoningLevel = seeded?.reasoningLevel ?? initialReasoningLevel
  const conversationOverrides = seeded?.conversationOverrides ?? null

  return {
    conversationModelId,
    conversationAssistantId,
    reasoningLevel,
    chatMode,
    yoloEnabled,
    conversationOverrides,
  }
}

/**
 * 运行时切换（requestedRuntimeId/handleRuntimeChange）+ 会话级偏好六件套
 * 的订阅适配与命令转发。
 *
 * 偏好六件套（conversationModelId/conversationAssistantId/reasoningLevel/
 * chatMode/yoloEnabled/conversationOverrides）及其每会话 Ref 缓存的唯一
 * owner 是 `ConversationPreferencesController`（普通 TS class，本 hook 内经
 * `useRef` 构造，随 Chat.tsx 组件实例创建/销毁）。本 hook 只做三件事：
 * ① 用 `useSyncExternalStore` 订阅 controller 快照；
 * ② 把 controller 的命令方法转发为与迁移前同名的 handler（
 * `handleConversationAssistantSelect`/`handleChatModeChange`/
 * `handleYoloChange`/`applyAssistantDefaultModel`）；③ 保留运行时切换
 * （`handleRuntimeChange`）——它与 CLI 编排 hook 的产出纠缠，仍需要一个
 * 局限于 CLI 编排量 + fork 工作目录领域的 late ref（`CliRuntimeSwitchLateState`），
 * 但偏好读写部分已经直接调用 controller 命令，不再经 late 绑定。
 */
export function useChatRuntimePreferences({
  app,
  t,
  settings,
  setSettings,
  cliRuntimeScope,
  cliRuntimeAvailable,
  chatMountedRef,
  seededActiveRuntimeId,
  hasInitialConversationId,
  currentConversationId,
  seededPreferences,
  initialReasoningLevel,
  getReasoningLevelForModelId,
}: UseChatRuntimePreferencesParams) {
  const preferredCliRuntimeId =
    settings.chatOptions.lastCliRuntimeId ?? 'claude-code'
  const preferredRuntimeId: ChatRuntimeId =
    settings.chatOptions.lastChatSurface === 'cli'
      ? preferredCliRuntimeId
      : 'yolo'
  const initialActiveRuntimeId = resolveChatRuntimeId({
    requestedRuntimeId:
      seededActiveRuntimeId ??
      (hasInitialConversationId ? 'yolo' : preferredRuntimeId),
    hasCliRuntimeScope: cliRuntimeScope !== undefined,
    cliRuntimeAvailable,
  })
  const [requestedRuntimeId, setRequestedRuntimeId] = useState<ChatRuntimeId>(
    initialActiveRuntimeId,
  )
  const activeRuntimeId = resolveChatRuntimeId({
    requestedRuntimeId,
    hasCliRuntimeScope: cliRuntimeScope !== undefined,
    cliRuntimeAvailable,
  })
  const activeRuntimeIdRef = useLatestRef(activeRuntimeId)
  const lastCliRuntimeIdRef = useRef<CliRuntimeId>(
    initialActiveRuntimeId === 'yolo'
      ? preferredCliRuntimeId
      : initialActiveRuntimeId,
  )
  const initialCliModePreference: CliModePreference = resolveCliModePreference(
    settings,
    initialActiveRuntimeId === 'yolo'
      ? preferredCliRuntimeId
      : initialActiveRuntimeId,
    seededPreferences?.conversationOverrides ?? null,
  )
  const prePlanCliModeByConversationRef = useRef(
    new Map<string, PrePlanCliModeEntry>(),
  )
  const cliModeRequestGenerationRef = useRef(0)
  const runtimeNavigationGenerationRef = useRef(0)

  const persistReasoningLevelForModel = useCallback(
    async (modelId: string, level: ReasoningLevel) => {
      if (!modelId) return
      const currentMap = settings.chatOptions.reasoningLevelByModelId ?? {}
      if (currentMap[modelId] === level) return
      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            reasoningLevelByModelId: {
              ...currentMap,
              [modelId]: level,
            },
          },
        })
      } catch (error: unknown) {
        console.error('Failed to persist reasoning level preference', error)
      }
    },
    [setSettings, settings],
  )

  const persistPreferredChatMode = useCallback(
    async (mode: ChatMode) => {
      if (settings.chatOptions.chatMode === mode) {
        return
      }

      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            chatMode: mode,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to persist preferred chat mode', error)
      }
    },
    [setSettings, settings],
  )

  const persistPreferredYolo = useCallback(
    async (enabled: boolean) => {
      if ((settings.chatOptions.agentYoloEnabled ?? false) === enabled) {
        return
      }

      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            agentYoloEnabled: enabled,
          },
        })
      } catch (error: unknown) {
        console.error('Failed to persist preferred YOLO state', error)
      }
    },
    [setSettings, settings],
  )

  const persistPreferredAssistantId = useCallback(
    async (assistantId: string) => {
      if (settings.currentAssistantId === assistantId) {
        return
      }

      try {
        await setSettings({
          ...settings,
          currentAssistantId: assistantId,
        })
      } catch (error: unknown) {
        console.error('Failed to persist preferred assistant', error)
      }
    },
    [setSettings, settings],
  )

  const persistChatRuntimePreference = useCallback(
    (runtimeId: ChatRuntimeId) => {
      const lastChatSurface = runtimeId === 'yolo' ? 'chat' : 'cli'
      const lastCliRuntimeId =
        runtimeId === 'yolo'
          ? (settings.chatOptions.lastCliRuntimeId ?? 'claude-code')
          : runtimeId
      if (
        settings.chatOptions.lastChatSurface === lastChatSurface &&
        settings.chatOptions.lastCliRuntimeId === lastCliRuntimeId
      ) {
        return
      }
      void setSettings({
        ...settings,
        chatOptions: {
          ...settings.chatOptions,
          lastChatSurface,
          lastCliRuntimeId,
        },
      })
    },
    [setSettings, settings],
  )

  // === 偏好六件套：唯一 owner 是 ConversationPreferencesController ===

  // 长期存活对象经 getter 读取当前值，不缓存闭包——每次渲染刷新，
  // controller 构造时注入的 deps 对象本身保持稳定引用（CLAUDE.md「Runtime
  // Boundaries」：长期存活服务必须读取当前设置而非闭包捕获的旧值）。
  const settingsRef = useLatestRef(settings)
  const getReasoningLevelForModelIdRef = useLatestRef(
    getReasoningLevelForModelId,
  )
  const persistPreferredAssistantIdRef = useLatestRef(
    (assistantId: string) => void persistPreferredAssistantId(assistantId),
  )
  const persistPreferredChatModeRef = useLatestRef(
    (mode: ChatMode) => void persistPreferredChatMode(mode),
  )

  const controllerDepsRef = useRef<ConversationPreferencesControllerDeps>()
  const controllerDeps = (controllerDepsRef.current ??= {
    getSettings: () => settingsRef.current,
    getReasoningLevelForModelId: (modelId) =>
      getReasoningLevelForModelIdRef.current(modelId),
    persistPreferredAssistantId: (assistantId) =>
      persistPreferredAssistantIdRef.current(assistantId),
    persistPreferredChatMode: (mode) =>
      persistPreferredChatModeRef.current(mode),
  })

  const controllerRef = useRef<ConversationPreferencesController>()
  const preferencesController = (controllerRef.current ??=
    new ConversationPreferencesController(
      currentConversationId,
      computeInitialSnapshot(
        settings,
        seededPreferences,
        initialReasoningLevel,
      ),
      controllerDeps,
    ))
  preferencesController.setActiveConversationId(currentConversationId)

  const preferencesSnapshot = useSyncExternalStore(
    preferencesController.subscribe,
    preferencesController.getSnapshot,
  )

  // 会话恢复/新建/分支时，assistant 可能来自一个已被删除的旧值——回退到
  // 当前可用的 assistant，与迁移前 useEffect 的语义一致，只是写入目标换成
  // 了 controller。
  const conversationAssistantId = preferencesSnapshot.conversationAssistantId
  useEffect(() => {
    if (
      getUnifiedAgentList(settings).some(
        (assistant) => assistant.id === conversationAssistantId,
      )
    ) {
      return
    }
    const fallbackAssistantId =
      settings.currentAssistantId ??
      getUnifiedAgentList(settings)[0]?.id ??
      DEFAULT_ASSISTANT_ID
    preferencesController.setConversationAssistantId(fallbackAssistantId)
    preferencesController.conversationAssistantIdRef.current.set(
      currentConversationId,
      fallbackAssistantId,
    )
  }, [
    conversationAssistantId,
    currentConversationId,
    preferencesController,
    settings.assistants,
    settings.workspaceAgents,
    settings.currentAssistantId,
  ])

  // === handleRuntimeChange：与 CLI 编排 hook 的产出纠缠，保留局限于 CLI
  // 编排量 + fork 工作目录领域的 late ref（不再承载偏好六件套）===
  const cliRuntimeSwitchLateStateRef = useRef<CliRuntimeSwitchLateState | null>(
    null,
  )
  const getCliLate = useCallback((): CliRuntimeSwitchLateState => {
    const late = cliRuntimeSwitchLateStateRef.current
    if (!late) {
      throw new Error(
        '[YOLO] useChatRuntimePreferences: accessed CLI runtime state before Chat.tsx hydrated cliRuntimeSwitchLateStateRef',
      )
    }
    return late
  }, [])

  const handleConversationAssistantSelect = useCallback(
    (assistantId: string) => {
      // fork 特有：工作目录兼容门控——显式工作目录存在时，目标 Agent 必须
      // 兼容该目录，否则拒绝切换（backup 语义）。
      const explicitDirectory = getCliLate().conversationWorkingDirectory
      if (explicitDirectory) {
        const candidate = findUnifiedAgentById(settings, assistantId)
        const compatible = candidate
          ? isAgentCompatibleWithDirectory(
              candidate.workspaceAccessPolicy,
              explicitDirectory,
            ).ok
          : false
        if (!compatible) {
          new Notice(
            t(
              'chat.workingDirectory.unavailable',
              'This folder is not available to the selected Agent.',
            ),
          )
          return
        }
      }
      preferencesController.selectAssistant(assistantId)
    },
    [getCliLate, preferencesController, settings, t],
  )

  const handleChatModeChange = useCallback(
    (nextMode: ChatMode) => {
      preferencesController.changeChatMode(nextMode)
    },
    [preferencesController],
  )

  const handleYoloChange = useCallback(
    (enabled: boolean) => {
      if (enabled && !settings.chatOptions.fullAccessWarningConfirmed) {
        new AcknowledgementModal(app, {
          title: t(
            'chatMode.fullAccessWarning.title',
            'Please confirm before enabling YOLO Mode',
          ),
          messages: [
            t(
              'chatMode.fullAccessWarning.description',
              'YOLO Mode auto-approves all tool calls, including file edits and terminal commands. Review the risks before continuing:',
            ),
          ],
          items: [
            t(
              'chatMode.fullAccessWarning.permission',
              'Tools run without per-call approval. Dangerous command prefixes are still blocked.',
            ),
            t(
              'chatMode.fullAccessWarning.cost',
              'Autonomous runs may consume significant model resources and incur higher costs.',
            ),
            t(
              'chatMode.fullAccessWarning.backup',
              'Back up important content in advance to avoid unintended changes.',
            ),
          ],
          checkboxLabel: t(
            'chatMode.fullAccessWarning.checkbox',
            'I understand the risks above and accept responsibility for proceeding',
          ),
          cancelText: t('chatMode.fullAccessWarning.cancel', 'Cancel'),
          confirmText: t(
            'chatMode.fullAccessWarning.confirm',
            'Continue with YOLO Mode',
          ),
          confirmTone: 'warning',
          onConfirm: () => {
            preferencesController.toggleYolo(true)
            void (async () => {
              try {
                await setSettings({
                  ...settings,
                  chatOptions: {
                    ...settings.chatOptions,
                    agentYoloEnabled: true,
                    fullAccessWarningConfirmed: true,
                  },
                })
              } catch (error: unknown) {
                console.error(
                  'Failed to persist YOLO preference and warning confirmation',
                  error,
                )
              }
            })()
          },
        }).open()
        return
      }

      preferencesController.toggleYolo(enabled)
      void persistPreferredYolo(enabled)
    },
    [
      app,
      persistPreferredYolo,
      preferencesController,
      setSettings,
      settings,
      t,
    ],
  )

  const applyAssistantDefaultModel = useCallback(
    (assistantModelId?: string | null) => {
      preferencesController.applyAssistantDefaultModel(assistantModelId)
    },
    [preferencesController],
  )

  const handleRuntimeChange = useCallback(
    (runtimeId: ChatRuntimeId) => {
      if (runtimeId === activeRuntimeId) return
      if (runtimeId !== 'yolo' && (!cliRuntimeScope || !cliRuntimeAvailable)) {
        return
      }
      const cliLate = getCliLate()
      cliModeRequestGenerationRef.current += 1
      const isLatestNavigation = beginChatRuntimeNavigation(
        runtimeNavigationGenerationRef,
        () => chatMountedRef.current,
      )

      const applyRuntimeChange = () => {
        if (!isLatestNavigation()) return
        if (runtimeId === 'yolo') {
          preferencesController.applyOverrides(
            preferencesController.conversationOverridesRef.current.get(
              currentConversationId,
            ) ?? null,
          )
          activeRuntimeIdRef.current = 'yolo'
          setRequestedRuntimeId('yolo')
          persistChatRuntimePreference('yolo')
          return
        }
        if (!cliRuntimeScope) return
        preferencesController.conversationOverridesRef.current.set(
          cliLate.activeHistoryConversationId,
          preferencesController.getSnapshot().conversationOverrides,
        )
        const controller = cliRuntimeScope.selectConversationRuntime(runtimeId)
        if (!controller.getSnapshot().sessionRef) {
          controller.stageConfiguration(
            resolveCliRuntimePreference(
              cliLate.cliPreferenceSettingsRef.current,
              runtimeId,
              cliLate.cliModelCatalog.get(runtimeId) ?? [],
            ),
          )
        }
        const nextCliConversationId = uuidv4()
        cliLate.setCliConversationController(controller)
        cliLate.setCliConversationId(nextCliConversationId)
        preferencesController.applyOverrides(null)
        lastCliRuntimeIdRef.current = runtimeId
        activeRuntimeIdRef.current = runtimeId
        setRequestedRuntimeId(runtimeId)
        persistChatRuntimePreference(runtimeId)
        const modePreference = resolveCliModePreference(
          cliLate.cliPreferenceSettingsRef.current,
          runtimeId,
          preferencesController.conversationOverridesRef.current.get(
            nextCliConversationId,
          ) ?? null,
        )
        cliLate.setCliChatMode(modePreference.mode)
        cliLate.setCliYoloEnabled(modePreference.yoloEnabled)
      }

      if (activeRuntimeId === 'yolo') {
        try {
          applyRuntimeChange()
        } catch (error) {
          new Notice(
            t(
              'chat.cliSurface.runtimeError',
              'Could not start the CLI runtime: {message}',
            ).replace(
              '{message}',
              error instanceof Error ? error.message : String(error),
            ),
          )
        }
        return
      }

      void cliLate.transitionCliSession((isCurrent) => {
        if (!isCurrent() || !isLatestNavigation()) return
        applyRuntimeChange()
      })
    },
    [
      activeRuntimeId,
      chatMountedRef,
      cliRuntimeAvailable,
      cliRuntimeScope,
      currentConversationId,
      getCliLate,
      persistChatRuntimePreference,
      preferencesController,
      t,
    ],
  )

  // 工作目录领域（backup 语义照抄）：可选性 = 目录存在 + Agent 文件策略
  // 兼容；弹窗根 = workspace agent 的 home，普通 assistant 为 vault 根；
  // 冻结（已开始对话/加载中）时选择与变更均被门控。状态经 late state 读取。
  const isWorkingDirectorySelectable = useCallback(
    (folderPath: string) => {
      let directory: string
      try {
        directory = normalizeConversationWorkingDirectory(folderPath || '/')
      } catch {
        return false
      }
      const vaultPath = directory === '/' ? '' : directory.slice(1)
      const entry = vaultPath
        ? app.vault.getAbstractFileByPath(vaultPath)
        : app.vault.getRoot()
      if (!(entry instanceof TFolder)) return false
      return isAgentCompatibleWithDirectory(
        getCliLate().selectedAssistantFilePolicy,
        directory,
      ).ok
    },
    [app.vault, getCliLate],
  )

  const handleWorkingDirectoryChange = useCallback(
    (folderPath: string | undefined) => {
      const late = getCliLate()
      if (late.conversationWorkingDirectoryLocked) return
      if (folderPath === undefined) {
        late.setConversationWorkingDirectory(undefined)
        return
      }
      if (!isWorkingDirectorySelectable(folderPath)) {
        new Notice(
          t(
            'chat.workingDirectory.unavailable',
            'This folder is not available to the selected Agent.',
          ),
        )
        return
      }
      const directory = normalizeConversationWorkingDirectory(folderPath || '/')
      late.setConversationWorkingDirectory(directory)
    },
    [getCliLate, isWorkingDirectorySelectable, t],
  )

  const handleOpenWorkingDirectoryPicker = useCallback(() => {
    const late = getCliLate()
    if (late.conversationWorkingDirectoryLocked) return
    const policy = late.selectedAssistantFilePolicy
    const rootPath = policy?.enabled
      ? normalizeConversationWorkingDirectory(
          policy.workspaceRoot.trim() || '/',
        ).replace(/^\/+/, '')
      : undefined
    const existing = late.conversationWorkingDirectory
      ? [late.conversationWorkingDirectory.replace(/^\/+/, '')].filter(
          (path) => path !== '',
        )
      : []
    new FolderPickerModal(
      app,
      app.vault,
      existing,
      false,
      handleWorkingDirectoryChange,
      rootPath || undefined,
      isWorkingDirectorySelectable,
    ).open()
  }, [
    app,
    getCliLate,
    handleWorkingDirectoryChange,
    isWorkingDirectorySelectable,
  ])

  return {
    // 运行时切换状态
    activeRuntimeId,
    activeRuntimeIdRef,
    setRequestedRuntimeId,
    lastCliRuntimeIdRef,
    initialActiveRuntimeId,
    initialCliModePreference,
    cliModeRequestGenerationRef,
    prePlanCliModeByConversationRef,
    runtimeNavigationGenerationRef,
    handleRuntimeChange,

    // 偏好六件套快照（唯一 owner 是 preferencesController）
    conversationModelId: preferencesSnapshot.conversationModelId,
    conversationAssistantId: preferencesSnapshot.conversationAssistantId,
    reasoningLevel: preferencesSnapshot.reasoningLevel,
    chatMode: preferencesSnapshot.chatMode,
    yoloEnabled: preferencesSnapshot.yoloEnabled,
    conversationOverrides: preferencesSnapshot.conversationOverrides,

    // 原始字段 setter（Dispatch<SetStateAction<T>> 同构）+ 每会话 Ref 缓存：
    // 供 useYoloChatSession / useCliRuntimeOrchestration / useChatDomainActions
    // 等消费 hook 的会话生命周期逻辑直接替换原 useState setter。
    setConversationModelId: preferencesController.setConversationModelId,
    setConversationAssistantId:
      preferencesController.setConversationAssistantId,
    setReasoningLevel: preferencesController.setReasoningLevel,
    setChatMode: preferencesController.setChatMode,
    setYoloEnabled: preferencesController.setYoloEnabled,
    setConversationOverrides: preferencesController.applyOverrides,
    conversationModelIdRef: preferencesController.conversationModelIdRef,
    conversationReasoningLevelRef:
      preferencesController.conversationReasoningLevelRef,
    conversationAssistantIdRef:
      preferencesController.conversationAssistantIdRef,
    conversationOverridesRef: preferencesController.conversationOverridesRef,

    // switchConversation：会话加载/新建/分支时一次性提交恢复值 + 写入 Ref
    // 缓存，供 useYoloChatSession 替换原「setX + 手动 ref.set」散落写法。
    switchConversation: preferencesController.switchConversation,

    // controller 实例本身：供 useChatInputController 直接注入（跨渲染稳定，
    // 不需要 late ref）——见架构治理第三步分期 C1，消灭事件处理器中的偏好
    // 残留 late 绑定。
    preferencesController,

    // persist* 全族
    persistReasoningLevelForModel,
    persistChatRuntimePreference,

    // assistant / mode / yolo 语义命令
    applyAssistantDefaultModel,
    handleConversationAssistantSelect,
    handleChatModeChange,
    handleYoloChange,
    onAssistantDefaultModelApplied:
      preferencesController.onAssistantDefaultModelApplied,

    // 工作目录领域（fork 特有）
    isWorkingDirectorySelectable,
    handleWorkingDirectoryChange,
    handleOpenWorkingDirectoryPicker,

    // CLI 编排相关 late ref（仅 handleRuntimeChange + 工作目录领域使用；
    // 偏好六件套已不再经 late 绑定）
    cliRuntimeSwitchLateStateRef,
  }
}
