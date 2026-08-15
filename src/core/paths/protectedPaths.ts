import { normalizePath } from 'obsidian'

import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { YoloSettingsLike } from '../../types/yoloSettingsLike'
import {
  CONVERSATION_JOURNAL_SQLITE_FILE_NAME,
  SESSION_JOURNAL_SQLITE_FILE_NAME,
  YOLO_MEMORY_SUBDIR,
  YOLO_SYNC_POINTER_FILE_NAME,
  YOLO_VECTOR_DB_FILE_NAME,
  getYoloBaseDir,
  getYoloDataJsonPath,
  getYoloJsonDbRootDir,
  getYoloProjectsDir,
} from './yoloPaths'

/**
 * A settings-driven host-managed deny rule. `prefix` denies the exact path and
 * everything below it; `exact` denies only that exact vault-relative path;
 * `namePrefix` denies files under `dir` whose name starts with `name`. Every
 * path is a normalized vault-relative path.
 */
export type ProtectedPathRule =
  | { kind: 'prefix'; path: string }
  | { kind: 'exact'; path: string }
  | { kind: 'namePrefix'; dir: string; name: string }

const SCHEDULED_TASKS_SQLITE_FILE_NAME = 'scheduled-tasks.sqlite'

/**
 * Host-managed paths that the agent's own fs tools and git-diff tools must
 * never reach, regardless of the assistant workspaceRoot or policy. Read from
 * current settings each call so baseDir/projectsDir changes take effect
 * immediately.
 */
export const getProtectedVaultPathRules = (
  settings?: YoloSettingsLike | null,
): ProtectedPathRule[] => {
  const baseDir = getYoloBaseDir(settings)
  const rules: ProtectedPathRule[] = [
    // Plugin-private data under `yolo.baseDir`.
    { kind: 'prefix', path: getYoloJsonDbRootDir(settings) },
    { kind: 'exact', path: getYoloDataJsonPath(settings) },
    { kind: 'exact', path: `${baseDir}/${SESSION_JOURNAL_SQLITE_FILE_NAME}` },
    {
      kind: 'exact',
      path: `${baseDir}/${CONVERSATION_JOURNAL_SQLITE_FILE_NAME}`,
    },
    {
      kind: 'exact',
      path: `${baseDir}/${SCHEDULED_TASKS_SQLITE_FILE_NAME}`,
    },
    { kind: 'prefix', path: `${baseDir}/${YOLO_MEMORY_SUBDIR}` },
    { kind: 'exact', path: `${baseDir}/${YOLO_VECTOR_DB_FILE_NAME}` },
    // Fixed-name pointer file at the vault root.
    { kind: 'exact', path: YOLO_SYNC_POINTER_FILE_NAME },
    // The whole host-managed project zone.
    { kind: 'prefix', path: getYoloProjectsDir(settings) },
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
    if (normalized === rule.path || normalized.startsWith(`${rule.path}/`)) {
      return true
    }
  }
  return false
}
