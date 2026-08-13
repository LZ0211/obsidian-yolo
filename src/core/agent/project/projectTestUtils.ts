import { normalizePath } from 'obsidian'

import type { YoloSettingsLike } from '../../../types/yoloSettingsLike'

import type { ProjectVaultAdapter, ProjectStoreOptions } from './store'
import { ProjectStore } from './store'

export class FakeAdapter implements ProjectVaultAdapter {
  private readonly files = new Map<string, string>()
  private readonly dirs = new Set<string>()

  async exists(path: string): Promise<boolean> {
    const normalized = normalizePath(path)
    return this.files.has(normalized) || this.dirs.has(normalized)
  }

  async read(path: string): Promise<string> {
    const normalized = normalizePath(path)
    const value = this.files.get(normalized)
    if (value === undefined) throw new Error(`file not found: ${normalized}`)
    return value
  }

  async write(path: string, data: string): Promise<void> {
    const normalized = normalizePath(path)
    this.files.set(normalized, data)
    const slash = normalized.lastIndexOf('/')
    if (slash > 0) await this.mkdir(normalized.slice(0, slash))
  }

  async mkdir(path: string): Promise<void> {
    const normalized = normalizePath(path)
    let current = ''
    for (const segment of normalized.split('/')) {
      current = current ? `${current}/${segment}` : segment
      this.dirs.add(current)
    }
  }

  async list(
    path: string,
  ): Promise<{ files: string[]; folders: string[] }> {
    const prefix = `${normalizePath(path)}/`
    return {
      files: [...this.files.keys()]
        .filter(
          (file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'),
        )
        .sort(),
      folders: [...this.dirs].filter(
        (dir) => dir.startsWith(prefix) && !dir.slice(prefix.length).includes('/'),
      ),
    }
  }
}

const defaultSettings = {} as unknown as YoloSettingsLike

export const createStore = (
  adapter = new FakeAdapter(),
  overrides: Partial<ProjectStoreOptions> = {},
): ProjectStore =>
  new ProjectStore({ getSettings: () => defaultSettings, adapter, ...overrides })

export const initSimpleProject = async (
  store: ProjectStore,
  projectId = 'proj-1',
) => {
  const result = await store.initProject({
    projectId,
    projectName: 'Proj One',
    tasks: [{ taskId: 'T-001', title: 'First' }],
  })
  if (!result.ok) throw new Error('test setup failed')
  return result
}
