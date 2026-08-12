import type { YoloSettings } from '../../../settings/schema/setting.types'
import type {
  Assistant,
  AssistantToolPreference,
} from '../../../types/assistant.types'

export type DelegatableAssistantRole = {
  id: string
  name: string
}

const LOCAL_TOOL_SERVER = 'yolo_local'

const localTool = (shortName: string): string =>
  `${LOCAL_TOOL_SERVER}__${shortName}`

const localToolPreferences = (
  shortNames: readonly string[],
): Record<string, AssistantToolPreference> =>
  Object.fromEntries(
    shortNames.map((shortName) => [
      localTool(shortName),
      {
        enabled: true,
        approvalMode: 'full_access',
        disclosureMode: 'always',
      } satisfies AssistantToolPreference,
    ]),
  )

const READ_AND_TASK_TOOLS = [
  'fs_list',
  'fs_search',
  'meta_search',
  'fs_read',
  'conversation_history',
  'todo_write',
] as const

export const BUILTIN_SUBAGENT_ASSISTANTS: readonly Assistant[] = Object.freeze([
  Object.freeze({
    id: '__builtin_subagent_general_worker__',
    name: 'General Worker',
    description:
      'Built-in delegated subagent for bounded multi-step inspection, summarization, and execution.',
    systemPrompt: `You are a built-in General Worker subagent.

Focus on the delegated task only. Work autonomously from the task prompt and tool results. Use tools when they materially improve evidence or accuracy. Keep scope tight: do not turn a bounded task into broad research.

When useful, make a short private plan, inspect the necessary evidence, then return a concise result. If the task asks for code or document changes but the available tools do not permit safe editing, report the exact change that should be made instead of pretending it was applied.`,
    delegatable: true,
    enableTools: true,
    includeBuiltinTools: true,
    enabledToolNames: [],
    toolPreferences: localToolPreferences(READ_AND_TASK_TOOLS),
    toolServerPreferences: {},
    enabledSkills: [],
    skillPreferences: {},
  } satisfies Assistant),
  Object.freeze({
    id: '__builtin_subagent_file_explorer__',
    name: 'File Explorer',
    description:
      'Built-in delegated subagent for read-only codebase and vault file exploration.',
    systemPrompt: `You are a built-in File Explorer subagent.

Your job is to locate relevant files, symbols, notes, and exact evidence quickly. Prefer broad search before reading full files. Use precise line or section reads when possible. Do not modify files, run state-changing commands, or infer facts that are not supported by inspected content.

Return absolute or workspace-relative paths, the relevant line/section evidence when available, and a short explanation of why each item matters.`,
    delegatable: true,
    enableTools: true,
    includeBuiltinTools: true,
    enabledToolNames: [],
    toolPreferences: localToolPreferences([
      'fs_list',
      'fs_search',
      'meta_search',
      'fs_read',
      'conversation_history',
    ]),
    toolServerPreferences: {},
    enabledSkills: [],
    skillPreferences: {},
  } satisfies Assistant),
  Object.freeze({
    id: '__builtin_subagent_reviewer__',
    name: 'Reviewer',
    description:
      'Built-in delegated subagent for independent code, spec, and design review.',
    systemPrompt: `You are a built-in Reviewer subagent.

Review independently and evidence-first. Look for correctness bugs, missing requirements, unsafe assumptions, performance risks, data-loss risks, and tests that do not prove the behavior. Prefer concrete findings over style comments.

For each finding, include severity, affected file or area, evidence, and a specific recommended fix. If no high-confidence issue is found, say so and list what you checked.`,
    delegatable: true,
    enableTools: true,
    includeBuiltinTools: true,
    enabledToolNames: [],
    toolPreferences: localToolPreferences(READ_AND_TASK_TOOLS),
    toolServerPreferences: {},
    enabledSkills: [],
    skillPreferences: {},
  } satisfies Assistant),
  Object.freeze({
    id: '__builtin_subagent_vault_librarian__',
    name: 'Vault Librarian',
    description:
      'Built-in delegated subagent for Obsidian vault and Agent knowledge-base retrieval.',
    systemPrompt: `You are a built-in Vault Librarian subagent for an Obsidian vault.

Treat the vault as the user's local knowledge base, not as model training data. Search before answering vault-specific questions. Start with comprehensive fs_search when available, then read only the precise files, lines, or sections needed to verify the answer. Use related terms, entities, concepts, aliases, and wikilinks to improve recall when the first search is incomplete.

Answer only from retrieved vault evidence. If the vault does not contain enough information, state what was searched and what is missing. Prefer precise source references over long copied passages.`,
    delegatable: true,
    enableTools: true,
    includeBuiltinTools: true,
    enabledToolNames: [],
    toolPreferences: localToolPreferences([
      'fs_list',
      'fs_search',
      'meta_search',
      'fs_read',
      'conversation_history',
      'todo_write',
    ]),
    toolServerPreferences: {},
    enabledSkills: [],
    skillPreferences: {},
  } satisfies Assistant),
])

const BUILTIN_SUBAGENT_ASSISTANT_IDS = new Set(
  BUILTIN_SUBAGENT_ASSISTANTS.map((assistant) => assistant.id),
)

export function listDelegatableAssistantRoles(
  settings: YoloSettings,
): DelegatableAssistantRole[] {
  const seenIds = new Set<string>()
  const roles: DelegatableAssistantRole[] = []

  for (const { id, name, delegatable } of settings.assistants) {
    if (seenIds.has(id) || BUILTIN_SUBAGENT_ASSISTANT_IDS.has(id)) continue
    seenIds.add(id)
    if (delegatable === true) roles.push({ id, name })
  }

  for (const { id, name } of BUILTIN_SUBAGENT_ASSISTANTS) {
    roles.push({ id, name })
  }

  return roles
}

export function resolveDelegatableAssistant(
  settings: YoloSettings,
  assistantId: string,
): Assistant {
  const requestedId = assistantId.trim()
  const builtInAssistant = BUILTIN_SUBAGENT_ASSISTANTS.find(
    (candidate) => candidate.id === requestedId,
  )
  if (builtInAssistant) return builtInAssistant

  const assistant = settings.assistants.find(
    (candidate) => candidate.id === requestedId,
  )

  if (!assistant) {
    throw new Error(`Assistant role "${requestedId}" does not exist.`)
  }

  if (assistant.delegatable !== true) {
    throw new Error(
      `Assistant role "${requestedId}" is not available for delegation.`,
    )
  }

  return assistant
}
