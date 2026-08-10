import { isReadablePath } from '../../core/agent/workspaceScope'
import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { Mentionable } from '../../types/mentionable'

/**
 * Whether a mention candidate is visible under the active workspace policy:
 * files must be readable; folders are visible when readable themselves or
 * when they are an ancestor of the home / a read-extra include (so the user
 * can navigate into the scoped area from above).
 */
export function isMentionableInWorkspaceScope(
  mentionable: Mentionable,
  policy: WorkspaceAccessPolicy | undefined,
): boolean {
  if (!policy?.enabled) return true
  if (mentionable.type === 'file') {
    return isReadablePath(mentionable.file.path, policy)
  }
  if (mentionable.type === 'folder') {
    if (isReadablePath(mentionable.folder.path, policy)) {
      return true
    }
    return [
      policy.workspaceRoot,
      ...policy.readExtraIncludes,
    ].some((includePath) => {
      const include = includePath.replace(/^\/+|\/+$/g, '')
      const folder = mentionable.folder.path.replace(/^\/+|\/+$/g, '')
      return include !== '' && include.startsWith(folder + '/')
    })
  }
  return true
}
