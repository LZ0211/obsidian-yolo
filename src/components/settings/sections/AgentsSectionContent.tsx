import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import {
  BookOpen,
  Check,
  ChevronDown,
  Copy,
  Edit,
  Eye,
  EyeOff,
  Folder,
  Key,
  Maximize2,
  Trash2,
  User,
  Wrench,
  X,
} from 'lucide-react'
import { App, Notice, TFile } from 'obsidian'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { createPortal } from 'react-dom'

import { useLanguage } from '../../../contexts/language-context'
import { usePlugin } from '../../../contexts/plugin-context'
import { useSettings } from '../../../contexts/settings-context'
import {
  ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE,
  getAssistantModelSelectValue,
  modelIdFromAssistantModelSelectValue,
} from '../../../core/agent/assistant-model'
import {
  BUILTIN_TOOL_CATEGORY_I18N,
  BUILTIN_TOOL_CATEGORY_ORDER,
  type BuiltinToolCategory,
  FILE_EDIT_GROUP_TOOL_NAME,
  FILE_OPS_GROUP_TOOL_NAME,
  MEMORY_OPS_GROUP_TOOL_NAME,
  WEB_OPS_GROUP_TOOL_NAME,
  WEB_OPS_SPLIT_ACTION_TOOL_NAMES,
  getBuiltinToolCategory,
  getBuiltinToolDisplayIndex,
  getBuiltinToolUiMeta,
} from '../../../core/agent/builtinToolUiMeta'
import { countEnabledVisibleAssistantTools } from '../../../core/agent/tool-display-count'
import {
  buildDefaultBuiltinToolPreferences,
  buildServerToolTokenBudgets,
  getAssistantToolApprovalMode,
  getAssistantToolDisclosureMode,
  getAssistantToolPreferences,
  getDefaultApprovalModeForTool,
  getEnabledAssistantToolNames,
  getExplicitlyEnabledAssistantToolNames,
  isAssistantToolEnabled,
  resolveDefaultDisclosureModeForServer,
} from '../../../core/agent/tool-preferences'
import { applyDynamicToolDescriptions } from '../../../core/agent/tool-selection'
import {
  getInjectedToolGroupName,
  isInjectedBridgeToolName,
} from '../../../core/mcp/injectionBridge'
import { getJsSandboxSettings } from '../../../core/mcp/jsSandboxSettings'
import {
  LOCAL_FS_EDIT_TOOL_NAMES,
  LOCAL_FS_PATH_OPERATION_TOOL_NAMES,
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
  USER_FACING_LOCAL_TOOL_SHORT_NAMES,
  getLocalFileToolServerName,
} from '../../../core/mcp/localFileTools'
import { parseToolName } from '../../../core/mcp/tool-name-utils'
import { getYoloSkillsDir } from '../../../core/paths/yoloPaths'
import {
  LiteSkillEntry,
  getLiteSkillDocument,
  humanizeSkillName,
} from '../../../core/skills/liteSkills'
import {
  getDisabledSkillNameSet,
  resolveAssistantSkillPolicy,
} from '../../../core/skills/skillPolicy'
import { useLiteSkillEntries } from '../../../hooks/useLiteSkillEntries'
import {
  type AgentShareTokenScope,
  type WorkspaceAgent,
  type WorkspaceAgentBehaviorOverrides,
  YoloSettings,
} from '../../../settings/schema/setting.types'
import {
  AgentPersona,
  Assistant,
  AssistantSkillLoadMode,
  AssistantToolApprovalMode,
  AssistantToolDisclosureMode,
  AssistantToolPreference,
} from '../../../types/assistant.types'
import { McpTool } from '../../../types/mcp.types'
import { stableStringify } from '../../../utils/json/stableStringify'
import {
  estimateJsonTokens,
  estimateTextTokens,
} from '../../../utils/llm/contextTokenEstimate'
import { formatTokenCount } from '../../../utils/llm/formatTokenCount'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextArea } from '../../common/ObsidianTextArea'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { SimpleSelect } from '../../common/SimpleSelect'
import { ConfirmModal } from '../../modals/ConfirmModal'
import { openIconPicker } from '../assistants/AssistantIconPicker'

import {
  normalizeToolPreferencesForPersistence,
  normalizeToolSelectionForPersistence,
} from './agentToolPersistence'
import { AgentWorkspaceScopeEditor } from './AgentWorkspaceScopeEditor'
import { AgentWorkspaceScopeEditor as TemplateWorkspaceScopeEditor } from './TemplateWorkspaceScopeEditor'
type AgentsSectionContentProps = {
  app: App
  onClose: () => void
  initialAssistantId?: string
  initialCreate?: boolean
  workspaceAgentId?: string
  workspaceAgentTemplateId?: string
  workspaceAgentName?: string
  workspaceRoot?: string
}

type WorkspaceAgentDraft = {
  agent: WorkspaceAgent
  template: Assistant
  effective: Assistant
  /** Whether this workspace agent exposes Agent mode in the chat input.
   *  YOLO is handled entirely by the upstream's chat-input toggle and
   *  per-conversation override — there is no per-workspace-agent YOLO
   *  setting. */
  agentModeAllowed: boolean
}

function buildInitialWorkspaceAgentDraft(input: {
  workspaceAgentId?: string
  workspaceAgentTemplateId?: string
  workspaceAgentName?: string
  workspaceRoot?: string
  workspaceAgents: WorkspaceAgent[]
  assistants: Assistant[]
}): WorkspaceAgentDraft | null {
  if (input.workspaceAgentId) {
    const agent = input.workspaceAgents.find(
      (item) => item.id === input.workspaceAgentId,
    )
    const template = agent
      ? input.assistants.find((item) => item.id === agent.templateId)
      : null
    return agent && template
      ? toWorkspaceAgentEffectiveDraft({
          agent,
          template,
        })
      : null
  }
  if (input.workspaceAgentTemplateId) {
    const template = input.assistants.find(
      (assistant) => assistant.id === input.workspaceAgentTemplateId,
    )
    return template
      ? createWorkspaceAgentDraft({
          template,
          name: input.workspaceAgentName,
          workspaceRoot: input.workspaceRoot,
        })
      : null
  }
  return null
}

type AgentEditorTab = 'profile' | 'tools' | 'skills' | 'workspace' | 'tokens'

type AgentToolView = {
  fullName: string
  toggleTargets: string[]
  displayName: string
  description: string
}

type SkillRowView = LiteSkillEntry & {
  enabled: boolean
  loadMode: AssistantSkillLoadMode
}

const EDIT_FS_TOOL_NAME_SET = new Set<string>(LOCAL_FS_EDIT_TOOL_NAMES)
const PATH_FS_TOOL_NAME_SET = new Set<string>(
  LOCAL_FS_PATH_OPERATION_TOOL_NAMES,
)
const SPLIT_MEMORY_TOOL_NAME_SET = new Set<string>(
  LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES,
)
const SPLIT_WEB_TOOL_NAME_SET = new Set<string>(WEB_OPS_SPLIT_ACTION_TOOL_NAMES)

const AGENT_EDITOR_TABS: AgentEditorTab[] = [
  'profile',
  'tools',
  'skills',
  'workspace',
]

const AGENT_EDITOR_TAB_ICONS = {
  profile: User,
  tools: Wrench,
  skills: BookOpen,
  workspace: Folder,
  tokens: Key,
} as const

const DEFAULT_PERSONA: AgentPersona = 'balanced'

// --- Token list helpers ------------------------------------------------------

// HTML5 `<input type="date">` works in YYYY-MM-DD local-date form. We treat
// the date as "valid through end of that day in local time" so a 30-day token
// created today is still usable at 23:59 on day +30.
function formatDateInput(date: Date): string {
  const yyyy = date.getFullYear()
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function parseDateInputToEndOfDayMs(value: string): number | null {
  if (!value) return null
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) return null
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  const day = Number(match[3])
  // 23:59:59.999 local — slightly past-end so a same-day comparison treats the
  // token as still valid throughout the expiry date.
  return new Date(year, month, day, 23, 59, 59, 999).getTime()
}

// Mask the secret middle for inline display (à la API-key UIs). Keeps the
// `yolo_share_v1_<id>_` prefix readable for support purposes and the last
// 4 characters of the secret as a fingerprint.
function maskShareTokenPlaintext(plaintext: string): string {
  const idx = plaintext.lastIndexOf('_')
  if (idx < 0 || idx >= plaintext.length - 4) return plaintext
  const head = plaintext.slice(0, idx + 5)
  const tail = plaintext.slice(-4)
  return `${head}**********${tail}`
}

type TokenDisplayStatus = 'valid' | 'expired' | 'disabled' | 'root_mismatch'

function deriveTokenDisplayStatus(
  token: {
    expiresAt?: number
    disabled?: boolean
    scope: AgentShareTokenScope
  },
  now: number,
  currentRootHash: string | null,
): TokenDisplayStatus {
  if (token.disabled === true) return 'disabled'
  if (token.expiresAt != null && token.expiresAt <= now) return 'expired'
  if (
    token.scope.kind === 'workspaceRoot' &&
    currentRootHash != null &&
    token.scope.rootHash !== currentRootHash
  ) {
    return 'root_mismatch'
  }
  return 'valid'
}

const skillDefaultContextTokenCache = new Map<string, number>()
// Caches the in-flight or resolved promise so concurrent calls dedupe to a
// single estimateJsonTokens invocation.
const toolDefaultContextTokenCache = new Map<string, Promise<number>>()

function fnv1aHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function buildToolTokenPayload(tool: McpTool): Record<string, unknown> {
  return {
    name: tool.name,
    description: tool.description ?? '',
    inputSchema: tool.inputSchema ?? {},
  }
}

/**
 * Token estimate payload for an on-demand tool stub. Mirrors the stable
 * stub registration: name + truncated description + permissive schema.
 * Kept conservative so the estimate is unaffected by which provider is
 * actually used at request time.
 */
function buildDeferredToolStubTokenPayload(tool: McpTool): unknown {
  const description = (tool.description ?? '').trim()
  const truncatedDescription =
    description.length > 200 ? `${description.slice(0, 197)}...` : description
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: truncatedDescription,
      parameters: { type: 'object', properties: {} },
    },
  }
}

function estimateToolDefaultContextTokens(tool: McpTool): Promise<number> {
  const payload = buildToolTokenPayload(tool)
  const cacheKey = `${tool.name}:${fnv1aHash(stableStringify(payload))}`
  const cached = toolDefaultContextTokenCache.get(cacheKey)
  if (cached) {
    return cached
  }
  const pending = estimateJsonTokens(payload).catch((error) => {
    toolDefaultContextTokenCache.delete(cacheKey)
    throw error
  })
  toolDefaultContextTokenCache.set(cacheKey, pending)
  return pending
}

function groupToolsByServer(tools: readonly McpTool[]): Map<string, McpTool[]> {
  const serverTools = new Map<string, McpTool[]>()
  for (const tool of tools) {
    let serverName: string
    try {
      serverName = parseToolName(tool.name).serverName
    } catch {
      continue
    }
    const bucket = serverTools.get(serverName) ?? []
    bucket.push(tool)
    serverTools.set(serverName, bucket)
  }
  return serverTools
}

function buildSkillMetadataPrompt(skill: LiteSkillEntry): string {
  return `- name: ${skill.name} | description: ${skill.description}`
}

function buildAlwaysOnSkillPrompt({
  entry,
  content,
}: {
  entry: LiteSkillEntry
  content: string
}): string {
  return `<skill name="${entry.name}" path="${entry.path}">
${content}
</skill>`
}

async function estimateSkillDefaultContextTokens({
  app,
  settings,
  skill,
}: {
  app: App
  settings: YoloSettings
  skill: SkillRowView
}): Promise<number> {
  if (skill.loadMode === 'lazy') {
    return await estimateTextTokens(buildSkillMetadataPrompt(skill))
  }

  const abstractFile = app.vault.getAbstractFileByPath(skill.path)
  const cacheKey =
    abstractFile instanceof TFile
      ? `${skill.path}:${abstractFile.stat.mtime}:${skill.loadMode}`
      : `${skill.path}:${skill.loadMode}`
  const cached = skillDefaultContextTokenCache.get(cacheKey)
  if (cached !== undefined) {
    return cached
  }

  const document = await getLiteSkillDocument({
    app,
    name: skill.name,
    settings,
  })
  if (!document) {
    return 0
  }

  const count = await estimateTextTokens(
    buildAlwaysOnSkillPrompt({
      entry: document.entry,
      content: document.content,
    }),
  )
  skillDefaultContextTokenCache.set(cacheKey, count)
  return count
}

function createNewAgent(): Assistant {
  return {
    id: crypto.randomUUID(),
    name: '',
    description: '',
    systemPrompt: '',
    persona: DEFAULT_PERSONA,
    // Omit modelId so new agents follow the global chat model.
    enableTools: true,
    includeBuiltinTools: true,
    enabledToolNames: [],
    toolPreferences: buildDefaultBuiltinToolPreferences(),
    toolServerPreferences: {},
    enabledSkills: [],
    skillPreferences: {},
    includeCurrentFileContent: true,
    timeContextEnabled: true,
    delegatable: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function toDraftAgent(assistant: Assistant): Assistant {
  return {
    ...assistant,
    persona: assistant.persona ?? DEFAULT_PERSONA,
    // Preserve empty/undefined modelId as "follow default".
    modelId: assistant.modelId || undefined,
    enabledToolNames: getExplicitlyEnabledAssistantToolNames(assistant),
    toolPreferences: getAssistantToolPreferences(assistant),
    toolServerPreferences: assistant.toolServerPreferences ?? {},
    enabledSkills: assistant.enabledSkills ?? [],
    skillPreferences: assistant.skillPreferences ?? {},
    enableTools: assistant.enableTools ?? true,
    includeBuiltinTools: assistant.includeBuiltinTools ?? true,
    includeCurrentFileContent: assistant.includeCurrentFileContent ?? true,
    timeContextEnabled: assistant.timeContextEnabled ?? true,
    delegatable: assistant.delegatable === true,
  }
}

function toWorkspaceAgentEffectiveDraft(input: {
  agent: WorkspaceAgent
  template: Assistant
}): WorkspaceAgentDraft {
  const overrides = input.agent.behaviorOverrides ?? {}
  return {
    agent: input.agent,
    template: input.template,
    effective: toDraftAgent(
      {
        ...input.template,
        id: input.agent.id,
        name: overrides.name ?? input.agent.name,
        systemPrompt:
          overrides.systemPromptOverride ??
          overrides.promptOverride ??
          input.template.systemPrompt,
        toolPreferences: {
          ...(input.template.toolPreferences ?? {}),
          ...(overrides.toolConfigOverrides ?? {}),
        },
        enabledToolNames: getExplicitlyEnabledAssistantToolNames(
          input.template,
        ).filter(
          (toolName) => !(overrides.disabledToolNames ?? []).includes(toolName),
        ),
        skillPreferences: {
          ...(input.template.skillPreferences ?? {}),
          ...(overrides.skillConfigOverrides ?? {}),
        },
        enabledSkills: (input.template.enabledSkills ?? []).filter(
          (skillName) =>
            !(overrides.disabledSkillIds ?? []).includes(skillName),
        ),
        modePolicy: input.template.modePolicy,
      },
    ),
    // Default true: omitted override means "use default" which exposes Agent.
    // Only an explicit `false` removes the Agent option.
    agentModeAllowed: overrides.agentModeAllowed ?? true,
  }
}

function createWorkspaceAgentDraft(input: {
  template: Assistant
  name?: string
  workspaceRoot?: string
}): WorkspaceAgentDraft {
  const now = Date.now()
  const name = input.name?.trim() || `${input.template.name} Workspace Agent`
  const agent: WorkspaceAgent = {
    id: crypto.randomUUID(),
    name,
    templateId: input.template.id,
    behaviorOverrides: {},
    workspacePolicy: {
      workspaceRoot: input.workspaceRoot?.trim() || '/',
      readAllowlist: [],
      readDenylist: [],
      writeDenylist: [],
    },
    shareTokens: [],
    createdAt: now,
    updatedAt: now,
  }
  return toWorkspaceAgentEffectiveDraft({
    agent,
    template: input.template,
  })
}

function buildWorkspaceAgentBehaviorOverrides(
  agent: WorkspaceAgent,
  template: Assistant,
  effectiveDraft: Assistant,
  agentModeAllowed: boolean,
): WorkspaceAgentBehaviorOverrides {
  const overrides: WorkspaceAgentBehaviorOverrides = {
    ...(agent.behaviorOverrides ?? {}),
  }
  const name = effectiveDraft.name.trim()
  if (name && name !== agent.name) {
    overrides.name = name
  } else {
    delete overrides.name
  }

  if (effectiveDraft.systemPrompt !== template.systemPrompt) {
    overrides.systemPromptOverride = effectiveDraft.systemPrompt
  } else {
    delete overrides.systemPromptOverride
    delete overrides.promptOverride
  }
  const disabledToolNames = getEnabledAssistantToolNames(template).filter(
    (toolName) => !isAssistantToolEnabled(effectiveDraft, toolName),
  )
  if (disabledToolNames.length > 0) {
    overrides.disabledToolNames = disabledToolNames
  } else {
    delete overrides.disabledToolNames
  }

  const toolConfigOverrides: NonNullable<
    WorkspaceAgentBehaviorOverrides['toolConfigOverrides']
  > = {}
  for (const toolName of getEnabledAssistantToolNames(template)) {
    const templatePreference = template.toolPreferences?.[toolName]
    const draftPreference = effectiveDraft.toolPreferences?.[toolName]
    const override: NonNullable<
      WorkspaceAgentBehaviorOverrides['toolConfigOverrides']
    >[string] = {}
    if (
      templatePreference?.approvalMode === 'full_access' &&
      draftPreference?.approvalMode === 'require_approval'
    ) {
      override.approvalMode = 'require_approval'
    }
    if (
      templatePreference?.disclosureMode === 'always' &&
      draftPreference?.disclosureMode === 'on_demand'
    ) {
      override.disclosureMode = 'on_demand'
    }
    if (Object.keys(override).length > 0) {
      toolConfigOverrides[toolName] = override
    }
  }
  if (Object.keys(toolConfigOverrides).length > 0) {
    overrides.toolConfigOverrides = toolConfigOverrides
  } else {
    delete overrides.toolConfigOverrides
  }

  const disabledSkillIds = (template.enabledSkills ?? []).filter(
    (skillName) => !effectiveDraft.enabledSkills?.includes(skillName),
  )
  if (disabledSkillIds.length > 0) {
    overrides.disabledSkillIds = disabledSkillIds
  } else {
    delete overrides.disabledSkillIds
  }

  const skillConfigOverrides: NonNullable<
    WorkspaceAgentBehaviorOverrides['skillConfigOverrides']
  > = {}
  for (const skillName of template.enabledSkills ?? []) {
    const templatePreference = template.skillPreferences?.[skillName]
    const draftPreference = effectiveDraft.skillPreferences?.[skillName]
    if (
      templatePreference?.loadMode === 'always' &&
      draftPreference?.loadMode === 'lazy'
    ) {
      skillConfigOverrides[skillName] = { loadMode: 'lazy' }
    }
  }
  if (Object.keys(skillConfigOverrides).length > 0) {
    overrides.skillConfigOverrides = skillConfigOverrides
  } else {
    delete overrides.skillConfigOverrides
  }

  // Only persist when Agent is explicitly disabled; the default (true) is
  // implicit so we keep the saved settings minimal.
  if (!agentModeAllowed) {
    overrides.agentModeAllowed = false
  } else {
    delete overrides.agentModeAllowed
  }
  return overrides
}

function isToolWithinWorkspaceAgentTemplate(
  toolName: string,
  template: Assistant | null | undefined,
): boolean {
  if (!template) return true
  return isAssistantToolEnabled(template, toolName)
}

function isSkillWithinWorkspaceAgentTemplate(
  skillName: string,
  template: Assistant | null | undefined,
): boolean {
  if (!template) return true
  return resolveAssistantSkillPolicy({
    assistant: template,
    skillName,
  }).enabled
}

function updateDraftToolPreferences(
  assistant: Assistant,
  updater: (
    current: Record<string, AssistantToolPreference>,
  ) => Record<string, AssistantToolPreference>,
): Assistant {
  const current = {
    ...getAssistantToolPreferences(assistant),
  }
  const nextToolPreferences = updater(current)
  const nextEnabledToolNames = getExplicitlyEnabledAssistantToolNames({
    ...assistant,
    toolPreferences: nextToolPreferences,
  })

  return {
    ...assistant,
    toolPreferences: nextToolPreferences,
    enabledToolNames: nextEnabledToolNames,
  }
}

export function AgentsSectionContent({
  app,
  onClose,
  initialAssistantId,
  initialCreate,
  workspaceAgentId,
  workspaceAgentTemplateId,
  workspaceAgentName,
  workspaceRoot,
}: AgentsSectionContentProps) {
  const plugin = usePlugin()
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const assistants = settings.assistants || []
  const workspaceAgents = settings.workspaceAgents || []
  const enableToolDisclosure = settings.mcp.enableToolDisclosure
  const isDirectEditEntry = Boolean(initialAssistantId)
  const isDirectCreateEntry = Boolean(initialCreate)
  const isWorkspaceAgentEntry = Boolean(
    workspaceAgentId || workspaceAgentTemplateId,
  )
  const isDirectEntry =
    isDirectEditEntry || isDirectCreateEntry || isWorkspaceAgentEntry
  const [workspaceAgentDraft, setWorkspaceAgentDraft] =
    useState<WorkspaceAgentDraft | null>(() =>
      buildInitialWorkspaceAgentDraft({
        workspaceAgentId,
        workspaceAgentTemplateId,
        workspaceAgentName,
        workspaceRoot,
        workspaceAgents,
        assistants,
      }),
    )
  const [draftAgent, setDraftAgent] = useState<Assistant | null>(() => {
    if (workspaceAgentDraft) {
      return workspaceAgentDraft.effective
    }
    if (initialCreate) {
      const draft = createNewAgent()
      draft.name = t('settings.agent.editorDefaultName', 'New agent')
      return draft
    }
    if (!initialAssistantId) {
      return null
    }
    const initialAssistant = assistants.find(
      (assistant) => assistant.id === initialAssistantId,
    )
    if (!initialAssistant) {
      return null
    }
    return toDraftAgent(initialAssistant)
  })
  const [activeTab, setActiveTab] = useState<AgentEditorTab>('profile')
  const [isSystemPromptExpanded, setIsSystemPromptExpanded] = useState(false)
  const expandedPromptTextareaRef = useRef<HTMLTextAreaElement | null>(null)
  const systemPromptWrapperRef = useRef<HTMLDivElement | null>(null)
  const [portalContainer, setPortalContainer] = useState<HTMLElement>()
  const sectionRef = useCallback((node: HTMLDivElement | null) => {
    setPortalContainer(node?.ownerDocument.body)
  }, [])
  const systemPromptExpandButtonRef = useRef<HTMLButtonElement | null>(null)
  const systemPromptOverlayPanelRef = useRef<HTMLDivElement | null>(null)
  const previousSystemPromptFocusRef = useRef<HTMLElement | null>(null)
  const [systemPromptOverlayTarget, setSystemPromptOverlayTarget] =
    useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!isSystemPromptExpanded) {
      setSystemPromptOverlayTarget(null)
      return
    }
    const wrapper = systemPromptWrapperRef.current
    const target =
      wrapper?.closest<HTMLElement>('.modal') ??
      wrapper?.ownerDocument.body ??
      null
    setSystemPromptOverlayTarget(target)
  }, [isSystemPromptExpanded])

  useEffect(() => {
    if (!isSystemPromptExpanded || !systemPromptOverlayTarget) {
      return
    }

    previousSystemPromptFocusRef.current =
      systemPromptExpandButtonRef.current ??
      (document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null)
    const panel = systemPromptOverlayPanelRef.current
    if (!panel) return

    const focusableSelector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
    const focusFirst = () => {
      const textarea = expandedPromptTextareaRef.current
      if (textarea) {
        textarea.focus()
        return
      }
      const first = panel.querySelector<HTMLElement>(focusableSelector)
      if (first) first.focus()
      else panel.focus()
    }
    focusFirst()

    const handleTab = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const focusable = Array.from(
        panel.querySelectorAll<HTMLElement>(focusableSelector),
      )
      if (focusable.length === 0) {
        event.preventDefault()
        panel.focus()
        return
      }
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleTab)
    return () => {
      document.removeEventListener('keydown', handleTab)
      previousSystemPromptFocusRef.current?.focus()
      previousSystemPromptFocusRef.current = null
    }
  }, [isSystemPromptExpanded, systemPromptOverlayTarget])
  const [availableTools, setAvailableTools] = useState<McpTool[]>([])
  // Token UI state. The `tokenFormState` drives the create/edit dialog —
  // `null` = closed, `{ mode: 'create' }` = create flow, `{ mode: 'edit', tokenId }` = edit.
  // `revealedTokenIds` tracks which rows are showing the unmasked plaintext;
  // toggling the eye button flips membership.
  const [generatingToken, setGeneratingToken] = useState(false)
  type TokenFormState =
    | null
    | {
        mode: 'create'
      }
    | {
        mode: 'edit'
        tokenId: string
      }
  const [tokenFormState, setTokenFormState] = useState<TokenFormState>(null)
  const [tokenFormLabel, setTokenFormLabel] = useState('')
  const [tokenFormScopeKind, setTokenFormScopeKind] = useState<
    'agent' | 'workspaceRoot'
  >('agent')
  // Date picker stores the date in YYYY-MM-DD form (HTML5 input value). The
  // default is today + 30 days, matching the user spec.
  const [tokenFormExpiresAt, setTokenFormExpiresAt] = useState<string>('')
  const [revealedTokenIds, setRevealedTokenIds] = useState<Set<string>>(
    () => new Set(),
  )

  // Live list of tokens for the current workspace agent — read straight from
  // settings so disable/delete/expiry-update flows reflect immediately after
  // setSettings completes.
  const workspaceAgentShareTokens = useMemo(() => {
    if (!workspaceAgentDraft) return []
    const agent = settings.workspaceAgents.find(
      (a) => a.id === workspaceAgentDraft.agent.id,
    )
    return (agent?.shareTokens ?? []).filter((t) => !t.revokedAt)
  }, [settings.workspaceAgents, workspaceAgentDraft])

  // Current persisted workspace root's hash for this agent, so the token
  // list can flag `workspaceRoot`-scoped tokens whose root has since changed
  // (the server already rejects these — this just surfaces it in the UI).
  const currentAgentRootHash = useMemo(() => {
    if (!workspaceAgentDraft) return null
    return (
      (
        plugin as unknown as {
          getWorkspaceAgentRootHash?: (agentId: string) => string | null
        }
      ).getWorkspaceAgentRootHash?.(workspaceAgentDraft.agent.id) ?? null
    )
  }, [plugin, workspaceAgentDraft, settings.workspaceAgents])

  const handleGenerateToken = async () => {
    if (!workspaceAgentDraft || tokenFormState?.mode !== 'create') return
    const agentId = workspaceAgentDraft.agent.id
    setGeneratingToken(true)
    try {
      const expiresAtMs = parseDateInputToEndOfDayMs(tokenFormExpiresAt)
      const result = await (
        plugin as unknown as {
          createWorkspaceAgentShareToken?: (
            agentId: string,
            input: {
              label?: string
              scopeKind: 'agent' | 'workspaceRoot'
              expiresAt?: number
            },
          ) => Promise<{ plaintext: string }>
        }
      ).createWorkspaceAgentShareToken?.(agentId, {
        label: tokenFormLabel.trim() || undefined,
        scopeKind: tokenFormScopeKind,
        ...(expiresAtMs != null ? { expiresAt: expiresAtMs } : {}),
      })
      if (result) {
        closeTokenForm()
      }
    } catch (err) {
      new Notice(
        err instanceof Error
          ? err.message
          : t('settings.agent.editorTokenError', 'Failed to generate token.'),
      )
    } finally {
      setGeneratingToken(false)
    }
  }

  // Open create dialog with sensible defaults: today + 30 days, agent scope,
  // empty label. Keeps the previous create-token UX accessible from the new
  // "Create Token" button in the list header.
  const openCreateTokenForm = () => {
    setTokenFormLabel('')
    setTokenFormScopeKind('agent')
    setTokenFormExpiresAt(formatDateInput(addDays(new Date(), 30)))
    setTokenFormState({ mode: 'create' })
  }

  // Open edit dialog pre-filled from the selected token. Edit only changes
  // metadata (label + expiry) — the hash stays untouched so existing clients
  // keep working.
  const openEditTokenForm = (token: {
    id: string
    label?: string
    expiresAt?: number
    scopeKind?: 'agent' | 'workspaceRoot'
  }) => {
    setTokenFormLabel(token.label ?? '')
    setTokenFormScopeKind(token.scopeKind ?? 'agent')
    setTokenFormExpiresAt(
      token.expiresAt != null ? formatDateInput(new Date(token.expiresAt)) : '',
    )
    setTokenFormState({ mode: 'edit', tokenId: token.id })
  }

  const closeTokenForm = () => {
    setTokenFormState(null)
    setTokenFormLabel('')
    setTokenFormExpiresAt('')
  }

  const handleSaveEditedToken = async () => {
    if (!workspaceAgentDraft || tokenFormState?.mode !== 'edit') return
    const expiresAtMs = parseDateInputToEndOfDayMs(tokenFormExpiresAt)
    try {
      await (
        plugin as unknown as {
          updateWorkspaceAgentShareToken?: (
            agentId: string,
            tokenId: string,
            update: {
              expiresAt?: number | null
              label?: string
              scopeKind?: 'agent' | 'workspaceRoot'
            },
          ) => Promise<void>
        }
      ).updateWorkspaceAgentShareToken?.(
        workspaceAgentDraft.agent.id,
        tokenFormState.tokenId,
        {
          expiresAt: expiresAtMs ?? null,
          label: tokenFormLabel.trim(),
          scopeKind: tokenFormScopeKind,
        },
      )
      closeTokenForm()
    } catch (err) {
      new Notice(
        err instanceof Error
          ? err.message
          : t('settings.agent.editorTokenError', 'Failed to update token.'),
      )
    }
  }

  const handleToggleTokenDisabled = async (
    tokenId: string,
    disabled: boolean,
  ) => {
    if (!workspaceAgentDraft) return
    try {
      await (
        plugin as unknown as {
          updateWorkspaceAgentShareToken?: (
            agentId: string,
            tokenId: string,
            update: { disabled: boolean },
          ) => Promise<void>
        }
      ).updateWorkspaceAgentShareToken?.(
        workspaceAgentDraft.agent.id,
        tokenId,
        { disabled },
      )
    } catch (err) {
      new Notice(
        err instanceof Error
          ? err.message
          : t('settings.agent.editorTokenError', 'Failed to update token.'),
      )
    }
  }

  const handleDeleteToken = (tokenId: string) => {
    if (!workspaceAgentDraft) return
    const agentId = workspaceAgentDraft.agent.id
    new ConfirmModal(plugin.app, {
      title: t('settings.agent.editorTokenDeleteTitle', 'Delete share token'),
      message: t(
        'settings.agent.editorTokenDeleteConfirm',
        'Delete this share token? Existing sessions using it will be ended.',
      ),
      ctaText: t('common.delete', 'Delete'),
      onConfirm: () => {
        void (async () => {
          try {
            await (
              plugin as unknown as {
                revokeWorkspaceAgentShareToken?: (
                  agentId: string,
                  tokenId: string,
                ) => Promise<void>
              }
            ).revokeWorkspaceAgentShareToken?.(agentId, tokenId)
          } catch (err) {
            new Notice(
              err instanceof Error
                ? err.message
                : t(
                    'settings.agent.editorTokenError',
                    'Failed to delete token.',
                  ),
            )
          }
        })()
      },
    }).open()
  }

  const toggleTokenReveal = (tokenId: string) => {
    setRevealedTokenIds((prev) => {
      const next = new Set(prev)
      if (next.has(tokenId)) next.delete(tokenId)
      else next.add(tokenId)
      return next
    })
  }

  const handleCopyToken = async (plaintext: string) => {
    try {
      await navigator.clipboard.writeText(plaintext)
      new Notice(
        t('settings.agent.editorTokenCopied', 'Token copied to clipboard.'),
      )
    } catch {
      new Notice(
        t('settings.agent.editorTokenCopyFailed', 'Failed to copy token.'),
      )
    }
  }

  const updateAgentModeAllowed = (allowed: boolean) => {
    if (!workspaceAgentDraft) return
    setWorkspaceAgentDraft({
      ...workspaceAgentDraft,
      agentModeAllowed: allowed,
    })
  }

  const editorTabs = useMemo(
    () =>
      workspaceAgentDraft
        ? [...AGENT_EDITOR_TABS, 'tokens' as const]
        : AGENT_EDITOR_TABS,
    [workspaceAgentDraft],
  )
  const activeTabIndex = editorTabs.findIndex((tab) => tab === activeTab)
  const activeTabIndexRef = useRef(activeTabIndex)
  const tabsNavRef = useRef<HTMLDivElement | null>(null)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const localFsServerName = getLocalFileToolServerName()

  const updateTabsGlider = useCallback(() => {
    const nav = tabsNavRef.current
    const index = activeTabIndexRef.current
    const activeButton = tabRefs.current[index]

    if (!nav || !activeButton || index < 0) {
      return
    }

    nav.style.setProperty(
      '--yolo-agent-tab-glider-left',
      `${activeButton.offsetLeft}px`,
    )
    nav.style.setProperty(
      '--yolo-agent-tab-glider-width',
      `${activeButton.offsetWidth}px`,
    )
  }, [])

  useLayoutEffect(() => {
    activeTabIndexRef.current = activeTabIndex
    updateTabsGlider()
  }, [activeTabIndex, updateTabsGlider])

  useEffect(() => {
    const nav = tabsNavRef.current
    if (!nav) {
      return
    }

    if (typeof ResizeObserver === 'undefined') {
      updateTabsGlider()
      return
    }

    const observer = new ResizeObserver(() => updateTabsGlider())
    observer.observe(nav)
    tabRefs.current.forEach((button) => {
      if (button) {
        observer.observe(button)
      }
    })

    return () => observer.disconnect()
  }, [updateTabsGlider])

  useEffect(() => {
    let mounted = true
    void plugin
      .getMcpManager()
      .then((manager) =>
        manager.listAvailableTools({ includeBuiltinTools: true }),
      )
      .then((tools) => {
        if (mounted) {
          setAvailableTools(tools)
        }
      })
      .catch((error: unknown) => {
        console.error('Failed to load available tools for agent editor', error)
      })

    return () => {
      mounted = false
    }
  }, [plugin])

  const agentModelOptionGroups = useMemo(() => {
    const providerOrder = settings.providers.map((provider) => provider.id)
    const providerIdsInModels = Array.from(
      new Set(settings.chatModels.map((model) => model.providerId)),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) => providerIdsInModels.includes(id)),
      ...providerIdsInModels.filter((id) => !providerOrder.includes(id)),
    ]

    return orderedProviderIds
      .map((providerId) => {
        const models = settings.chatModels.filter(
          (model) => model.providerId === providerId,
        )
        if (models.length === 0) {
          return null
        }
        return {
          label: providerId,
          options: models.map((model) => ({
            value: model.id,
            label: model.name?.trim()
              ? model.name.trim()
              : model.model || model.id,
          })),
        }
      })
      .filter(
        (
          group,
        ): group is {
          label: string
          options: { value: string; label: string }[]
        } => group !== null,
      )
  }, [settings.chatModels, settings.providers])

  const agentFollowDefaultModelOption = useMemo(
    () => ({
      value: ASSISTANT_FOLLOW_DEFAULT_MODEL_OPTION_VALUE,
      label: t('settings.agent.followDefaultModel', 'Follow default model'),
    }),
    [t],
  )

  useEffect(() => {
    if (!initialAssistantId || draftAgent) {
      return
    }
    const target = assistants.find(
      (assistant) => assistant.id === initialAssistantId,
    )
    if (!target) {
      return
    }
    setDraftAgent(toDraftAgent(target))
    setActiveTab('profile')
  }, [assistants, draftAgent, initialAssistantId])

  const upsertDraft = async () => {
    if (!draftAgent || !draftAgent.name.trim()) {
      return
    }

    if (workspaceAgentDraft) {
      const nextAgent: WorkspaceAgent = {
        ...workspaceAgentDraft.agent,
        name: draftAgent.name.trim(),
        behaviorOverrides: buildWorkspaceAgentBehaviorOverrides(
          workspaceAgentDraft.agent,
          workspaceAgentDraft.template,
          draftAgent,
          workspaceAgentDraft.agentModeAllowed,
        ),
        updatedAt: Date.now(),
      }
      const exists = workspaceAgents.some((agent) => agent.id === nextAgent.id)
      await setSettings({
        ...settings,
        workspaceAgents: exists
          ? workspaceAgents.map((agent) =>
              agent.id === nextAgent.id ? nextAgent : agent,
            )
          : [...workspaceAgents, nextAgent],
        currentWorkspaceAgentId:
          settings.currentWorkspaceAgentId ?? nextAgent.id,
      })
      onClose()
      return
    }

    const normalized: Assistant = {
      ...draftAgent,
      name: draftAgent.name.trim(),
      description: draftAgent.description?.trim(),
      modelId: draftAgent.modelId || undefined,
      toolPreferences: normalizeToolPreferencesForPersistence(
        draftAgent.toolPreferences,
        availableTools,
      ),
      toolServerPreferences: draftAgent.toolServerPreferences ?? {},
      enabledToolNames: normalizeToolSelectionForPersistence(
        getExplicitlyEnabledAssistantToolNames(draftAgent),
        availableTools,
      ),
      updatedAt: Date.now(),
    }

    const exists = assistants.some(
      (assistant) => assistant.id === normalized.id,
    )
    const nextAssistants = exists
      ? assistants.map((assistant) =>
          assistant.id === normalized.id ? normalized : assistant,
        )
      : [...assistants, normalized]

    await setSettings({
      ...settings,
      assistants: nextAssistants,
      currentAssistantId: settings.currentAssistantId ?? normalized.id,
      quickAskAssistantId: settings.quickAskAssistantId ?? normalized.id,
    })
    if (isDirectEntry) {
      onClose()
      return
    }
    setDraftAgent(null)
  }

  const toggleTool = (toolNames: string[], enabled: boolean) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      return updateDraftToolPreferences(prev, (current) => {
        const next = { ...current }
        for (const toolName of toolNames) {
          next[toolName] = {
            ...next[toolName],
            enabled,
            approvalMode:
              next[toolName]?.approvalMode ??
              getDefaultApprovalModeForTool(toolName),
          }
        }
        return next
      })
    })
  }

  const setToolApprovalMode = (
    toolNames: string[],
    approvalMode: AssistantToolApprovalMode,
  ) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      return updateDraftToolPreferences(prev, (current) => {
        const next = { ...current }
        for (const toolName of toolNames) {
          next[toolName] = {
            ...next[toolName],
            enabled: next[toolName]?.enabled ?? true,
            approvalMode,
          }
        }
        return next
      })
    })
  }

  const setServerApprovalMode = (
    serverName: string,
    approvalMode: AssistantToolApprovalMode,
  ) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      return {
        ...prev,
        toolServerPreferences: {
          ...(prev.toolServerPreferences ?? {}),
          [serverName]: { approvalMode },
        },
      }
    })
  }

  const setToolDisclosureMode = (
    toolNames: string[],
    disclosureMode: AssistantToolDisclosureMode,
  ) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      return updateDraftToolPreferences(prev, (current) => {
        const next = { ...current }
        for (const toolName of toolNames) {
          // Preserve the tool's effective enabled state. Without this, batch
          // server-level disclosure changes would flip default-off MCP tools
          // on, which violates the "enable stays per-tool" decision.
          const effectiveEnabled = isAssistantToolEnabled(prev, toolName)
          next[toolName] = {
            ...next[toolName],
            enabled: next[toolName]?.enabled ?? effectiveEnabled,
            approvalMode:
              next[toolName]?.approvalMode ??
              getDefaultApprovalModeForTool(toolName),
            disclosureMode,
          }
        }
        return next
      })
    })
  }

  const clearToolDisclosureMode = (toolNames: string[]) => {
    setDraftAgent((prev) => {
      if (!prev) {
        return prev
      }

      return updateDraftToolPreferences(prev, (current) => {
        let next = { ...current }
        for (const toolName of toolNames) {
          const currentPreference = next[toolName]
          if (!currentPreference) {
            continue
          }
          const { disclosureMode: _disclosureMode, ...rest } = currentPreference
          if (Object.keys(rest).length === 0) {
            next = Object.fromEntries(
              Object.entries(next).filter(([name]) => name !== toolName),
            )
          } else {
            next[toolName] = rest
          }
        }
        return next
      })
    })
  }

  const setSkillEnabled = (skillName: string, enabled: boolean) => {
    if (!draftAgent) {
      return
    }
    const current = new Set(draftAgent.enabledSkills ?? [])
    const nextPreferences = {
      ...(draftAgent.skillPreferences ?? {}),
    }

    if (enabled) {
      current.add(skillName)
    } else {
      current.delete(skillName)
    }

    nextPreferences[skillName] = {
      ...(nextPreferences[skillName] ?? {}),
      enabled,
    }

    setDraftAgent({
      ...draftAgent,
      enabledSkills: [...current],
      skillPreferences: nextPreferences,
    })
  }

  const setSkillLoadMode = (
    skillName: string,
    loadMode: AssistantSkillLoadMode,
  ) => {
    if (!draftAgent) {
      return
    }

    const nextPreferences = {
      ...(draftAgent.skillPreferences ?? {}),
      [skillName]: {
        ...(draftAgent.skillPreferences?.[skillName] ?? {}),
        enabled:
          draftAgent.skillPreferences?.[skillName]?.enabled ??
          draftAgent.enabledSkills?.includes(skillName) ??
          true,
        loadMode,
      },
    }

    setDraftAgent({
      ...draftAgent,
      skillPreferences: nextPreferences,
    })
  }

  const visibleToolGroups = useMemo(() => {
    const groups = new Map<
      string,
      { title: string; tools: AgentToolView[]; isBuiltin: boolean }
    >()
    const localEditSplitToolTargets = new Set<string>()
    const localPathSplitToolTargets = new Set<string>()
    const localMemorySplitToolTargets = new Set<string>()
    const localWebSplitToolTargets = new Set<string>()
    const templateCeiling = workspaceAgentDraft?.template
    const userFacingLocalToolNames = new Set(USER_FACING_LOCAL_TOOL_SHORT_NAMES)

    availableTools.forEach((tool) => {
      if (!isToolWithinWorkspaceAgentTemplate(tool.name, templateCeiling)) {
        return
      }
      let serverName = localFsServerName
      let toolName = tool.name

      try {
        const parsed = parseToolName(tool.name)
        serverName = parsed.serverName
        toolName = parsed.toolName
      } catch {
        serverName = localFsServerName
        toolName = tool.name
      }

      const isBuiltin = serverName === localFsServerName
      if (isBuiltin && draftAgent?.includeBuiltinTools === false) {
        return
      }
      // Bot-runtime-only built-ins (e.g. send_attachment, Bot Platform Phase
      // 6.5) are never part of the per-assistant configurable surface — keep
      // them out of the settings tool tree entirely.
      if (isBuiltin && !userFacingLocalToolNames.has(toolName)) {
        return
      }
      if (isBuiltin && EDIT_FS_TOOL_NAME_SET.has(toolName)) {
        localEditSplitToolTargets.add(tool.name)
        return
      }
      if (isBuiltin && PATH_FS_TOOL_NAME_SET.has(toolName)) {
        localPathSplitToolTargets.add(tool.name)
        return
      }
      if (isBuiltin && SPLIT_MEMORY_TOOL_NAME_SET.has(toolName)) {
        localMemorySplitToolTargets.add(tool.name)
        return
      }
      if (isBuiltin && SPLIT_WEB_TOOL_NAME_SET.has(toolName)) {
        localWebSplitToolTargets.add(tool.name)
        return
      }

      // 注入工具按插件能力分组（注入方自定义组名）；未提供时回退"外部能力"。
      const injectedGroupName = isInjectedBridgeToolName(toolName)
        ? getInjectedToolGroupName(toolName)
        : undefined
      const builtinCategory = isBuiltin
        ? (getBuiltinToolCategory(toolName) ?? 'vault')
        : null
      const key = injectedGroupName
        ? `__injected:${injectedGroupName}`
        : isBuiltin
          ? `__builtin:${builtinCategory}`
          : serverName
      const title = injectedGroupName
        ? injectedGroupName
        : isBuiltin
          ? t(
              BUILTIN_TOOL_CATEGORY_I18N[builtinCategory!].key,
              BUILTIN_TOOL_CATEGORY_I18N[builtinCategory!].fallback,
            )
          : serverName
      const builtinMeta = isBuiltin ? getBuiltinToolUiMeta(toolName) : null
      const displayName = builtinMeta
        ? t(builtinMeta.labelKey, builtinMeta.labelFallback)
        : toolName
      const description = builtinMeta
        ? t(builtinMeta.descKey ?? '', builtinMeta.descFallback)
        : tool.description || t('common.none', 'None')
      const group = groups.get(key) ?? { title, tools: [], isBuiltin }
      group.tools.push({
        fullName: tool.name,
        toggleTargets: [tool.name],
        displayName,
        description,
      })
      groups.set(key, group)
    })

    const pushBuiltinGroupTool = (toolName: string, tool: AgentToolView) => {
      const category = getBuiltinToolCategory(toolName) ?? 'vault'
      const key = `__builtin:${category}`
      const title = t(
        BUILTIN_TOOL_CATEGORY_I18N[category].key,
        BUILTIN_TOOL_CATEGORY_I18N[category].fallback,
      )
      const group = groups.get(key) ?? { title, tools: [], isBuiltin: true }
      group.tools.push(tool)
      groups.set(key, group)
    }

    if (
      draftAgent?.includeBuiltinTools !== false &&
      localEditSplitToolTargets.size > 0
    ) {
      const fileEditMeta = getBuiltinToolUiMeta(FILE_EDIT_GROUP_TOOL_NAME)
      if (!fileEditMeta) {
        throw new Error('Missing built-in tool UI metadata for fs_edit_ops')
      }
      pushBuiltinGroupTool(FILE_EDIT_GROUP_TOOL_NAME, {
        fullName: `${localFsServerName}__${FILE_EDIT_GROUP_TOOL_NAME}`,
        toggleTargets: [...localEditSplitToolTargets],
        displayName: t(fileEditMeta.labelKey, fileEditMeta.labelFallback),
        description: t(fileEditMeta.descKey ?? '', fileEditMeta.descFallback),
      })
    }

    if (
      draftAgent?.includeBuiltinTools !== false &&
      localPathSplitToolTargets.size > 0
    ) {
      const fileOpsMeta = getBuiltinToolUiMeta(FILE_OPS_GROUP_TOOL_NAME)
      if (!fileOpsMeta) {
        throw new Error('Missing built-in tool UI metadata for fs_file_ops')
      }
      pushBuiltinGroupTool(FILE_OPS_GROUP_TOOL_NAME, {
        fullName: `${localFsServerName}__${FILE_OPS_GROUP_TOOL_NAME}`,
        toggleTargets: [...localPathSplitToolTargets],
        displayName: t(fileOpsMeta.labelKey, fileOpsMeta.labelFallback),
        description: t(fileOpsMeta.descKey ?? '', fileOpsMeta.descFallback),
      })
    }

    if (
      draftAgent?.includeBuiltinTools !== false &&
      localMemorySplitToolTargets.size > 0
    ) {
      const memoryOpsMeta = getBuiltinToolUiMeta(MEMORY_OPS_GROUP_TOOL_NAME)
      if (!memoryOpsMeta) {
        throw new Error('Missing built-in tool UI metadata for memory_ops')
      }
      pushBuiltinGroupTool(MEMORY_OPS_GROUP_TOOL_NAME, {
        fullName: `${localFsServerName}__${MEMORY_OPS_GROUP_TOOL_NAME}`,
        toggleTargets: [...localMemorySplitToolTargets],
        displayName: t(memoryOpsMeta.labelKey, memoryOpsMeta.labelFallback),
        description: t(memoryOpsMeta.descKey ?? '', memoryOpsMeta.descFallback),
      })
    }

    if (
      draftAgent?.includeBuiltinTools !== false &&
      localWebSplitToolTargets.size > 0
    ) {
      const webOpsMeta = getBuiltinToolUiMeta(WEB_OPS_GROUP_TOOL_NAME)
      if (!webOpsMeta) {
        throw new Error('Missing built-in tool UI metadata for web_ops')
      }
      pushBuiltinGroupTool(WEB_OPS_GROUP_TOOL_NAME, {
        fullName: `${localFsServerName}__${WEB_OPS_GROUP_TOOL_NAME}`,
        toggleTargets: [...localWebSplitToolTargets],
        displayName: t(webOpsMeta.labelKey, webOpsMeta.labelFallback),
        description: t(webOpsMeta.descKey ?? '', webOpsMeta.descFallback),
      })
    }

    const builtinCategoryRank = new Map<string, number>(
      BUILTIN_TOOL_CATEGORY_ORDER.map(
        (category, index) => [`__builtin:${category}`, index] as const,
      ),
    )
    return [...groups.entries()]
      .sort(([a], [b]) => {
        const ra = builtinCategoryRank.get(a)
        const rb = builtinCategoryRank.get(b)
        if (ra !== undefined && rb !== undefined) return ra - rb
        if (ra !== undefined) return -1
        if (rb !== undefined) return 1
        return a.localeCompare(b)
      })
      .map(([key, value]) => {
        const builtinCategory = key.startsWith('__builtin:')
          ? (key.slice('__builtin:'.length) as BuiltinToolCategory)
          : null
        const tools = builtinCategory
          ? value.tools.slice().sort((toolA, toolB) => {
              const idA = parseToolName(toolA.fullName).toolName
              const idB = parseToolName(toolB.fullName).toolName
              return (
                getBuiltinToolDisplayIndex(builtinCategory, idA) -
                getBuiltinToolDisplayIndex(builtinCategory, idB)
              )
            })
          : value.tools
        return { key, ...value, tools }
      })
  }, [
    availableTools,
    draftAgent?.includeBuiltinTools,
    localFsServerName,
    t,
    workspaceAgentDraft?.template,
  ])

  const visibleToolsCount = useMemo(
    () => visibleToolGroups.reduce((sum, group) => sum + group.tools.length, 0),
    [visibleToolGroups],
  )

  const enabledVisibleToolsCount = useMemo(() => {
    return countEnabledVisibleAssistantTools(draftAgent, availableTools)
  }, [availableTools, draftAgent])

  const groupEnabledCounts = useMemo(() => {
    const enabled = new Set(getEnabledAssistantToolNames(draftAgent))
    const counts = new Map<string, number>()
    for (const group of visibleToolGroups) {
      counts.set(
        group.key,
        group.tools.filter((tool) =>
          tool.toggleTargets.every((target) => enabled.has(target)),
        ).length,
      )
    }
    return counts
  }, [draftAgent, visibleToolGroups])

  // Estimated tokens are scoped to a specific agent identity. Stale values
  // from a previous agent must NOT leak across an agent switch (would mislead
  // the user). Within the same agent, we still keep the prior value visible
  // during recomputation to avoid flickering on tool toggles.
  const [estimatedToolContextTokens, setEstimatedToolContextTokens] = useState<{
    agentId: string | null
    value: number | null
    perTool: Map<string, number>
    serverToolTokenBudgets: Map<string, number>
  }>({
    agentId: null,
    value: null,
    perTool: new Map(),
    serverToolTokenBudgets: new Map(),
  })

  useEffect(() => {
    let cancelled = false
    const currentAgentId = draftAgent?.id ?? null

    if (!draftAgent?.enableTools) {
      setEstimatedToolContextTokens({
        agentId: currentAgentId,
        value: 0,
        perTool: new Map(),
        serverToolTokenBudgets: new Map(),
      })
      return
    }

    const eligibleTools = availableTools.filter((tool) => {
      let serverName = localFsServerName
      try {
        serverName = parseToolName(tool.name).serverName
      } catch {
        serverName = localFsServerName
      }
      if (
        serverName === localFsServerName &&
        draftAgent.includeBuiltinTools === false
      ) {
        return false
      }
      return isAssistantToolEnabled(draftAgent, tool.name)
    })

    if (eligibleTools.length === 0) {
      setEstimatedToolContextTokens({
        agentId: currentAgentId,
        value: 0,
        perTool: new Map(),
        serverToolTokenBudgets: new Map(),
      })
      return
    }

    // Reset to loading only when agent identity changed; same agent keeps
    // its previous value visible while the new sum resolves.
    setEstimatedToolContextTokens((prev) =>
      prev.agentId === currentAgentId
        ? prev
        : {
            agentId: currentAgentId,
            value: null,
            perTool: new Map(),
            serverToolTokenBudgets: new Map(),
          },
    )

    // Resolve per-agent dynamic descriptions (js_eval's varies with the
    // enabled extension capabilities) before estimating, so the token count
    // tracks capability toggles instead of the static default the cached
    // tool list carries. Same bridge selectAllowedTools uses at request time.
    const resolvedTools = applyDynamicToolDescriptions(eligibleTools, {
      jsSandboxSettings: getJsSandboxSettings(settings),
      settings,
    })

    void buildServerToolTokenBudgets(
      groupToolsByServer(resolvedTools),
      estimateJsonTokens,
    ).then(async (serverToolTokenBudgets) => {
      const entries = await Promise.all(
        resolvedTools.map((tool) =>
          estimateToolDefaultContextTokens(tool).then(async (count) => {
            const disclosureMode = getAssistantToolDisclosureMode(
              draftAgent,
              tool.name,
              { enableToolDisclosure, serverToolTokenBudgets },
            )
            if (disclosureMode !== 'on_demand') {
              return [tool.name, count] as const
            }
            const stubCount = await estimateJsonTokens(
              buildDeferredToolStubTokenPayload(tool),
            )
            return [tool.name, stubCount] as const
          }),
        ),
      )
      if (cancelled) return
      const perTool = new Map(entries)
      setEstimatedToolContextTokens({
        agentId: currentAgentId,
        value: entries.reduce((sum, [, count]) => sum + count, 0),
        perTool,
        serverToolTokenBudgets,
      })
    })

    return () => {
      cancelled = true
    }
  }, [
    availableTools,
    draftAgent,
    draftAgent?.enableTools,
    draftAgent?.includeBuiltinTools,
    localFsServerName,
    enableToolDisclosure,
  ])

  const groupEnabledTokens = useMemo(() => {
    const enabledNames = new Set(getEnabledAssistantToolNames(draftAgent))
    const perTool = estimatedToolContextTokens.perTool
    const result = new Map<string, number>()
    for (const group of visibleToolGroups) {
      let sum = 0
      for (const tool of group.tools) {
        for (const target of tool.toggleTargets) {
          if (enabledNames.has(target)) {
            sum += perTool.get(target) ?? 0
          }
        }
      }
      result.set(group.key, sum)
    }
    return result
  }, [draftAgent, estimatedToolContextTokens.perTool, visibleToolGroups])

  const skillEntries = useLiteSkillEntries(app, { settings })

  const disabledSkillIds = useMemo(
    () => settings.skills?.disabledSkillIds ?? [],
    [settings.skills?.disabledSkillIds],
  )
  const skillsDir = getYoloSkillsDir(settings)
  const disabledSkillNameSet = useMemo(
    () => getDisabledSkillNameSet(disabledSkillIds),
    [disabledSkillIds],
  )

  const skillRows = useMemo(() => {
    return skillEntries
      .filter((skill) => !disabledSkillNameSet.has(skill.name))
      .filter((skill) =>
        isSkillWithinWorkspaceAgentTemplate(
          skill.name,
          workspaceAgentDraft?.template,
        ),
      )
      .map((skill) => {
        const policy = resolveAssistantSkillPolicy({
          assistant: draftAgent,
          skillName: skill.name,
          defaultLoadMode: skill.mode,
        })
        return {
          ...skill,
          enabled: policy.enabled,
          loadMode: policy.loadMode,
        }
      })
  }, [
    disabledSkillNameSet,
    draftAgent,
    skillEntries,
    workspaceAgentDraft?.template,
  ])

  // Same agent-scoped pattern as estimatedToolContextTokens above.
  const [estimatedSkillContextTokens, setEstimatedSkillContextTokens] =
    useState<{
      agentId: string | null
      value: number | null
      perSkill: Map<string, number>
    }>({
      agentId: null,
      value: null,
      perSkill: new Map(),
    })

  const alwaysSkillRows = useMemo(
    () =>
      skillRows.filter((skill) => skill.enabled && skill.loadMode === 'always'),
    [skillRows],
  )
  const lazySkillRows = useMemo(
    () =>
      skillRows.filter((skill) => skill.enabled && skill.loadMode === 'lazy'),
    [skillRows],
  )

  useEffect(() => {
    let cancelled = false
    const currentAgentId = draftAgent?.id ?? null

    const run = async () => {
      const enabledSkillRows = skillRows.filter((skill) => skill.enabled)
      if (enabledSkillRows.length === 0) {
        if (!cancelled) {
          setEstimatedSkillContextTokens({
            agentId: currentAgentId,
            value: 0,
            perSkill: new Map(),
          })
        }
        return
      }

      if (!cancelled) {
        setEstimatedSkillContextTokens((prev) =>
          prev.agentId === currentAgentId
            ? prev
            : { agentId: currentAgentId, value: null, perSkill: new Map() },
        )
      }

      const entries = await Promise.all(
        enabledSkillRows.map((skill) =>
          estimateSkillDefaultContextTokens({
            app,
            settings,
            skill,
          }).then((count) => [skill.name, count] as const),
        ),
      )

      if (!cancelled) {
        const perSkill = new Map(entries)
        setEstimatedSkillContextTokens({
          agentId: currentAgentId,
          value: entries.reduce((sum, [, count]) => sum + count, 0),
          perSkill,
        })
      }
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [app, settings, skillRows, draftAgent?.id])
  const toolApprovalOptions = useMemo(
    () => [
      {
        value: 'require_approval',
        label: t('settings.agent.toolApprovalRequire', 'Require approval'),
      },
      {
        value: 'full_access',
        label: t('settings.agent.toolApprovalFullAccess', 'Full access'),
      },
    ],
    [t],
  )
  return (
    <div
      ref={sectionRef}
      className={`yolo-settings-section yolo-agent-editor-panel${
        isDirectEntry ? ' yolo-agent-editor-panel--direct' : ''
      }`}
    >
      {draftAgent && (
        <div className="yolo-agent-editor-sheet">
          <div className="yolo-agent-editor-sheet-top">
            <div className="yolo-agent-editor-sheet-header">
              <div>
                <div className="yolo-settings-sub-header">
                  {draftAgent.name ||
                    t('settings.agent.editorDefaultName', 'New template')}
                </div>
                <div className="yolo-settings-desc">
                  {t(
                    'settings.agent.editorIntro',
                    "Configure this Agent Template's capabilities, model, and behavior.",
                  )}
                </div>
              </div>
              {!isDirectEntry && (
                <div className="yolo-agent-editor-sheet-actions">
                  <ObsidianButton
                    text={t('common.cancel', 'Cancel')}
                    onClick={() => setDraftAgent(null)}
                  />
                  <ObsidianButton
                    text={t('common.save', 'Save')}
                    cta
                    onClick={() => void upsertDraft()}
                  />
                </div>
              )}
            </div>

            <div
              className="yolo-agent-editor-tabs yolo-agent-editor-tabs--glider"
              role="tablist"
              ref={tabsNavRef}
              style={
                {
                  '--yolo-agent-tab-count': editorTabs.length,
                  '--yolo-agent-tab-index': activeTabIndex,
                } as React.CSSProperties
              }
            >
              <div
                className="yolo-agent-editor-tabs-glider"
                aria-hidden="true"
              />
              {editorTabs.map((tab, index) => {
                const TabIcon = AGENT_EDITOR_TAB_ICONS[tab]
                return (
                  <button
                    key={tab}
                    type="button"
                    className={`yolo-agent-editor-tab ${activeTab === tab ? 'is-active' : ''}`}
                    onClick={() => setActiveTab(tab)}
                    role="tab"
                    aria-selected={activeTab === tab}
                    ref={(element) => {
                      tabRefs.current[index] = element
                    }}
                  >
                    <span
                      className="yolo-agent-editor-tab-icon"
                      aria-hidden="true"
                    >
                      <TabIcon size={14} />
                    </span>
                    <span className="yolo-agent-editor-tab-label">
                      {
                        {
                          profile: t(
                            'settings.agent.editorTabProfile',
                            'Profile',
                          ),
                          tools: t('settings.agent.editorTabTools', 'Tools'),
                          skills: t('settings.agent.editorTabSkills', 'Skills'),
                          workspace: t(
                            'settings.agent.editorTabWorkspace',
                            'Workspace',
                          ),
                          tokens: t('settings.agent.editorTabTokens', 'Tokens'),
                        }[tab]
                      }
                    </span>
                  </button>
                )
              })}
            </div>
          </div>

          {activeTab === 'profile' && (
            <div className="yolo-agent-editor-body">
              <ObsidianSetting
                name={t('settings.agent.editorName', 'Name')}
                desc={t('settings.agent.editorNameDesc', 'Agent display name')}
              >
                <ObsidianTextInput
                  value={draftAgent.name}
                  onChange={(value) =>
                    setDraftAgent({ ...draftAgent, name: value })
                  }
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.editorDescription', 'Description')}
                desc={t(
                  'settings.agent.editorDescriptionDesc',
                  'Short summary for this template',
                )}
              >
                <ObsidianTextInput
                  value={draftAgent.description || ''}
                  onChange={(value) =>
                    setDraftAgent({ ...draftAgent, description: value })
                  }
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.editorIcon', 'Icon')}
                desc={t(
                  'settings.agent.editorIconDesc',
                  'Pick an icon for this template',
                )}
              >
                <ObsidianButton
                  text={t('settings.agent.editorChooseIcon', 'Choose icon')}
                  onClick={() => {
                    openIconPicker(app, draftAgent.icon, (newIcon) => {
                      setDraftAgent({ ...draftAgent, icon: newIcon })
                    })
                  }}
                />
              </ObsidianSetting>
              <div className="yolo-agent-model-setting-row">
                <div className="yolo-agent-model-setting-info">
                  <div className="yolo-agent-model-setting-title">
                    {t('settings.agent.editorModel', 'Model')}
                  </div>
                  <div className="yolo-agent-model-setting-desc">
                    {t(
                      'settings.agent.editorModelDesc',
                      'Select the model used by this template',
                    )}
                  </div>
                </div>
                <div className="yolo-agent-model-select-wrap">
                  <SimpleSelect
                    value={getAssistantModelSelectValue(draftAgent.modelId)}
                    leadingOptions={[agentFollowDefaultModelOption]}
                    groupedOptions={agentModelOptionGroups}
                    align="end"
                    side="bottom"
                    sideOffset={6}
                    placeholder={t('common.select', 'Select')}
                    contentClassName="yolo-agent-model-select-content"
                    onChange={(value: string) =>
                      setDraftAgent({
                        ...draftAgent,
                        modelId: modelIdFromAssistantModelSelectValue(value),
                      })
                    }
                  />
                </div>
              </div>
              <ObsidianSetting
                name={t('settings.agent.editorSystemPrompt', 'System prompt')}
                desc={t(
                  'settings.agent.editorSystemPromptDesc',
                  'Primary behavior instruction for this template',
                )}
                className="yolo-settings-textarea-header yolo-settings-desc-copyable"
              />
              <div
                className="yolo-agent-system-prompt-wrapper"
                ref={systemPromptWrapperRef}
              >
                <ObsidianSetting className="yolo-settings-textarea">
                  <ObsidianTextArea
                    value={draftAgent.systemPrompt}
                    onChange={(value) =>
                      setDraftAgent({ ...draftAgent, systemPrompt: value })
                    }
                    autoResize
                    maxAutoResizeHeight={360}
                    inputClassName="yolo-agent-system-prompt-textarea"
                  />
                </ObsidianSetting>
                <button
                  type="button"
                  ref={systemPromptExpandButtonRef}
                  className="clickable-icon yolo-agent-system-prompt-expand-btn"
                  aria-label={t(
                    'settings.agent.editorSystemPromptExpand',
                    'Expand editor',
                  )}
                  onClick={() => setIsSystemPromptExpanded(true)}
                >
                  <Maximize2 size={14} />
                </button>
              </div>
              {isSystemPromptExpanded &&
                systemPromptOverlayTarget &&
                createPortal(
                  <div
                    className="yolo-agent-system-prompt-overlay"
                    role="dialog"
                    aria-modal="true"
                    onClick={(e) => {
                      if (e.target === e.currentTarget) {
                        setIsSystemPromptExpanded(false)
                      }
                    }}
                  >
                    <div
                      ref={systemPromptOverlayPanelRef}
                      className="yolo-agent-system-prompt-overlay-panel"
                      tabIndex={-1}
                    >
                      <div className="yolo-agent-system-prompt-overlay-header">
                        <div className="yolo-agent-system-prompt-overlay-title">
                          {t(
                            'settings.agent.editorSystemPrompt',
                            'System prompt',
                          )}
                        </div>
                        <button
                          type="button"
                          className="clickable-icon yolo-agent-system-prompt-overlay-close"
                          aria-label={t(
                            'settings.agent.editorSystemPromptCollapse',
                            'Close editor',
                          )}
                          onClick={() => setIsSystemPromptExpanded(false)}
                        >
                          <X size={16} />
                        </button>
                      </div>
                      <div className="yolo-agent-system-prompt-overlay-desc">
                        {t(
                          'settings.agent.editorSystemPromptDesc',
                          'Primary behavior instruction for this template',
                        )}
                      </div>
                      <textarea
                        ref={expandedPromptTextareaRef}
                        className="yolo-agent-system-prompt-overlay-textarea"
                        value={draftAgent.systemPrompt}
                        onChange={(e) =>
                          setDraftAgent({
                            ...draftAgent,
                            systemPrompt: e.target.value,
                          })
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Escape') {
                            e.preventDefault()
                            setIsSystemPromptExpanded(false)
                          }
                        }}
                        autoFocus
                      />
                    </div>
                  </div>,
                  systemPromptOverlayTarget,
                )}
              <ObsidianSetting
                name={t('settings.agent.focusSyncTitle')}
                desc={t('settings.agent.focusSyncDesc')}
              >
                <ObsidianToggle
                  value={draftAgent.includeCurrentFileContent !== false}
                  onChange={(value) => {
                    setDraftAgent({
                      ...draftAgent,
                      includeCurrentFileContent: value,
                    })
                  }}
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t('settings.agent.timeContextTitle')}
                desc={t('settings.agent.timeContextDesc')}
              >
                <ObsidianToggle
                  value={draftAgent.timeContextEnabled !== false}
                  onChange={(value) => {
                    setDraftAgent({
                      ...draftAgent,
                      timeContextEnabled: value,
                    })
                  }}
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t(
                  'settings.agent.editorEnableProjectInstructions',
                  'Load project instruction files',
                )}
                desc={t(
                  'settings.agent.editorEnableProjectInstructionsDesc',
                  'Auto-load AGENTS.md and CLAUDE.md from the vault root for this agent.',
                )}
              >
                <ObsidianToggle
                  value={draftAgent.enableProjectInstructions === true}
                  onChange={(value) => {
                    setDraftAgent({
                      ...draftAgent,
                      enableProjectInstructions: value,
                    })
                  }}
                />
              </ObsidianSetting>

              {!workspaceAgentDraft && (
                <ObsidianSetting
                  name={t(
                    'settings.agent.editorDelegatable',
                    'Allow subagent delegation',
                  )}
                  desc={t(
                    'settings.agent.editorDelegatableDesc',
                    'Allow another Agent to select this template as a specialist child role.',
                  )}
                >
                  <ObsidianToggle
                    value={draftAgent.delegatable === true}
                    onChange={(value) => {
                      setDraftAgent({
                        ...draftAgent,
                        delegatable: value,
                      })
                    }}
                  />
                </ObsidianSetting>
              )}

              {/* Enable / Agent mode — only shown for workspace agents. */}
              {workspaceAgentDraft && (
                <>
                  <ObsidianSetting
                    name={t('settings.agent.editorEnableAgent', 'Enable agent')}
                    desc={t(
                      'settings.agent.editorEnableAgentDesc',
                      'When disabled, this workspace agent is hidden from the chat selector and web access is blocked.',
                    )}
                  >
                    <ObsidianToggle
                      value={!workspaceAgentDraft.agent.disabled}
                      onChange={(enabled) =>
                        setWorkspaceAgentDraft({
                          ...workspaceAgentDraft,
                          agent: {
                            ...workspaceAgentDraft.agent,
                            disabled: enabled ? undefined : true,
                          },
                        })
                      }
                    />
                  </ObsidianSetting>
                  <ObsidianSetting
                    name={t('settings.agent.editorAgentModes', 'Agent mode')}
                    desc={t(
                      'settings.agent.editorAgentModesDesc',
                      'Ask mode is always available. Allow this workspace agent to use Agent mode in the chat window.',
                    )}
                  >
                    <ObsidianToggle
                      value={workspaceAgentDraft.agentModeAllowed}
                      onChange={updateAgentModeAllowed}
                    />
                  </ObsidianSetting>
                </>
              )}
            </div>
          )}

          {activeTab === 'tools' && (
            <div className="yolo-agent-editor-body">
              <ObsidianSetting
                name={t('settings.agent.editorEnableTools', 'Enable tools')}
                desc={t(
                  'settings.agent.editorEnableToolsDesc',
                  'Allow this agent to call tools',
                )}
              >
                <ObsidianToggle
                  value={Boolean(draftAgent.enableTools)}
                  onChange={(value) => {
                    setDraftAgent({
                      ...draftAgent,
                      enableTools: value,
                    })
                  }}
                />
              </ObsidianSetting>
              <ObsidianSetting
                name={t(
                  'settings.agent.editorIncludeBuiltinTools',
                  'Include built-in tools',
                )}
                desc={t(
                  'settings.agent.editorIncludeBuiltinToolsDesc',
                  'Allow local vault file tools for this agent',
                )}
              >
                <ObsidianToggle
                  value={Boolean(draftAgent.includeBuiltinTools)}
                  onChange={(value) => {
                    setDraftAgent((prev) =>
                      prev ? { ...prev, includeBuiltinTools: value } : prev,
                    )
                  }}
                />
              </ObsidianSetting>
              <div
                className={`yolo-agent-tools-panel${
                  draftAgent.enableTools ? '' : ' is-disabled'
                }`}
              >
                <div className="yolo-agent-tools-panel-head">
                  <div className="yolo-agent-tools-panel-title-row">
                    <div className="yolo-agent-tools-panel-title">
                      {t('settings.agent.tools', 'Tools')}
                    </div>
                    {estimatedToolContextTokens.value !== null && (
                      <div className="yolo-agent-tools-panel-estimate">
                        {t(
                          'settings.agent.editorEstimatedContextTokens',
                          '~{count} tokens',
                        ).replace(
                          '{count}',
                          formatTokenCount(estimatedToolContextTokens.value),
                        )}
                      </div>
                    )}
                  </div>
                  <div className="yolo-agent-tools-panel-count">
                    {`${enabledVisibleToolsCount} / ${visibleToolsCount} ${t(
                      'settings.agent.toolsActive',
                      'active',
                    )}`}
                  </div>
                </div>

                {visibleToolGroups.map((group) => {
                  const groupEnabledCount =
                    groupEnabledCounts.get(group.key) ?? 0
                  const allGroupToolsEnabled =
                    group.tools.length > 0 &&
                    groupEnabledCount === group.tools.length
                  const groupToggleTargets = group.tools.flatMap(
                    (tool) => tool.toggleTargets,
                  )
                  const showServerDisclosure =
                    !group.isBuiltin &&
                    enableToolDisclosure &&
                    group.tools.length > 0
                  const explicitDisclosureModes = showServerDisclosure
                    ? groupToggleTargets
                        .map(
                          (target) =>
                            draftAgent.toolPreferences?.[target]
                              ?.disclosureMode,
                        )
                        .filter(
                          (mode): mode is AssistantToolDisclosureMode =>
                            mode !== undefined,
                        )
                    : []
                  const explicitDisclosureMode =
                    explicitDisclosureModes.length ===
                      groupToggleTargets.length &&
                    explicitDisclosureModes.every(
                      (mode) => mode === explicitDisclosureModes[0],
                    )
                      ? explicitDisclosureModes[0]
                      : null
                  const disclosureSelectionValue =
                    explicitDisclosureModes.length === 0
                      ? 'auto'
                      : (explicitDisclosureMode ?? 'mixed')
                  const autoDisclosureMode = (() => {
                    const firstTarget = groupToggleTargets[0]
                    if (!firstTarget) return null
                    try {
                      const { serverName } = parseToolName(firstTarget)
                      const tokenBudget =
                        estimatedToolContextTokens.serverToolTokenBudgets.get(
                          serverName,
                        )
                      return tokenBudget === undefined
                        ? null
                        : resolveDefaultDisclosureModeForServer(tokenBudget)
                    } catch {
                      return null
                    }
                  })()
                  const disclosureModeLabel = (
                    mode: AssistantToolDisclosureMode,
                  ) =>
                    mode === 'on_demand'
                      ? t('settings.agent.toolDisclosureOnDemand', 'On demand')
                      : t(
                          'settings.agent.toolDisclosureAlways',
                          'Always loaded',
                        )
                  const autoDisclosureLabel = `${t(
                    'settings.agent.toolDisclosureAuto',
                    'Auto',
                  )}${
                    autoDisclosureMode
                      ? `: ${disclosureModeLabel(autoDisclosureMode)}`
                      : ''
                  }`
                  const autoDisclosureOptionLabel = t(
                    'settings.agent.toolDisclosureAutoSelect',
                    'Auto select',
                  )
                  const serverDisclosureLabel =
                    disclosureSelectionValue === 'auto'
                      ? autoDisclosureLabel
                      : disclosureSelectionValue === 'mixed'
                        ? t('settings.agent.toolDisclosureMixed', 'Mixed')
                        : disclosureModeLabel(disclosureSelectionValue)
                  const showServerApproval = !group.isBuiltin
                  const serverApprovalMode: AssistantToolApprovalMode =
                    draftAgent.toolServerPreferences?.[group.key]
                      ?.approvalMode ?? 'require_approval'
                  const groupFullyDisabled =
                    !group.isBuiltin &&
                    group.tools.length > 0 &&
                    groupEnabledCount === 0
                  const groupClassName = [
                    'yolo-agent-tool-group',
                    !group.isBuiltin ? 'yolo-agent-tool-group--mcp' : null,
                  ]
                    .filter(Boolean)
                    .join(' ')
                  return (
                    <div key={group.key} className={groupClassName}>
                      <div className="yolo-agent-tool-group-title">
                        <span className="yolo-agent-tool-group-title-main">
                          <span>{group.title}</span>
                          {estimatedToolContextTokens.perTool.size > 0 && (
                            <span className="yolo-agent-tool-group-tokens">
                              {t(
                                'settings.agent.editorEstimatedContextTokens',
                                '~{count} tokens',
                              ).replace(
                                '{count}',
                                formatTokenCount(
                                  groupEnabledTokens.get(group.key) ?? 0,
                                ),
                              )}
                            </span>
                          )}
                          {showServerDisclosure && (
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger asChild>
                                <button
                                  type="button"
                                  className="yolo-agent-tool-group-disclosure"
                                >
                                  <span>{serverDisclosureLabel}</span>
                                  <ChevronDown size={12} aria-hidden="true" />
                                </button>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal container={portalContainer}>
                                <DropdownMenu.Content
                                  className="yolo-simple-select__content"
                                  side="bottom"
                                  align="center"
                                  sideOffset={6}
                                  collisionPadding={10}
                                  loop
                                >
                                  <DropdownMenu.RadioGroup
                                    className="yolo-simple-select__list"
                                    value={disclosureSelectionValue}
                                    onValueChange={(nextValue) => {
                                      if (nextValue === 'auto') {
                                        clearToolDisclosureMode(
                                          groupToggleTargets,
                                        )
                                        return
                                      }
                                      if (
                                        nextValue === 'always' ||
                                        nextValue === 'on_demand'
                                      ) {
                                        setToolDisclosureMode(
                                          groupToggleTargets,
                                          nextValue,
                                        )
                                      }
                                    }}
                                  >
                                    <DropdownMenu.RadioItem
                                      className="yolo-simple-select__item"
                                      value="auto"
                                    >
                                      <div className="yolo-simple-select__item-text">
                                        <div className="yolo-simple-select__item-label">
                                          {autoDisclosureOptionLabel}
                                        </div>
                                      </div>
                                      <DropdownMenu.ItemIndicator className="yolo-simple-select__item-indicator">
                                        <Check size={12} />
                                      </DropdownMenu.ItemIndicator>
                                    </DropdownMenu.RadioItem>
                                    <DropdownMenu.RadioItem
                                      className="yolo-simple-select__item"
                                      value="always"
                                    >
                                      <div className="yolo-simple-select__item-text">
                                        <div className="yolo-simple-select__item-label">
                                          {disclosureModeLabel('always')}
                                        </div>
                                      </div>
                                      <DropdownMenu.ItemIndicator className="yolo-simple-select__item-indicator">
                                        <Check size={12} />
                                      </DropdownMenu.ItemIndicator>
                                    </DropdownMenu.RadioItem>
                                    <DropdownMenu.RadioItem
                                      className="yolo-simple-select__item"
                                      value="on_demand"
                                    >
                                      <div className="yolo-simple-select__item-text">
                                        <div className="yolo-simple-select__item-label">
                                          {disclosureModeLabel('on_demand')}
                                        </div>
                                      </div>
                                      <DropdownMenu.ItemIndicator className="yolo-simple-select__item-indicator">
                                        <Check size={12} />
                                      </DropdownMenu.ItemIndicator>
                                    </DropdownMenu.RadioItem>
                                  </DropdownMenu.RadioGroup>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          )}
                        </span>
                        <span className="yolo-agent-tool-group-meta">
                          {showServerApproval && (
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger asChild>
                                <button
                                  type="button"
                                  className="yolo-agent-tool-group-disclosure yolo-agent-tool-group-approval-trigger"
                                >
                                  <span>
                                    {serverApprovalMode === 'full_access'
                                      ? t(
                                          'settings.agent.toolApprovalFullAccess',
                                          'Full access',
                                        )
                                      : t(
                                          'settings.agent.toolApprovalRequire',
                                          'Require approval',
                                        )}
                                  </span>
                                  <ChevronDown size={12} aria-hidden="true" />
                                </button>
                              </DropdownMenu.Trigger>
                              <DropdownMenu.Portal container={portalContainer}>
                                <DropdownMenu.Content
                                  className="yolo-simple-select__content"
                                  side="bottom"
                                  align="center"
                                  sideOffset={6}
                                  collisionPadding={10}
                                  loop
                                >
                                  <DropdownMenu.RadioGroup
                                    className="yolo-simple-select__list"
                                    value={serverApprovalMode}
                                    onValueChange={(nextValue) => {
                                      if (
                                        nextValue === 'full_access' ||
                                        nextValue === 'require_approval'
                                      ) {
                                        setServerApprovalMode(
                                          group.key,
                                          nextValue,
                                        )
                                      }
                                    }}
                                  >
                                    {toolApprovalOptions.map((option) => (
                                      <DropdownMenu.RadioItem
                                        key={option.value}
                                        className="yolo-simple-select__item"
                                        value={option.value}
                                      >
                                        <div className="yolo-simple-select__item-text">
                                          <div className="yolo-simple-select__item-label">
                                            {option.label}
                                          </div>
                                        </div>
                                        <DropdownMenu.ItemIndicator className="yolo-simple-select__item-indicator">
                                          <Check size={12} />
                                        </DropdownMenu.ItemIndicator>
                                      </DropdownMenu.RadioItem>
                                    ))}
                                  </DropdownMenu.RadioGroup>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          )}
                          <span className="yolo-agent-tool-group-count">
                            {`${groupEnabledCount} / ${group.tools.length} ${t(
                              'settings.agent.toolsActive',
                              'active',
                            )}`}
                          </span>
                          {group.tools.length > 0 && (
                            <button
                              type="button"
                              className="yolo-agent-tool-group-bulk-toggle"
                              onClick={() =>
                                toggleTool(
                                  groupToggleTargets,
                                  !allGroupToolsEnabled,
                                )
                              }
                            >
                              {allGroupToolsEnabled
                                ? t(
                                    'settings.agent.disableAllTools',
                                    'Disable all',
                                  )
                                : t(
                                    'settings.agent.enableAllTools',
                                    'Enable all',
                                  )}
                            </button>
                          )}
                        </span>
                      </div>
                      {!groupFullyDisabled && (
                        <div className="yolo-agent-tool-list">
                          {group.tools.map((tool) => {
                            const selected = tool.toggleTargets.every(
                              (target) =>
                                isAssistantToolEnabled(draftAgent, target),
                            )
                            const approvalMode =
                              group.isBuiltin &&
                              tool.toggleTargets.every(
                                (target) =>
                                  getAssistantToolApprovalMode(
                                    draftAgent,
                                    target,
                                  ) === 'full_access',
                              )
                                ? 'full_access'
                                : 'require_approval'
                            return (
                              <div
                                key={tool.fullName}
                                className="yolo-agent-tool-row"
                              >
                                <div className="yolo-agent-tool-main">
                                  <div className="yolo-agent-tool-name yolo-agent-tool-name--mono">
                                    {tool.displayName}
                                  </div>
                                  <div className="yolo-agent-tool-source yolo-agent-tool-source--preview">
                                    {tool.description}
                                  </div>
                                </div>
                                <div className="yolo-agent-tool-controls">
                                  {group.isBuiltin && selected && (
                                    <>
                                      <div className="yolo-agent-tool-select">
                                        <SimpleSelect
                                          value={approvalMode}
                                          options={toolApprovalOptions}
                                          onChange={(value) =>
                                            setToolApprovalMode(
                                              tool.toggleTargets,
                                              value as AssistantToolApprovalMode,
                                            )
                                          }
                                          align="end"
                                          contentClassName="yolo-agent-tool-select-menu"
                                        />
                                      </div>
                                    </>
                                  )}
                                  <ObsidianToggle
                                    value={Boolean(selected)}
                                    onChange={(value) =>
                                      toggleTool(tool.toggleTargets, value)
                                    }
                                  />
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  )
                })}

                {visibleToolsCount === 0 && (
                  <div className="yolo-agent-tools-empty">
                    {t('settings.agent.noTools', 'No tools available')}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'skills' && (
            <div className="yolo-agent-editor-body">
              <div className="yolo-agent-tools-panel">
                <div className="yolo-agent-tools-panel-head">
                  <div className="yolo-agent-tools-panel-title-row">
                    <div className="yolo-agent-tools-panel-title">
                      {t('settings.agent.skills', 'Skills')}
                    </div>
                    {estimatedSkillContextTokens.value !== null && (
                      <div className="yolo-agent-tools-panel-estimate">
                        {t(
                          'settings.agent.editorEstimatedContextTokens',
                          '~{count} tokens',
                        ).replace(
                          '{count}',
                          formatTokenCount(estimatedSkillContextTokens.value),
                        )}
                      </div>
                    )}
                  </div>
                  <div className="yolo-agent-tools-panel-count">
                    {t(
                      'settings.agent.editorSkillsCountWithEnabled',
                      '{count} skills (enabled {enabled})',
                    )
                      .replace('{count}', String(skillRows.length))
                      .replace(
                        '{enabled}',
                        String(
                          skillRows.filter((skill) => skill.enabled).length,
                        ),
                      )}
                  </div>
                </div>

                <div className="yolo-agent-skill-summary-row">
                  <span className="yolo-agent-chip">
                    {t('settings.agent.skillLoadAlways', 'Full inject')}:{' '}
                    {alwaysSkillRows.length}
                  </span>
                  <span className="yolo-agent-chip">
                    {t('settings.agent.skillLoadLazy', 'On demand')}:{' '}
                    {lazySkillRows.length}
                  </span>
                </div>

                {skillRows.length > 0 ? (
                  <div className="yolo-agent-tool-list">
                    {skillRows.map((skill) => {
                      return (
                        <div key={skill.name} className="yolo-agent-tool-row">
                          <div className="yolo-agent-tool-main">
                            <div className="yolo-agent-tool-name">
                              <span>{humanizeSkillName(skill.name)}</span>
                              {skill.enabled &&
                                estimatedSkillContextTokens.perSkill.has(
                                  skill.name,
                                ) && (
                                  <span className="yolo-agent-skill-tokens">
                                    {t(
                                      'settings.agent.editorEstimatedContextTokens',
                                      '~{count} tokens',
                                    ).replace(
                                      '{count}',
                                      formatTokenCount(
                                        estimatedSkillContextTokens.perSkill.get(
                                          skill.name,
                                        ) ?? 0,
                                      ),
                                    )}
                                  </span>
                                )}
                            </div>
                            <div className="yolo-agent-tool-source yolo-agent-tool-source--preview">
                              {skill.description}
                            </div>
                            <div className="yolo-agent-skill-meta">
                              <span className="yolo-agent-chip">
                                name: {skill.name}
                              </span>
                              <span className="yolo-agent-chip">
                                {skill.path}
                              </span>
                            </div>
                          </div>
                          <div className="yolo-agent-skill-controls">
                            <ObsidianToggle
                              value={skill.enabled}
                              onChange={(value) =>
                                setSkillEnabled(skill.name, value)
                              }
                            />
                            <select
                              value={skill.loadMode}
                              disabled={!skill.enabled}
                              onChange={(event) =>
                                setSkillLoadMode(
                                  skill.name,
                                  event.target.value as AssistantSkillLoadMode,
                                )
                              }
                            >
                              <option value="always">
                                {t(
                                  'settings.agent.skillLoadAlways',
                                  'Full inject',
                                )}
                              </option>
                              <option value="lazy">
                                {t('settings.agent.skillLoadLazy', 'On demand')}
                              </option>
                            </select>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                ) : (
                  <div className="yolo-agent-tools-empty">
                    {t(
                      'settings.agent.skillsEmptyHint',
                      'No skills found. Create skill markdown files under {path}.',
                    ).replace('{path}', skillsDir)}
                  </div>
                )}
              </div>
            </div>
          )}

          {activeTab === 'workspace' && workspaceAgentDraft && (
            <div className="yolo-agent-editor-body">
              <AgentWorkspaceScopeEditor
                app={app}
                vault={app.vault}
                value={workspaceAgentDraft.agent.workspacePolicy}
                onChange={(next) =>
                  setWorkspaceAgentDraft({
                    ...workspaceAgentDraft,
                    agent: {
                      ...workspaceAgentDraft.agent,
                      workspacePolicy: next,
                    },
                    effective: workspaceAgentDraft.effective,
                  })
                }
              />
            </div>
          )}

          {activeTab === 'workspace' && !workspaceAgentDraft && draftAgent && (
            <div className="yolo-agent-editor-body">
              <TemplateWorkspaceScopeEditor
                app={app}
                vault={app.vault}
                value={draftAgent.workspaceScope}
                onChange={(next) =>
                  setDraftAgent((prev) =>
                    prev ? { ...prev, workspaceScope: next } : prev,
                  )
                }
              />
            </div>
          )}

          {activeTab === 'tokens' && workspaceAgentDraft && (
            <div className="yolo-agent-editor-body">
              <ObsidianSetting
                name={t('settings.agent.editorTokenTitle', 'Share Tokens')}
                desc={t(
                  'settings.agent.editorTokenDesc',
                  'Generate a token for web access. Set an expiry to limit how long it works.',
                )}
              >
                <ObsidianButton
                  text={t('settings.agent.editorTokenCreate', 'Create Token')}
                  cta
                  onClick={openCreateTokenForm}
                />
              </ObsidianSetting>

              {/* Token list with header row (same grid pattern as McpSection) */}
              {workspaceAgentShareTokens.length === 0 ? (
                <div className="setting-item-description yolo-agent-token-empty">
                  {t(
                    'settings.agent.editorTokenEmpty',
                    'No tokens yet. Click "Create Token" to issue one.',
                  )}
                </div>
              ) : (
                <div className="yolo-mcp-servers-container">
                  <div className="yolo-agent-tokens-header">
                    <div>{t('settings.agent.editorTokenLabel', 'Label')}</div>
                    <div>{t('settings.agent.editorTokenStatus', 'Status')}</div>
                    <div>
                      {t('settings.agent.editorTokenCreated', 'Created')}
                    </div>
                    <div>
                      {t('settings.agent.editorTokenExpiry', 'Expires')}
                    </div>
                    <div>{t('settings.agent.editorTokenSecret', 'Token')}</div>
                    <div>{t('settings.mcp.enabled', 'Enabled')}</div>
                    <div>{t('settings.mcp.actions', 'Actions')}</div>
                  </div>
                  {workspaceAgentShareTokens.map((token) => {
                    const status = deriveTokenDisplayStatus(
                      token,
                      Date.now(),
                      currentAgentRootHash,
                    )
                    const revealed = revealedTokenIds.has(token.id)
                    const plaintext = token.plaintext ?? null
                    const displayText = plaintext
                      ? revealed
                        ? plaintext
                        : maskShareTokenPlaintext(plaintext)
                      : `${token.id} (legacy)`
                    const formatDate = (ts: number) =>
                      new Date(ts).toLocaleDateString()
                    return (
                      <div key={token.id} className="yolo-mcp-server">
                        <div className="yolo-mcp-server-row yolo-agent-token-row">
                          <div className="yolo-mcp-server-name">
                            {token.label?.trim() ||
                              t(
                                'settings.agent.editorTokenUnnamed',
                                '(Unnamed)',
                              )}
                          </div>
                          <div className="yolo-mcp-server-status">
                            <span
                              className={`yolo-agent-token-status-badge yolo-agent-token-status-${status}`}
                              title={
                                status === 'root_mismatch'
                                  ? t(
                                      'settings.agent.editorTokenStatusRootMismatchHint',
                                      'This token was issued for a previous workspace root and no longer authorizes requests.',
                                    )
                                  : undefined
                              }
                            >
                              {status === 'valid'
                                ? t(
                                    'settings.agent.editorTokenStatusValid',
                                    'Valid',
                                  )
                                : status === 'expired'
                                  ? t(
                                      'settings.agent.editorTokenStatusExpired',
                                      'Expired',
                                    )
                                  : status === 'root_mismatch'
                                    ? t(
                                        'settings.agent.editorTokenStatusRootMismatch',
                                        'Workspace changed',
                                      )
                                    : t(
                                        'settings.agent.editorTokenStatusDisabled',
                                        'Disabled',
                                      )}
                            </span>
                          </div>
                          <div className="yolo-agent-token-date">
                            {formatDate(token.createdAt)}
                          </div>
                          <div className="yolo-agent-token-date">
                            {token.expiresAt
                              ? formatDate(token.expiresAt)
                              : '—'}
                          </div>
                          <div
                            className="yolo-agent-token-secret"
                            title={
                              token.expiresAt
                                ? `${t('settings.agent.editorTokenExpiry', 'Expires')}: ${new Date(token.expiresAt).toLocaleString()}`
                                : t(
                                    'settings.agent.editorTokenNoExpiry',
                                    'No expiry',
                                  )
                            }
                          >
                            <code className="yolo-agent-token-secret-text">
                              {displayText}
                            </code>
                            {plaintext && (
                              <>
                                <button
                                  type="button"
                                  className="clickable-icon"
                                  aria-label={
                                    revealed
                                      ? t(
                                          'settings.agent.editorTokenHide',
                                          'Hide token',
                                        )
                                      : t(
                                          'settings.agent.editorTokenShow',
                                          'Show token',
                                        )
                                  }
                                  onClick={() => toggleTokenReveal(token.id)}
                                >
                                  {revealed ? (
                                    <EyeOff size={16} />
                                  ) : (
                                    <Eye size={16} />
                                  )}
                                </button>
                                <button
                                  type="button"
                                  className="clickable-icon"
                                  aria-label={t(
                                    'settings.agent.editorTokenCopy',
                                    'Copy',
                                  )}
                                  onClick={() =>
                                    void handleCopyToken(plaintext)
                                  }
                                >
                                  <Copy size={16} />
                                </button>
                              </>
                            )}
                          </div>
                          <div className="yolo-mcp-server-toggle">
                            <ObsidianToggle
                              value={!token.disabled}
                              onChange={(enabled) =>
                                void handleToggleTokenDisabled(
                                  token.id,
                                  !enabled,
                                )
                              }
                            />
                          </div>
                          <div className="yolo-mcp-server-actions">
                            <button
                              type="button"
                              onClick={() =>
                                openEditTokenForm({
                                  id: token.id,
                                  label: token.label,
                                  expiresAt: token.expiresAt,
                                  scopeKind: token.scope?.kind,
                                })
                              }
                              className="clickable-icon"
                              aria-label={t(
                                'settings.agent.editorTokenEdit',
                                'Edit',
                              )}
                            >
                              <Edit size={16} />
                            </button>
                            <button
                              type="button"
                              onClick={() => void handleDeleteToken(token.id)}
                              className="clickable-icon"
                              aria-label={t(
                                'settings.agent.editorTokenDelete',
                                'Delete',
                              )}
                            >
                              <Trash2 size={16} />
                            </button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}

              {/* Create / Edit dialog */}
              {tokenFormState && (
                <TokenFormDialog
                  mode={tokenFormState.mode}
                  label={tokenFormLabel}
                  scopeKind={tokenFormScopeKind}
                  expiresAt={tokenFormExpiresAt}
                  onLabelChange={setTokenFormLabel}
                  onScopeKindChange={setTokenFormScopeKind}
                  onExpiresAtChange={setTokenFormExpiresAt}
                  onCancel={closeTokenForm}
                  onSubmit={() => {
                    if (tokenFormState.mode === 'create') {
                      void handleGenerateToken()
                    } else {
                      void handleSaveEditedToken()
                    }
                  }}
                  submitting={generatingToken}
                  t={t}
                />
              )}
            </div>
          )}

          {isDirectEntry && (
            <div className="yolo-agent-editor-direct-footer">
              <div className="yolo-agent-editor-direct-footer-actions">
                <ObsidianButton
                  text={t('common.cancel', 'Cancel')}
                  onClick={onClose}
                />
                <ObsidianButton
                  text={t('common.save', 'Save')}
                  cta
                  onClick={() => void upsertDraft()}
                />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// Create / Edit share-token dialog. Reuses the existing modal-overlay styling
// (Obsidian's `.modal-bg` + `.modal`) so it visually matches the surrounding
// settings dialogs. Keeps its own minimal markup — no third-party date picker
// dependency; native `<input type="date" min="...">` already opens the OS
// calendar widget and blocks past dates.
function TokenFormDialog(props: {
  mode: 'create' | 'edit'
  label: string
  scopeKind: 'agent' | 'workspaceRoot'
  expiresAt: string
  onLabelChange: (value: string) => void
  onScopeKindChange: (value: 'agent' | 'workspaceRoot') => void
  onExpiresAtChange: (value: string) => void
  onCancel: () => void
  onSubmit: () => void
  submitting: boolean
  t: (key: string, fallback: string) => string
}): React.JSX.Element {
  const todayInputValue = formatDateInput(new Date())
  const title =
    props.mode === 'create'
      ? props.t(
          'settings.agent.editorTokenDialogCreateTitle',
          'Create share token',
        )
      : props.t('settings.agent.editorTokenDialogEditTitle', 'Edit share token')
  const submitLabel =
    props.mode === 'create'
      ? props.t('settings.agent.editorTokenGenerate', 'Generate')
      : props.t('common.save', 'Save')

  return (
    <div
      className="yolo-agent-token-dialog-overlay"
      role="dialog"
      aria-modal="true"
      onClick={(e) => {
        if (e.target === e.currentTarget) props.onCancel()
      }}
    >
      <div className="yolo-agent-token-dialog">
        <div className="yolo-agent-token-dialog-title">{title}</div>
        <div className="yolo-agent-token-dialog-content">
          <label className="yolo-settings-card-desc">
            {props.t('settings.agent.editorTokenLabel', 'Label')}
            <input
              type="text"
              value={props.label}
              onChange={(e) => props.onLabelChange(e.target.value)}
              placeholder={props.t(
                'settings.agent.editorTokenLabelPlaceholder',
                'e.g. CI/CD, mobile access',
              )}
            />
          </label>

          <label className="yolo-settings-card-desc">
            {props.t('settings.agent.editorTokenScope', 'Scope')}
            <select
              value={props.scopeKind}
              onChange={(e) =>
                props.onScopeKindChange(
                  e.target.value as 'agent' | 'workspaceRoot',
                )
              }
            >
              <option value="agent">
                {props.t(
                  'settings.agent.editorTokenScopeAgent',
                  'Current agent only',
                )}
              </option>
              <option value="workspaceRoot">
                {props.t(
                  'settings.agent.editorTokenScopeRoot',
                  'All agents in same workspace root',
                )}
              </option>
            </select>
          </label>

          <label className="yolo-settings-card-desc">
            {props.t('settings.agent.editorTokenExpiry', 'Expiry date')}
            {/* `min=today` blocks past dates in browsers that respect it.
                Empty value = no expiry (allowed during edit). */}
            <input
              type="date"
              value={props.expiresAt}
              min={todayInputValue}
              onChange={(e) => props.onExpiresAtChange(e.target.value)}
            />
            <span className="setting-item-description">
              {props.t(
                'settings.agent.editorTokenExpiryDesc',
                'Leave empty for no expiry. The token is valid through the end of the selected day.',
              )}
            </span>
          </label>
        </div>
        <div className="yolo-agent-token-dialog-actions">
          <button type="button" onClick={props.onCancel}>
            {props.t('common.cancel', 'Cancel')}
          </button>
          <button
            type="button"
            className="mod-cta"
            disabled={props.submitting}
            onClick={props.onSubmit}
          >
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
