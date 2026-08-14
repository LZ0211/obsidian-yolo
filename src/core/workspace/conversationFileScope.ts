import type { WorkspaceAgentPolicy } from '../../settings/schema/setting.types'
import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { ChatMessage } from '../../types/chat'

import {
  decideWorkspacePathAccess,
  normalizeVaultRootPath,
} from './workspacePermissionEngine'

export type EffectiveConversationFileScope = {
  explicitWorkingDirectory?: string
  workingDirectory: string
  workspaceAccessPolicy?: WorkspaceAccessPolicy
}

export type ConversationDirectoryCompatibility =
  | { ok: true; directory: string }
  | {
      ok: false
      reason: 'invalid' | 'not_readable' | 'not_writable'
    }

export function normalizeConversationWorkingDirectory(raw: string): string {
  try {
    return normalizeVaultRootPath(raw)
  } catch {
    throw new Error('Invalid path')
  }
}

export function isConversationFileScopeLocked(
  messages: readonly Pick<ChatMessage, 'role'>[],
  fileScopeLocked?: boolean,
): boolean {
  return (
    fileScopeLocked === true ||
    messages.some((message) => message.role === 'user')
  )
}

export function isAgentCompatibleWithDirectory(
  agentPolicy: WorkspaceAccessPolicy | undefined,
  workingDirectory: string,
): ConversationDirectoryCompatibility {
  let directory: string
  try {
    directory = normalizeConversationWorkingDirectory(workingDirectory)
  } catch {
    return { ok: false, reason: 'invalid' }
  }

  const policy = toWorkspaceAgentPolicy(agentPolicy)
  const writeDecision = decideWorkspacePathAccess({
    policy,
    operation: 'write',
    path: directory,
  })
  if (!writeDecision.ok) {
    return { ok: false, reason: 'not_writable' }
  }

  const readDecision = decideWorkspacePathAccess({
    policy,
    operation: 'read',
    path: directory,
  })
  if (!readDecision.ok) {
    return { ok: false, reason: 'not_readable' }
  }

  return { ok: true, directory }
}

export function resolveConversationFileScope(
  agentPolicy: WorkspaceAccessPolicy | undefined,
  workingDirectory: string | undefined,
): EffectiveConversationFileScope {
  const activePolicy = agentPolicy?.enabled ? agentPolicy : undefined
  if (workingDirectory === undefined) {
    return {
      workingDirectory: activePolicy
        ? normalizePolicyPath(activePolicy.workspaceRoot)
        : '/',
      workspaceAccessPolicy: activePolicy,
    }
  }

  const compatibility = isAgentCompatibleWithDirectory(
    activePolicy,
    workingDirectory,
  )
  if (!compatibility.ok) {
    throw new Error(
      `Conversation working directory is ${compatibility.reason.replace('_', ' ')}`,
    )
  }

  const directory = compatibility.directory
  const baseRoot = activePolicy
    ? normalizePolicyPath(activePolicy.workspaceRoot)
    : '/'
  const readableRoots = activePolicy
    ? [baseRoot, ...activePolicy.readExtraIncludes.map(normalizePolicyPath)]
    : ['/']
  const readExtraIncludes = Array.from(new Set(readableRoots)).filter(
    (root) => root !== directory,
  )

  return {
    explicitWorkingDirectory: directory,
    workingDirectory: directory,
    workspaceAccessPolicy: {
      enabled: true,
      workspaceRoot: directory,
      readExtraIncludes,
      readExcludes: activePolicy?.readExcludes ?? [],
      writeExcludes: activePolicy?.writeExcludes ?? [],
      // 收窄工作目录只调整根与读取面；宿主托管保护路径（插件私有数据）
      // 必须原样保留，否则 git-diff/fs/bash 的写排除会失效。
      ...(activePolicy?.protectedPaths
        ? { protectedPaths: activePolicy.protectedPaths }
        : {}),
    },
  }
}

function toWorkspaceAgentPolicy(
  policy: WorkspaceAccessPolicy | undefined,
): WorkspaceAgentPolicy {
  if (!policy?.enabled) {
    return {
      workspaceRoot: '/',
      readAllowlist: [],
      readDenylist: [],
      writeDenylist: [],
    }
  }

  return {
    workspaceRoot: normalizePolicyPath(policy.workspaceRoot),
    readAllowlist: policy.readExtraIncludes.map(normalizePolicyPath),
    readDenylist: policy.readExcludes.map(normalizePolicyPath),
    writeDenylist: policy.writeExcludes.map(normalizePolicyPath),
  }
}

function normalizePolicyPath(path: string): string {
  return normalizeConversationWorkingDirectory(path.trim() || '/')
}
