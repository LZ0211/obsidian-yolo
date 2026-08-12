import { normalizePath } from 'obsidian'

import type { ScheduledTasksSettings } from '../../settings/schema/setting.types'

export type ScriptPathValidationError =
  | { code: 'execution_disabled'; message: string }
  | { code: 'absolute_path'; message: string }
  | { code: 'path_escape'; message: string }
  | { code: 'outside_allowlist'; message: string }

export type ScriptExecutionSettings = Pick<
  ScheduledTasksSettings,
  'enableScriptExecution' | 'allowedScriptDirectories'
>

/**
 * Hard input validation for a vault-relative script path, shared by `TaskExecutor.executeScript()`
 * (defense at execution time), `ScheduledTasksService.createTask`/`updateTask` (defense at
 * create/edit time, so a bad path is rejected before it's ever scheduled), and `TaskEditorModal`'s
 * submit handler — one implementation so the UI, the MCP tools, and the executor can never disagree
 * about which paths are allowed. Independent of tool approval gating (`tool-preferences.ts`): this
 * rejects invalid input outright rather than asking for user confirmation.
 */
export function validateScriptPath(
  scriptPath: string,
  settings: ScriptExecutionSettings,
): ScriptPathValidationError | null {
  if (!settings.enableScriptExecution) {
    return {
      code: 'execution_disabled',
      message: '脚本任务执行功能未启用（设置 → 定时任务 → 允许执行脚本）',
    }
  }
  // normalizePath only regularizes separators/case, it doesn't resolve '..' segments — absolute
  // paths and path-escape must still be checked explicitly, not inferred from the normalized result.
  if (
    /^[a-zA-Z]:[\\/]/.test(scriptPath) ||
    scriptPath.startsWith('/') ||
    scriptPath.startsWith('\\')
  ) {
    return {
      code: 'absolute_path',
      message: `脚本路径必须是 Vault 内相对路径，不能是绝对路径: ${scriptPath}`,
    }
  }
  const normalized = normalizePath(scriptPath)
  if (normalized.split('/').includes('..')) {
    return {
      code: 'path_escape',
      message: `脚本路径不能包含 "../" 路径逃逸: ${scriptPath}`,
    }
  }
  const allowlist =
    settings.allowedScriptDirectories.length > 0
      ? settings.allowedScriptDirectories
      : ['']
  const isAllowed = allowlist.some(
    // An empty entry denotes the vault root, which contains every non-escaping relative path.
    (dir) =>
      dir === '' ||
      normalized === dir ||
      normalized.startsWith(normalizePath(`${dir}/`)),
  )
  if (!isAllowed) {
    return {
      code: 'outside_allowlist',
      message: `脚本路径不在允许的目录列表内: ${scriptPath}（允许: ${allowlist
        .map((dir) => dir || '/(Vault 根目录)')
        .join(', ')}）`,
    }
  }
  return null
}
