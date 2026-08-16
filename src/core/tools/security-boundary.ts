import type { YoloSettings } from '../../settings/schema/setting.types'
import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import {
  buildAllowedSkillPathSet,
  findWorkspacePolicyViolation,
  findPathWithinExcludedRoot,
} from '../agent/workspaceScope'
import { isWithinYoloUserDataRoot } from '../paths/yoloPaths'

/**
 * The two safety-critical checks that live outside every built-in tool's own
 * logic (master.md §3.4). `dispatcher.ts` is the only caller.
 *
 * Throws with the exact same messages the pre-registry inline checks threw.
 * Callers must run this inside the same try/catch that normalizes thrown
 * errors into a tool error result — it does not catch anything itself.
 *
 * DO NOT inline this into a single tool's `execute` — it must stay reachable
 * from every call path, manual-approval and direct-call included ("this is
 * a security boundary" — see the comments below, copied verbatim from the
 * original call site).
 */
export function enforceBuiltinToolSecurityBoundary(
  toolName: string,
  args: Record<string, unknown>,
  {
    settings,
    workspaceAccessPolicy,
    allowedSkillPaths,
  }: {
    settings?: YoloSettings
    workspaceAccessPolicy?: WorkspaceAccessPolicy
    allowedSkillPaths?: readonly string[]
  },
): void {
  // Final defense: reject any fs_* call whose path args fall outside the
  // agent's workspace scope. The gateway performs the same check up front
  // for UI Rejected status, but we re-validate here so manual-approval /
  // direct-call code paths cannot bypass the constraint.
  if (workspaceAccessPolicy && toolName !== 'fs_read') {
    const exemptPaths = allowedSkillPaths
      ? buildAllowedSkillPathSet(allowedSkillPaths)
      : undefined
    const offendingPath = findWorkspacePolicyViolation({
      toolName,
      args,
      policy: workspaceAccessPolicy,
      exemptPaths,
    })
    if (offendingPath !== null) {
      throw new Error(
        `Path "${offendingPath}" is outside this agent's workspace access policy.`,
      )
    }
  }

  // The YOLO user-data root (`<baseDir>/data`: chat history, module
  // settings/intent — see `ensureUserDataRootDir` in
  // `core/paths/yoloManagedData.ts`) must stay invisible to agent tools,
  // unconditionally and regardless of workspace scope. Before that data
  // moved out of the hidden `.yolo_json_db` directory, it could never be
  // reached this way at all — dot directories are never indexed into the
  // `TFile` tree fs_* tools resolve paths against. This reproduces that
  // same invisibility now that the root is a normal, visible folder.
  // Reported as a plain not-found, matching a genuine miss, so nothing
  // about "this path is specially hidden" leaks to the model.
  // fs_read resolves literal paths and wikilinks before checking the same
  // boundary per resolved file. Its raw paths must reach that layer.
  if (toolName !== 'fs_read') {
    const offendingUserDataPath = findPathWithinExcludedRoot(
      toolName,
      args,
      (path) => isWithinYoloUserDataRoot(path, settings),
    )
    if (offendingUserDataPath !== null) {
      throw new Error(`File not found: ${offendingUserDataPath}`)
    }
  }
}
