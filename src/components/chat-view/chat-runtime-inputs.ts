import { augmentWorkspacePolicyWithProtectedPaths } from '../../core/paths/protectedPaths'
import { resolveConversationFileScope } from '../../core/workspace/conversationFileScope'
import type { Assistant } from '../../types/assistant.types'
import type { YoloSettingsLike } from '../../types/yoloSettingsLike'

/**
 * 会话工作目录（backup 语义）：静态 assistant 策略 + 显式工作目录合成
 * 动态策略，限定该会话内工具的读写边界。
 */
export function resolveWorkspaceAccessPolicyForRuntimeInput(
  assistant: Assistant | null | undefined,
  workingDirectory?: string,
  settings?: YoloSettingsLike | null,
): Assistant['workspaceAccessPolicy'] | undefined {
  // 宿主保护路径（baseDir − 技能路径）在所有运行时入口统一注入：
  // 无论 assistant 策略如何配置，fs/bash/git-diff 都不能触达插件私有数据。
  return augmentWorkspacePolicyWithProtectedPaths(
    resolveConversationFileScope(
      assistant?.workspaceAccessPolicy,
      workingDirectory,
    ).workspaceAccessPolicy,
    settings,
  )
}

export function resolveWorkingDirectoryForRuntimeInput(
  assistant: Assistant | null | undefined,
  workingDirectory?: string,
): string {
  return resolveConversationFileScope(
    assistant?.workspaceAccessPolicy,
    workingDirectory,
  ).workingDirectory
}
