import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { isReadablePath } from '../../agent/workspaceScope'
import { MetadataFilterDslError } from '../../search/metadataFilterDsl'
import {
  type MetadataFileSearchHit,
  type MetadataSearchHit,
  searchFilesByMetadataDsl,
} from '../../search/metadataSearch'
import { defineTool } from '../define'
import { getOptionalIntegerArg, getTextArg } from '../tool-args'

const META_SEARCH_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Query note metadata (frontmatter + built-in fields like tags/links/headings) with a SQL-like DSL: SELECT|TABLE ... FROM ... [WHERE ...] [ORDER BY ...] [LIMIT N]. ' +
    'TABLE returns a Markdown table instead of JSON; same grammar otherwise. ' +
    'Run `select keys(*) from *|"path"` first to discover which fields exist before filtering.',
  inputSchema: {
    type: 'object',
    properties: {
      meta: {
        type: 'string',
        description:
          'Grammar: `select|table <fields>|**|keys(*)|distinct <field> from *|**|"path" [where <cond>] [order by <field> [asc|desc]] [limit N]`. Standard SQL comparison operators, plus `contains`/`includes`/`ilike` for substring match. ' +
          'Built-in fields start with `$` and have bare aliases: `$source_path`/`path`, `$folder_path`/`folder`, `$file_name`/`filename`, `$title`/`name`, `$document_type`/`type`, `$tag`/`tags`, `$alias`/`aliases`, `$link`/`links`, `$outlink`/`outlinks`, `$inlink`/`backlinks`, `$embed`/`embeds`, `$heading`/`headings`, `$heading_level`, `$section_type`, `$list_item_count`, `$task_count`. Anything else is read straight from frontmatter. ' +
          'Use `table` instead of `select` for a compact Markdown table instead of JSON.\n' +
          'Examples:\n' +
          '  `select keys(*) from "Projects"`\n' +
          '  `select title, priority from Projects where priority >= 3 order by priority desc limit 5`\n' +
          '  `table title, priority from Projects where priority >= 3 order by priority desc limit 5`',
      },
      maxResults: {
        type: 'integer',
        description: 'Maximum files to return. Defaults to 20, range 1-300.',
      },
    },
    required: ['meta'],
  },
}

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length

const sliceToByteBudget = (
  full: string,
  maxBytes: number,
): {
  text: string
  truncated?: { totalBytes: number; omittedBytes: number }
} => {
  const totalBytes = utf8ByteLength(full)
  if (totalBytes <= maxBytes) return { text: full }

  const suffix = '\n\n... (truncated)'
  const available = maxBytes - utf8ByteLength(suffix)
  if (available <= 0) {
    return {
      text: suffix.trim(),
      truncated: { totalBytes, omittedBytes: totalBytes },
    }
  }

  let sliceEnd = Math.min(available, full.length)
  while (sliceEnd > 0 && utf8ByteLength(full.slice(0, sliceEnd)) > available) {
    sliceEnd -= 1
  }
  const prefix = full.slice(0, sliceEnd)
  return {
    text: prefix + suffix,
    truncated: {
      totalBytes,
      omittedBytes: totalBytes - utf8ByteLength(prefix),
    },
  }
}

const buildZeroResultHints = (meta: string): string[] => {
  const hints: string[] = []
  const lower = meta.toLowerCase()
  if (!lower.includes('keys(*)') && !lower.includes('distinct')) {
    hints.push(
      'No files matched. Try `select keys(*) from *` to see available field names in this scope.',
    )
  }
  if (/\btag\b/.test(lower)) {
    hints.push(
      'The built-in `$tag` field only matches Obsidian #tags in file content/frontmatter, not folder names.',
    )
  }
  if (/document_type\s*(=|like|contains)\s*['"]email['"]/i.test(lower)) {
    hints.push(
      '`$document_type` is derived from file extension. `.md` files have `$document_type = "markdown"`, not `"email"`.',
    )
  }
  if (/\bfolder\b/.test(lower) && !lower.includes('folder_path')) {
    hints.push(
      'The built-in folder field is `$folder_path`, not `folder`. Use `select keys(*) from *` to confirm correct key names.',
    )
  }
  if (/\bsource_path\b.*\blike\b/i.test(lower) && !lower.includes('%')) {
    hints.push(
      '`$source_path` is the full vault path. Try `$folder_path = "path/to/folder"` instead of `$source_path like "substring"` for filtering by directory.',
    )
  }
  if (
    /(?:^|\s|=)\w+\s*=\s*['"]/.test(lower) &&
    !lower.includes('contains') &&
    !lower.includes(' like ')
  ) {
    hints.push(
      'Query uses = but returned no matches. If the field is marked list[...] in `select keys(*) from *|"path"`, use contains for membership checks instead of =.',
    )
  }
  if (!/\bwhere\b|contains\b|=|\blike\b|>=|<=/.test(lower)) {
    hints.push('No filter detected. Did you mean to add `where key op value`?')
  }
  return hints
}

const escapeTableCell = (value: string): string =>
  value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const buildMetadataResultTable = (results: MetadataSearchHit[]): string => {
  if (results[0]?.kind === 'distinct') {
    const hit = results[0]
    const header = hit.key === 'available_keys' ? 'field' : hit.key
    const rows = hit.values.map(
      (value) => `| ${escapeTableCell(String(value))} |`,
    )
    return [`| ${header} |`, '| --- |', ...rows].join('\n')
  }

  const fileHits = results as MetadataFileSearchHit[]
  const columns = [
    ...new Set(fileHits.flatMap((hit) => Object.keys(hit.metadata))),
  ]
  const headerCells = ['path', ...columns]
  const dataRows = fileHits.map((hit) => {
    const cells = [
      escapeTableCell(hit.path),
      ...columns.map((column) => {
        const values = hit.metadata[column]
        return values ? escapeTableCell(values.map(String).join(', ')) : ''
      }),
    ]
    return `| ${cells.join(' | ')} |`
  })
  return [
    `| ${headerCells.join(' | ')} |`,
    `| ${headerCells.map(() => '---').join(' | ')} |`,
    ...dataRows,
  ].join('\n')
}

const METADATA_DSL_HINTS: Record<string, string> = {
  malformed_query:
    'Query syntax is invalid. Use `select keys(*) from *` to discover queryable fields, then write `select ... from ...`.',
  unsupported_operator:
    'Operator not supported. Use: =, ==, !=, <>, like, contains, >=, >, <=, <.',
  unsupported_syntax:
    'Use `select keys(*) from *` to discover queryable fields, then write `select ... from ...`.',
}

const formatMetadataDslError = (error: unknown): Error => {
  if (!(error instanceof MetadataFilterDslError)) {
    return error instanceof Error ? error : new Error(String(error))
  }
  const hint = METADATA_DSL_HINTS[error.code]
  return new Error(
    hint
      ? `${error.message}. ${hint}`
      : `${error.message}. Use: key op value [and key op value ...].`,
  )
}

export const metaSearchDefinition = defineTool({
  name: 'meta_search',
  getMcpTool: () => META_SEARCH_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinMetaSearchLabel',
    fallback: 'Search Metadata',
  },
  contextPrunable: true,
  execute: async (args, { app, signal, workspaceAccessPolicy }) => {
    if (signal?.aborted) return { status: ToolCallResponseStatus.Aborted }

    const meta = getTextArg(args, 'meta').trim()
    const maxResults = getOptionalIntegerArg({
      args,
      key: 'maxResults',
      defaultValue: 20,
      min: 1,
      max: 300,
    })
    let results: MetadataSearchHit[]
    try {
      results = searchFilesByMetadataDsl(app, meta, {
        maxResults,
        isReadablePath: (path) => {
          try {
            return isReadablePath(path, workspaceAccessPolicy)
          } catch {
            return false
          }
        },
      })
    } catch (error) {
      throw formatMetadataDslError(error)
    }
    if (signal?.aborted) return { status: ToolCallResponseStatus.Aborted }

    const maxResultBytes = 12_000
    const zeroHints = buildZeroResultHints(meta)
    const wantsTable = /^\s*table\b/i.test(meta)
    const formatted = wantsTable
      ? sliceToByteBudget(
          results.length === 0
            ? zeroHints.length > 0
              ? zeroHints.join('\n')
              : 'No rows matched.'
            : buildMetadataResultTable(results),
          maxResultBytes,
        )
      : sliceToByteBudget(
          JSON.stringify({
            tool: 'meta_search',
            ...(results[0]?.kind && { resultKind: results[0].kind }),
            results: results.map((hit) =>
              hit.kind === 'file'
                ? {
                    path: hit.path,
                    matchedKeys: hit.matchedKeys,
                    metadata: hit.metadata,
                  }
                : { key: hit.key, values: hit.values },
            ),
            ...(results.length === 0 &&
              zeroHints.length > 0 && { hint: zeroHints }),
          }),
          maxResultBytes,
        )

    return {
      status: ToolCallResponseStatus.Success,
      text: formatted.text,
      ...(formatted.truncated && {
        metadata: { truncated: formatted.truncated },
      }),
    }
  },
})
