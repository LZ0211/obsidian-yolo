import { resolveConversationFileScope } from '../../core/workspace/conversationFileScope'
import type { Assistant } from '../../types/assistant.types'

/**
 * Chat and Agent runtimes both inherit workspace scope from the selected assistant
 * so restricted Chat tools (e.g. bash) respect the same boundaries as Agent.
 */
export function resolveWorkspaceScopeForRuntimeInput(
  assistant: Assistant | null | undefined,
): Assistant['workspaceScope'] | undefined {
  return assistant?.workspaceScope
}

/**
 * 会话工作目录（backup 语义）：静态 assistant 策略 + 显式工作目录合成
 * 动态策略，限定该会话内工具的读写边界。
 */
export function resolveWorkspaceAccessPolicyForRuntimeInput(
  assistant: Assistant | null | undefined,
  workingDirectory?: string,
): Assistant['workspaceAccessPolicy'] | undefined {
  return resolveConversationFileScope(
    assistant?.workspaceAccessPolicy,
    workingDirectory,
  ).workspaceAccessPolicy
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
