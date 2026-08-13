import type { ProjectStore } from './store'

export type ProjectPickerItem = {
  projectId: string
  name: string
  status: string
  activeTaskCount: number
  updatedAt: string
}

export type ProjectPickerProvider = {
  search(query: string, signal: AbortSignal): Promise<ProjectPickerItem[]>
  resolve(projectId: string): Promise<ProjectPickerItem | null>
}

const rankForQuery = (item: ProjectPickerItem, query: string): number => {
  if (!query) return 0
  const id = item.projectId.toLowerCase()
  const name = item.name.toLowerCase()
  if (id === query || name === query) return 0
  if (id.startsWith(query) || name.startsWith(query)) return 1
  return 2
}

/**
 * Bounded project picker over the project store. Returns compact summaries
 * only; never loads task bodies. Ordering is deterministic: exact id/name,
 * prefix, then fuzzy match, then most recently updated.
 */
export class ProjectPickerService implements ProjectPickerProvider {
  constructor(private readonly store: ProjectStore) {}

  async search(
    query: string,
    signal: AbortSignal,
  ): Promise<ProjectPickerItem[]> {
    const q = query.trim().toLowerCase()
    const projects = await this.store.listProjects()
    const items: ProjectPickerItem[] = []
    for (const project of projects) {
      if (signal.aborted) break
      if (
        q &&
        !project.projectId.toLowerCase().includes(q) &&
        !project.projectName.toLowerCase().includes(q)
      ) {
        continue
      }
      const status = await this.store.status(project.projectId)
      items.push({
        projectId: project.projectId,
        name: project.projectName,
        status: project.status,
        activeTaskCount: status?.active.length ?? 0,
        updatedAt: project.updatedAt,
      })
    }
    return [...items].sort((left, right) => {
      const leftRank = rankForQuery(left, q)
      const rightRank = rankForQuery(right, q)
      if (leftRank !== rightRank) return leftRank - rightRank
      // Deterministic tiebreak: same recency sorts by project id, so projects
      // created within the same millisecond do not flip order run to run.
      return (
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.projectId.localeCompare(right.projectId)
      )
    })
  }

  async resolve(projectId: string): Promise<ProjectPickerItem | null> {
    const project = await this.store.readProject(projectId)
    if (!project) return null
    const status = await this.store.status(projectId)
    return {
      projectId: project.projectId,
      name: project.projectName,
      status: project.status,
      activeTaskCount: status?.active.length ?? 0,
      updatedAt: project.updatedAt,
    }
  }
}
