/**
 * subagent 工具名常量叶子模块（决策 B 断环：无任何 import）。
 *
 * 原先这些常量住在 subagent/constants.ts，经 `getLocalFileToolServerName`
 * （mcp/localFileTools）回流成环（localFileTools → subagent/* → tool-preferences
 * → localFileTools）。下沉后本文件与 mcp/localFileToolNames.ts 同属叶子，
 * 环被切断。`yolo_local` 与 mcp/localFileToolNames.ts 的 LOCAL_FILE_TOOL_SERVER
 * 同值——为保持叶子零依赖而内联，修改时两处需同步。
 */
const LOCAL_FILE_TOOL_SERVER = 'yolo_local'

export const DELEGATE_SUBAGENT_TOOL_SHORT_NAME = 'delegate_subagent'

/**
 * Baseline tools blocked for every child subagent run regardless of settings:
 * `delegate_subagent` (no recursive subagent dispatch) and `ask_user_question`
 * (no UI surface to render the prompt). These are runtime-enforced.
 *
 * Tools that merely require approval (`js_eval` with high-risk caps, `fs_edit`
 * in review mode, etc.) are NOT blocked here — their approval requests are
 * routed to the parent conversation's UI (the SubagentCard renders an inline
 * approval block). See `docs/plans/2026-06-18-subagent-tool-approval-routing.md`.
 */
export const SUBAGENT_BLOCKED_TOOL_SHORT_NAMES: readonly string[] = [
  DELEGATE_SUBAGENT_TOOL_SHORT_NAME,
  'ask_user_question',
]

export const SUBAGENT_BLOCKED_TOOL_NAMES: readonly string[] =
  SUBAGENT_BLOCKED_TOOL_SHORT_NAMES.map(
    (shortName) => `${LOCAL_FILE_TOOL_SERVER}__${shortName}`,
  )
