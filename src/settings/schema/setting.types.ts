import { z } from 'zod'

import {
  DEFAULT_CHAT_MODELS,
  DEFAULT_CHAT_TITLE_MODEL_ID,
} from '../../constants'
import { SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT } from '../../core/agent/subagent/constants'
import {
  SUBAGENT_RESULT_MAX_CHARS,
  SUBAGENT_RESULT_TRUNCATION_MARKER_LENGTH,
} from '../../core/agent/subagent/result-limit'
import { DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG } from '../../core/agent/subagent/subagent-timeout-config'
import { DEFAULT_LOCAL_MCP_SERVER_PORT } from '../../core/mcp/localMcpServerConfig'
import { webSearchSettingsSchema } from '../../core/web-search/types'
import {
  assistantSchema,
  assistantSkillOverridePreferenceSchema,
  assistantToolOverridePreferenceSchema,
} from '../../types/assistant.types'
import { chatModelSchema } from '../../types/chat-model.types'
import { embeddingModelSchema } from '../../types/embedding-model.types'
import { imageModelSchema } from '../../types/image-model.types'
import { rerankModelSchema } from '../../types/rerank-model.types'
import { sttModelSchema } from '../../types/stt-model.types'
import { ttsModelSchema } from '../../types/tts-model.types'
import {
  mcpServerConfigSchema,
  mcpServerToolOptionsSchema,
} from '../../types/mcp.types'
import { llmProviderSchema } from '../../types/provider.types'
import { REASONING_LEVELS, ReasoningLevel } from '../../types/reasoning'
import { DEFAULT_CHAT_QUICK_ACCESS_ENTRIES } from '../chatQuickAccess'

import { SETTINGS_SCHEMA_VERSION } from './migrations'

/**
 * MoA (Mixture of Agents) settings stored under `chatOptions.moa`. The
 * explicit `/moa` chat command is the only activation path: reference models
 * come from `@`-mentions in the composer (2–8 when used); if none are
 * mentioned, the current conversation model is used as the reference proposer
 * (3 runs). The aggregator is always the current conversation model.
 * `allowedReferenceModelIds` is an optional allow-list that, when absent,
 * permits any enabled model.
 */
export const moaSettingsSchema = z.object({
  enabled: z.boolean().catch(true),
  allowedReferenceModelIds: z.array(z.string()).optional(),
  timeoutMs: z.number().int().min(1_000).max(120_000).catch(45_000),
  maxOutputTokens: z.number().int().min(256).max(4_096).catch(2_048),
})

/**
 * Configurable parent subagent timeout + breaker. Optional so older settings
 * snapshots keep validating; the registry falls back to built-in defaults.
 */
export const subagentTimeoutSettingsSchema = z.object({
  timeoutMs: z
    .number()
    .int()
    .min(1)
    .catch(DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG.timeoutMs),
  maxConsecutiveTimeouts: z
    .number()
    .int()
    .min(1)
    .catch(DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG.maxConsecutiveTimeouts),
  cooldownMs: z
    .number()
    .int()
    .min(0)
    .catch(DEFAULT_PARENT_SUBAGENT_TIMEOUT_CONFIG.cooldownMs),
})

const resilientArraySchema = <T extends z.ZodTypeAny>(itemSchema: T) =>
  z
    .array(z.unknown())
    .transform((items): Array<z.infer<T>> => {
      return items.flatMap((item) => {
        const parsed = itemSchema.safeParse(item)
        return parsed.success ? [parsed.data] : []
      })
    })
    .catch([])

const ragOptionsSchema = z.object({
  enabled: z.boolean().catch(true),
  chunkSize: z.number().catch(1000),
  chunkOverlap: z.number().catch(50),
  minSimilarity: z.number().catch(0.0),
  limit: z.number().catch(10),
  rerankEnabled: z.boolean().catch(true),
  /**
   * Max parallel embedding requests during indexing. Lower this when the
   * embedding provider returns 429 / rate-limit errors (e.g. Azure S0 tier
   * or per-minute-quota free tiers). Clamped to [1, 24] at the call site.
   */
  embeddingConcurrency: z.number().catch(10),
  excludePatterns: z.array(z.string()).catch([]),
  /**
   * When true, the plugin's YOLO base directory (resolved dynamically from
   * `yolo.baseDir`) is excluded from indexing on top of `excludePatterns`.
   * The UI surfaces this as a removable chip in the exclude folder list;
   * deleting that chip flips this flag to false and persists the choice.
   */
  excludeYoloBaseDir: z.boolean().catch(true),
  includePatterns: z.array(z.string()).catch([]),
  /** When true, index `.pdf` files for RAG (text extraction). */
  indexPdf: z.boolean().catch(true),
  diagnosticsEnabled: z.boolean().catch(true),
  showRagLogRibbonIcon: z.boolean().catch(true),
  autoUpdateEnabled: z.boolean().catch(true),
  autoUpdateIntervalHours: z.number().catch(0),
  lastAutoUpdateAt: z.number().catch(0),
})

type TabCompletionOptionDefaults = {
  multipleCandidatesEnabled: boolean
  idleTriggerEnabled: boolean
  autoTriggerDelayMs: number
  autoTriggerCooldownMs: number
  triggerDelayMs: number
  minContextLength: number
  contextRange: number // Combined context range, internally split 4:1 (before:after)
  maxSuggestionLength: number
  temperature: number
  requestTimeoutMs: number
  reasoningLevel: ReasoningLevel
}

// Legacy fields for migration compatibility
export type TabCompletionOptionLegacy = {
  maxBeforeChars?: number
  maxAfterChars?: number
  maxTokens?: number
  maxRetries?: number
}

export type TabCompletionTrigger = {
  id: string
  type: 'string' | 'regex'
  pattern: string
  enabled: boolean
  acceptMode: 'insert' | 'replace'
  description?: string
}

export type TabCompletionLengthPreset = 'short' | 'medium' | 'long'

export const TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER =
  '{{tab_completion_constraints}}'
export const DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT =
  'Your job is to predict the most logical text that should be written at the location of the <mask/>. Your answer can be either code, a single word, or multiple sentences. Your answer must be in the same language as the text that is already there.' +
  `\n\nAdditional constraints:\n${TAB_COMPLETION_CONSTRAINTS_PLACEHOLDER}` +
  '\n\nOutput only the text that should appear at the <mask/>. Do not include explanations, labels, or formatting.'

export const DEFAULT_TAB_COMPLETION_LENGTH_PRESET: TabCompletionLengthPreset =
  'medium'

export const notificationChannelSchema = z.enum(['sound', 'system', 'both'])
export type NotificationChannel = z.infer<typeof notificationChannelSchema>
export const notificationTimingSchema = z.enum(['always', 'when-unfocused'])
export type NotificationTiming = z.infer<typeof notificationTimingSchema>

export const DEFAULT_TAB_COMPLETION_OPTIONS: TabCompletionOptionDefaults = {
  multipleCandidatesEnabled: true,
  idleTriggerEnabled: false,
  autoTriggerDelayMs: 3000,
  autoTriggerCooldownMs: 15000,
  triggerDelayMs: 3000,
  minContextLength: 5,
  contextRange: 4000, // Total context chars, split 4:1 (3200 before, 800 after)
  maxSuggestionLength: 2000, // Legacy; no longer applied at request/render time
  temperature: 0.5, // Legacy; tab completion no longer sends temperature
  requestTimeoutMs: 12000,
  // Tab 补全是延迟敏感场景，默认关闭推理；用户可在设置中改为 low / auto 以适配强制推理的模型（如 gpt-oss）
  reasoningLevel: 'off',
}

export const DEFAULT_MODEL_REQUEST_TIMEOUT_MS = 60000
export const MAX_MODEL_REQUEST_TIMEOUT_MS = 60 * 60 * 1000

const notificationOptionsSchema = z
  .object({
    enabled: z.boolean().optional(),
    channel: notificationChannelSchema.optional(),
    timing: notificationTimingSchema.optional(),
    notifyOnApprovalRequired: z.boolean().optional(),
    notifyOnTaskCompleted: z.boolean().optional(),
  })
  .catch({
    enabled: false,
    channel: 'sound',
    timing: 'when-unfocused',
    notifyOnApprovalRequired: true,
    notifyOnTaskCompleted: true,
  })

export const DEFAULT_TAB_COMPLETION_TRIGGERS: TabCompletionTrigger[] = [
  {
    id: 'sentence-end-comma',
    type: 'string',
    pattern: ', ',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'sentence-end-chinese-comma',
    type: 'string',
    pattern: '，',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'sentence-end-colon',
    type: 'string',
    pattern: ': ',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'sentence-end-chinese-colon',
    type: 'string',
    pattern: '：',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'newline',
    type: 'regex',
    pattern: '\\n$',
    enabled: true,
    acceptMode: 'insert',
  },
  {
    id: 'list-item',
    type: 'regex',
    pattern: '(?:^|\\n)[-*+]\\s$',
    enabled: true,
    acceptMode: 'insert',
  },
]

// Helper to compute maxTokens from maxSuggestionLength (roughly 1 token ≈ 3-4 chars)
export const computeMaxTokens = (maxSuggestionLength: number): number => {
  return Math.max(16, Math.min(2000, Math.ceil(maxSuggestionLength / 3)))
}

// Helper to split contextRange into before/after (4:1 ratio)
export const splitContextRange = (
  contextRange: number,
): { maxBeforeChars: number; maxAfterChars: number } => {
  const maxBeforeChars = Math.round((contextRange * 4) / 5)
  const maxAfterChars = contextRange - maxBeforeChars
  return { maxBeforeChars, maxAfterChars }
}

const tabCompletionOptionsSchema = z
  .object({
    multipleCandidatesEnabled: z
      .boolean()
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.multipleCandidatesEnabled),
    idleTriggerEnabled: z
      .boolean()
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.idleTriggerEnabled),
    autoTriggerDelayMs: z
      .number()
      .min(200)
      .max(30000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.autoTriggerDelayMs),
    autoTriggerCooldownMs: z
      .number()
      .min(0)
      .max(600000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.autoTriggerCooldownMs),
    triggerDelayMs: z
      .number()
      .min(200)
      .max(30000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.triggerDelayMs),
    minContextLength: z
      .number()
      .min(0)
      .max(2000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.minContextLength),
    contextRange: z
      .number()
      .min(500)
      .max(50000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.contextRange),
    maxSuggestionLength: z
      .number()
      .min(20)
      .max(4000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.maxSuggestionLength),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.temperature),
    requestTimeoutMs: z
      .number()
      .min(1000)
      .max(60000)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.requestTimeoutMs),
    reasoningLevel: z
      .enum(REASONING_LEVELS)
      .catch(DEFAULT_TAB_COMPLETION_OPTIONS.reasoningLevel),
    // Legacy fields kept for migration compatibility (will be removed in future)
    maxBeforeChars: z.number().optional(),
    maxAfterChars: z.number().optional(),
    maxTokens: z.number().optional(),
    maxRetries: z.number().optional(),
  })
  .catch({ ...DEFAULT_TAB_COMPLETION_OPTIONS })

export const jsSandboxSettingsSchema = z.object({
  allowDbQuery: z.boolean().optional(),
  allowFetch: z.boolean().optional(),
  fetchMode: z.enum(['whitelist', 'blacklist']).optional(),
  fetchDomains: z.array(z.string()).optional(),
  fetchMaxConcurrent: z.number().optional(),
  fetchMaxResponseKb: z.number().optional(),
  allowVaultRead: z.boolean().optional(),
  // Maximum size (in KB) returned by $vault.readText / $vault.readBinary.
  // Files exceeding this are truncated (text) or refused (binary).
  vaultReadMaxKb: z.number().optional(),
  allowBrowserRead: z.boolean().optional(),
  // Maximum size (in KB) returned by $browser.readHtml. Pages exceeding
  // this are refused so callers do not silently receive partial HTML.
  browserReadMaxKb: z.number().optional(),
  allowExternalScripts: z.boolean().optional(),
  // Execution timeout cap, in milliseconds. The LLM may pass a smaller
  // timeoutMs in its tool args, but the host clamps the effective value
  // to this cap. Undefined means use the built-in default.
  timeoutMs: z.number().optional(),
  // Maximum rows returned by $db.search (knowledge-base RAG/vector search).
  dbQueryMaxLimit: z.number().optional(),
  // Maximum size (in KB) of the tool's serialized JSON result returned to
  // the model. Output above this is truncated with a prefix. Undefined
  // uses the built-in default. Host enforces a hard ceiling.
  outputMaxKb: z.number().optional(),
})

export type JsSandboxSettings = z.infer<typeof jsSandboxSettingsSchema>

const tabCompletionTriggerSchema = z
  .object({
    id: z.string(),
    type: z.enum(['string', 'regex']),
    pattern: z.string(),
    enabled: z.boolean().catch(true),
    acceptMode: z.enum(['insert', 'replace']).catch('insert'),
    description: z.string().optional(),
  })
  .catch({
    id: '',
    type: 'string',
    pattern: '',
    enabled: true,
    acceptMode: 'insert',
  })

export const agentShareTokenScopeSchema = z.union([
  z.object({
    kind: z.literal('agent'),
    agentId: z.string(),
  }),
  z.object({
    kind: z.literal('workspaceRoot'),
    rootHash: z.string(),
    issuedForAgentId: z.string(),
  }),
])
export type AgentShareTokenScope = z.infer<typeof agentShareTokenScopeSchema>

export const agentShareTokenRecordSchema = z.object({
  id: z.string(),
  tokenHash: z.string(),
  tokenHashVersion: z.literal('hmac-sha256-v1'),
  scope: agentShareTokenScopeSchema,
  label: z.string().optional(),
  createdAt: z.number(),
  lastUsedAt: z.number().optional(),
  revokedAt: z.number().optional(),
  plaintext: z.string().optional(),
  expiresAt: z.number().optional(),
  disabled: z.boolean().optional(),
})
export type AgentShareTokenRecord = z.infer<typeof agentShareTokenRecordSchema>

/**
 * Workspace agent policy (migrated from the local fork): the agent's home
 * directory and read/write boundary rules around it.
 */
export const workspaceAgentPolicySchema = z.object({
  workspaceRoot: z.string().trim().min(1, 'Workspace root cannot be blank'),
  readAllowlist: z.array(z.string()).catch([]),
  readDenylist: z.array(z.string()).catch([]),
  writeDenylist: z.array(z.string()).catch([]),
})
export type WorkspaceAgentPolicy = z.infer<typeof workspaceAgentPolicySchema>

/**
 * Workspace agent behavior overrides (migrated from the local fork): a
 * workspace agent inherits an upstream Assistant template and can override
 * selected behaviors (prompt, tools, skills, mode gate) plus a workspace
 * home-directory policy.
 */
export const workspaceAgentBehaviorOverridesSchema = z.object({
  name: z.string().optional(),
  promptOverride: z.string().optional(),
  systemPromptOverride: z.string().optional(),
  disabledToolNames: z.array(z.string()).optional(),
  toolConfigOverrides: z
    .record(z.string(), assistantToolOverridePreferenceSchema)
    .optional(),
  disabledSkillIds: z.array(z.string()).optional(),
  skillConfigOverrides: z
    .record(z.string(), assistantSkillOverridePreferenceSchema)
    .optional(),
  // When false, the workspace agent only exposes Ask mode in the chat input.
  agentModeAllowed: z.boolean().optional(),
})
export type WorkspaceAgentBehaviorOverrides = z.infer<
  typeof workspaceAgentBehaviorOverridesSchema
>

/**
 * Workspace agent instance: inherits an upstream Assistant template and
 * overrides behavior + workspace policy. Kept as its own record type so the
 * upstream assistant editor stays untouched.
 */
export const workspaceAgentSchema = z.object({
  id: z.string(),
  name: z.string().min(1, 'Name cannot be empty'),
  templateId: z.string(),
  disabled: z.boolean().optional(),
  behaviorOverrides: workspaceAgentBehaviorOverridesSchema.optional(),
  workspacePolicy: workspaceAgentPolicySchema,
  shareTokens: z.array(agentShareTokenRecordSchema).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})
export type WorkspaceAgent = z.infer<typeof workspaceAgentSchema>

/**
 * Settings
 */

// platform instance is one record in `platforms[]`; the same platformType
// can appear multiple times (e.g. two Telegram bots), disambiguated by `id`.
const botPlatformBaseSchema = z.object({
  id: z.string(),
  name: z.string().catch(''),
  enabled: z.boolean().catch(false),
  allowedUsers: resilientArraySchema(z.string()).catch([]),
  allowedGroups: resilientArraySchema(z.string()).catch([]),
  whitelistEnabled: z.boolean().catch(true),
  // Falls back to DEFAULT_ASSISTANT_ID at runtime when unset.
  assistantId: z.string().optional(),
})

export const botPlatformTelegramSchema = botPlatformBaseSchema.extend({
  platformType: z.literal('telegram'),
  botToken: z.string().catch(''),
  allowedUsers: resilientArraySchema(z.string()).catch([]),
  allowedGroups: resilientArraySchema(z.string()).catch([]),
  whitelistEnabled: z.boolean().catch(true),
  startupUpdatePolicy: z.enum(['skip', 'consume']).catch('skip'),
  pollingIntervalMs: z.number().int().min(1000).catch(3000),
})
export type BotPlatformTelegramConfig = z.infer<
  typeof botPlatformTelegramSchema
>

// WeChat personal-account ClawBot/iLink protocol. botToken/baseUrl/botId/
// loginTime are written by the QR login flow (Settings UI); new instances
// start with these unset. Private chat only, no groups.
export const botPlatformWeixinSchema = botPlatformBaseSchema.extend({
  platformType: z.literal('weixin_oc'),
  botToken: z.string().optional(),
  baseUrl: z.string().catch('https://ilinkai.weixin.qq.com'),
  botId: z.string().optional(),
  loginTime: z.number().optional(),
  allowedUsers: resilientArraySchema(z.string()).catch([]),
  allowedGroups: resilientArraySchema(z.string()).catch([]),
  whitelistEnabled: z.boolean().catch(true),
  pollTimeoutMs: z.number().int().catch(40_000),
})
export type BotPlatformWeixinConfig = z.infer<typeof botPlatformWeixinSchema>

export const botPlatformDingtalkSchema = botPlatformBaseSchema.extend({
  platformType: z.literal('dingtalk'),
  robotCode: z.string().catch(''),
  clientId: z.string().catch(''),
  clientSecret: z.string().catch(''),
  streamMode: z.boolean().catch(true),
})
export type BotPlatformDingtalkConfig = z.infer<
  typeof botPlatformDingtalkSchema
>

export const botPlatformFeishuSchema = botPlatformBaseSchema.extend({
  platformType: z.literal('feishu'),
  appId: z.string().catch(''),
  appSecret: z.string().catch(''),
})
export type BotPlatformFeishuConfig = z.infer<typeof botPlatformFeishuSchema>

export const botPlatformQqOfficialSchema = botPlatformBaseSchema.extend({
  platformType: z.literal('qq_official'),
  appId: z.string().catch(''),
  appSecret: z.string().catch(''),
  enableC2c: z.boolean().catch(true),
  enableGroup: z.boolean().catch(true),
  enableGuild: z.boolean().catch(true),
})
export type BotPlatformQqOfficialConfig = z.infer<
  typeof botPlatformQqOfficialSchema
>

export const botPlatformConfigSchema = z.discriminatedUnion('platformType', [
  botPlatformTelegramSchema,
  botPlatformWeixinSchema,
  botPlatformDingtalkSchema,
  botPlatformFeishuSchema,
  botPlatformQqOfficialSchema,
])
export type BotPlatformConfig = z.infer<typeof botPlatformConfigSchema>

export const sessionMappingSchema = z.object({
  sessionKey: z.string(),
  platformInstanceId: z.string().optional(),
  platformName: z.string(),
  chatType: z.enum(['private', 'group']),
  platformChatId: z.string(),
  threadId: z.string().optional(),
  conversationId: z.string(),
  conversationTitle: z.string().optional(),
  createdAt: z.number(),
  lastActiveAt: z.number(),
  archivedAt: z.number().optional(),
  disabled: z.boolean().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})
export type SessionMapping = z.infer<typeof sessionMappingSchema>

export const botsSettingsSchema = z.object({
  enabled: z.boolean().catch(false),
  whitelistEnabled: z.boolean().catch(true),
  groupChatEnabled: z.boolean().catch(false),
  adminUsers: resilientArraySchema(z.string()).catch([]),
  platforms: resilientArraySchema(botPlatformConfigSchema).catch([]),
  sessionMappings: resilientArraySchema(sessionMappingSchema).catch([]),
})
export type BotsSettings = z.infer<typeof botsSettingsSchema>

/**
 * ragOptions scope snapshot the index was last built with (see
 * `src/core/rag/ragIndexScope.ts`). Absent until the first successful run;
 * any non-object value (legacy data, corruption) parses to undefined.
 */
const ragIndexedOptionsSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value
      : undefined,
  z
    .object({
      chunkSize: z.number().catch(0),
      chunkOverlap: z.number().catch(0),
      indexPdf: z.boolean().catch(false),
      includePatterns: z.array(z.string()).catch([]),
      excludePatterns: z.array(z.string()).catch([]),
      excludeYoloBaseDir: z.boolean().catch(false),
    })
    .optional(),
)

export const ragBackendSettingsSchema = z.preprocess(
  (value) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value
      : {},
  z.object({
    indexedNamespaceId: z.string().optional(),
    rebuildRequired: z.boolean().catch(false),
    indexedOptions: ragIndexedOptionsSchema,
  }),
)

export const webRuntimeSettingsSchema = z
  .object({
    enabled: z.boolean().catch(false),
    port: z.number().int().min(1).max(65535).catch(18900),
    host: z.string().min(1).catch('127.0.0.1'),
    token: z.string().catch(''),
    maxConcurrentAgentRuns: z.number().int().min(1).max(20).catch(12),
  })
  .catch({
    enabled: false,
    port: 18900,
    host: '127.0.0.1',
    token: '',
    maxConcurrentAgentRuns: 12,
  })

// Scheduled Tasks — cron/interval/one-time triggered agent (and, later,
// script) task automation. `enableScriptExecution`/`allowedScriptDirectories`
// are added now even though `type=script` tasks are V2-only work, so the
// settings schema/migration doesn't need a second bump when V2 lands.
export const scheduledTasksSettingsSchema = z.object({
  enabled: z.boolean().catch(false),
  enableScriptExecution: z.boolean().catch(false),
  allowedScriptDirectories: resilientArraySchema(z.string()).catch([]),
})
export type ScheduledTasksSettings = z.infer<
  typeof scheduledTasksSettingsSchema
>

export const yoloSettingsSchema = z.object({
  // Version
  version: z.literal(SETTINGS_SCHEMA_VERSION).catch(SETTINGS_SCHEMA_VERSION),

  providers: resilientArraySchema(llmProviderSchema),

  chatModels: resilientArraySchema(chatModelSchema),

  embeddingModels: resilientArraySchema(embeddingModelSchema),
  rerankModels: resilientArraySchema(rerankModelSchema),

  chatModelId: z.string().catch(''), // model for default chat feature
  rerankModelId: z.string().catch(''),
  chatTitleModelId: z.string().catch(''), // model for automatic conversation naming
  memoryAgentModelId: z.string().optional(), // model for hidden memory extraction
  advancedMemoryIndexEnabled: z.boolean().catch(true),
  memoryReflectionEnabled: z.boolean().catch(false),
  embeddingModelId: z.string().catch(''), // model for embedding

  // System Prompt
  systemPrompt: z.string().catch(''),

  // 时间感知:开启后,每条新用户消息发送时固定当前时间并以 <current_time> 前缀注入。
  // 只影响之后的新消息,历史消息已固定不变。
  timeContextEnabled: z.boolean().catch(true),

  // 更新提示:同版本第一次关闭后记录软关闭版本,下次启动仍提示一次。
  softDismissedUpdateVersion: z.string().catch(''),

  // 更新提示:同版本第二次关闭后记录被静音的版本号,只有出现更高版本才会再次提示。
  mutedUpdateVersion: z.string().catch(''),

  // 模块更新提示:按模块记录被静音的版本,更高版本仍会重新提示。
  mutedModuleUpdateVersions: z.record(z.string(), z.string()).catch({}),

  /**
   * 检测到新版本时是否弹出更新卡片。关闭后主插件与模块都不再提示,也不再自动
   * 下载(没有卡片就没有安装入口)。分发源 Feed 仍然照常请求——它同时是模块
   * 目录的数据源,`设置 → 模块` 的更新按钮依赖它。
   */
  pluginUpdateNoticeEnabled: z.boolean().catch(true),

  /** 检测到新版本时在后台自动下载 release 文件；安装仍需用户确认。 */
  pluginUpdateAutoDownloadEnabled: z.boolean().catch(true),

  // RAG Options
  ragOptions: ragOptionsSchema.catch({
    enabled: true,
    chunkSize: 1000,
    chunkOverlap: 50,
    minSimilarity: 0.0,
    limit: 10,
    rerankEnabled: true,
    embeddingConcurrency: 10,
    excludePatterns: [],
    excludeYoloBaseDir: true,
    includePatterns: [],
    indexPdf: true,
    diagnosticsEnabled: true,
    showRagLogRibbonIcon: true,
    autoUpdateEnabled: true,
    autoUpdateIntervalHours: 0,
    lastAutoUpdateAt: 0,
  }),
  ragBackendSettings: ragBackendSettingsSchema,
  webRuntime: webRuntimeSettingsSchema,
  scheduledTasks: scheduledTasksSettingsSchema.catch({
    enabled: false,
    enableScriptExecution: false,
    allowedScriptDirectories: [],
  }),

  // MCP configuration
  mcp: z
    .object({
      servers: resilientArraySchema(mcpServerConfigSchema),
      builtinToolOptions: mcpServerToolOptionsSchema.catch({}),
      enableToolDisclosure: z.boolean().catch(false),
      localServer: z
        .object({
          enabled: z.boolean().catch(false),
          port: z
            .number()
            .int()
            .min(1024)
            .max(65535)
            .catch(DEFAULT_LOCAL_MCP_SERVER_PORT),
          token: z.string().catch(''),
        })
        .catch({
          enabled: false,
          port: DEFAULT_LOCAL_MCP_SERVER_PORT,
          token: '',
        }),
    })
    .catch({
      servers: [],
      builtinToolOptions: {},
      enableToolDisclosure: false,
      localServer: {
        enabled: false,
        port: DEFAULT_LOCAL_MCP_SERVER_PORT,
        token: '',
      },
    }),

  // JS sandbox (js_eval) capability configuration is global; execution
  // approval remains a per-agent tool preference.
  jsSandbox: jsSandboxSettingsSchema.catch({}),

  // Web search configuration (built-in agent tool)
  webSearch: webSearchSettingsSchema.catch({
    providers: [],
    defaultProviderId: undefined,
    common: {
      resultSize: 10,
      searchTimeoutMs: 120000,
      scrapeTimeoutMs: 20000,
    },
  }),

  // Skills configuration
  skills: z
    .object({
      // Globally disabled skills, stored by canonical skill *name* (frontmatter
      // `name`, trim-only, case-sensitive). Field name kept for backwards
      // compatibility; its elements are skill names, not a separate id.
      disabledSkillIds: z.array(z.string()).catch([]),
    })
    .catch({
      disabledSkillIds: [],
    }),

  // YOLO workspace configuration
  yolo: z
    .object({
      baseDir: z.string().catch('YOLO'),
      // Vault-relative project/task directory, separate from `baseDir` so user
      // content stays visible and portable. Defaults to a top-level Projects.
      projectsDir: z.string().optional(),
    })
    .catch({
      baseDir: 'YOLO',
    }),

  debug: z
    .object({
      captureRawRequestDebug: z.boolean().optional(),
    })
    .catch({
      captureRawRequestDebug: false,
    }),

  // Media models (TTS/STT/image)
  ttsModels: resilientArraySchema(ttsModelSchema),
  sttModels: resilientArraySchema(sttModelSchema),
  imageModels: resilientArraySchema(imageModelSchema),
  ttsModelId: z.string().catch(''),
  sttModelId: z.string().catch(''),
  imageModelId: z.string().catch(''),

  subagentTimeout: subagentTimeoutSettingsSchema.optional(),

  // Cap for a child subagent result copied back into the parent conversation.
  // Read through the result-limit settings getter so changes take effect
  // without a restart. `.catch` keeps absent or malformed values at the default.
  //
  // The floor is the truncation-marker length + 1 so the configured cap can
  // always hold the injected text: the content budget reserves room for the
  // marker, and a cap of `marker + 1` yields exactly `marker + 1` chars. Any
  // smaller cap would let the injected total exceed the configured cap.
  subagentResultMaxChars: z
    .number()
    .int()
    .min(SUBAGENT_RESULT_TRUNCATION_MARKER_LENGTH + 1)
    .catch(SUBAGENT_RESULT_MAX_CHARS),

  // Parent messages composed into a `last_turns` subagent fork. Read through
  // the parent-context settings getter so changes take effect without a
  // restart. `.catch` keeps absent or malformed values at the default.
  forkContextTurns: z
    .number()
    .int()
    .min(1)
    .catch(SUBAGENT_FORK_CONTEXT_TURNS_DEFAULT),

  // Chat options
  chatOptions: z
    .object({
      includeCurrentFileContent: z.boolean(),
      mentionDisplayMode: z.enum(['inline', 'badge']).optional(),
      mentionContextMode: z.enum(['light', 'full']).optional(),
      enterKeyCreatesNewline: z.boolean().optional(),
      chatInputHeight: z.number().int().min(80).max(520).optional(),
      chatApplyMode: z.enum(['review-required', 'direct-apply']).optional(),
      chatTitlePrompt: z.string().optional(),
      // Chat mode (ask/agent)
      chatMode: z.enum(['ask', 'agent']).optional(),
      // Auto-approve tool calls (YOLO). Orthogonal to chatMode; only effective
      // in Agent mode.
      agentYoloEnabled: z.boolean().optional(),
      // Whether the user has acknowledged the first-time full access (YOLO) warning
      fullAccessWarningConfirmed: z.boolean().optional(),
      // Persist preferred reasoning level per model id in Chat input
      reasoningLevelByModelId: z
        .record(z.string(), z.enum(REASONING_LEVELS))
        .optional(),
      // Auto context compaction prompt injected at runtime LLM boundaries
      // (based on last assistant usage).
      autoContextCompactionEnabled: z.boolean().optional(),
      autoContextCompactionThresholdMode: z
        .enum(['tokens', 'ratio'])
        .optional(),
      autoContextCompactionThresholdTokens: z.number().int().min(1).optional(),
      autoContextCompactionThresholdRatio: z.number().min(0).max(1).optional(),
      // Font scale factor for chat messages (1 = default)
      chatFontScale: z.number().min(0.7).max(1.5).optional(),
      // Image reading & compression for vision tool calls
      imageReadingEnabled: z.boolean().optional(),
      imageCompressionEnabled: z.boolean().optional(),
      imageCompressionQuality: z.number().min(1).max(100).optional(),
      // Fetch external (http/https) image URLs referenced in Markdown
      externalImageFetchEnabled: z.boolean().optional(),
      // Include assistant reasoning in exported chat markdown
      chatExportIncludeThinking: z.boolean().optional(),
      // Include tool call blocks in exported chat markdown
      chatExportIncludeToolCalls: z.boolean().optional(),
      // Where the ribbon icon should open the Chat view
      ribbonClickAction: z
        .enum(['sidebar', 'tab', 'split', 'window', 'last'])
        .optional(),
      // Last placement actually used to open a chat leaf; only consulted when
      // `ribbonClickAction === 'last'`
      lastChatPlacement: z
        .enum(['sidebar', 'tab', 'split', 'window'])
        .optional(),
      // Last user-selected conversation surface and CLI provider. Kept
      // separately so returning to Chat does not forget the preferred CLI.
      lastChatSurface: z.enum(['chat', 'cli']).optional(),
      lastCliRuntimeId: z.enum(['claude-code', 'codex']).optional(),
      cliModelIdByRuntime: z
        .object({
          'claude-code': z.string().optional(),
          codex: z.string().optional(),
        })
        .optional(),
      cliReasoningEffortByModel: z.record(z.string(), z.string()).optional(),
      // Last CLI chat mode (agent/plan) remembered per CLI runtime.
      cliChatModeByRuntime: z
        .object({
          'claude-code': z.enum(['agent', 'plan']).optional(),
          codex: z.enum(['agent', 'plan']).optional(),
        })
        .optional(),
      // Last CLI YOLO flag remembered per CLI runtime.
      cliAgentYoloEnabledByRuntime: z
        .object({
          'claude-code': z.boolean().optional(),
          codex: z.boolean().optional(),
        })
        .optional(),
      quickAccessEntries: resilientArraySchema(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('skill'), name: z.string().min(1) }),
          z.object({ type: z.literal('snippet'), id: z.string().min(1) }),
        ]),
      ).optional(),
      moa: moaSettingsSchema.optional(),
    })
    .catch({
      includeCurrentFileContent: true,
      mentionDisplayMode: 'inline',
      mentionContextMode: 'light',
      chatInputHeight: undefined,
      chatApplyMode: 'review-required',
      chatTitlePrompt: '',
      chatMode: 'agent',
      fullAccessWarningConfirmed: false,
      reasoningLevelByModelId: {},
      autoContextCompactionEnabled: false,
      autoContextCompactionThresholdMode: 'tokens',
      autoContextCompactionThresholdTokens: 100000,
      autoContextCompactionThresholdRatio: 0.8,
      chatFontScale: undefined,
      imageReadingEnabled: true,
      imageCompressionEnabled: true,
      imageCompressionQuality: 85,
      externalImageFetchEnabled: false,
      chatExportIncludeThinking: false,
      chatExportIncludeToolCalls: false,
      ribbonClickAction: 'sidebar',
      lastChatSurface: 'chat',
      lastCliRuntimeId: 'claude-code',
      cliModelIdByRuntime: {},
      cliReasoningEffortByModel: {},
      cliChatModeByRuntime: {},
      cliAgentYoloEnabledByRuntime: {},
      lastChatPlacement: undefined,
      quickAccessEntries: DEFAULT_CHAT_QUICK_ACCESS_ENTRIES,
    }),

  notificationOptions: notificationOptionsSchema,

  learningOptions: z.unknown().optional(),

  // Continuation (续写) options
  continuationOptions: z
    .object({
      // dedicated model for tab completion and selection rewrite (Quick Ask's
      // "continue" mode uses the panel's own assistant model instead, see
      // QuickAskPanel's modelClient)
      continuationModelId: z.string().optional(),
      // enable selection chat (Cursor-like text selection actions)
      enableSelectionChat: z.boolean().optional(),
      // persist selected editor block highlight while chatting in sidebar
      persistSelectionHighlight: z.boolean().optional(),
      // enable manual context selection for continuation
      manualContextEnabled: z.boolean().optional(),
      // manual context folders picked by user from the vault
      manualContextFolders: z.array(z.string()).optional(),
      // folders that should be fully injected into continuation context
      referenceRuleFolders: z.array(z.string()).optional(),
      // folders used as the scoped knowledge base for RAG retrieval
      knowledgeBaseFolders: z.array(z.string()).optional(),
      // override sampling parameters specifically for continuation
      temperature: z.number().min(0).max(2).optional(),
      topP: z.number().min(0).max(1).optional(),
      // enable or disable streaming responses for continuation results
      stream: z.boolean().optional(),
      // cap on how many characters of context to send with continuation requests
      maxContinuationChars: z.number().int().min(0).optional(),
      // enable tab completion based on prefix suggestion
      enableTabCompletion: z.boolean().optional(),
      // fixed model id for tab completion suggestions
      tabCompletionModelId: z.string().optional(),
      // extra options for tab completion behavior
      tabCompletionOptions: tabCompletionOptionsSchema.optional(),
      // triggers used to invoke tab completion
      tabCompletionTriggers: z
        .array(tabCompletionTriggerSchema)
        .catch([...DEFAULT_TAB_COMPLETION_TRIGGERS]),
      // override system prompt for tab completion
      tabCompletionSystemPrompt: z.string().optional(),
      // extra prompt constraints for tab completion
      tabCompletionConstraints: z.string().optional(),
      // length preset for tab completion prompt constraints
      tabCompletionLengthPreset: z.enum(['short', 'medium', 'long']).optional(),
      // Quick Ask "continue" mode quick actions (chips shown when the
      // continue mode input is empty). Key name predates the Quick Ask
      // "continue" mode (it originally belonged to the now-removed Smart
      // Space panel); kept as-is to avoid a settings migration.
      smartSpaceQuickActions: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            instruction: z.string(),
            icon: z.string().optional(),
            category: z
              .enum(['suggestions', 'writing', 'thinking', 'custom'])
              .optional(),
            enabled: z.boolean().default(true),
          }),
        )
        .optional(),
      // Selection Chat custom actions
      selectionChatActions: z
        .array(
          z.object({
            id: z.string(),
            label: z.string(),
            instruction: z.string(),
            mode: z
              .enum(['ask', 'rewrite', 'chat-input', 'chat-send'])
              .optional(),
            rewriteBehavior: z.enum(['custom', 'preset']).optional(),
            assistantId: z.string().optional(),
            enabled: z.boolean().default(true),
          }),
        )
        .optional(),
      // enable quick ask feature (@ trigger in empty line)
      enableQuickAsk: z.boolean().optional(),
      // trigger character for quick ask (default: @)
      quickAskTrigger: z.string().optional(),
      // Quick Ask mode. The UI only ever persists 'ask'/'agent'/'continue' —
      // 'edit' and 'edit-direct' are kept here only so a leftover legacy
      // value in an old data.json doesn't fail this whole continuationOptions
      // object's validation (see the single .catch() below). Callers
      // normalize any unrecognized value, including these legacy ones, to
      // 'ask'.
      quickAskMode: z
        .enum(['ask', 'edit', 'edit-direct', 'agent', 'continue'])
        .optional(),
      // auto dock quick ask to editor top right after sending
      quickAskAutoDockToTopRight: z.boolean().optional(),
      // quick ask context chars before cursor
      quickAskContextBeforeChars: z.number().int().min(0).optional(),
      // quick ask context chars after cursor
      quickAskContextAfterChars: z.number().int().min(0).optional(),
      // whether a failed streaming primary request should recover once with non-stream fallback
      streamFallbackRecoveryEnabled: z.boolean().optional(),
      // timeout for the primary request before recovery is considered
      primaryRequestTimeoutMs: z
        .number()
        .int()
        .min(1000)
        .max(MAX_MODEL_REQUEST_TIMEOUT_MS)
        .optional(),
    })
    .catch({
      continuationModelId:
        DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_CHAT_TITLE_MODEL_ID)
          ?.id ?? '',
      enableSelectionChat: true,
      persistSelectionHighlight: true,
      manualContextEnabled: false,
      manualContextFolders: [],
      referenceRuleFolders: [],
      knowledgeBaseFolders: [],
      stream: true,
      maxContinuationChars: 8000,
      enableTabCompletion: false,
      tabCompletionModelId:
        DEFAULT_CHAT_MODELS.find((v) => v.id === DEFAULT_CHAT_TITLE_MODEL_ID)
          ?.id ?? '',
      tabCompletionOptions: { ...DEFAULT_TAB_COMPLETION_OPTIONS },
      tabCompletionTriggers: [...DEFAULT_TAB_COMPLETION_TRIGGERS],
      tabCompletionSystemPrompt: DEFAULT_TAB_COMPLETION_SYSTEM_PROMPT,
      tabCompletionConstraints: '',
      tabCompletionLengthPreset: DEFAULT_TAB_COMPLETION_LENGTH_PRESET,
      smartSpaceQuickActions: undefined,
      selectionChatActions: undefined,
      enableQuickAsk: true,
      quickAskTrigger: '@',
      quickAskMode: 'ask',
      quickAskAutoDockToTopRight: true,
      quickAskContextBeforeChars: 5000,
      quickAskContextAfterChars: 2000,
      streamFallbackRecoveryEnabled: true,
      primaryRequestTimeoutMs: DEFAULT_MODEL_REQUEST_TIMEOUT_MS,
    }),

  // Assistant list
  assistants: resilientArraySchema(assistantSchema),

  // Bot platform instances
  bots: botsSettingsSchema.catch({
    enabled: false,
    whitelistEnabled: true,
    groupChatEnabled: false,
    adminUsers: [],
    platforms: [],
    sessionMappings: [],
  }),

  // Workspace agent instances (inherit an assistant template + override)
  workspaceAgents: resilientArraySchema(workspaceAgentSchema),
  currentWorkspaceAgentId: z.string().optional(),

  // Currently selected assistant ID
  currentAssistantId: z.string().optional(),

  // Quick Ask selected assistant ID
  quickAskAssistantId: z.string().optional(),
})
export type YoloSettings = z.infer<typeof yoloSettingsSchema>

export type SettingMigration = {
  fromVersion: number
  toVersion: number
  migrate: (data: Record<string, unknown>) => Record<string, unknown>
}
