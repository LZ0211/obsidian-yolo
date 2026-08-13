import type { ProjectStore } from './store'
import type { ProjectRecord } from './types'

/**
 * Compact, live `<active_project>` identity block for request context. No
 * project-level status/revision: the on-disk record no longer carries them
 * (they were frozen at init and never truthful); live project state is
 * derived per-read via `ProjectStore.status()`.
 */
export const buildActiveProjectContextBlock = (
  project: ProjectRecord,
): string =>
  [
    '<active_project>',
    `  <project_id>${escapeXmlText(project.projectId)}</project_id>`,
    `  <name>${escapeXmlText(project.projectName)}</name>`,
    '</active_project>',
  ].join('\n')

export type ActiveProjectContext =
  | { ok: true; block: string; project: ProjectRecord }
  | { ok: false; error: string }

/**
 * Resolves a project fresh from the store and formats its compact context
 * block. Never inlines task bodies, acceptance criteria, or deliverables; the
 * agent loads those on demand through the project tool.
 */
export const resolveActiveProjectContext = async (
  store: ProjectStore,
  projectId: string,
): Promise<ActiveProjectContext> => {
  const project = await store.readProject(projectId)
  if (!project) {
    return {
      ok: false,
      error: `Active project "${projectId}" could not be resolved. It may have been moved or deleted.`,
    }
  }
  return { ok: true, block: buildActiveProjectContextBlock(project), project }
}

const escapeXmlText = (value: string): string =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
