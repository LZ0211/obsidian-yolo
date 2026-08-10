import type { TAbstractFile } from 'obsidian'

import type { WorkspaceAccessPolicy } from '../../types/assistant.types'
import type { AgentFileChange } from '../../types/chat'

import type {
  AgentGitDiffEnricher,
  AgentGitDiffRun,
} from './git-diff/agentGitDiffEnricher'
import { normalizeWorkspacePath } from './workspaceScope'

type RunState = {
  changes: Map<string, AgentFileChange>
  gitDiffRun?: AgentGitDiffRun
  workspaceAccessPolicy?: WorkspaceAccessPolicy
  alwaysExcludedPaths: string[]
}

type BeginRunOptions = {
  workspaceAccessPolicy?: WorkspaceAccessPolicy | null
}

type AgentFileChangeTrackerOptions = {
  gitDiffEnricher?: Pick<
    AgentGitDiffEnricher,
    'beginRun' | 'finishRun' | 'markChanged'
  >
  getAlwaysExcludedPaths?: () => readonly string[]
}

function matchesPath(path: string, rule: string): boolean {
  return path === rule || path.startsWith(`${rule}/`)
}

function isTrackedPath(
  path: string,
  policy: WorkspaceAccessPolicy | undefined,
  alwaysExcludedPaths: readonly string[],
): boolean {
  if (alwaysExcludedPaths.some((rule) => matchesPath(path, rule))) {
    return false
  }
  if (!policy?.enabled) return true

  const root = normalizeWorkspacePath(policy.workspaceRoot)
  if (root !== '' && !matchesPath(path, root)) return false

  return !(policy.writeExcludes ?? []).some((rule) => {
    const normalizedRule = normalizeWorkspacePath(rule)
    return normalizedRule === '' || matchesPath(path, normalizedRule)
  })
}

function normalizeExcludedPaths(
  paths: readonly string[] | undefined,
): string[] {
  const normalizedPaths: string[] = []
  for (const rawPath of paths ?? []) {
    try {
      const path = normalizeWorkspacePath(rawPath)
      if (path && !normalizedPaths.includes(path)) normalizedPaths.push(path)
    } catch {
      continue
    }
  }
  return normalizedPaths
}

function normalizeChangePath(path: string): string | null {
  try {
    const normalized = normalizeWorkspacePath(path)
    return normalized === '' ? null : normalized
  } catch {
    return null
  }
}

function recordSingleChange(
  changes: Map<string, AgentFileChange>,
  change: Exclude<AgentFileChange, { kind: 'renamed' }>,
): void {
  const existing = changes.get(change.path)

  if (change.kind === 'modified') {
    if (!existing) changes.set(change.path, change)
    return
  }

  if (change.kind === 'created') {
    changes.set(
      change.path,
      existing?.kind === 'deleted'
        ? { kind: 'modified', path: change.path }
        : change,
    )
    return
  }

  if (existing?.kind === 'created') {
    changes.delete(change.path)
    return
  }
  if (existing?.kind === 'renamed' && existing.oldPath) {
    changes.set(existing.oldPath, {
      kind: 'deleted',
      path: existing.oldPath,
    })
    changes.delete(change.path)
    return
  }
  changes.set(change.path, change)
}

function recordRename(
  changes: Map<string, AgentFileChange>,
  oldPath: string,
  path: string,
): void {
  if (oldPath === path) return

  const existing = changes.get(oldPath)
  changes.delete(oldPath)

  if (existing?.kind === 'created') {
    changes.set(path, { kind: 'created', path })
    return
  }

  changes.set(path, {
    kind: 'renamed',
    oldPath: existing?.kind === 'renamed' ? existing.oldPath : oldPath,
    path,
  })
}

export class AgentFileChangeTracker {
  private readonly activeRuns = new Map<symbol, RunState>()

  constructor(private readonly options: AgentFileChangeTrackerOptions = {}) {}

  beginRun(options: BeginRunOptions = {}): symbol {
    const token = Symbol('agent-file-change-run')
    this.activeRuns.set(token, {
      changes: new Map(),
      gitDiffRun: this.options.gitDiffEnricher?.beginRun(
        options.workspaceAccessPolicy,
      ),
      workspaceAccessPolicy: options.workspaceAccessPolicy ?? undefined,
      alwaysExcludedPaths: normalizeExcludedPaths(
        this.options.getAlwaysExcludedPaths?.(),
      ),
    })
    return token
  }

  async finishRun(token: symbol): Promise<AgentFileChange[]> {
    const state = this.activeRuns.get(token)
    if (!state) return []

    this.activeRuns.delete(token)
    const changes = Array.from(state.changes.values()).sort((left, right) =>
      left.path.localeCompare(right.path),
    )
    if (!state.gitDiffRun || !this.options.gitDiffEnricher) return changes
    return this.options.gitDiffEnricher.finishRun(state.gitDiffRun, changes)
  }

  record(change: AgentFileChange): void {
    if (this.activeRuns.size === 0) return

    const path = normalizeChangePath(change.path)
    if (!path) return
    const oldPath =
      change.kind === 'renamed' && change.oldPath
        ? normalizeChangePath(change.oldPath)
        : null

    for (const state of this.activeRuns.values()) {
      if (change.kind !== 'renamed' || !oldPath) {
        if (
          !isTrackedPath(
            path,
            state.workspaceAccessPolicy,
            state.alwaysExcludedPaths,
          )
        )
          continue
        this.markChanged(state)
        recordSingleChange(state.changes, { kind: change.kind, path })
        continue
      }

      const tracksOldPath = isTrackedPath(
        oldPath,
        state.workspaceAccessPolicy,
        state.alwaysExcludedPaths,
      )
      const tracksNewPath = isTrackedPath(
        path,
        state.workspaceAccessPolicy,
        state.alwaysExcludedPaths,
      )
      if (tracksOldPath && tracksNewPath) {
        if (oldPath === path) continue
        this.markChanged(state)
        recordRename(state.changes, oldPath, path)
      } else if (tracksOldPath) {
        this.markChanged(state)
        recordSingleChange(state.changes, { kind: 'deleted', path: oldPath })
      } else if (tracksNewPath) {
        this.markChanged(state)
        recordSingleChange(state.changes, { kind: 'created', path })
      }
    }
  }

  private markChanged(state: RunState): void {
    if (!state.gitDiffRun) return
    this.options.gitDiffEnricher?.markChanged(state.gitDiffRun)
  }

  buildVaultHandlers(): {
    create: (file: TAbstractFile) => void
    modify: (file: TAbstractFile) => void
    delete: (file: TAbstractFile) => void
    rename: (file: TAbstractFile, oldPath: string) => void
  } {
    return {
      create: (file) => this.record({ kind: 'created', path: file.path }),
      modify: (file) => this.record({ kind: 'modified', path: file.path }),
      delete: (file) => this.record({ kind: 'deleted', path: file.path }),
      rename: (file, oldPath) =>
        this.record({ kind: 'renamed', oldPath, path: file.path }),
    }
  }
}
