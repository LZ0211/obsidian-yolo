import type { WorkspaceAccessPolicy } from '../../../types/assistant.types'
import type { AgentFileChange } from '../../../types/chat'

import type {
  AgentGitDiffBackend,
  ShadowGitBaseline,
} from './shadowGitDiffBackend'

export type AgentGitDiffRun = {
  baseline: Promise<ShadowGitBaseline | null>
  baselineSettled: boolean
  invalidated: boolean
}

export class AgentGitDiffEnricher {
  constructor(private readonly backend: AgentGitDiffBackend) {}

  beginRun(policy?: WorkspaceAccessPolicy | null): AgentGitDiffRun {
    let baseline: Promise<ShadowGitBaseline | null>
    try {
      baseline = this.backend.begin(policy ?? undefined)
    } catch {
      baseline = Promise.resolve(null)
    }

    const run: AgentGitDiffRun = {
      baseline: Promise.resolve(null),
      baselineSettled: false,
      invalidated: false,
    }
    run.baseline = baseline
      .catch(() => null)
      .finally(() => {
        run.baselineSettled = true
      })
    return run
  }

  markChanged(run: AgentGitDiffRun): void {
    if (!run.baselineSettled) run.invalidated = true
  }

  async finishRun(
    run: AgentGitDiffRun,
    changes: AgentFileChange[],
  ): Promise<AgentFileChange[]> {
    if (run.invalidated || changes.length === 0) {
      this.releaseBaseline(run)
      return changes
    }

    const baseline = await run.baseline
    if (!baseline) return changes

    try {
      const gitDiffs = await this.backend.finish(baseline, changes)
      if (gitDiffs.size === 0) return changes

      return changes.map((change) => {
        const gitDiff = gitDiffs.get(change.path)
        return gitDiff ? { ...change, gitDiff } : change
      })
    } catch {
      return changes
    }
  }

  private releaseBaseline(run: AgentGitDiffRun): void {
    void run.baseline
      .then((baseline) =>
        baseline ? this.backend.discard?.(baseline) : undefined,
      )
      .catch(() => undefined)
  }
}
