import { normalizePath } from 'obsidian'

import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { YoloSettingsLike } from '../../types/yoloSettingsLike'
import {
  YOLO_SYNC_POINTER_FILE_NAME,
  getYoloBaseDir,
  getYoloSkillsDir,
  getYoloSnippetsPath,
} from './yoloPaths'

/**
 * 宿主托管保护规则：`prefix`/`exact`/`namePrefix` 拒绝；`except` 从已匹配
 * 的保护中挖除（技能文件是用户内容，位于 baseDir 下但必须可达）。
 */
export type ProtectedPathRule =
  | { kind: 'prefix'; path: string }
  | { kind: 'exact'; path: string }
  | { kind: 'namePrefix'; dir: string; name: string }
  | { kind: 'except'; path: string }

/**
 * 保护路径 = baseDir 整体 − 技能相关路径。项目目录是 baseDir 的子目录
 * （projects），随兜底规则一起受保护。不做专门规则体系。
 */
export const getProtectedVaultPathRules = (
  settings?: YoloSettingsLike | null,
): ProtectedPathRule[] => {
  const baseDir = getYoloBaseDir(settings)
  const normalizedBaseDir = normalizePath(baseDir.trim())
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
  const rules: ProtectedPathRule[] = [
    ...(normalizedBaseDir
      ? [{ kind: 'prefix' as const, path: normalizedBaseDir }]
      : []),
    // 技能文件（skills 目录 + snippets 文件）是 baseDir 下的用户内容。
    { kind: 'except', path: getYoloSkillsDir(settings) },
    { kind: 'except', path: getYoloSnippetsPath(settings) },
    // Vault 根的固定指针文件（不在 baseDir 内）。
    { kind: 'exact', path: YOLO_SYNC_POINTER_FILE_NAME },
  ]
  return rules
}

const normalizeProtectedPath = (value: string): string =>
  normalizePath(value.trim()).replace(/^\/+/, '').replace(/\/+$/, '')

/**
 * Copies a workspace policy and attaches the current host-managed deny rules.
 * Runs without workspace scoping receive a disabled policy that still carries
 * the host protection rules.
 */
export const augmentWorkspacePolicyWithProtectedPaths = (
  policy: WorkspaceAccessPolicy | undefined,
  settings?: YoloSettingsLike | null,
): WorkspaceAccessPolicy | undefined => {
  return {
    ...(policy ?? {
      enabled: false,
      workspaceRoot: '',
      readExtraIncludes: [],
      readExcludes: [],
      writeExcludes: [],
    }),
    protectedPaths: getProtectedVaultPathRules(settings),
  }
}

export const isProtectedVaultPath = (
  vaultPath: string,
  rules: readonly ProtectedPathRule[] | undefined,
): boolean => {
  if (!rules || rules.length === 0) return false
  const normalized = normalizeProtectedPath(vaultPath)
  if (normalized.length === 0) return false

  const matchesPrefixLike = (path: string, rulePath: string): boolean =>
    path === rulePath || path.startsWith(`${rulePath}/`)

  // 挖除优先：技能路径即使落入 baseDir 兜底也不算受保护。
  for (const rule of rules) {
    if (rule.kind !== 'except') continue
    if (matchesPrefixLike(normalized, rule.path)) return false
  }

  for (const rule of rules) {
    if (rule.kind === 'exact') {
      if (normalized === rule.path) return true
      continue
    }
    if (rule.kind === 'namePrefix') {
      if (
        normalized !== rule.dir &&
        !normalized.startsWith(`${rule.dir}/`)
      ) {
        continue
      }
      const lastSegment = normalized.slice(normalized.lastIndexOf('/') + 1)
      if (lastSegment.startsWith(rule.name)) return true
      continue
    }
    if (rule.kind === 'prefix' && matchesPrefixLike(normalized, rule.path)) {
      return true
    }
  }
  return false
}
