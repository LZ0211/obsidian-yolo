import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import type { AssistantWorkspaceScope } from '../../../types/assistant.types'
import { runVaultSearchStructured } from '../../mcp/vaultSearchService'
import type { RAGEngine } from '../../rag/ragEngine'
import type {
  BashSearchCallback,
  BashSearchResultEntry,
} from '../../runtime-components/contracts'
import { publishQueryProgress } from '../../rag/queryProgressBus'
import { superSearchDedupKey } from '../../search/hybridSearch'
import type { CitationRegistry } from '../citationRegistry'
import { isPathAllowedByScope } from '../workspaceScope'

/**
 * Host implementation behind the bash tool's custom `search` command:
 * hybrid (RAG + keyword RRF) retrieval via `runVaultSearchStructured`, which
 * itself degrades to keyword ranking when RAG is unavailable — so the
 * command is always registered regardless of embedding configuration.
 *
 * Workspace scope is enforced here, not in the component: the fs callbacks
 * gate every path the shell touches (see `vaultBashFileSystem.ts`), but the
 * search index is queried vault-wide, so both the scope argument and each
 * result path must be checked against the same rules.
 */
export function createVaultBashSearch({
  app,
  settings,
  getRagEngine,
  workspaceScope,
  signal,
  registry,
}: {
  app: App
  settings?: YoloSettings
  getRagEngine?: () => Promise<RAGEngine>
  workspaceScope?: AssistantWorkspaceScope
  signal?: AbortSignal
  /**
   * Run-scoped citation registry (from the agent run's runContext). When
   * provided, each content hit is registered so the run can attach the
   * sources to the assistant message metadata (citation cards).
   */
  registry?: CitationRegistry
}): BashSearchCallback {
  return async ({ query, scopePath, maxResults }) => {
    if (
      scopePath !== undefined &&
      workspaceScope?.enabled &&
      !isPathAllowedByScope(scopePath, workspaceScope)
    ) {
      return {
        status: 'error',
        message: `path is outside the allowed workspace scope: '${scopePath}'`,
      }
    }

    publishQueryProgress({ type: 'querying' })
    let outcome: Awaited<ReturnType<typeof runVaultSearchStructured>>
    try {
      outcome = await runVaultSearchStructured({
        app,
        settings,
        getRagEngine,
        args: {
          query,
          path: scopePath,
          maxResults,
          mode: 'hybrid',
        },
        signal,
        // Forward retrieval states (querying/querying-done/querying-error)
        // onto the shared bus so chat surfaces show the progress banner.
        onQueryProgressChange: publishQueryProgress,
      })
    } finally {
      // The banner must never stay stuck on the last retrieval state.
      publishQueryProgress({ type: 'idle' })
    }
    if (outcome.status === 'aborted') {
      return { status: 'error', message: 'aborted' }
    }
    if (outcome.status === 'error') {
      return { status: 'error', message: outcome.error }
    }

    const entries: BashSearchResultEntry[] = []
    for (const result of outcome.results) {
      if (entries.length >= maxResults) break
      if (
        workspaceScope?.enabled &&
        !isPathAllowedByScope(result.path, workspaceScope)
      ) {
        continue
      }
      if (result.kind === 'content_group') {
        for (const snippet of result.snippets) {
          if (entries.length >= maxResults) break
          entries.push({
            kind: 'content',
            path: result.path,
            startLine: snippet.startLine ?? snippet.line,
            endLine: snippet.endLine,
            page: snippet.page,
            snippet: snippet.snippet,
          })
          if (registry) {
            const startLine = snippet.startLine ?? snippet.line ?? 0
            const endLine = snippet.endLine ?? snippet.line ?? startLine
            registry.assign(
              superSearchDedupKey({
                kind: 'content',
                path: result.path,
                line: snippet.line,
                startLine: snippet.startLine,
                endLine: snippet.endLine,
                page: snippet.page,
                snippet: snippet.snippet,
                source: snippet.source,
              }),
              {
                path: result.path,
                startLine,
                endLine,
                page: snippet.page,
                snippet: snippet.snippet ?? '',
                similarity: snippet.similarity,
                source: snippet.source,
              },
            )
          }
        }
      } else {
        entries.push({ kind: result.kind, path: result.path })
      }
    }

    return {
      status: 'success',
      results: entries,
      notice: outcome.fallbackReason,
    }
  }
}
