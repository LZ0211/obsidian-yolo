/**
 * YOLO 本地文件工具名常量叶子模块（无 import 依赖，杜绝经 tool-preferences 等
 * 回流成环——决策 B 断环：localFileTools → subagent/* → tool-preferences →
 * localFileTools 的前向边不可断，改断此叶子可消的后向边）。
 *
 * 注意：`LOCAL_FILE_TOOL_SERVER` 与 core/agent/subagent/tool-name-utils.ts 的
 * 同值内联常量需保持同步（上游同步便利优先，不做跨模块引用）。
 */

export const LOCAL_FILE_TOOL_SERVER = 'yolo_local'

export function getLocalFileToolServerName(): string {
  return LOCAL_FILE_TOOL_SERVER
}

export const TERMINAL_COMMAND_TOOL_NAME = 'terminal_command'
export const BASH_TOOL_NAME = 'bash'
export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question'
export const LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME = 'load_tool_schemas'

/** js_eval 沙箱工具名（原定义于 jsSandboxTool.ts，随工具名常量一并下沉）。 */
export const JS_SANDBOX_TOOL_NAME = 'js_eval'

export const LOCAL_FILE_TOOL_SHORT_NAMES = [
  BASH_TOOL_NAME,
  'context_prune_tool_results',
  'context_compact',
  'context_manage',
  'fs_read',
  'fs_edit',
  'fs_write',
  'mineru_convert',
  'memory_add',
  'memory_update',
  'memory_delete',
  'meta_search',
  'web_search',
  'web_scrape',
  JS_SANDBOX_TOOL_NAME,
  TERMINAL_COMMAND_TOOL_NAME,
  'delegate_subagent',
  'project_ops',
  'scheduled_task_ops',
  'load_tool_schemas',
  'todo_write',
  'ask_user_question',
  'send_attachment',
] as const

// Excluded from the user-facing Agent settings surface. `load_tool_schemas`
// is a protocol tool for the on-demand disclosure mechanism, not a user
// capability. `send_attachment` is a bot-runtime-only capability (Bot
// Platform Phase 6.5) — it is only ever offered by `agent-runner.ts`
// appending its FQN directly to a bot run's `allowedToolNames`, never through
// per-assistant `toolPreferences`, so it must not be enumerable/toggleable in
// the normal Agent settings UI.
const NON_USER_FACING_LOCAL_TOOL_SHORT_NAMES = new Set<string>([
  'load_tool_schemas',
  'send_attachment',
  'memory_add',
  'memory_update',
  'memory_delete',
])

export const isUserFacingLocalToolShortName = (name: string): boolean =>
  !NON_USER_FACING_LOCAL_TOOL_SHORT_NAMES.has(name)

/**
 * Subset of {@link LOCAL_FILE_TOOL_SHORT_NAMES} that the user actually
 * configures via the Agent settings panel. See
 * {@link NON_USER_FACING_LOCAL_TOOL_SHORT_NAMES} for what's excluded and why.
 * The runtime still dispatches and normalizes excluded tools through
 * `LOCAL_FILE_TOOL_SHORT_NAMES`; they just aren't part of the per-agent tool
 * preference surface.
 */
export const USER_FACING_LOCAL_TOOL_SHORT_NAMES: readonly string[] =
  LOCAL_FILE_TOOL_SHORT_NAMES.filter(isUserFacingLocalToolShortName)

export const LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION = {
  fs_write: 'write',
} as const

export const LOCAL_FS_SPLIT_ACTION_TOOL_NAMES = Object.keys(
  LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION,
) as Array<keyof typeof LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION>

export const LOCAL_FS_EDIT_TOOL_NAMES = ['fs_edit', 'fs_write'] as const
