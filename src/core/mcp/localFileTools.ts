import {
  App,
  FileSystemAdapter,
  Platform,
  TFile,
  TFolder,
  normalizePath,
} from 'obsidian'
import { v4 as uuidv4 } from 'uuid'

import { buildPdfPageImageCacheKey } from '../../database/json/chat/imageCacheStore'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  ApplyViewResult,
  ApplyViewState,
} from '../../types/apply-view.types'
import type {
  AssistantToolApprovalMode,
  AssistantWorkspaceScope,
  WorkspaceAccessPolicy,
} from '../../types/assistant.types'
import type { ChatMessage } from '../../types/chat'
import type { ChatModelModality } from '../../types/chat-model.types'
import type { ContentPart } from '../../types/llm/request'
import { McpTool } from '../../types/mcp.types'
import {
  ToolCallResponseStatus,
  type ToolFsReadOperationSummary,
} from '../../types/tool-call.types'
import { uint8ArrayToBase64 } from '../../utils/base64'
import { collectWikilinkPaths } from '../../utils/llm/annotate-wikilinks'
import { extractMarkdownImages } from '../../utils/llm/extract-markdown-images'
import { tFileToImageDataUrl } from '../../utils/llm/image'
import {
  chatModelSupportsPdf,
  chatModelSupportsVision,
} from '../../utils/llm/model-modalities'
import {
  type WikilinkReadSubpath,
  resolveWikilinkReadTarget,
} from '../../utils/llm/resolve-wikilink-target'
import { parseOfficeDocument } from '../../utils/office'
import {
  PDF_INDEX_MAX_BYTES,
  PDF_INDEX_MAX_PAGES,
  extractPdfText,
} from '../../utils/pdf/extractPdfText'
import { convertPdfViaMinerU } from '../../utils/pdf/mineruCacheStore'
import {
  type MinerURawConversionResult,
  convertPdfToMarkdown,
  isMinerUEnabled,
  resolveMinerUImageRefs,
  toArrayBuffer,
} from '../../utils/pdf/mineruClient'
import { renderPdfPagesToImages } from '../../utils/pdf/renderPdfPagesToImages'
import { PdfSliceError, slicePdfPages } from '../../utils/pdf/slicePdfPages'
import {
  type DangerousBashOperationKind,
  cancelDangerousBashApproval,
  requestDangerousBashApproval,
} from '../agent/bash/dangerousOperationGate'
import {
  VAULT_BASH_STDERR_BUDGET,
  VAULT_BASH_STDOUT_BUDGET,
  truncateBashOutputForContext,
} from '../agent/bash/outputBudget'
import { createVaultBashFileSystem } from '../agent/bash/vaultBashFileSystem'
import { createVaultBashSearch } from '../agent/bash/vaultBashSearch'
import {
  buildConsolidatedToolSchemas,
  resolveConsolidatedAction,
  validateConsolidatedAction,
} from '../agent/consolidated-tools'
import { assertProjectTaskDispatchable } from '../agent/project/delivery'
import { buildReviewPrompt } from '../agent/project/review-prompt'
import { ProjectStore } from '../agent/project/store'
import { ProjectTool } from '../agent/project/tool'
import type { ProjectTaskBinding, TaskRecord } from '../agent/project/types'
import type { PromptSourceWatcher } from '../agent/promptSourceWatcher'
import type { TodoItem } from '../agent/todos-from-messages'
import type { AgentRunContext } from '../agent/types'
import {
  buildAllowedSkillPathSet,
  collectToolCallPaths,
  findPathOutsideScope,
  findPathWithinExcludedRoot,
  findWorkspacePolicyViolation,
  isCoveredBySkillPathExemption,
  isWorkspaceWriteToolName,
  isReadablePath,
  normalizeSkillPathForExemption,
} from '../agent/workspaceScope'
import { validateAttachmentPath } from '../bot/attachment-security'
import { findWebviewHandleByPageId } from '../browser/activeWebviewProbe'
import {
  BrowserReadFailure,
  readActiveWebviewPage,
} from '../browser/activeWebviewReader'
import {
  buildReplaceMatchErrorHint,
  materializeTextEditPlan,
  recoverLikelyEscapedBackslashSequences,
} from '../edits/textEditEngine'
import {
  type MemoryScope,
  memoryAdd,
  memoryDelete,
  memoryUpdate,
} from '../memory/memoryManager'
import { isWithinYoloUserDataRoot } from '../paths/yoloPaths'
import type { RAGEngine } from '../rag/ragEngine'
import { publishQueryProgress } from '../rag/queryProgressBus'
import {
  acquireRuntimeComponent,
  isRuntimeComponentEnabled,
} from '../runtime-components/runtimeComponentAccess'
import type {
  ScheduledTask,
  ScheduledTaskAgentConfig,
  TaskConfig,
} from '../scheduler/scheduledTasksStore'
import { MetadataFilterDslError } from '../search/metadataFilterDsl'
import {
  type MetadataFileSearchHit,
  type MetadataSearchHit,
  searchFilesByMetadataDsl,
} from '../search/metadataSearch'
import { getLiteSkillDocumentByPath } from '../skills/liteSkills'
import {
  getContextPrunableToolCallIds,
  getContextPruneMode,
} from '../tools/context_prune_tool_results/helpers'
import {
  buildFileChangeSummary,
  maybeWithInternalWrite,
} from '../tools/file-editing-support'
import {
  MAX_EDIT_FILE_SIZE_BYTES,
  buildFsEditRejectedReason,
  buildFsEditReviewPayload,
  getFsEditPlan,
  getFsEditSelectionRange,
  waitForFsEditReview,
} from '../tools/fs_edit/schema-helpers'
import {
  type FsReadOperation,
  MAX_BATCH_READ_FILES,
  MAX_READ_MAX_LINES,
  OFFICE_READ_MAX_BYTES,
  buildFsReadModalitySchema,
  getFsReadOperation,
  getOfficeDocumentKindFromExtension,
  isBrowserReadPath,
  normalizeFsReadPath,
  parseBrowserReadPageId,
  sliceLinesForFsReadOperation,
} from '../tools/fs_read/schema-helpers'
import { invokeMemoryTool } from '../tools/memory-tool-support'
import { enforceBuiltinToolSecurityBoundary } from '../tools/security-boundary'
import {
  MAX_FILE_SIZE_BYTES,
  asErrorMessage,
  formatJsonResult,
  getOptionalBoundedIntegerArg,
  getOptionalIntegerArg,
  getOptionalTextArg,
  getRecordArrayArg,
  getStringArrayArg,
  getTextArg,
} from '../tools/tool-args'
import type {
  LocalToolCallResult,
  LocalToolCallResultMetadata,
} from '../tools/types'
import {
  WEB_SCRAPE_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  runWebScrape,
  runWebSearch,
} from '../web-search'

import { getJsSandboxSettings } from './jsSandboxSettings'
import {
  callInjectedBridgeTool,
  getInjectedBridgeTools,
  isInjectedBridgeToolName,
} from './injectionBridge'
import {
  buildJsSandboxProxyHandlers,
  callJsSandboxTool,
  getJsSandboxTool,
} from './jsSandboxTool'
import {
  ASK_USER_QUESTION_TOOL_NAME,
  BASH_TOOL_NAME,
  JS_SANDBOX_TOOL_NAME,
  LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
  LOCAL_FILE_TOOL_SERVER,
  LOCAL_FILE_TOOL_SHORT_NAMES,
  LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION,
  TERMINAL_COMMAND_TOOL_NAME,
} from './localFileToolNames'
import { parseToolName } from './tool-name-utils'
import {
  ensureFolderPathExists,
  ensureParentFolderExists,
  validateVaultPath,
} from './vaultFileOps'

/**
 * localFileTools 可消费的调度服务结构子集。就地声明避免
 * localFileTools → scheduled-tasks-service → scheduler → task-executor 的
 * 静态/type 导入边（madge 对 type-only 导入计边；task-executor 依赖 agent
 * runtime，会经 tool-selection 与 localFileTools 回流成环）。完整形态见
 * `IScheduledTasksService`（src/core/scheduled-tasks-service.ts）。
 */
export type ScheduledTaskServiceLike = {
  createTask(config: TaskConfig): Promise<ScheduledTask>
  getTask(id: string): Promise<ScheduledTask>
  updateTask(id: string, config: Partial<TaskConfig>): Promise<void>
  deleteTask(id: string): Promise<void>
  listTasks(filters?: { enabled?: boolean }): Promise<ScheduledTask[]>
  executeTaskNow(taskId: string): Promise<unknown>
}

export { recoverLikelyEscapedBackslashSequences }

type LocalFileToolName = (typeof LOCAL_FILE_TOOL_SHORT_NAMES)[number]
// 'delete' | 'create_dir' | 'move' retired with fs_delete/fs_create_dir/fs_move
// (see the bash tool, which now covers path operations via vaultFileOps.ts).
type FsFileOpAction = 'write'

type FsResultItem = {
  ok: boolean
  action: FsFileOpAction
  target: string
  message: string
}

// Retired path-operation tools kept for the agent editor's toolset grouping
// (fs_file_ops); the bash tool covers path operations via vaultFileOps.
export const LOCAL_FS_PATH_OPERATION_TOOL_NAMES = [
  'fs_delete',
  'fs_create_dir',
  'fs_move',
] as const

export const LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES = [
  'memory_add',
  'memory_update',
  'memory_delete',
] as const

const LOCAL_FS_WRITE_TOOL_NAMES = new Set<string>([
  'fs_edit',
  ...LOCAL_FS_SPLIT_ACTION_TOOL_NAMES,
  'memory_add',
  'memory_update',
  'memory_delete',
])

/**
 * Standalone tool definition for `load_tool_schemas`. Used by the runtime to
 * inject the loader on demand (when `enableToolDisclosure=true` AND the
 * filtered tool set contains any `on_demand` tool). Not surfaced through
 * `getLocalFileTools()` to keep it out of the user-facing tool list.
 */
export function getLoadToolSchemasTool(): McpTool {
  return {
    name: LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME,
    description:
      'Load full schemas for all on-demand tools belonging to the given MCP servers, making them callable in the next turn. Pass MCP server names (the prefix before "__" in any stub tool name) — batch multiple servers when needed.',
    inputSchema: {
      type: 'object',
      properties: {
        servers: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          description:
            'MCP server names whose on-demand tools should be loaded (e.g. "context7", "deepwiki").',
        },
      },
      required: ['servers'],
    },
  }
}

export function getLocalFileTools(options?: {
  vaultBasePath?: string
  chatModelModalities?: ChatModelModality[]
}): McpTool[] {
  const modalitySchema = buildFsReadModalitySchema(options?.chatModelModalities)
  return [
    {
      name: 'context_prune_tool_results',
      description:
        'Exclude historical tool call results from future model-visible context without deleting chat history. Supports pruning selected calls or all prunable calls at once.',
      inputSchema: {
        type: 'object',
        properties: {
          mode: {
            type: 'string',
            enum: ['selected', 'all'],
            description:
              'Prune mode. Use selected to prune specific toolCallIds, or all to prune all historical prunable tool results.',
          },
          toolCallIds: {
            type: 'array',
            items: {
              type: 'string',
            },
            description:
              'Tool call ids to exclude from future prompt context when mode is selected.',
          },
          reason: {
            type: 'string',
            description: 'Optional short reason for pruning.',
          },
        },
      },
    },
    {
      name: 'context_compact',
      description:
        'Compact earlier conversation history into a summary and continue in a fresh context window while preserving visible chat history.',
      inputSchema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Optional short reason for compacting.',
          },
          instruction: {
            type: 'string',
            description: 'Optional focus hint for the summary.',
          },
        },
      },
    },
    // Consolidated group tool (migration 82→83 capability key
    // `context_manage:compact/prune`). Registered like project_ops /
    // scheduled_task_ops: a single `action`-switched tool covering both the
    // compact and prune operations. The legacy split tools
    // (context_compact / context_prune_tool_results) stay registered and
    // dispatchable — they map to the same execution logic below.
    {
      name: 'context_manage',
      description:
        'Manage conversation context. Pass action plus the action-specific fields: action="compact" summarizes earlier history into a fresh context window (optional instruction focus hint), action="prune" excludes selected or all historical tool results from future model-visible context without deleting chat history (mode="selected" requires toolCallIds, mode="all" prunes every prunable call).',
      inputSchema: buildConsolidatedToolSchemas().context_manage,
    },
    {
      name: 'fs_read',
      description: [
        'Read vault files, listed skills, or open web pages.',
        '',
        'paths: copy exactly from the source. Do not invent prefixes.',
        '- vault file: vault-relative path',
        '- skill: the path field in <available_skills>',
        '- open page: browser://<page_id> from <browser_context>',
        '- wikilink: [[Note#Heading]] or bare Note#^blockId (nested headings ok; .md optional). Exact vault path wins first.',
        '',
        'Omit range fields for a full read. Targeted read: startLine and optionally endLine or maxLines (1-based; PDF pages). Office files (.docx/.pptx/.xlsx) parse to markdown.',
        '',
        'browser://:',
        '- copy page_id from <browser_context>; never invent browser://https://... or browser://domain/path',
        '- do not call when <browser_context> is absent',
        '- does not fetch internet content; use web_search or web_scrape when available',
      ].join('\n'),
      inputSchema: {
        type: 'object',
        properties: {
          paths: {
            type: 'array',
            items: {
              type: 'string',
            },
            description: `Copy each path exactly as given. Max ${MAX_BATCH_READ_FILES} items.`,
          },
          sourcePath: {
            type: 'string',
            description:
              "Optional vault path of the note the wikilink targets are being resolved from, to match Obsidian's link-resolution rules (relative/shortest-path). Only affects wikilink-style paths entries; ignored otherwise. Omit to resolve against the vault-wide best match.",
          },
          startLine: {
            type: 'integer',
            description:
              'Start line/page (1-based). Providing this selects a targeted read; omit all range fields for a full read.',
          },
          endLine: {
            type: 'integer',
            description:
              'Inclusive end line/page. Requires startLine and cannot be combined with maxLines.',
          },
          maxLines: {
            type: 'integer',
            description:
              'Maximum lines/pages to return. Requires startLine and cannot be combined with endLine. When both endLine and maxLines are omitted, text-like content defaults to 50 lines and PDFs default to one page.',
          },
          format: {
            type: 'string',
            enum: ['readable', 'key_visible_info'],
            description:
              'Browser pages only. key_visible_info (default): compact visible headings, text blocks, tables, code, and formulas — prefer for long pages. readable: fuller Markdown-like text.',
          },
          ...(modalitySchema ? { modality: modalitySchema } : {}),
        },
        required: ['paths'],
      },
    },
    {
      name: 'fs_edit',
      description:
        'Apply one targeted text edit to an existing file. You must provide path, newText, and exactly one locator: oldText for exact-text replacement, or startLine+endLine for line-range replacement. Do not call fs_edit with only path and newText. Do not provide both oldText and startLine/endLine. Use fs_write to create a new file, fill an empty file, or overwrite full file content. To make several edits in the same file, emit multiple fs_edit calls — the system automatically merges edits targeting the same file into one atomic review and write, so earlier edits cannot invalidate later ones.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          newText: {
            type: 'string',
            description:
              'Replacement text. This is not a standalone write request; it is only valid together with oldText or startLine+endLine.',
          },
          oldText: {
            type: 'string',
            description:
              'Exact-text mode: the existing text to find and replace. Must match the file exactly once. Do not combine with startLine/endLine.',
          },
          startLine: {
            type: 'integer',
            description:
              'Line-range mode: 1-based inclusive start line. Provide together with endLine; do not combine with oldText.',
          },
          endLine: {
            type: 'integer',
            description:
              'Line-range mode: 1-based inclusive end line. Provide together with startLine; do not combine with oldText.',
          },
        },
        required: ['path', 'newText'],
      },
    },
    {
      name: 'fs_write',
      description:
        'Create a file, or overwrite an existing file with new full content. Missing parent folders are created automatically. Use fs_edit instead when you only need to change part of an existing file.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative file path.',
          },
          content: {
            type: 'string',
            description: 'Full file content.',
          },
        },
        required: ['path', 'content'],
      },
    },
    {
      name: 'mineru_convert',
      description:
        'Convert a PDF file to Markdown and images via the configured MinerU service (only available when MinerU is enabled and reachable in settings). Pass inputPath (vault-relative PDF path) and outputDir (vault-relative target folder); returns the written markdown/image file list.',
      inputSchema: {
        type: 'object',
        properties: {
          inputPath: {
            type: 'string',
            description: 'Vault-relative path of the PDF to convert.',
          },
          outputDir: {
            type: 'string',
            description:
              'Vault-relative target folder for the extracted markdown and images.',
          },
        },
        required: ['inputPath', 'outputDir'],
      },
    },
    ...(isRuntimeComponentEnabled('bash-engine')
      ? [
          {
            name: BASH_TOOL_NAME,
            description:
              'A sandboxed virtual shell over the vault, mounted at /vault (cwd defaults there); nothing outside /vault exists. To read a file, call the separate `fs_read` tool — this shell has no read command. To search, use the `search [-n N] "query" [path]` command inside this shell (hybrid RAG + keyword retrieval). Path operations — mkdir, mv, rm — run directly here. Content writes are unavailable here — call the separate `fs_edit` or `fs_write` tool instead.',
            inputSchema: {
              type: 'object',
              properties: {
                command: {
                  type: 'string',
                  description: 'The shell command line to run.',
                },
              },
              required: ['command'],
            },
          } satisfies McpTool,
        ]
      : []),
    {
      name: 'memory_add',
      description:
        'Add memory entries to global or assistant memory. Supports single entry or batch items; category defaults to other and id is auto-assigned.',
      inputSchema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Memory content text to store.',
          },
          items: {
            type: 'array',
            description:
              'Batch add items. Each item accepts content, optional category, and optional scope.',
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                },
                category: {
                  type: 'string',
                },
                scope: {
                  type: 'string',
                  enum: ['global', 'assistant'],
                },
              },
              required: ['content'],
            },
          },
          category: {
            type: 'string',
            description:
              'Memory category. Use profile, preferences, or other. Defaults to other.',
          },
          scope: {
            type: 'string',
            enum: ['global', 'assistant'],
            description:
              'Memory scope. Defaults to assistant, and may fallback to global when assistant memory is unavailable.',
          },
        },
      },
    },
    {
      name: 'memory_update',
      description:
        'Update an existing memory entry by id within global or assistant memory.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Memory id such as Profile_2 or Memory_4.',
          },
          new_content: {
            type: 'string',
            description: 'Replacement content for the target memory id.',
          },
          scope: {
            type: 'string',
            enum: ['global', 'assistant'],
            description:
              'Memory scope. Defaults to assistant, and may fallback to global when assistant memory is unavailable.',
          },
        },
        required: ['id', 'new_content'],
      },
    },
    {
      name: 'memory_delete',
      description:
        'Delete memory entries by id from global or assistant memory. Supports single id or batch ids.',
      inputSchema: {
        type: 'object',
        properties: {
          id: {
            type: 'string',
            description: 'Memory id such as Preference_1.',
          },
          ids: {
            type: 'array',
            items: {
              type: 'string',
            },
            description:
              'Batch delete ids. Each id must exist in the selected memory scope.',
          },
          scope: {
            type: 'string',
            enum: ['global', 'assistant'],
            description:
              'Memory scope. Defaults to assistant, and may fallback to global when assistant memory is unavailable.',
          },
        },
      },
    },
    {
      name: 'meta_search',
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
            description:
              'Maximum files to return. Defaults to 20, range 1-300.',
          },
        },
        required: ['meta'],
      },
    },
    {
      name: WEB_SEARCH_TOOL_NAME,
      description:
        'Search the web for up-to-date or specific information using the configured search provider. ' +
        'Returns { answer?, items: [{ id, title, url, text }] }. ' +
        'When citing a fact taken from a result, append `[citation,domain](id)` immediately after the sentence; ' +
        'example: "The capital of France is Paris. [citation,example.com](abc123)".',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Natural language search query.',
          },
          topic: {
            type: 'string',
            enum: ['general', 'news', 'finance'],
            description:
              'Optional topic hint. Some providers (e.g. Tavily) use this to bias results; others ignore it.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: WEB_SCRAPE_TOOL_NAME,
      description:
        'Fetch the full content of a single web page (markdown when the provider supports it). ' +
        'Use this only when search snippets are insufficient. Returns { url, title?, content }.',
      inputSchema: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: 'Absolute http(s) URL to fetch.',
          },
        },
        required: ['url'],
      },
    },
    getJsSandboxTool(),
    {
      name: TERMINAL_COMMAND_TOOL_NAME,
      description:
        'Run a command in the local OS shell. Desktop-only. ' +
        'Uses PowerShell on Windows and a POSIX shell on macOS/Linux. ' +
        'Use for terminal-style inspection or local CLI commands on the user’s machine. ' +
        'For vault content search/read/inspection, prefer the bash tool instead — it is sandboxed to the vault and works on every platform. ' +
        'By default, command runs as a one-shot process and completes when that process exits; ' +
        'it does not keep shell state between calls. ' +
        'Use background=true to create a persistent session for long-running or interactive commands; ' +
        'session_id polls or continues an existing ' +
        'session; input sends stdin to that session; kill=true terminates it. ' +
        'Results separate stdout and stderr. ' +
        'Use tail_lines or tail_bytes when polling verbose sessions to inspect recent logs only. ' +
        'Avoid heredocs and full-screen TUI programs such as vim/top. Long-running ' +
        'commands should use background=true; completion is pushed when finished. ' +
        'Avoid frequent polling to check status. ' +
        'The tool result is returned to you, but it does not automatically become a user-facing answer; to show the user the result, send a concise text summary of the relevant output.',
      inputSchema: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description:
              'Shell command to run. Omit when polling, sending input, or killing an existing session.',
          },
          session_id: {
            type: 'integer',
            description:
              'Existing session id returned by a previous terminal_command call. Use it to poll, send input, or kill.',
          },
          input: {
            type: 'string',
            description:
              'Text to write to the session stdin. Include a trailing newline when submitting interactive input.',
          },
          background: {
            type: 'boolean',
            description:
              'Start the command in a dedicated session and return a session_id if it is still running after a short wait.',
          },
          cwd: {
            type: 'string',
            description:
              'Absolute working directory for this command. Defaults to the current vault root when available.',
          },
          timeout: {
            type: 'integer',
            description:
              'Maximum seconds to wait for foreground output before returning a live session_id. Defaults to 30.',
          },
          tail_lines: {
            type: 'integer',
            description:
              'Return only the last N lines from stdout and stderr. Useful when polling verbose long-running sessions.',
          },
          tail_bytes: {
            type: 'integer',
            description:
              'Return only the last N bytes from stdout and stderr. Cannot be combined with tail_lines.',
          },
          kill: {
            type: 'boolean',
            description: 'Terminate the given session_id.',
          },
        },
      },
    },
    {
      name: 'delegate_subagent',
      description:
        'Dispatch an isolated temporary sub-agent to work on a self-contained task asynchronously. ' +
        'The sub-agent does not see the parent conversation; the prompt must include all necessary context. ' +
        'Returns immediately with a taskId while the child runs in the background. ' +
        'When complete, a follow-up background message starting with ' +
        '[subagent_result taskId=...] will arrive for you to summarize or continue. ' +
        'The child uses the selected assistant role when delegatedRoleId is provided; otherwise it uses the generic sub-agent policy. ' +
        'The tool result is returned to you, but it does not automatically become a user-facing answer; to show the user the result, send a concise text summary of the relevant output.',
      inputSchema: {
        type: 'object',
        properties: {
          description: {
            type: 'string',
            description:
              'Short title for this dispatch (shown in the UI and tool summary).',
          },
          prompt: {
            type: 'string',
            description:
              'Complete task instructions for the temporary sub-agent.',
          },
          delegatedRoleId: {
            type: 'string',
            description:
              "Optional delegated role id from the available roles listed in the request context. When set, the sub-agent runs with that role's model, tools, and loop configuration.",
          },
          modelPreferenceId: {
            type: 'string',
            description:
              'Optional model id preference for the generic sub-agent model pool (ignored when delegatedRoleId is set).',
          },
          forkContext: {
            type: 'string',
            enum: ['none', 'last_turns', 'full'],
            description:
              "Optional read-only parent-context fork for the sub-agent. Defaults to none (the child sees only the prompt, exactly as today). last_turns appends a read-only snapshot of the parent conversation's most recent turns to the child prompt; full appends a size-capped read-only snapshot of the whole parent history. The snapshot reflects the parent conversation as of the current parent run's start: the child cannot write to parent state.",
            default: 'none',
          },
          projectTask: {
            type: 'object',
            description:
              'Optional binding to a project task. Provide the projectId/taskId plus the expectedRevision/expectedContentHash from a prior project get_task/query_tasks read. The parent resolves the task, composes its body + acceptance criteria into the child prompt, and binds the delivery back to the task.',
            properties: {
              projectId: { type: 'string' },
              taskId: { type: 'string' },
              expectedRevision: { type: 'number' },
              expectedContentHash: { type: 'string' },
              review: {
                type: 'boolean',
                description:
                  'Set true to dispatch an independent reviewer for an awaiting_review task instead of an implementer; the reviewer returns a structured verdict the parent records.',
              },
            },
            required: [
              'projectId',
              'taskId',
              'expectedRevision',
              'expectedContentHash',
            ],
          },
        },
        required: ['description', 'prompt'],
      },
    },
    // 边界说明：browser_ops（scroll/navigate/click/type）不在此注册——浏览器
    // 操作由第三方插件经 MCP 桥注入（injectionBridge），YOLO 内置不提供执行
    // 器。内置仅保留 fs_read 的 browser:// 只读能力（读取 <browser_context>
    // 标记的已打开 webview 页面）。
    {
      name: 'project_ops',
      description:
        'Manage durable project and task files under the host-managed Projects directory (parent-only; this is the sole way to read/write project/task state — those files are excluded from the normal fs tools). Pass action plus the action-specific fields: action="init" creates a project, "get" reads one task (taskId present) or lists tasks (status filter), "status" returns the project summary + signals (reclaimed, concurrent_running, all_terminal), "update" applies a patch or claims a task for a run (requires expectedRevision/expectedContentHash from a prior get), "review" records an approved/rework/escalated decision with evidence.',
      inputSchema: buildConsolidatedToolSchemas().project_ops,
    },
    {
      name: 'scheduled_task_ops',
      description:
        'Manage scheduled agent tasks: a prompt that runs automatically once, on an interval, or on a cron schedule. Pass action plus the action-specific fields: action="create" registers a new task, "update" patches a task by id, "delete" removes a task and its run history, "list" lists tasks (optionally filtered by enabled), "get" fetches one task, "run_now" triggers an immediate run subject to queue/concurrency limits.',
      inputSchema: buildConsolidatedToolSchemas().scheduled_task_ops,
    },
    {
      name: 'ask_user_question',
      description:
        'Ask the user one or more structured questions when you are blocked by missing information that cannot be inferred from context or the vault. Group related questions in a single call instead of asking turn by turn. Use sparingly — never to confirm trivial actions. Prefer concrete options (single_select / multi_select) over free text for the main questions. The UI automatically appends an "Other" escape hatch to every single_select / multi_select (with a free-text input that lands in the answer as `otherText`), so you do NOT need to add your own "Other" / "其他" option. The trailing free_text catch-all is also useful when an open-ended answer is plausible (e.g. "Anything else to add? (optional)") — note that free_text answers are treated as optional and may come back empty. This call MUST be the only tool call in the turn; the agent run pauses until the user submits answers in a dedicated panel.',
      inputSchema: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            minItems: 1,
            description:
              'One or more structured questions to ask the user. Group related questions together rather than splitting them across turns.',
            items: {
              type: 'object',
              required: ['id', 'prompt', 'inputType'],
              properties: {
                id: {
                  type: 'string',
                  description:
                    'Stable id used to key the answer back. Must be unique across the questions array.',
                },
                prompt: {
                  type: 'string',
                  description: 'The question text shown to the user.',
                },
                inputType: {
                  type: 'string',
                  enum: ['free_text', 'single_select', 'multi_select'],
                  description:
                    'free_text: open answer. single_select: pick exactly one option. multi_select: pick one or more options.',
                },
                options: {
                  type: 'array',
                  minItems: 2,
                  description:
                    'Required for single_select / multi_select. Each option has a stable id and a human-readable label. Disallowed for free_text. The id "__other__" is reserved — the UI appends its own "Other" entry, so do not include one yourself.',
                  items: {
                    type: 'object',
                    required: ['id', 'label'],
                    properties: {
                      id: { type: 'string' },
                      label: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
        required: ['questions'],
      },
    },
    {
      name: 'todo_write',
      description:
        'Update the todo list for the current agent run. Use proactively for multi-step tasks (≥3 steps) or when the user has multiple requests. Each call replaces the entire list; pass `[]` to clear. Keep at most one item in_progress (and exactly one while work is ongoing). Mark items completed immediately as you finish them.',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description:
              'Complete replacement list of todo items. Pass [] to clear all todos.',
            items: {
              type: 'object',
              properties: {
                content: {
                  type: 'string',
                  description:
                    'The work to do, as an action phrase. Examples: "Run tests", "Refactor the parser".',
                },
                status: {
                  type: 'string',
                  enum: ['pending', 'in_progress', 'completed'],
                  description: 'Current status of the task.',
                },
              },
              required: ['content', 'status'],
            },
          },
        },
        required: ['todos'],
      },
    },
    {
      name: 'send_attachment',
      description:
        'Send a file already present in the vault as an attachment to the current bot chat. Only available in bot conversations. The path must be vault-relative and fall under one of the admin-configured allowed directories, or the call fails.',
      inputSchema: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Vault-relative path of the file to send.',
          },
          label: {
            type: 'string',
            description:
              'Optional short caption shown alongside the attachment (images only).',
          },
        },
        required: ['path'],
      },
    },
    ...getInjectedBridgeTools(),
  ]
}

const getOptionalBooleanArg = (
  args: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'boolean') {
    throw new Error(`${key} must be a boolean.`)
  }
  return value
}

const assertContentSize = (content: string): void => {
  if (content.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `Content too large (${content.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
    )
  }
}

const utf8ByteLength = (value: string): number =>
  new TextEncoder().encode(value).length

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

const sliceToByteBudget = (
  full: string,
  maxChars: number,
): { text: string; truncated?: { totalBytes: number; omittedBytes: number } } => {
  if (utf8ByteLength(full) <= maxChars) return { text: full }

  const suffix = '\n\n... (truncated)'
  const available = maxChars - utf8ByteLength(suffix)
  if (available <= 0) {
    return {
      text: suffix.trim(),
      truncated: {
        totalBytes: utf8ByteLength(full),
        omittedBytes: utf8ByteLength(full),
      },
    }
  }

  let sliceEnd = Math.min(available, full.length)
  while (sliceEnd > 0 && utf8ByteLength(full.slice(0, sliceEnd)) > available) {
    sliceEnd -= 1
  }
  const text = full.slice(0, sliceEnd) + suffix
  return {
    text,
    truncated: {
      totalBytes: utf8ByteLength(full),
      omittedBytes: utf8ByteLength(full) - utf8ByteLength(text),
    },
  }
}

const formatBoundedJsonResult = (
  payload: unknown,
  maxChars: number,
): { text: string; truncated?: { totalBytes: number; omittedBytes: number } } =>
  sliceToByteBudget(JSON.stringify(payload), maxChars)

const formatBoundedTextResult = (
  text: string,
  maxChars: number,
): { text: string; truncated?: { totalBytes: number; omittedBytes: number } } =>
  sliceToByteBudget(text, maxChars)

const escapeTableCell = (value: string): string =>
  value.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')

const buildMetadataResultTable = (results: MetadataSearchHit[]): string => {
  if (results[0]?.kind === 'distinct') {
    const hit = results[0]
    const header = hit.key === 'available_keys' ? 'field' : hit.key
    const rows = hit.values.map((value) => `| ${escapeTableCell(String(value))} |`)
    return [`| ${header} |`, '| --- |', ...rows].join('\n')
  }

  const fileHits = results as MetadataFileSearchHit[]
  const columns = [...new Set(fileHits.flatMap((hit) => Object.keys(hit.metadata)))]
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

const isReadablePathSafe = (
  path: string,
  policy: WorkspaceAccessPolicy | undefined,
): boolean => {
  try {
    return isReadablePath(path, policy)
  } catch {
    return false
  }
}
const normalizeLocalToolName = (toolName: string): string => {
  if (!toolName.includes('__')) {
    return toolName
  }
  const parts = toolName.split('__')
  return parts[parts.length - 1] ?? toolName
}

export function isLocalFsWriteToolName(toolName: string): boolean {
  const normalizedToolName = normalizeLocalToolName(toolName)
  return (
    isWorkspaceWriteToolName(normalizedToolName) ||
    LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES.includes(
      normalizedToolName as (typeof LOCAL_MEMORY_SPLIT_ACTION_TOOL_NAMES)[number],
    )
  )
}

export type AskUserQuestionInputType =
  | 'free_text'
  | 'single_select'
  | 'multi_select'

export type AskUserQuestionOption = {
  id: string
  label: string
}

/**
 * Reserved option id used by the UI to inject an "Other" escape hatch into
 * every single_select / multi_select. The model is forbidden from emitting an
 * option with this id (the validator rejects it) so the UI can rely on the id
 * being free.
 */
export const ASK_USER_QUESTION_OTHER_ID = '__other__'

export type AskUserQuestionItem = {
  id: string
  prompt: string
  inputType: AskUserQuestionInputType
  options?: AskUserQuestionOption[]
}

export type AskUserQuestionArgs = {
  questions: AskUserQuestionItem[]
}

export type AskUserQuestionValidationResult =
  | { ok: true; value: AskUserQuestionArgs }
  | { ok: false; error: string }

/**
 * Validate the model-provided arguments for the `ask_user_question` tool.
 * The tool has no execution path — the gateway calls this and converts a
 * failed result into a Tool Error response. A successful result is what the
 * UI panel renders.
 */
export function validateAskUserQuestionArgs(
  rawArgs: unknown,
): AskUserQuestionValidationResult {
  if (
    rawArgs === null ||
    typeof rawArgs !== 'object' ||
    Array.isArray(rawArgs)
  ) {
    return { ok: false, error: 'arguments must be an object.' }
  }
  const args = rawArgs as Record<string, unknown>
  const rawQuestions = args.questions
  if (!Array.isArray(rawQuestions)) {
    return { ok: false, error: 'questions must be an array.' }
  }
  if (rawQuestions.length < 1) {
    return {
      ok: false,
      error: 'questions must contain at least 1 item.',
    }
  }

  const seenIds = new Set<string>()
  const validated: AskUserQuestionItem[] = []
  for (let i = 0; i < rawQuestions.length; i++) {
    const raw = rawQuestions[i]
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      return { ok: false, error: `questions[${i}] must be an object.` }
    }
    const q = raw as Record<string, unknown>

    const id = q.id
    if (typeof id !== 'string' || id.trim() === '') {
      return {
        ok: false,
        error: `questions[${i}].id must be a non-empty string.`,
      }
    }
    if (seenIds.has(id)) {
      return {
        ok: false,
        error: `questions[${i}].id "${id}" is duplicated; ids must be unique.`,
      }
    }
    seenIds.add(id)

    const prompt = q.prompt
    if (typeof prompt !== 'string' || prompt.trim() === '') {
      return {
        ok: false,
        error: `questions[${i}].prompt must be a non-empty string.`,
      }
    }

    const inputType = q.inputType
    if (
      inputType !== 'free_text' &&
      inputType !== 'single_select' &&
      inputType !== 'multi_select'
    ) {
      return {
        ok: false,
        error: `questions[${i}].inputType must be "free_text", "single_select", or "multi_select".`,
      }
    }

    let options: AskUserQuestionOption[] | undefined

    if (inputType === 'single_select' || inputType === 'multi_select') {
      if (!Array.isArray(q.options)) {
        return {
          ok: false,
          error: `questions[${i}].options must be an array for ${inputType}.`,
        }
      }
      if (q.options.length < 2) {
        return {
          ok: false,
          error: `questions[${i}].options must contain at least 2 items.`,
        }
      }
      const seenOptionIds = new Set<string>()
      const opts: AskUserQuestionOption[] = []
      for (let j = 0; j < q.options.length; j++) {
        const rawOpt = q.options[j]
        if (
          rawOpt === null ||
          typeof rawOpt !== 'object' ||
          Array.isArray(rawOpt)
        ) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}] must be an object.`,
          }
        }
        const opt = rawOpt as Record<string, unknown>
        if (typeof opt.id !== 'string' || opt.id.trim() === '') {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].id must be a non-empty string.`,
          }
        }
        if (opt.id === ASK_USER_QUESTION_OTHER_ID) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].id "${ASK_USER_QUESTION_OTHER_ID}" is reserved by the UI; remove this option and rely on the auto-appended "Other" entry.`,
          }
        }
        if (typeof opt.label !== 'string' || opt.label.trim() === '') {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].label must be a non-empty string.`,
          }
        }
        if (seenOptionIds.has(opt.id)) {
          return {
            ok: false,
            error: `questions[${i}].options[${j}].id "${opt.id}" is duplicated within the question.`,
          }
        }
        seenOptionIds.add(opt.id)
        opts.push({ id: opt.id, label: opt.label })
      }
      options = opts
    } else {
      // free_text
      if (q.options !== undefined) {
        return {
          ok: false,
          error: `questions[${i}].options is not allowed for free_text inputType.`,
        }
      }
    }

    validated.push({
      id,
      prompt,
      inputType,
      ...(options ? { options } : {}),
    })
  }

  return { ok: true, value: { questions: validated } }
}

export function isAskUserQuestionToolName(toolName: string): boolean {
  try {
    const parsed = parseToolName(toolName)
    return (
      parsed.serverName === LOCAL_FILE_TOOL_SERVER &&
      parsed.toolName === ASK_USER_QUESTION_TOOL_NAME
    )
  } catch {
    return false
  }
}

export function parseLocalFsActionFromToolArgs({
  toolName,
  args: _args,
}: {
  toolName: string
  args?: Record<string, unknown> | string
}): FsFileOpAction | null {
  const normalizedToolName = normalizeLocalToolName(toolName)
  const splitAction =
    LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION[
      normalizedToolName as keyof typeof LOCAL_FS_SPLIT_ACTION_TOOL_TO_ACTION
    ]
  if (splitAction) {
    return splitAction
  }
  return null
}

const executeFsFileOps = async ({
  app,
  settings,
  action,
  item,
  signal,
  tool,
  conversationId,
  roundId,
  toolCallId,
}: {
  app: App
  settings?: YoloSettings
  action: FsFileOpAction
  item: Record<string, unknown>
  signal?: AbortSignal
  tool: string
  conversationId?: string
  roundId?: string
  toolCallId?: string
}): Promise<LocalToolCallResult> => {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  const appliedAt = Date.now()

  try {
    if (action === 'write') {
      const path = validateVaultPath(getTextArg(item, 'path'))
      const content = getTextArg(item, 'content')
      assertContentSize(content)

      const existing = app.vault.getAbstractFileByPath(path)

      if (existing instanceof TFolder) {
        throw new Error(`Path is a folder, cannot overwrite as a file: ${path}`)
      }

      let result: FsResultItem
      let metadata: LocalToolCallResultMetadata | undefined

      if (existing instanceof TFile) {
        // Overwrite. Guard against pulling an oversized old file into the
        // diff/undo snapshot: when the existing content exceeds the size
        // limit we still overwrite, but skip the snapshot/editSummary so we
        // don't blow up memory with a giant before-content.
        const overSized = existing.stat.size > MAX_FILE_SIZE_BYTES
        const beforeContent = overSized ? '' : await app.vault.read(existing)
        await app.vault.modify(existing, content)
        if (!overSized) {
          metadata = await buildFileChangeSummary({
            app,
            settings,
            path,
            beforeContent,
            afterContent: content,
            beforeExists: true,
            afterExists: true,
            conversationId,
            roundId,
            toolCallId,
            appliedAt,
          })
        }
        result = {
          ok: true,
          action,
          target: path,
          message: overSized
            ? 'Overwrote file (existing content too large for undo snapshot).'
            : 'Overwrote file.',
        }
      } else {
        await ensureParentFolderExists(app, path)
        await app.vault.create(path, content)
        metadata = await buildFileChangeSummary({
          app,
          settings,
          path,
          beforeContent: '',
          afterContent: content,
          beforeExists: false,
          afterExists: true,
          conversationId,
          roundId,
          toolCallId,
          appliedAt,
        })
        result = {
          ok: true,
          action,
          target: path,
          message: 'Created file.',
        }
      }

      return {
        status: ToolCallResponseStatus.Success,
        text: formatJsonResult({ tool, action, results: [result] }),
        metadata,
      }
    }

    throw new Error(`Unsupported fs action: ${action}`)
  } catch (error) {
    return {
      status: ToolCallResponseStatus.Error,
      error: asErrorMessage(error),
    }
  }
}

export const workspacePolicyToUpstreamScope = (
  policy: WorkspaceAccessPolicy | undefined,
): AssistantWorkspaceScope | undefined => {
  if (!policy) return undefined
  const protectedExcludes = (policy.protectedPaths ?? []).map((rule) =>
    rule.kind === 'namePrefix'
      ? `${rule.dir}/${rule.name}`.replace(/\/+$/, '')
      : rule.path,
  )
  if (!policy.enabled && protectedExcludes.length === 0) return undefined
  return {
    enabled: true,
    include: policy.enabled
      ? [policy.workspaceRoot, ...policy.readExtraIncludes].filter(
          (entry) => entry !== '',
        )
      : [],
    exclude: [
      ...(policy.enabled ? policy.readExcludes : []),
      // Fold the host-managed protected paths into the upstream scope so the
      // bash virtual FS (which only knows AssistantWorkspaceScope) denies
      // plugin-private data even for a whole-vault workspaceRoot. Without
      // this, an agent scoped to `/` could `cat YOLO/sessions.sqlite` etc.
      // through bash while the fs tools reject the same path. `prefix` and
      // `exact` rules keep their path; `namePrefix` maps to `<dir>/<name>`,
      // which the upstream exclude matcher's "path and all descendants"
      // prefix semantics covers for name-prefixed children (siblings that
      // only share the prefix without a path boundary are not covered — the
      // fixed-name exact rules for the SQLite files still hold).
      ...protectedExcludes,
    ],
  }
}

/** 单张 MinerU 图片（vault 路径）→ image_url content part；解析/读取失败跳过。 */
async function buildMinerUImageParts(
  app: App,
  refs: string[],
  settings: YoloSettings | undefined,
): Promise<ContentPart[]> {
  const parts: ContentPart[] = []
  for (const vaultPath of refs) {
    const imageFile = app.vault.getFileByPath(vaultPath)
    if (!imageFile) continue
    try {
      const dataUrl = await tFileToImageDataUrl(app, imageFile, {
        cache: { enabled: true, settings },
      })
      parts.push({ type: 'image_url', image_url: { url: dataUrl } })
    } catch (error) {
      console.warn('[YOLO] Failed to read MinerU image', vaultPath, error)
    }
  }
  return parts
}

/**
 * MinerU-first PDF read shared by the fs_read PDF branches: converts the PDF
 * to markdown + images and resolves the image refs to content parts (capped at
 * 8). Returns null when MinerU is disabled/unavailable or the conversion
 * failed (callers fall back to the legacy pipeline). AbortError propagates so
 * callers can return the Aborted status like the legacy extract path.
 */
async function readPdfViaMinerU({
  app,
  file,
  settings,
  signal,
  includeImages,
}: {
  app: App
  file: TFile
  settings: YoloSettings | undefined
  signal?: AbortSignal
  includeImages: boolean
}): Promise<{ markdown: string; imageParts: ContentPart[] } | null> {
  if (!isMinerUEnabled(settings) || !settings?.mineru) {
    return null
  }
  try {
    const mineruResult = await convertPdfViaMinerU({
      app,
      file,
      options: settings.mineru,
      settings,
      signal,
    })
    const { refs, markdown } = resolveMinerUImageRefs(
      mineruResult.markdown,
      mineruResult.images,
      8, // 图片上限
    )
    const imageParts = includeImages
      ? await buildMinerUImageParts(app, refs, settings)
      : []
    return { markdown, imageParts }
  } catch (mineruErr) {
    if (mineruErr instanceof DOMException && mineruErr.name === 'AbortError') {
      throw mineruErr
    }
    console.warn(
      '[YOLO] MinerU conversion failed, falling back to default PDF handling',
      mineruErr,
    )
    return null
  }
}
export async function callLocalFileTool({
  app,
  settings,
  openApplyReview,
  getRagEngine,
  conversationId,
  conversationMessages,
  roundId,
  toolCallId,
  toolName,
  args,
  requireReview = false,
  signal,
  chatModelId,
  workspaceAccessPolicy,
  allowedSkillPaths,
  runContext,
  subagentParentContext,
  promptSourceWatcher,
  bashApprovalMode,
  bashReadOnly,
  getScheduledTasksService,
}: {
  app: App
  settings?: YoloSettings
  openApplyReview?: (state: ApplyViewState) => Promise<boolean>
  getRagEngine?: () => Promise<RAGEngine>
  getScheduledTasksService?: () => ScheduledTaskServiceLike | null
  conversationId?: string
  conversationMessages?: ChatMessage[]
  roundId?: string
  toolCallId?: string
  toolName: string
  args: Record<string, unknown>
  requireReview?: boolean
  signal?: AbortSignal
  chatModelId?: string
  workspaceAccessPolicy?: WorkspaceAccessPolicy
  allowedSkillPaths?: readonly string[]
  runContext?: AgentRunContext
  /**
   * 仅消费/转发父 subagent 运行上下文的部分字段（工作区策略、request context
   * builder、父 assistant id、forkContext）；完整形态见 SubagentParentContext。
   * 以结构子集就地声明，避免 localFileTools → subagent/* 的静态/type 导入边
   * （madge 对 type-only 导入计边，会与 tool-preferences 回流成环）。forkContext
   * 由 delegate_subagent 工具参数解析后在派发处填入（Task 14）。
   */
  subagentParentContext?: {
    workspaceAccessPolicy?: WorkspaceAccessPolicy
    requestContextBuilder: unknown
    assistantId?: string
    forkContext?: 'none' | 'last_turns' | 'full'
  }
  promptSourceWatcher?: PromptSourceWatcher
  /** Effective approval tier for the bash tool (see tool-gateway.ts). */
  bashApprovalMode?: AssistantToolApprovalMode
  /**
   * Forces the bash tool call into its structurally read-only variant for
   * this entire run (see tool-gateway.ts). When true, mkdir/mv/rm/rmdir are
   * unavailable regardless of `bashApprovalMode`.
   */
  bashReadOnly?: boolean
}): Promise<LocalToolCallResult> {
  if (signal?.aborted) {
    return { status: ToolCallResponseStatus.Aborted }
  }

  try {
    // The shared boundary owns the policy and user-data-root checks for every
    // execution path.
    enforceBuiltinToolSecurityBoundary(toolName, args, {
      settings,
      workspaceAccessPolicy,
      allowedSkillPaths,
    })

    const name = toolName as LocalFileToolName
    switch (name) {
      // 'context_prune_tool_results' and 'context_compact' below are now
      // unreachable in practice — both are registered in `CAPABILITIES`
      // (`src/core/tools/capabilities/index.ts`), so the delegation bridge
      // above routes them to `executeBuiltinTool` before this switch is ever
      // reached. Left in place rather than deleted, matching the precedent
      // set by the still-present `memory_add`/`memory_update`/
      // `memory_delete`/`delegate_subagent` cases below (D2/D3): tearing
      // down this switch is a later-phase concern (master.md D6 "注意" /
      // D7), not this batch's.
      case 'context_prune_tool_results': {
        const mode = getContextPruneMode(args)

        const prunableToolCallIds = getContextPrunableToolCallIds(
          conversationMessages,
          toolCallId,
        )
        const toolCallIds =
          mode === 'all'
            ? [...prunableToolCallIds]
            : getStringArrayArg(args, 'toolCallIds')
                .map((value) => value.trim())
                .filter(
                  (value, index, arr) =>
                    value.length > 0 && arr.indexOf(value) === index,
                )

        if (mode === 'selected' && toolCallIds.length === 0) {
          throw new Error('toolCallIds cannot be empty when mode is selected.')
        }

        const acceptedToolCallIds = toolCallIds.filter((value) =>
          prunableToolCallIds.has(value),
        )
        const ignoredToolCallIds = toolCallIds.filter(
          (value) => !prunableToolCallIds.has(value),
        )

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'context_prune_tool_results',
            toolCallId: toolCallId ?? null,
            operation: mode === 'all' ? 'prune_all' : 'prune_selected',
            acceptedToolCallIds,
            ignoredToolCallIds,
            reason: getOptionalTextArg(args, 'reason')?.trim() || null,
          }),
        }
      }

      case 'context_compact': {
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'context_compact',
            toolCallId: toolCallId ?? null,
            operation: 'compact_restart',
            reason: getOptionalTextArg(args, 'reason')?.trim() || null,
            instruction:
              getOptionalTextArg(args, 'instruction')?.trim() || null,
          }),
        }
      }

      // Consolidated context_manage group dispatch. Maps each action onto the
      // existing split-tool execution logic; the result keeps the legacy split
      // tool name in the `tool` field so the compaction pipeline
      // (parseCompactOperationResult / findCompactTrigger /
      // findCompactToolCallId) stays untouched. `action` is validated through
      // resolveConsolidatedAction + validateConsolidatedAction below; the
      // fallthrough error mirrors project_ops/scheduled_task_ops.
      case 'context_manage': {
        const capability = resolveConsolidatedAction('context_manage', args)
        validateConsolidatedAction(capability, args)
        switch (capability.action) {
          case 'compact': {
            return {
              status: ToolCallResponseStatus.Success,
              text: formatJsonResult({
                tool: 'context_compact',
                toolCallId: toolCallId ?? null,
                operation: 'compact_restart',
                reason: getOptionalTextArg(args, 'reason')?.trim() || null,
                instruction:
                  getOptionalTextArg(args, 'instruction')?.trim() || null,
              }),
            }
          }
          case 'prune': {
            const mode = getContextPruneMode(args)

            const prunableToolCallIds = getContextPrunableToolCallIds(
              conversationMessages,
              toolCallId,
            )
            const toolCallIds =
              mode === 'all'
                ? [...prunableToolCallIds]
                : getStringArrayArg(args, 'toolCallIds')
                    .map((value) => value.trim())
                    .filter(
                      (value, index, arr) =>
                        value.length > 0 && arr.indexOf(value) === index,
                    )

            if (mode === 'selected' && toolCallIds.length === 0) {
              throw new Error(
                'toolCallIds cannot be empty when mode is selected.',
              )
            }

            const acceptedToolCallIds = toolCallIds.filter((value) =>
              prunableToolCallIds.has(value),
            )
            const ignoredToolCallIds = toolCallIds.filter(
              (value) => !prunableToolCallIds.has(value),
            )

            return {
              status: ToolCallResponseStatus.Success,
              text: formatJsonResult({
                tool: 'context_prune_tool_results',
                toolCallId: toolCallId ?? null,
                operation: mode === 'all' ? 'prune_all' : 'prune_selected',
                acceptedToolCallIds,
                ignoredToolCallIds,
                reason: getOptionalTextArg(args, 'reason')?.trim() || null,
              }),
            }
          }
          default:
            // Unreachable: resolve+validate reject unknown actions above.
            throw new Error(
              `Unsupported context_manage action: ${capability.action}`,
            )
        }
      }

      case 'fs_read': {
        const paths = getStringArrayArg(args, 'paths')
          .map((path) => normalizeFsReadPath(path))
          .filter((path, index, arr) => arr.indexOf(path) === index)

        if (paths.length === 0) {
          throw new Error('paths cannot be empty.')
        }
        if (paths.length > MAX_BATCH_READ_FILES) {
          throw new Error(
            `paths supports up to ${MAX_BATCH_READ_FILES} files per call.`,
          )
        }
        const operation = getFsReadOperation(args)
        // Resolution context for wikilink-style path entries (see the
        // fallback resolution below). Not a path read from — just the
        // linking note's path, mirroring how Obsidian resolves real
        // wikilinks. Not subject to workspace-scope checks itself.
        const rawSourcePath = getOptionalTextArg(args, 'sourcePath')?.trim()
        const sourcePath =
          rawSourcePath && rawSourcePath.length > 0
            ? validateVaultPath(rawSourcePath)
            : undefined
        const allowedSkillPathSet = allowedSkillPaths
          ? buildAllowedSkillPathSet(allowedSkillPaths)
          : undefined

        const results: Array<
          | {
              path: string
              ok: true
              totalLines: number
              returnedRange?: {
                startLine: number | null
                endLine: number | null
              }
              hasMoreBelow: boolean
              nextStartLine: number | null
              content: string
              wikilinks?: Array<{ link: string; path: string }>
              effectiveModality?: 'text' | 'image' | 'pdf'
              warning?: string
              url?: string
              title?: string
              loading?: boolean
              redactions?: Array<{ kind: string; count: number }>
              partial?: { reason: string; message: string }
              // Present when this entry was resolved via wikilink fallback
              // rather than an exact vault path match (see the resolution
              // loop below).
              resolvedPath?: string
              resolvedSubpath?: WikilinkReadSubpath
            }
          | {
              path: string
              ok: false
              error: string
            }
        > = []
        const readSkillNames: string[] = []

        // Tool result attachments hoisted to a follow-up user message after
        // the tool block. Mostly image_url for rendered PDFs/images, but also
        // `document` for native PDF slices.
        const perFileAttachmentParts: Array<{
          path: string
          parts: ContentPart[]
        }> = []

        // Skip image extraction when the active chat model does not accept
        // vision input; otherwise we'd ship base64 payloads to a text-only
        // endpoint and get a 400 back (issue #255). Migration 48→49 backfills
        // `modalities` on every ChatModel, so a missing array here means we
        // either have no active model or the lookup failed — treat as allow.
        const activeChatModel =
          chatModelId && settings?.chatModels
            ? (settings.chatModels.find((m) => m.id === chatModelId) ?? null)
            : null
        const chatModelAcceptsImages = activeChatModel
          ? chatModelSupportsVision(activeChatModel)
          : true
        // Conservative: when no active model is known, don't assume PDF support.
        const chatModelAcceptsPdf = activeChatModel
          ? chatModelSupportsPdf(activeChatModel)
          : false

        for (const path of paths) {
          if (signal?.aborted) {
            return { status: ToolCallResponseStatus.Aborted }
          }

          if (allowedSkillPathSet?.has(normalizeSkillPathForExemption(path))) {
            const skillDocument = await getLiteSkillDocumentByPath({
              app,
              path,
              settings,
            })
            if (!skillDocument) {
              results.push({ path, ok: false, error: 'Skill not found.' })
              continue
            }

            const content = skillDocument.content
            const lines = content.length === 0 ? [] : content.split('\n')
            const sliced = sliceLinesForFsReadOperation(lines, operation)

            results.push({
              path,
              ok: true,
              totalLines: sliced.totalLines,
              returnedRange:
                operation.type === 'lines'
                  ? {
                      startLine: sliced.returnedStartLine,
                      endLine: sliced.returnedEndLine,
                    }
                  : undefined,
              hasMoreBelow: sliced.hasMoreBelow,
              nextStartLine: sliced.nextStartLine,
              content: sliced.outputContent,
            })
            readSkillNames.push(skillDocument.entry.name)
            continue
          }

          if (isBrowserReadPath(path)) {
            if (Platform.isMobile) {
              results.push({
                path,
                ok: false,
                error: 'Reading open web pages via fs_read is desktop-only.',
              })
              continue
            }

            const pageId = parseBrowserReadPageId(path)
            const handle = findWebviewHandleByPageId(app, pageId)
            if (!handle) {
              results.push({
                path,
                ok: false,
                // Distinguish the web runtime: its workspace has no webview
                // leaves, so the probe always misses and "tab closed" would
                // mislead. Desktop workspaces can hold webviews, so there the
                // miss genuinely means the page is gone.
                error:
                  typeof app.workspace?.iterateAllLeaves === 'function'
                    ? `No open web page with page_id "${pageId}" was found. The tab may have been closed or replaced.`
                    : 'Reading open web pages via fs_read is not supported in this environment (no desktop webview tabs).',
              })
              continue
            }

            const format = operation.format ?? 'key_visible_info'
            try {
              const browserResult = await readActiveWebviewPage(handle, {
                format,
                signal,
              })
              if (!browserResult) {
                results.push({
                  path,
                  ok: false,
                  error:
                    'Webview is present but has no loaded page (URL empty or about:blank). Navigate to a URL first.',
                })
                continue
              }

              const text = browserResult.text ?? ''
              const lines = text.length === 0 ? [] : text.split('\n')
              const sliced = sliceLinesForFsReadOperation(lines, operation)
              results.push({
                path,
                ok: true,
                totalLines: sliced.totalLines,
                returnedRange:
                  operation.type === 'lines'
                    ? {
                        startLine: sliced.returnedStartLine,
                        endLine: sliced.returnedEndLine,
                      }
                    : undefined,
                hasMoreBelow: sliced.hasMoreBelow,
                nextStartLine: sliced.nextStartLine,
                content: sliced.outputContent,
                url: browserResult.url,
                title: browserResult.title,
                loading: browserResult.loading,
                redactions: browserResult.redactions,
                ...(browserResult.partial
                  ? { partial: browserResult.partial }
                  : {}),
              })
            } catch (error) {
              if (error instanceof BrowserReadFailure) {
                results.push({
                  path,
                  ok: false,
                  error: `${error.code}: ${error.message}`,
                })
                continue
              }
              throw error
            }
            continue
          }

          // Exact vault path first (unchanged from prior behavior). Only on
          // a miss do we try wikilink resolution — an explicit `[[...]]`
          // wrapper can never be a valid exact path, and Obsidian filenames
          // can't contain '#', so subpathed links can't collide with exact
          // paths either.
          let file = app.vault.getFileByPath(path)
          let resolvedPath: string | undefined
          let resolvedSubpath: WikilinkReadSubpath | undefined
          let subpathWarning: string | undefined

          if (!file) {
            const target = resolveWikilinkReadTarget(app, path, sourcePath)
            if (!target) {
              results.push({
                path,
                ok: false,
                error: `File not found. "${path}" did not match a vault path or a resolvable wikilink target.`,
              })
              continue
            }
            file = target.file
            resolvedPath = file.path
            if (target.subpath) {
              resolvedSubpath = target.subpath
            } else if (target.subpathError) {
              subpathWarning = target.subpathError
            }
          }

          // The YOLO user-data root (`<baseDir>/data`: chat history, module
          // settings/intent) must stay invisible to agent tools exactly like
          // its hidden pre-migration location (`.yolo_json_db`) was — see
          // `ensureUserDataRootDir` in `core/paths/yoloManagedData.ts`. Dot
          // directories were never indexed into the `TFile` tree at all, so
          // this exact-match/wikilink resolution above could never have hit
          // them; this check reproduces that invisibility explicitly now
          // that the root is visible. Reported as a plain not-found — same
          // wording as a genuine miss — so no new information ("this path is
          // specially hidden") leaks to the model. Checked before the
          // workspace-scope gate so it applies unconditionally, regardless
          // of whether workspace scope is even enabled.
          if (isWithinYoloUserDataRoot(file.path, settings)) {
            results.push({
              path,
              ok: false,
              error: `File not found: "${path}".`,
            })
            continue
          }

          // Scope enforcement for fs_read lives here rather than in the
          // top-level raw-string check (see workspaceScope.ts) because
          // wikilink targets aren't literal paths until resolved above.
          // Applies uniformly to exact-match and wikilink-resolved entries.
          // Files inside an allowed skill package keep the same exemption
          // they had under the workspace policy's exemptPaths option.
          if (
            workspaceAccessPolicy &&
            !isReadablePath(file.path, workspaceAccessPolicy) &&
            !(
              allowedSkillPathSet &&
              isCoveredBySkillPathExemption(file.path, allowedSkillPathSet)
            )
          ) {
            results.push({
              path,
              ok: false,
              error: `Path "${file.path}" is outside this agent's workspace scope.`,
            })
            continue
          }

          const wikilinkResultFields: {
            resolvedPath?: string
            resolvedSubpath?: WikilinkReadSubpath
          } = resolvedPath
            ? {
                resolvedPath,
                ...(resolvedSubpath ? { resolvedSubpath } : {}),
              }
            : {}

          const isPdf = file.extension?.toLowerCase() === 'pdf'
          if (isPdf) {
            if (file.stat.size > PDF_INDEX_MAX_BYTES) {
              results.push({
                path,
                ok: false,
                error: `PDF too large (${file.stat.size} bytes).`,
              })
              continue
            }

            // Resolve the effective modality for this PDF read. The schema
            // exposed to the model is tailored per capability (see
            // buildFsReadModalitySchema), so normally the requested modality
            // is already aligned with what the model can use. The branches
            // below also handle the "out-of-schema" cases (model somehow
            // sends image to a PDF-capable model, or pdf to a vision-only
            // model) — those resolve to the strictly-better alternative
            // rather than failing.
            //
            // Decision table:
            //   ── PDF-capable model ──
            //     undefined → pdf
            //     'pdf'     → pdf
            //     'text'    → text  (cheap path; respected verbatim)
            //     'image'   → pdf   (image is redundant when native PDF is
            //                       available — native PDF is strictly more
            //                       informative; this branch is a safety net,
            //                       schema doesn't expose image to these
            //                       models)
            //   ── vision-capable (non-PDF) ──
            //     undefined → text
            //     'pdf'     → text  (pdf not supported; safety-net downgrade)
            //     'text'    → text
            //     'image'   → image if image-read setting enabled, else text
            //   ── text-only ──
            //     all paths → text (no other modality is supported)
            const imageReadingEnabled =
              settings?.chatOptions?.imageReadingEnabled ?? true
            const canUseImage = chatModelAcceptsImages && imageReadingEnabled
            const resolvedModality: 'pdf' | 'image' | 'text' = (() => {
              if (chatModelAcceptsPdf) {
                switch (operation.modality) {
                  case undefined:
                  case 'pdf':
                  case 'image':
                    return 'pdf'
                  case 'text':
                    return 'text'
                }
              }
              switch (operation.modality) {
                case undefined:
                case 'pdf':
                case 'text':
                  return 'text'
                case 'image':
                  return canUseImage ? 'image' : 'text'
              }
            })()

            // ── Native PDF slice branch ────────────────────────────────────
            if (resolvedModality === 'pdf') {
              const reqStart =
                operation.type === 'lines' ? operation.startLine : 1
              // 范围读取显式给 maxLines 时按页数计算；未给 endLine/maxLines
              // 时保留低成本探查语义，只读 startLine 对应的单页。
              // full 模式的 endPage 留空，由 slicePdfPages 自动取到文档末页。
              const reqEnd =
                operation.type === 'lines'
                  ? (operation.endLine ??
                    (operation.maxLines !== undefined
                      ? operation.startLine + operation.maxLines - 1
                      : operation.startLine))
                  : undefined

              // Attempt to slice the PDF. slicePdfPages loads the source once
              // and reports total page count + clamped range; on failure it
              // throws a tagged PdfSliceError. Caller-side reaction depends on
              // the kind:
              //   • 'invalid-range' (e.g. startPage > totalPages) is a hard
              //     model-facing error — degrading to text would silently hide
              //     a bad page request.
              //   • all other kinds (load-failed / too-large / too-many-pages)
              //     fall through to text extraction with a warning prefix.
              let sliceResult:
                | Awaited<ReturnType<typeof slicePdfPages>>
                | undefined
              let sliceFallbackWarning: string | undefined

              try {
                const rawBuf = await app.vault.readBinary(file)
                const rawBytes = new Uint8Array(rawBuf)
                sliceResult = await slicePdfPages(rawBytes, {
                  startPage: reqStart,
                  endPage: reqEnd,
                })
              } catch (err) {
                if (
                  err instanceof PdfSliceError &&
                  err.kind === 'invalid-range'
                ) {
                  results.push({
                    path,
                    ok: false,
                    error: err.message,
                  })
                  continue
                }
                sliceFallbackWarning =
                  err instanceof Error ? err.message : String(err)
              }

              if (sliceResult !== undefined) {
                // Slice succeeded — emit the document part.
                const {
                  bytes: slicedBytes,
                  totalSourcePages,
                  actualStart,
                  actualEnd,
                } = sliceResult
                const slicePageCount = actualEnd - actualStart + 1

                const base64Data = uint8ArrayToBase64(slicedBytes)
                const documentPart: ContentPart = {
                  type: 'document',
                  mediaType: 'application/pdf',
                  name: `${file.name} (pages ${actualStart}–${actualEnd})`,
                  data: base64Data,
                  pageCount: slicePageCount,
                }

                const hasMoreBelow =
                  operation.type === 'lines' && actualEnd < totalSourcePages
                const nextStartLine = hasMoreBelow ? actualEnd + 1 : null

                results.push({
                  path,
                  ok: true,
                  totalLines: totalSourcePages,
                  returnedRange:
                    operation.type === 'lines'
                      ? { startLine: actualStart, endLine: actualEnd }
                      : undefined,
                  hasMoreBelow,
                  nextStartLine,
                  // Explain page-number renumbering so the model cites original
                  // page numbers (actualStart–actualEnd) rather than the
                  // slice-internal numbers (1–slicePageCount).
                  content: `Read pages ${actualStart}–${actualEnd} of "${file.name}" (original document has ${totalSourcePages} pages).\nThe attached PDF slice contains those pages renumbered as 1–${slicePageCount} internally, but you should refer to them by their ORIGINAL page numbers (${actualStart}–${actualEnd}) when citing.`,
                  effectiveModality: 'pdf' as const,
                  ...wikilinkResultFields,
                  ...(subpathWarning ? { warning: subpathWarning } : {}),
                })
                perFileAttachmentParts.push({ path, parts: [documentPart] })
                continue
              }

              // MinerU 优先：开关开且接口可用时 PDF 先转 md + 图片（取代文本提取）。
              // 范围语义：仅 full 模式走 MinerU（返回整份 md，无分页语义）；
              // lines 范围请求保持切片/分页语义，由下方 legacy 路径处理。
              if (operation.type === 'full') {
                let mineruResult: Awaited<
                  ReturnType<typeof readPdfViaMinerU>
                > | null = null
                try {
                  mineruResult = await readPdfViaMinerU({
                    app,
                    file,
                    settings,
                    signal,
                    includeImages: chatModelAcceptsImages,
                  })
                } catch (mineruErr) {
                  if (
                    mineruErr instanceof DOMException &&
                    mineruErr.name === 'AbortError'
                  ) {
                    return { status: ToolCallResponseStatus.Aborted }
                  }
                  throw mineruErr
                }
                if (mineruResult) {
                  // MinerU 一次性返回整份 md，无分页语义；行号 = md 行数。
                  const totalLines =
                    mineruResult.markdown.length === 0
                      ? 0
                      : mineruResult.markdown.split('\n').length
                  results.push({
                    path,
                    ok: true,
                    totalLines,
                    hasMoreBelow: false,
                    nextStartLine: null,
                    content: mineruResult.markdown,
                    effectiveModality: 'text' as const,
                    ...wikilinkResultFields,
                    ...(subpathWarning ? { warning: subpathWarning } : {}),
                  })
                  if (mineruResult.imageParts.length > 0) {
                    perFileAttachmentParts.push({
                      path,
                      parts: mineruResult.imageParts,
                    })
                  }
                  continue
                }
              } // end: operation.type === 'full'（MinerU 仅 full 模式）

              // Slice failed — fall through to text extraction with a warning prefix.
              let pdfSliceFallbackPages: { page: number; text: string }[] = []
              try {
                const extracted = await extractPdfText(app, file, {
                  signal,
                  maxBinaryBytes: PDF_INDEX_MAX_BYTES,
                  maxPages: PDF_INDEX_MAX_PAGES,
                  settings,
                })
                pdfSliceFallbackPages = extracted.pages
              } catch (extractErr) {
                if (
                  extractErr instanceof DOMException &&
                  extractErr.name === 'AbortError'
                ) {
                  return { status: ToolCallResponseStatus.Aborted }
                }
                results.push({
                  path,
                  ok: false,
                  error:
                    extractErr instanceof Error
                      ? extractErr.message
                      : 'Failed to extract PDF text.',
                })
                continue
              }

              const fbTotalPageCount = pdfSliceFallbackPages.length
              const fbRangeStart = operation.type === 'lines' ? reqStart : 1
              const fbRangeEnd =
                operation.type === 'full'
                  ? fbTotalPageCount
                  : Math.min(reqEnd ?? fbRangeStart, fbTotalPageCount)
              const fbSelectedPages = pdfSliceFallbackPages.filter(
                (p) => p.page >= fbRangeStart && p.page <= fbRangeEnd,
              )
              const fbTaggedBody = fbSelectedPages
                .map((p) => `<page ${p.page}>\n${p.text}\n</page ${p.page}>`)
                .join('\n')
              const fbWarningPrefix = `[PDF native slice failed for pages ${fbRangeStart}–${fbRangeEnd}, falling back to text extraction. Reason: ${sliceFallbackWarning ?? 'unknown error'}]\n\n`

              results.push({
                path,
                ok: true,
                totalLines: fbTotalPageCount,
                returnedRange:
                  operation.type === 'lines'
                    ? {
                        startLine:
                          fbSelectedPages.length > 0 ? fbRangeStart : null,
                        endLine: fbSelectedPages.length > 0 ? fbRangeEnd : null,
                      }
                    : undefined,
                hasMoreBelow:
                  operation.type === 'lines' && fbRangeEnd < fbTotalPageCount,
                nextStartLine:
                  operation.type === 'lines' && fbRangeEnd < fbTotalPageCount
                    ? fbRangeEnd + 1
                    : null,
                content: fbWarningPrefix + fbTaggedBody,
                effectiveModality: 'text' as const,
                warning: subpathWarning
                  ? `${fbWarningPrefix.trim()} ${subpathWarning}`
                  : fbWarningPrefix.trim(),
                ...wikilinkResultFields,
              })
              continue
            }

            // ── Image render branch ────────────────────────────────────────
            // resolvedModality has already taken vision capability and the
            // image-reading setting into account; checking it here is enough.
            if (resolvedModality === 'image') {
              // Mirror text-mode semantics where it makes sense:
              //   - `full`  → render every page (matches "full = whole file").
              //   - targeted read with maxLines → render that many pages.
              //   - targeted read without endLine/maxLines → render only
              //     startLine. This gives the model a cheap peek that returns
              //     totalPages before it asks for a precise range.
              const reqStart =
                operation.type === 'lines' ? operation.startLine : 1
              const reqEnd =
                operation.type === 'lines'
                  ? (operation.endLine ??
                    (operation.maxLines !== undefined
                      ? operation.startLine + operation.maxLines - 1
                      : operation.startLine))
                  : undefined

              let renderResult: Awaited<
                ReturnType<typeof renderPdfPagesToImages>
              >
              try {
                renderResult = await renderPdfPagesToImages(
                  app,
                  file,
                  reqStart,
                  reqEnd,
                  settings,
                )
              } catch (error) {
                results.push({
                  path,
                  ok: false,
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Failed to render PDF pages as images.',
                })
                continue
              }

              const { totalPages, rendered } = renderResult
              const rangeStartPage = reqStart
              const rangeEndPageInclusive =
                reqEnd === undefined ? totalPages : Math.min(reqEnd, totalPages)
              const returnedCount = rendered.length
              const returnedStartLine =
                returnedCount > 0 ? rangeStartPage : null
              const returnedEndLine =
                returnedCount > 0 ? rangeEndPageInclusive : null
              const hasMoreBelow = rangeEndPageInclusive < totalPages
              const nextStartLine = hasMoreBelow
                ? rangeEndPageInclusive + 1
                : null

              results.push({
                path,
                ok: true,
                totalLines: totalPages,
                returnedRange: {
                  startLine: returnedStartLine,
                  endLine: returnedEndLine,
                },
                hasMoreBelow,
                nextStartLine,
                content: '',
                ...wikilinkResultFields,
                ...(subpathWarning ? { warning: subpathWarning } : {}),
              })

              if (rendered.length > 0) {
                perFileAttachmentParts.push({
                  path,
                  parts: rendered.map((r) => ({
                    type: 'image_url' as const,
                    image_url: {
                      url: r.dataUrl,
                      cacheKey: buildPdfPageImageCacheKey(
                        file.path,
                        file.stat.mtime,
                        file.stat.size,
                        r.page,
                      ),
                    },
                  })),
                })
              }
              continue
            }

            // MinerU 优先：开关开且接口可用时 PDF 先转 md + 图片（取代文本提取）。
            // 范围语义：仅 full 模式走 MinerU（返回整份 md，无分页语义）；
            // lines 范围请求保持分页语义（行号 = 页号），由下方 legacy 路径处理。
            if (operation.type === 'full') {
              let mineruResult: Awaited<
                ReturnType<typeof readPdfViaMinerU>
              > | null = null
              try {
                mineruResult = await readPdfViaMinerU({
                  app,
                  file,
                  settings,
                  signal,
                  includeImages: chatModelAcceptsImages,
                })
              } catch (mineruErr) {
                if (
                  mineruErr instanceof DOMException &&
                  mineruErr.name === 'AbortError'
                ) {
                  return { status: ToolCallResponseStatus.Aborted }
                }
                throw mineruErr
              }
              if (mineruResult) {
                // MinerU 一次性返回整份 md，无分页语义；行号 = md 行数。
                const totalLines =
                  mineruResult.markdown.length === 0
                    ? 0
                    : mineruResult.markdown.split('\n').length
                results.push({
                  path,
                  ok: true,
                  totalLines,
                  hasMoreBelow: false,
                  nextStartLine: null,
                  content: mineruResult.markdown,
                  effectiveModality: 'text' as const,
                  ...wikilinkResultFields,
                  ...(subpathWarning ? { warning: subpathWarning } : {}),
                })
                if (mineruResult.imageParts.length > 0) {
                  perFileAttachmentParts.push({
                    path,
                    parts: mineruResult.imageParts,
                  })
                }
                continue
              }
            } // end: operation.type === 'full'（MinerU 仅 full 模式）

            let pages: { page: number; text: string }[] = []
            try {
              const extracted = await extractPdfText(app, file, {
                signal,
                maxBinaryBytes: PDF_INDEX_MAX_BYTES,
                maxPages: PDF_INDEX_MAX_PAGES,
                settings,
              })
              pages = extracted.pages
            } catch (error) {
              if (
                error instanceof DOMException &&
                error.name === 'AbortError'
              ) {
                return { status: ToolCallResponseStatus.Aborted }
              }
              results.push({
                path,
                ok: false,
                error:
                  error instanceof Error
                    ? error.message
                    : 'Failed to extract PDF text.',
              })
              continue
            }

            const totalPageCount = pages.length
            let rangeStartPage = 1
            let rangeEndPageInclusive = totalPageCount
            if (operation.type === 'lines') {
              rangeStartPage = operation.startLine
              // PDF defaults to a single page when neither endLine nor
              // maxLines is provided — a PDF page carries far more content
              // than a markdown line. Explicit maxLines counts pages.
              rangeEndPageInclusive = Math.min(
                operation.endLine ??
                  (operation.maxLines !== undefined
                    ? rangeStartPage + operation.maxLines - 1
                    : rangeStartPage),
                totalPageCount,
              )
              if (rangeEndPageInclusive < rangeStartPage) {
                results.push({
                  path,
                  ok: false,
                  error: 'endLine must be greater than or equal to startLine.',
                })
                continue
              }
              if (
                rangeEndPageInclusive - rangeStartPage + 1 >
                MAX_READ_MAX_LINES
              ) {
                results.push({
                  path,
                  ok: false,
                  error: `Requested page range is too large. Maximum ${MAX_READ_MAX_LINES} pages per file.`,
                })
                continue
              }
            }

            const selectedPages = pages.filter(
              (p) =>
                p.page >= rangeStartPage && p.page <= rangeEndPageInclusive,
            )

            const taggedBody = selectedPages
              .map((p) => `<page ${p.page}>\n${p.text}\n</page ${p.page}>`)
              .join('\n')
            if (taggedBody.length > MAX_FILE_SIZE_BYTES) {
              results.push({
                path,
                ok: false,
                error: `Extracted PDF text too large (${taggedBody.length} chars). Max allowed is ${MAX_FILE_SIZE_BYTES}.`,
              })
              continue
            }

            // PDF 场景下 line 语义 = 页号。不做 `${index+1}|` 前缀，避免
            // 与 returnedRange（页号）语义错位，LLM 可直接依赖 <page N> 标签定位。
            const totalLines = totalPageCount
            const outputContent = taggedBody
            const returnedCount = selectedPages.length
            const returnedStartLine = returnedCount > 0 ? rangeStartPage : null
            const returnedEndLine =
              returnedCount > 0 ? rangeEndPageInclusive : null
            const hasMoreBelow =
              operation.type === 'lines' &&
              rangeEndPageInclusive < totalPageCount
            const nextStartLine = hasMoreBelow
              ? rangeEndPageInclusive + 1
              : null

            // When an explicit modality request was silently re-mapped to
            // text by the resolver, mark `effectiveModality` so callers /
            // log readers can observe the divergence between requested and
            // executed mode. Default (undefined) lands here too — but we
            // only emit the marker when there's an actual divergence.
            //
            // Two visible divergences trigger metadata:
            //   - 'image' on text-only model → text (caller asked for image
            //     but the model can't do vision). Carries a model-visible
            //     warning so the model knows its visual request was lost.
            //   - 'pdf' on non-PDF model → text (caller asked for native
            //     PDF, model doesn't support it). No warning text — the
            //     downgrade is the system's choice, not something the model
            //     should try to "correct" by asking again.
            const visionDowngraded =
              operation.modality === 'image' && !chatModelAcceptsImages
            const pdfDowngraded =
              operation.modality === 'pdf' && !chatModelAcceptsPdf

            results.push({
              path,
              ok: true,
              totalLines,
              returnedRange:
                operation.type === 'lines'
                  ? {
                      startLine: returnedStartLine,
                      endLine: returnedEndLine,
                    }
                  : undefined,
              hasMoreBelow,
              nextStartLine,
              content: outputContent,
              ...(visionDowngraded
                ? {
                    effectiveModality: 'text' as const,
                    warning: subpathWarning
                      ? `当前模型不支持图像输入，已自动降级为文本读取 ${subpathWarning}`
                      : '当前模型不支持图像输入，已自动降级为文本读取',
                  }
                : pdfDowngraded
                  ? {
                      effectiveModality: 'text' as const,
                      ...(subpathWarning ? { warning: subpathWarning } : {}),
                    }
                  : subpathWarning
                    ? { warning: subpathWarning }
                    : {}),
              ...wikilinkResultFields,
            })
            continue
          }

          const officeKind = getOfficeDocumentKindFromExtension(file.extension)
          if (officeKind) {
            if (file.stat.size > OFFICE_READ_MAX_BYTES) {
              results.push({
                path,
                ok: false,
                error: `Office document too large (${file.stat.size} bytes).`,
              })
              continue
            }

            try {
              const rawBuf = await app.vault.readBinary(file)
              const parsed = await parseOfficeDocument(rawBuf, officeKind)
              const content = parsed.markdown
              const lines = content.length === 0 ? [] : content.split('\n')
              const sliced = sliceLinesForFsReadOperation(lines, operation)

              results.push({
                path,
                ok: true,
                totalLines: sliced.totalLines,
                returnedRange:
                  operation.type === 'lines'
                    ? {
                        startLine: sliced.returnedStartLine,
                        endLine: sliced.returnedEndLine,
                      }
                    : undefined,
                hasMoreBelow: sliced.hasMoreBelow,
                nextStartLine: sliced.nextStartLine,
                content: sliced.outputContent,
                ...wikilinkResultFields,
                ...(subpathWarning ? { warning: subpathWarning } : {}),
              })
            } catch (error) {
              results.push({
                path,
                ok: false,
                error:
                  error instanceof Error
                    ? error.message
                    : typeof error === 'string'
                      ? error
                      : JSON.stringify(error),
              })
            }
            continue
          }

          if (file.stat.size > MAX_FILE_SIZE_BYTES) {
            results.push({
              path,
              ok: false,
              error: `File too large (${file.stat.size} bytes).`,
            })
            continue
          }

          // A subpath resolved from wikilink fallback only takes effect for
          // a `full` read — an explicit startLine/endLine/maxLines from the
          // caller always wins and the subpath is used only to locate the
          // file.
          const effectiveOperation: FsReadOperation =
            resolvedSubpath && operation.type === 'full'
              ? {
                  type: 'lines',
                  startLine: resolvedSubpath.startLine,
                  endLine: resolvedSubpath.endLine,
                  modality: operation.modality,
                  format: operation.format,
                }
              : operation

          const rawContent = await app.vault.read(file)
          const content = rawContent
          const lines = content.length === 0 ? [] : content.split('\n')
          const sliced = sliceLinesForFsReadOperation(lines, effectiveOperation)
          const outputContent = sliced.outputContent
          const rawSelected = sliced.rawSelected

          const wikilinks =
            file.extension === 'md' && rawSelected.length > 0
              ? collectWikilinkPaths(app, rawSelected, file.path)
              : []

          results.push({
            path,
            ok: true,
            totalLines: sliced.totalLines,
            returnedRange:
              effectiveOperation.type === 'lines'
                ? {
                    startLine: sliced.returnedStartLine,
                    endLine: sliced.returnedEndLine,
                  }
                : undefined,
            hasMoreBelow: sliced.hasMoreBelow,
            nextStartLine: sliced.nextStartLine,
            content: outputContent,
            ...(wikilinks.length > 0 ? { wikilinks } : {}),
            ...wikilinkResultFields,
            ...(subpathWarning ? { warning: subpathWarning } : {}),
          })

          // Extract images from markdown files using the outputContent
          // (which is the line-numbered text that was actually returned)
          if (
            chatModelAcceptsImages &&
            (settings?.chatOptions?.imageReadingEnabled ?? true) &&
            file.extension === 'md' &&
            outputContent.length > 0
          ) {
            const imageResult = await extractMarkdownImages(
              app,
              outputContent,
              file.path,
              {
                compression: {
                  enabled:
                    settings?.chatOptions?.imageCompressionEnabled ?? true,
                  quality: settings?.chatOptions?.imageCompressionQuality ?? 85,
                },
                cache: { enabled: true, settings },
                externalUrl: {
                  enabled:
                    settings?.chatOptions?.externalImageFetchEnabled ?? false,
                },
              },
            )
            if (imageResult.contentParts) {
              perFileAttachmentParts.push({
                path,
                parts: imageResult.contentParts,
              })
            }
          }
        }

        const textResult = formatJsonResult({
          toolCallId: toolCallId ?? null,
          // Echo the requested modality so the model can compare it against
          // each result's `effectiveModality` (only set when we forcibly
          // downgrade image→text because the model lacks vision capability).
          requestedOperation: {
            type: operation.type,
            modality: operation.modality,
          },
          results,
        })

        // contentParts only carries image payloads — the request builder
        // filters to image_url parts and ignores any text entries here, so we
        // skip building per-file text headers that would just be discarded.
        // The text JSON (above) is the source of truth for paths/ranges.
        const contentParts: ContentPart[] | undefined =
          perFileAttachmentParts.length > 0
            ? perFileAttachmentParts.flatMap((p) => p.parts)
            : undefined

        const firstReadableResult = results[0]?.ok ? results[0] : undefined
        const isPdf =
          typeof firstReadableResult?.path === 'string' &&
          firstReadableResult.path.toLowerCase().endsWith('.pdf')
        const fsReadOperation: ToolFsReadOperationSummary | undefined = (() => {
          if (!firstReadableResult) {
            return undefined
          }
          if (operation.type === 'full') {
            return {
              type: 'full',
              isPdf,
              ...(readSkillNames.length === paths.length
                ? { skillNames: readSkillNames }
                : {}),
            }
          }
          const returnedRange = firstReadableResult.returnedRange
          if (
            typeof returnedRange?.startLine !== 'number' ||
            typeof returnedRange.endLine !== 'number'
          ) {
            return undefined
          }
          return {
            type: 'lines',
            startLine: returnedRange.startLine,
            endLine: returnedRange.endLine,
            isPdf,
            ...(readSkillNames.length === paths.length
              ? { skillNames: readSkillNames }
              : {}),
          }
        })()

        return {
          status: ToolCallResponseStatus.Success,
          text: textResult,
          contentParts,
          metadata: fsReadOperation ? { fsReadOperation } : undefined,
        }
      }

      case 'fs_edit': {
        const path = validateVaultPath(getTextArg(args, 'path'))
        const plan = getFsEditPlan(args)

        const file = app.vault.getAbstractFileByPath(path)
        if (!file || !(file instanceof TFile)) {
          throw new Error(`File not found: ${path}`)
        }
        if (file.stat.size > MAX_EDIT_FILE_SIZE_BYTES) {
          throw new Error(`File too large (${file.stat.size} bytes).`)
        }

        const content = await app.vault.read(file)
        const materialized = materializeTextEditPlan({
          content,
          plan,
        })

        if (materialized.errors.length > 0) {
          const replaceFailure = materialized.failures?.find(
            (failure) =>
              failure.operation.type === 'replace' &&
              failure.kind === 'no_match',
          )
          if (replaceFailure && replaceFailure.operation.type === 'replace') {
            throw new Error(
              `${path}: ${buildReplaceMatchErrorHint({
                content,
                oldText: replaceFailure.operation.oldText,
              })}`,
            )
          }
          throw new Error(`${path}: ${materialized.errors[0]}`)
        }

        const nextContent = materialized.newContent

        if (nextContent.length > MAX_EDIT_FILE_SIZE_BYTES) {
          throw new Error(
            `Content too large (${nextContent.length} chars). Max allowed is ${MAX_EDIT_FILE_SIZE_BYTES}.`,
          )
        }

        let appliedContent = nextContent
        let reviewResultSummary: NonNullable<ApplyViewResult['review']> | null =
          null

        if (requireReview) {
          if (!openApplyReview) {
            throw new Error('Apply review is unavailable for fs_edit.')
          }

          const reviewResult = await waitForFsEditReview({
            openApplyReview,
            file,
            originalContent: content,
            newContent: nextContent,
            reviewEdits: materialized.reviewEdits,
            selectionRange: getFsEditSelectionRange(
              content,
              materialized.operationResults,
            ),
            signal,
          })

          if (reviewResult.status === ToolCallResponseStatus.Aborted) {
            return reviewResult
          }
          if (reviewResult.status === ToolCallResponseStatus.Rejected) {
            return {
              status: ToolCallResponseStatus.Rejected,
              reason: buildFsEditRejectedReason(),
            }
          }

          appliedContent = reviewResult.finalContent
          reviewResultSummary = reviewResult.review
        } else {
          await maybeWithInternalWrite(promptSourceWatcher, path, () =>
            app.vault.modify(file, nextContent),
          )
        }

        const appliedAt = Date.now()
        // MAX_FILE_SIZE_BYTES 作为"快照阈值"：当编辑前或编辑后的内容超过阈值时，
        // 跳过 undo/review 快照与 diff（避免把超大内容读进快照存储），与 fs_write
        // 覆盖超大文件时的行为对齐。必须同时看 before(content) 与 after(appliedContent)，
        // 因为小文件也可能被编辑后膨胀到阈值以上。
        const overSized =
          content.length > MAX_FILE_SIZE_BYTES ||
          appliedContent.length > MAX_FILE_SIZE_BYTES
        const metadata = overSized
          ? undefined
          : await buildFileChangeSummary({
              app,
              settings,
              path,
              beforeContent: content,
              afterContent: appliedContent,
              beforeExists: true,
              afterExists: true,
              conversationId,
              roundId,
              toolCallId,
              appliedAt,
            })

        const resultPayload = reviewResultSummary
          ? {
              tool: 'fs_edit',
              path,
              changed: content !== appliedContent,
              review: buildFsEditReviewPayload(reviewResultSummary),
              message:
                reviewResultSummary.rejectedChanges.length > 0
                  ? 'Explicit user decision: the listed change was rejected in the review UI. This is not an edit or matching failure. Do not retry it with another locator or tool this turn; acknowledge the decision and wait for the user.'
                  : 'Applied reviewed edit.',
            }
          : {
              tool: 'fs_edit',
              path,
              totalOperations: materialized.totalOperations,
              appliedCount: materialized.appliedCount,
              operationResults: materialized.operationResults.map((result) => ({
                type: result.operation.type,
                changed: result.changed,
                actualOccurrences: result.actualOccurrences,
                matchMode: result.matchMode,
              })),
              changed: content !== appliedContent,
              message: overSized
                ? 'Applied edit (content too large for undo snapshot).'
                : 'Applied edit.',
            }

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult(resultPayload),
          metadata,
        }
      }

      case 'fs_write': {
        const path = normalizePath(getTextArg(args, 'path'))
        return maybeWithInternalWrite(promptSourceWatcher, path, () =>
          executeFsFileOps({
            app,
            settings,
            action: 'write',
            item: {
              path,
              content: getTextArg(args, 'content'),
            },
            signal,
            tool: 'fs_write',
            conversationId,
            roundId,
            toolCallId,
          }),
        )
      }

      case 'mineru_convert': {
        // 显式按需转换（与 fs_read/RAG/附件的隐式路径互补）：输入 PDF +
        // 目标目录 → 转换结果落盘到 outputDir，返回写入清单。无缓存——协议层
        // 直接转换，落盘方式与 mineruCacheStore.writeCache 一致（vault adapter）。
        if (!isMinerUEnabled(settings) || !settings?.mineru) {
          throw new Error(
            'MinerU is not enabled or not configured in settings.',
          )
        }
        const inputPath = validateVaultPath(getTextArg(args, 'inputPath'))
        const outputDir = validateVaultPath(getTextArg(args, 'outputDir'))

        const file = app.vault.getAbstractFileByPath(inputPath)
        if (!file || !(file instanceof TFile)) {
          throw new Error(`File not found: ${inputPath}`)
        }
        if ((file.extension ?? '').toLowerCase() !== 'pdf') {
          throw new Error(`Not a PDF file: ${inputPath}`)
        }

        const pdfBytes = await app.vault.readBinary(file)
        const raw: MinerURawConversionResult = await convertPdfToMarkdown({
          pdfBytes,
          fileName: file.name,
          baseUrl: settings.mineru.baseUrl,
          apiKey: settings.mineru.apiKey,
          signal,
        })
        if (signal?.aborted) {
          return { status: ToolCallResponseStatus.Aborted }
        }

        // Once output starts, finish the set so cancellation cannot leave a
        // new markdown file paired with only part of its images.
        await ensureFolderPathExists(app, `${outputDir}/images`)
        const resultPath = normalizePath(`${outputDir}/result.md`)
        const adapter = app.vault.adapter
        await adapter.write(resultPath, raw.markdown)
        const imageFiles: string[] = []
        for (const image of raw.images) {
          const vaultPath = normalizePath(`${outputDir}/images/${image.name}`)
          await adapter.writeBinary(vaultPath, toArrayBuffer(image.data))
          imageFiles.push(vaultPath)
        }
        return {
          status: ToolCallResponseStatus.Success,
          text: JSON.stringify({
            markdownFiles: [resultPath],
            imageFiles,
          }),
        }
      }

      case BASH_TOOL_NAME: {
        const command = getTextArg(args, 'command')
        const lease = await acquireRuntimeComponent('bash-engine')
        try {
          const fs = createVaultBashFileSystem(
            app,
            workspacePolicyToUpstreamScope(workspaceAccessPolicy),
            settings,
          )
          const confirmDangerousOperation = async (
            kind: DangerousBashOperationKind,
            targets: readonly string[],
          ): Promise<boolean> => {
            // 'full_access': nothing to gate. 'require_approval': the whole
            // call was already approved before execution started (see
            // tool-gateway.ts's pre-call gate) — asking again mid-script
            // would be redundant. Only the default 'dangerous_only' tier (and
            // any unrecognized value, failing toward the safer behavior)
            // pauses here.
            if (
              bashApprovalMode === 'full_access' ||
              bashApprovalMode === 'require_approval'
            ) {
              return true
            }
            // No addressable tool call to attach an approval card to (should
            // not happen in practice — every real dispatch has a toolCallId).
            // Fail closed rather than silently allowing a destructive op.
            if (!toolCallId) return false
            return requestDangerousBashApproval(toolCallId, kind, targets)
          }
          const session = lease.api.createSession({
            fs,
            confirmDangerousOperation,
            search: createVaultBashSearch({
              app,
              settings,
              getRagEngine,
              workspaceScope: workspacePolicyToUpstreamScope(
                workspaceAccessPolicy,
              ),
              signal,
              registry: runContext?.citationRegistry,
            }),
            signal,
            readOnly: bashReadOnly ?? false,
          })
          const onAbort = (): void => {
            if (toolCallId) cancelDangerousBashApproval(toolCallId)
          }
          signal?.addEventListener('abort', onAbort)
          try {
            const result = await session.exec(command)
            return {
              status: ToolCallResponseStatus.Success,
              text: formatJsonResult({
                tool: BASH_TOOL_NAME,
                exit_code: result.exitCode,
                stdout: truncateBashOutputForContext(
                  result.stdout,
                  VAULT_BASH_STDOUT_BUDGET,
                ),
                stderr: truncateBashOutputForContext(
                  result.stderr,
                  VAULT_BASH_STDERR_BUDGET,
                ),
              }),
            }
          } finally {
            signal?.removeEventListener('abort', onAbort)
            session.dispose()
          }
        } finally {
          lease.release()
        }
      }

      case 'meta_search': {
        if (signal?.aborted) {
          return { status: ToolCallResponseStatus.Aborted }
        }
        const meta = getTextArg(args, 'meta').trim()
        const maxResults = getOptionalIntegerArg({
          args,
          key: 'maxResults',
          defaultValue: 20,
          min: 1,
          max: 300,
        })
        let results
        try {
          results = searchFilesByMetadataDsl(app, meta, {
            maxResults,
            isReadablePath: (path) =>
              isReadablePathSafe(path, workspaceAccessPolicy),
          })
        } catch (error) {
          throw formatMetadataDslError(error)
        }
        // The DSL search is synchronous; check again so an abort observed
        // during the search still surfaces as Aborted instead of a result.
        if (signal?.aborted) {
          return { status: ToolCallResponseStatus.Aborted }
        }
        const MAX_RESULT_CHARS = 12_000
        const zeroHints = buildZeroResultHints(meta)
        const wantsTable = /^\s*table\b/i.test(meta)

        if (wantsTable) {
          const tableText =
            results.length === 0
              ? zeroHints.length > 0
                ? zeroHints.join('\n')
                : 'No rows matched.'
              : buildMetadataResultTable(results)
          const { text, truncated } = formatBoundedTextResult(
            tableText,
            MAX_RESULT_CHARS,
          )
          return {
            status: ToolCallResponseStatus.Success,
            text,
            ...(truncated && {
              metadata: {
                truncated: {
                  totalBytes: truncated.totalBytes,
                  omittedBytes: truncated.omittedBytes,
                },
              },
            }),
          }
        }

        const resultKind = results[0]?.kind ?? null
        const strippedResults = results.map((hit) =>
          hit.kind === 'file'
            ? {
                path: hit.path,
                matchedKeys: hit.matchedKeys,
                metadata: hit.metadata,
              }
            : { key: hit.key, values: hit.values },
        )
        const { text, truncated } = formatBoundedJsonResult(
          {
            tool: 'meta_search',
            ...(resultKind && { resultKind }),
            results: strippedResults,
            ...(results.length === 0 &&
              zeroHints.length > 0 && { hint: zeroHints }),
          },
          MAX_RESULT_CHARS,
        )
        return {
          status: ToolCallResponseStatus.Success,
          text,
          ...(truncated && {
            metadata: {
              truncated: {
                totalBytes: truncated.totalBytes,
                omittedBytes: truncated.omittedBytes,
              },
            },
          }),
        }
      }

      case 'web_search': {
        if (!settings) {
          throw new Error('Web search is unavailable: settings not loaded.')
        }
        const query = getTextArg(args, 'query').trim()
        if (!query) {
          throw new Error('query cannot be empty.')
        }
        const topic = getOptionalTextArg(args, 'topic')?.trim() || undefined
        const result = await runWebSearch({
          settings: settings.webSearch,
          query,
          topic,
          signal,
        })
        const itemsWithIndex = result.items.map((it, idx) => ({
          id: it.id,
          index: idx + 1,
          title: it.title,
          url: it.url,
          text: it.text,
        }))
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'web_search',
            provider: result.providerName,
            answer: result.answer,
            items: itemsWithIndex,
          }),
        }
      }

      case 'web_scrape': {
        if (!settings) {
          throw new Error('Web scrape is unavailable: settings not loaded.')
        }
        const url = getTextArg(args, 'url').trim()
        if (!url) {
          throw new Error('url cannot be empty.')
        }
        const result = await runWebScrape({
          settings: settings.webSearch,
          url,
          signal,
        })
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'web_scrape',
            provider: result.providerName,
            url: result.url,
            title: result.title,
            content: result.content,
          }),
        }
      }

      case JS_SANDBOX_TOOL_NAME: {
        const jsSandboxSettings = getJsSandboxSettings(settings)
        const proxyHandlers = buildJsSandboxProxyHandlers(
          app,
          jsSandboxSettings,
          getRagEngine,
          settings,
        )
        return callJsSandboxTool({
          app,
          args,
          signal,
          jsSandboxSettings,
          proxyHandlers,
        })
      }

      case 'memory_add': {
        if (args.items !== undefined) {
          const items = getRecordArrayArg(args, 'items')
          if (items.length === 0) {
            throw new Error('items cannot be empty.')
          }

          const results: Array<
            | {
                ok: true
                id: string
                scope: MemoryScope
                filePath: string
              }
            | {
                ok: false
                error: string
                scope: MemoryScope
              }
          > = []

          for (const item of items) {
            try {
              const result = await invokeMemoryTool(
                promptSourceWatcher,
                (hooks) =>
                  memoryAdd({
                    app,
                    settings,
                    content: item.content,
                    category: item.category,
                    scope: item.scope ?? args.scope,
                    assistantId: settings?.currentAssistantId,
                    ...hooks,
                  }),
              )
              results.push({
                ok: true,
                id: result.id,
                scope: result.scope,
                filePath: result.filePath,
              })
            } catch (error) {
              results.push({
                ok: false,
                error: asErrorMessage(error),
                scope:
                  typeof (item.scope ?? args.scope) === 'string' &&
                  String(item.scope ?? args.scope)
                    .trim()
                    .toLowerCase() === 'global'
                    ? 'global'
                    : 'assistant',
              })
            }
          }

          return {
            status: ToolCallResponseStatus.Success,
            text: formatJsonResult({
              tool: 'memory_add',
              mode: 'batch',
              results,
              okCount: results.filter((result) => result.ok).length,
              failCount: results.filter((result) => !result.ok).length,
            }),
          }
        }

        if (args.content === undefined) {
          throw new Error('content or items is required.')
        }

        const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
          memoryAdd({
            app,
            settings,
            content: args.content,
            category: args.category,
            scope: args.scope,
            assistantId: settings?.currentAssistantId,
            ...hooks,
          }),
        )

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'memory_add',
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
          }),
        }
      }

      case 'memory_update': {
        const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
          memoryUpdate({
            app,
            settings,
            id: args.id,
            newContent: args.new_content,
            scope: args.scope,
            assistantId: settings?.currentAssistantId,
            ...hooks,
          }),
        )

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'memory_update',
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
          }),
        }
      }

      case 'memory_delete': {
        if (args.ids !== undefined) {
          const ids = getStringArrayArg(args, 'ids')
          if (ids.length === 0) {
            throw new Error('ids cannot be empty.')
          }

          const results: Array<
            | {
                ok: true
                id: string
                scope: MemoryScope
                filePath: string
              }
            | {
                ok: false
                id: string
                error: string
                scope: MemoryScope
              }
          > = []

          for (const id of ids) {
            try {
              const result = await invokeMemoryTool(
                promptSourceWatcher,
                (hooks) =>
                  memoryDelete({
                    app,
                    settings,
                    id,
                    scope: args.scope,
                    assistantId: settings?.currentAssistantId,
                    ...hooks,
                  }),
              )
              results.push({
                ok: true,
                id: result.id,
                scope: result.scope,
                filePath: result.filePath,
              })
            } catch (error) {
              results.push({
                ok: false,
                id,
                error: asErrorMessage(error),
                scope:
                  typeof args.scope === 'string' &&
                  args.scope.trim().toLowerCase() === 'global'
                    ? 'global'
                    : 'assistant',
              })
            }
          }

          return {
            status: ToolCallResponseStatus.Success,
            text: formatJsonResult({
              tool: 'memory_delete',
              mode: 'batch',
              results,
              okCount: results.filter((result) => result.ok).length,
              failCount: results.filter((result) => !result.ok).length,
            }),
          }
        }

        if (args.id === undefined) {
          throw new Error('id or ids is required.')
        }

        const result = await invokeMemoryTool(promptSourceWatcher, (hooks) =>
          memoryDelete({
            app,
            settings,
            id: args.id,
            scope: args.scope,
            assistantId: settings?.currentAssistantId,
            ...hooks,
          }),
        )

        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult({
            tool: 'memory_delete',
            id: result.id,
            scope: result.scope,
            filePath: result.filePath,
          }),
        }
      }

      case 'delegate_subagent': {
        if (!subagentParentContext) {
          throw new Error(
            'delegate_subagent is only available during an active parent agent run.',
          )
        }
        if (!conversationId) {
          throw new Error('conversationId is required for delegate_subagent.')
        }

        // 连续超时熔断 gate（pre localFileTools.ts:6264/6272 语义）：本会话的
        // breaker 打开期间，拒绝派发一个可辨识的结果（accepted: false +
        // blocked: true），而不是 spawn 子代理。父 runtime 为本 pending 调用
        // 注册的 deadline 一并清理——子代理从未 spawn，计时器不能事后触发
        // 注入虚假超时。registry 经动态 import，与 Task 8 的接线形态一致
        // （madge 对动态 import 计边，本计划已决策接受新增环，Task 12-15
        // 完成后统一断环）。
        const {
          SUBAGENT_DELEGATION_BLOCKED_REASON,
          clearParentSubagentDeadline,
          isParentSubagentDelegationBlocked,
        } = await import('../agent/subagent/pending-timeout-registry')
        if (isParentSubagentDelegationBlocked(conversationId)) {
          if (toolCallId) clearParentSubagentDeadline(toolCallId)
          return {
            status: ToolCallResponseStatus.Success,
            text: JSON.stringify({
              accepted: false,
              status: 'blocked',
              blocked: true,
              reason: SUBAGENT_DELEGATION_BLOCKED_REASON,
            }),
          }
        }

        const description = getTextArg(args, 'description').trim()
        const taskPrompt = getTextArg(args, 'prompt').trim()
        if (!settings) {
          throw new Error('settings are required for delegate_subagent.')
        }
        let composedPrompt = taskPrompt
        let projectTask: ProjectTaskBinding | undefined
        if (args.projectTask !== undefined) {
          projectTask = parseProjectTaskBinding(args.projectTask)
          const store = new ProjectStore({
            getSettings: () => settings,
            adapter: app.vault.adapter,
          })
          const versioned = await store.readTask(
            projectTask.projectId,
            projectTask.taskId,
          )
          if (!versioned) {
            throw new Error(
              `Project task not found: ${projectTask.projectId}/${projectTask.taskId}`,
            )
          }
          if (
            versioned.revision !== projectTask.expectedRevision ||
            versioned.contentHash !== projectTask.expectedContentHash
          ) {
            throw new Error(
              `Project task ${projectTask.taskId} changed since it was read; re-read it via the project tool.`,
            )
          }
          const review =
            (args.projectTask as { review?: boolean } | undefined)?.review ===
            true
          if (review) {
            if (versioned.task.status !== 'awaiting_review') {
              throw new Error(
                `Project task ${projectTask.taskId} is not awaiting_review; it cannot be reviewed.`,
              )
            }
            const taskBody = (
              await store.readTaskBody(
                projectTask.projectId,
                projectTask.taskId,
              )
            ).trim()
            const deliveries: string[] = []
            for (const ref of versioned.task.deliveryRefs) {
              // deliveryRefs carry a trailing `.md`; the store appends its own
              // `.md` when resolving the artifact path, so strip the suffix to
              // avoid looking for a double-extension file (`run.md.md`).
              const runKey = (ref.split('/').pop() ?? '').replace(/\.md$/, '')
              const artifact = await store.readDeliveryArtifact(
                projectTask.projectId,
                projectTask.taskId,
                runKey,
              )
              if (artifact) deliveries.push(artifact)
            }
            const history = (versioned.task.reviewHistory ?? [])
              .map((r) => `${r.decision} (${r.at}): ${r.comments.join('; ')}`)
              .join('\n')
            composedPrompt = buildReviewPrompt({
              task: versioned.task,
              body: taskBody,
              delivery: deliveries.join('\n\n---\n\n'),
              history,
            })
            // A review run does not claim/bind the task: the parent records the
            // verdict itself via the project tool.
            projectTask = undefined
          } else {
            assertProjectTaskDispatchable(versioned.task)
            const taskBody = (
              await store.readTaskBody(
                projectTask.projectId,
                projectTask.taskId,
              )
            ).trim()
            composedPrompt = buildProjectTaskPrompt(
              versioned.task,
              taskBody,
              taskPrompt,
            )
          }
        }
        const delegatedRoleId =
          getOptionalTextArg(args, 'delegatedRoleId')?.trim() ?? ''
        const modelPreferenceId =
          getOptionalTextArg(args, 'modelPreferenceId')?.trim() ?? ''

        // forkContext 三档校验（pre localFileTools.ts:6381-6395 语义）：none（默认，
        // 子代理只见 prompt，与今天逐字节一致）/ last_turns（最近
        // getForkContextTurns() 轮父消息）/ full（全文按 24_000 字符截断）。类型
        // 就地声明，不从 subagent/types 静态/type 导入（Task 8 修复轮 2 已清零
        // localFileTools → subagent 的导入边）。守卫用 `!== undefined`（而非
        // truthiness）：空串/纯空白经 trim 后为 `''`，同样非法——与 backup 一致
        // 抛错让模型纠正，而不是静默落入 full 分支注入父全文（Task 14 审查
        // 发现 1 修复）。
        const requestedForkContext = getOptionalTextArg(
          args,
          'forkContext',
        )?.trim()
        if (
          requestedForkContext !== undefined &&
          !['none', 'last_turns', 'full'].includes(requestedForkContext)
        ) {
          throw new Error(
            'forkContext must be "none", "last_turns", or "full".',
          )
        }
        const forkContext: 'none' | 'last_turns' | 'full' =
          (requestedForkContext as
            | 'none'
            | 'last_turns'
            | 'full'
            | undefined) ?? 'none'

        // 全部 subagent 依赖走动态 import——madge 对静态与 type-only 导入都计边，
        // localFileTools → subagent/* 会经 tool-preferences 回流成环（deps:check
        // 棘轮基线 271，38 组新增环全部由此造成）。类型一律从动态 import 绑定
        // 推导，不引入任何 subagent 模块的静态/type-only 导入边。
        const { runSubagent } = await import('../agent/subagent/runner')
        type LocalRunSubagentParams = Parameters<typeof runSubagent>[0]

        // 委托角色路径：delegatedRoleId → Task 2 的 profile 覆盖模型/工具/loop/
        // request context；解析失败（不存在/不可委托/模型不可用）由 resolver 抛错，
        // undefined 返回按未知角色拒绝。
        let delegatedProfile: LocalRunSubagentParams['delegatedProfile']
        let selectedModelId: string
        if (delegatedRoleId) {
          const { resolveDelegatedAssistantProfile } = await import(
            '../agent/subagent/delegated-assistant-profile'
          )
          const profile = await resolveDelegatedAssistantProfile({
            app,
            settings,
            assistantId: delegatedRoleId,
            parentWorkspacePolicy: subagentParentContext.workspaceAccessPolicy,
            // 签名用结构子集（requestContextBuilder: unknown）声明，此处按
            // resolver 参数真实类型收窄（resolver 现将其标为 _ 前缀暂不使用）。
            parentRequestContextBuilder:
              subagentParentContext.requestContextBuilder as Parameters<
                typeof resolveDelegatedAssistantProfile
              >[0]['parentRequestContextBuilder'],
          })
          if (!profile) {
            throw new Error(`Unknown delegated role "${delegatedRoleId}".`)
          }
          delegatedProfile = profile
          selectedModelId = profile.modelId
        } else {
          // 通用路径：modelPreferenceId 是本次派发的模型偏好，优先于既有的
          // modelId 参数，仍须在子代理模型池内。
          const requestedModelId =
            modelPreferenceId ||
            (getOptionalTextArg(args, 'modelId')?.trim() ?? '')
          const { resolveSubagentModelConfig } = await import(
            '../agent/subagent/model-config'
          )
          const subagentModelConfig = resolveSubagentModelConfig(settings)
          if (subagentModelConfig.allowedModelIds.length === 0) {
            throw new Error(
              'No registered chat models are configured for delegate_subagent.',
            )
          }
          if (
            requestedModelId &&
            !subagentModelConfig.allowedModelIds.includes(requestedModelId)
          ) {
            throw new Error(
              `Model "${requestedModelId}" is not allowed for delegate_subagent.`,
            )
          }
          selectedModelId =
            requestedModelId || subagentModelConfig.preferredModelId
          if (!selectedModelId) {
            throw new Error(
              'No preferred chat model is configured for delegate_subagent.',
            )
          }
        }
        const { getChatModelClient } = await import('../llm/manager')
        const selectedModelClient = getChatModelClient({
          settings,
          modelId: selectedModelId,
        })
        const selectedProvider = settings.providers.find(
          (provider) => provider.id === selectedModelClient.model.providerId,
        )

        let assistantMessageId = ''
        if (conversationMessages) {
          for (let i = conversationMessages.length - 1; i >= 0; i--) {
            const m = conversationMessages[i]
            if (m.role === 'assistant') {
              assistantMessageId = m.id
              break
            }
          }
        }

        // 纯 ephemeral 派发（去 durable 化）：不再 spawn/续接持久会话——
        // 每次 delegate_subagent 都启动一个全新子代理（Task 14 的 forkContext
        // 仍把父上下文只读快照并入 child 初始 prompt）。
        const accepted = await runSubagent({
          description,
          prompt: composedPrompt,
          conversationId,
          source: {
            type: 'llm_tool_call',
            toolCallId: toolCallId ?? '',
            assistantMessageId,
          },
          // 签名结构子集按 runner 的 parent 参数真实类型收窄（调用方总是传入
          // 完整 SubagentParentContext，运行时无差异）。forkContext 由本工具参数
          // 解析后并入 parent 上下文（Task 14：runner 在组合 child 初始 prompt 时
          // 从 parent.forkContext 读取）。
          parent: {
            ...subagentParentContext,
            forkContext,
          } as LocalRunSubagentParams['parent'],
          childModel: {
            providerClient: selectedModelClient.providerClient,
            model: selectedModelClient.model,
            apiType: selectedProvider?.apiType ?? null,
          },
          signal,
          ...(delegatedProfile ? { delegatedProfile } : {}),
          ...(projectTask ? { projectTask } : {}),
        })

        if (projectTask) {
          // Backfill the claim's runKey with the real subagent run id. The
          // claim is made before dispatch with a placeholder runKey (the
          // `sub_*` id only materializes inside runSubagent); re-keying it
          // keeps delivery ingestion and the liveness probe matched by the
          // real run id — otherwise every delivery appends a duplicate
          // attempt. Never fail the dispatch over a failed backfill (the run
          // already started); the ingester's append fallback still records
          // the outcome.
          const backfillStore = new ProjectStore({
            getSettings: () => settings,
            adapter: app.vault.adapter,
          })
          const backfill = await backfillStore.backfillClaimRunKey(
            projectTask.projectId,
            projectTask.taskId,
            {
              expectedRevision: projectTask.expectedRevision,
              expectedContentHash: projectTask.expectedContentHash,
            },
            accepted.taskId,
          )
          if (!backfill.ok) {
            console.warn(
              `[YOLO] claim runKey backfill failed for ${projectTask.taskId}: ${backfill.message}`,
            )
          }
        }

        return {
          status: ToolCallResponseStatus.Success,
          text: JSON.stringify(accepted),
        }
      }

      case 'project_ops': {
        if (!settings) {
          return {
            status: ToolCallResponseStatus.Error,
            error: 'Settings are not available.',
          }
        }
        const store = new ProjectStore({
          getSettings: () => settings,
          adapter: app.vault.adapter,
        })
        const tool = new ProjectTool(store)
        try {
          // Fail fast on unknown/mis-shapen actions instead of letting the
          // dispatch fall through to an arbitrary handler (previously an
          // unknown action silently reached `review`).
          const capability = resolveConsolidatedAction('project_ops', args)
          validateConsolidatedAction(capability, args)
          let result: unknown
          switch (capability.action) {
            case 'init':
              result = await tool.init(args as Parameters<typeof tool.init>[0])
              break
            case 'get':
              result = await tool.get(args as Parameters<typeof tool.get>[0])
              break
            case 'status':
              result = await tool.status(getTextArg(args, 'projectId'))
              break
            case 'update':
              result = await tool.update(
                args as Parameters<typeof tool.update>[0],
              )
              break
            case 'review':
              result = await tool.review(
                args as Parameters<typeof tool.review>[0],
              )
              break
            default:
              // Unreachable: resolve+validate reject unknown actions above.
              // Kept for parity with scheduled_task_ops.
              throw new Error(
                `Unsupported project_ops action: ${capability.action}`,
              )
          }
          return {
            status: ToolCallResponseStatus.Success,
            text: JSON.stringify(result),
          }
        } catch (error) {
          return {
            status: ToolCallResponseStatus.Error,
            error: error instanceof Error ? error.message : String(error),
          }
        }
      }

      case 'scheduled_task_ops': {
        const service = getScheduledTasksService?.()
        if (!service) {
          throw new Error('Scheduled tasks service is not available.')
        }
        const action = getTextArg(args, 'action')
        switch (action) {
          case 'create':
            return await executeScheduledTaskCreate({
              service,
              args,
              tool: 'scheduled_task_ops',
              action: 'create',
            })
          case 'update':
            return await executeScheduledTaskUpdate({
              service,
              args,
              tool: 'scheduled_task_ops',
              action: 'update',
            })
          case 'delete':
            return await executeScheduledTaskDelete({
              service,
              args,
              tool: 'scheduled_task_ops',
              action: 'delete',
            })
          case 'list':
            return await executeScheduledTaskList({
              service,
              args,
              tool: 'scheduled_task_ops',
              action: 'list',
            })
          case 'get':
            return await executeScheduledTaskGet({
              service,
              args,
              tool: 'scheduled_task_ops',
              action: 'get',
            })
          case 'run_now':
            return await executeScheduledTaskRunNow({
              service,
              args,
              tool: 'scheduled_task_ops',
              action: 'run_now',
            })
          default:
            throw new Error(`Unsupported scheduled_task_ops action: ${action}`)
        }
      }

      case TERMINAL_COMMAND_TOOL_NAME: {
        const { runBash } = await import('../agent/bash/index')

        let assistantMessageId = ''
        if (conversationMessages) {
          for (let i = conversationMessages.length - 1; i >= 0; i--) {
            const m = conversationMessages[i]
            if (m.role === 'assistant') {
              assistantMessageId = m.id
              break
            }
          }
        }

        let cwd = getOptionalTextArg(args, 'cwd')?.trim() ?? ''
        if (!cwd) {
          const adapter = app.vault.adapter
          if (adapter instanceof FileSystemAdapter) {
            cwd = adapter.getBasePath()
          }
        }

        const result = await runBash({
          command: getOptionalTextArg(args, 'command'),
          sessionId: getOptionalBoundedIntegerArg({
            args,
            key: 'session_id',
            min: 1,
            max: Number.MAX_SAFE_INTEGER,
          }),
          input: getOptionalTextArg(args, 'input'),
          background: getOptionalBooleanArg(args, 'background') ?? false,
          cwd: cwd || undefined,
          timeoutSeconds: getOptionalBoundedIntegerArg({
            args,
            key: 'timeout',
            min: 1,
            max: 600,
          }),
          tailLines: getOptionalBoundedIntegerArg({
            args,
            key: 'tail_lines',
            min: 1,
            max: 10_000,
          }),
          tailBytes: getOptionalBoundedIntegerArg({
            args,
            key: 'tail_bytes',
            min: 1,
            max: 1_048_576,
          }),
          kill: getOptionalBooleanArg(args, 'kill') ?? false,
          signal,
          conversationId,
          source:
            conversationId && toolCallId && assistantMessageId
              ? {
                  type: 'llm_tool_call',
                  toolCallId,
                  assistantMessageId,
                }
              : undefined,
        })

        const exitOk =
          result.exit_code === undefined ||
          result.exit_code === null ||
          result.exit_code === 0
        const text = JSON.stringify(
          {
            session_id: result.session_id,
            state: result.state,
            exit_code: result.exit_code,
            stdout: result.stdout,
            stderr: result.stderr,
          },
          null,
          2,
        )

        if (!exitOk) {
          return {
            status: ToolCallResponseStatus.Error,
            error: `Exit code ${result.exit_code}. Output:\n${text}`,
          }
        }

        return {
          status: ToolCallResponseStatus.Success,
          text,
          metadata: result.truncated
            ? { truncated: result.truncated }
            : undefined,
        }
      }

      case LOAD_TOOL_SCHEMAS_LOCAL_TOOL_NAME: {
        throw new Error(
          'load_tool_schemas is only available through the Agent runtime.',
        )
      }

      case 'todo_write': {
        return executeTodoWrite({ args })
      }

      case 'send_attachment': {
        // Result status directly gates `scanForSendAttachment` (see
        // `message-converter.ts`): it only ever inspects `request.arguments`
        // for calls whose `response.status === Success`, so a failed
        // validation MUST return `Error` here — returning `Success` with an
        // `ok: false` payload would make the dispatcher try to send a file
        // that was never actually validated/allowed.
        const path = getOptionalTextArg(args, 'path')
        if (!path || path.trim() === '') {
          return {
            status: ToolCallResponseStatus.Error,
            error: 'path is required.',
          }
        }
        const validation = validateAttachmentPath(path, {
          isAllowed: (normalizedPath) =>
            isReadablePathSafe(normalizedPath, workspaceAccessPolicy),
        })
        if (!validation.ok) {
          return {
            status: ToolCallResponseStatus.Error,
            error: validation.error,
          }
        }
        return {
          status: ToolCallResponseStatus.Success,
          text: JSON.stringify({ ok: true, path: validation.normalizedPath }),
        }
      }

      default:
        if (isInjectedBridgeToolName(normalizeLocalToolName(toolName))) {
          const result = await callInjectedBridgeTool(
            normalizeLocalToolName(toolName),
            args,
          )
          return {
            status: ToolCallResponseStatus.Success,
            text:
              typeof result === 'string'
                ? result
                : JSON.stringify(result, null, 2),
          }
        }
        throw new Error(`Unknown local file tool: ${toolName}`)
    }
  } catch (error) {
    return {
      status: ToolCallResponseStatus.Error,
      error: asErrorMessage(error),
    }
  }
}

const getOptionalStringArrayArg = (
  args: Record<string, unknown>,
  key: string,
): string[] | undefined => {
  const value = args[key]
  if (value === undefined) {
    return undefined
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`${key} must be an array of strings.`)
  }
  const normalized = [
    ...new Set(value.map((item) => item.trim()).filter(Boolean)),
  ]
  if (normalized.length > 64) {
    throw new Error(`${key} cannot contain more than 64 tools.`)
  }
  return normalized
}

const withResultAction = <T extends Record<string, unknown>>(
  action: string | undefined,
  payload: T,
): Record<string, unknown> =>
  action === undefined ? payload : { ...payload, action }

const getScheduledTaskNotifyOnArg = (
  args: Record<string, unknown>,
): ('success' | 'failure')[] => {
  if (args.notifyOn === undefined) {
    return []
  }
  const values = getStringArrayArg(args, 'notifyOn')
  for (const value of values) {
    if (value !== 'success' && value !== 'failure') {
      throw new Error('notifyOn entries must be "success" or "failure".')
    }
  }
  return values as ('success' | 'failure')[]
}

const executeScheduledTaskCreate = async ({
  service,
  args,
  tool,
  action,
}: {
  service: ScheduledTaskServiceLike
  args: Record<string, unknown>
  tool: string
  action?: string
}): Promise<LocalToolCallResult> => {
  const name = getOptionalTextArg(args, 'name')?.trim()
  if (!name) throw new Error('name is required.')

  const scheduleType = getOptionalTextArg(args, 'scheduleType')
  if (
    scheduleType !== 'once' &&
    scheduleType !== 'cron' &&
    scheduleType !== 'interval'
  ) {
    throw new Error('scheduleType must be one of "once", "cron", "interval".')
  }

  const agentPrompt = getOptionalTextArg(args, 'agentPrompt')?.trim()
  if (!agentPrompt) throw new Error('agentPrompt is required.')

  const assistantId = getOptionalTextArg(args, 'assistantId')?.trim()
  const requestedToolNames = getOptionalStringArrayArg(
    args,
    'requestedToolNames',
  )
  const agentConfig: ScheduledTaskAgentConfig | null =
    assistantId || requestedToolNames?.length
      ? {
          ...(assistantId ? { assistantId } : {}),
          ...(requestedToolNames?.length
            ? { temporaryApprovedToolNames: requestedToolNames }
            : {}),
        }
      : null

  const config: TaskConfig = {
    name,
    type: 'agent',
    createdBy: 'agent',
    scheduleType,
    cronExpression: getOptionalTextArg(args, 'cronExpression') ?? null,
    intervalSeconds:
      getOptionalBoundedIntegerArg({
        args,
        key: 'intervalSeconds',
        min: 1,
        max: 31_536_000,
      }) ?? null,
    oneTimeDateTime:
      getOptionalBoundedIntegerArg({
        args,
        key: 'oneTimeDateTime',
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      }) ?? null,
    nextRunTime: null,
    scriptPath: null,
    agentPrompt,
    agentConfig,
    queueGroup: null,
    dependsOn: null,
    continueOnDependencyFailure: false,
    priority: getOptionalIntegerArg({
      args,
      key: 'priority',
      defaultValue: 5,
      min: 1,
      max: 10,
    }),
    timeoutSeconds: getOptionalIntegerArg({
      args,
      key: 'timeoutSeconds',
      defaultValue: 300,
      min: 1,
      max: 3600,
    }),
    maxRetries: getOptionalIntegerArg({
      args,
      key: 'maxRetries',
      defaultValue: 3,
      min: 0,
      max: 10,
    }),
    enabled: getOptionalBooleanArg(args, 'enabled') ?? true,
    notifyOn: getScheduledTaskNotifyOnArg(args),
  }

  const task = await service.createTask(config)
  return {
    status: ToolCallResponseStatus.Success,
    text: formatJsonResult(withResultAction(action, { tool, task })),
  }
}

const executeScheduledTaskUpdate = async ({
  service,
  args,
  tool,
  action,
}: {
  service: ScheduledTaskServiceLike
  args: Record<string, unknown>
  tool: string
  action?: string
}): Promise<LocalToolCallResult> => {
  const id = getOptionalTextArg(args, 'id')?.trim()
  if (!id) throw new Error('id is required.')

  const patch: Partial<TaskConfig> = {}
  const existingTask =
    args.requestedToolNames !== undefined && args.assistantId === undefined
      ? await service.getTask(id)
      : null

  if (args.name !== undefined) {
    const name = getOptionalTextArg(args, 'name')?.trim()
    if (!name) throw new Error('name cannot be empty.')
    patch.name = name
  }
  if (args.scheduleType !== undefined) {
    const scheduleType = getOptionalTextArg(args, 'scheduleType')
    if (
      scheduleType !== 'once' &&
      scheduleType !== 'cron' &&
      scheduleType !== 'interval'
    ) {
      throw new Error('scheduleType must be one of "once", "cron", "interval".')
    }
    patch.scheduleType = scheduleType
  }
  if (args.cronExpression !== undefined) {
    patch.cronExpression = getOptionalTextArg(args, 'cronExpression') ?? null
  }
  if (args.intervalSeconds !== undefined) {
    patch.intervalSeconds =
      getOptionalBoundedIntegerArg({
        args,
        key: 'intervalSeconds',
        min: 1,
        max: 31_536_000,
      }) ?? null
  }
  if (args.oneTimeDateTime !== undefined) {
    patch.oneTimeDateTime =
      getOptionalBoundedIntegerArg({
        args,
        key: 'oneTimeDateTime',
        min: 0,
        max: Number.MAX_SAFE_INTEGER,
      }) ?? null
  }
  if (args.agentPrompt !== undefined) {
    const agentPrompt = getOptionalTextArg(args, 'agentPrompt')?.trim()
    if (!agentPrompt) throw new Error('agentPrompt cannot be empty.')
    patch.agentPrompt = agentPrompt
  }
  if (args.assistantId !== undefined) {
    const assistantId = getOptionalTextArg(args, 'assistantId')?.trim()
    const requestedToolNames =
      args.requestedToolNames === undefined
        ? undefined
        : getOptionalStringArrayArg(args, 'requestedToolNames')
    patch.agentConfig =
      assistantId || requestedToolNames?.length
        ? {
            ...(assistantId ? { assistantId } : {}),
            ...(requestedToolNames?.length
              ? { temporaryApprovedToolNames: requestedToolNames }
              : {}),
          }
        : null
  } else if (args.requestedToolNames !== undefined) {
    const requestedToolNames = getOptionalStringArrayArg(
      args,
      'requestedToolNames',
    )
    patch.agentConfig = requestedToolNames?.length
      ? {
          ...(existingTask?.agentConfig?.assistantId
            ? { assistantId: existingTask.agentConfig.assistantId }
            : {}),
          temporaryApprovedToolNames: requestedToolNames,
        }
      : null
  }
  if (args.priority !== undefined) {
    patch.priority = getOptionalIntegerArg({
      args,
      key: 'priority',
      defaultValue: 5,
      min: 1,
      max: 10,
    })
  }
  if (args.timeoutSeconds !== undefined) {
    patch.timeoutSeconds = getOptionalIntegerArg({
      args,
      key: 'timeoutSeconds',
      defaultValue: 300,
      min: 1,
      max: 3600,
    })
  }
  if (args.maxRetries !== undefined) {
    patch.maxRetries = getOptionalIntegerArg({
      args,
      key: 'maxRetries',
      defaultValue: 3,
      min: 0,
      max: 10,
    })
  }
  if (args.notifyOn !== undefined) {
    patch.notifyOn = getScheduledTaskNotifyOnArg(args)
  }
  if (args.enabled !== undefined) {
    const enabled = getOptionalBooleanArg(args, 'enabled')
    if (enabled !== undefined) patch.enabled = enabled
  }

  await service.updateTask(id, patch)
  const task = await service.getTask(id)
  return {
    status: ToolCallResponseStatus.Success,
    text: formatJsonResult(withResultAction(action, { tool, task })),
  }
}

const executeScheduledTaskDelete = async ({
  service,
  args,
  tool,
  action,
}: {
  service: ScheduledTaskServiceLike
  args: Record<string, unknown>
  tool: string
  action?: string
}): Promise<LocalToolCallResult> => {
  const id = getOptionalTextArg(args, 'id')?.trim()
  if (!id) throw new Error('id is required.')

  await service.deleteTask(id)
  return {
    status: ToolCallResponseStatus.Success,
    text: formatJsonResult(
      withResultAction(action, { tool, id, deleted: true }),
    ),
  }
}

const executeScheduledTaskList = async ({
  service,
  args,
  tool,
  action,
}: {
  service: ScheduledTaskServiceLike
  args: Record<string, unknown>
  tool: string
  action?: string
}): Promise<LocalToolCallResult> => {
  const enabled = getOptionalBooleanArg(args, 'enabled')
  const tasks = await service.listTasks(
    enabled !== undefined ? { enabled } : undefined,
  )
  return {
    status: ToolCallResponseStatus.Success,
    text: formatJsonResult(
      withResultAction(action, { tool, tasks, count: tasks.length }),
    ),
  }
}

const executeScheduledTaskGet = async ({
  service,
  args,
  tool,
  action,
}: {
  service: ScheduledTaskServiceLike
  args: Record<string, unknown>
  tool: string
  action?: string
}): Promise<LocalToolCallResult> => {
  const id = getOptionalTextArg(args, 'id')?.trim()
  if (!id) throw new Error('id is required.')

  const task = await service.getTask(id)
  return {
    status: ToolCallResponseStatus.Success,
    text: formatJsonResult(withResultAction(action, { tool, task })),
  }
}

const executeScheduledTaskRunNow = async ({
  service,
  args,
  tool,
  action,
}: {
  service: ScheduledTaskServiceLike
  args: Record<string, unknown>
  tool: string
  action?: string
}): Promise<LocalToolCallResult> => {
  const id = getOptionalTextArg(args, 'id')?.trim()
  if (!id) throw new Error('id is required.')

  const result = await service.executeTaskNow(id)
  return {
    status: ToolCallResponseStatus.Success,
    text: formatJsonResult(withResultAction(action, { tool, result })),
  }
}

function executeTodoWrite({
  args,
}: {
  args: Record<string, unknown>
}): LocalToolCallResult {
  const rawTodos = args.todos
  if (!Array.isArray(rawTodos)) {
    return {
      status: ToolCallResponseStatus.Error,
      error: 'todos must be an array.',
    }
  }

  const todos: TodoItem[] = []
  for (let i = 0; i < rawTodos.length; i++) {
    const item = rawTodos[i]
    if (typeof item !== 'object' || item === null) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}] must be an object.`,
      }
    }
    const { content, status } = item as Record<string, unknown>
    if (typeof content !== 'string' || content.trim() === '') {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}].content must be a non-empty string.`,
      }
    }
    if (
      status !== 'pending' &&
      status !== 'in_progress' &&
      status !== 'completed'
    ) {
      return {
        status: ToolCallResponseStatus.Error,
        error: `todos[${i}].status must be "pending", "in_progress", or "completed".`,
      }
    }
    todos.push({ content, status })
  }

  const inProgressCount = todos.filter((t) => t.status === 'in_progress').length
  if (inProgressCount > 1) {
    return {
      status: ToolCallResponseStatus.Error,
      error: `At most one todo may be in_progress at a time, but ${inProgressCount} were provided.`,
    }
  }

  return {
    status: ToolCallResponseStatus.Success,
    text: 'Todos updated. Continue tracking your progress with the todo list.',
  }
}
const parseProjectTaskBinding = (value: unknown): ProjectTaskBinding => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('projectTask must be an object.')
  }
  const { projectId, taskId, expectedRevision, expectedContentHash } =
    value as Record<string, unknown>
  if (
    typeof projectId !== 'string' ||
    projectId.length === 0 ||
    typeof taskId !== 'string' ||
    taskId.length === 0 ||
    typeof expectedRevision !== 'number' ||
    typeof expectedContentHash !== 'string'
  ) {
    throw new Error(
      'projectTask requires projectId, taskId, expectedRevision, and expectedContentHash.',
    )
  }
  return { projectId, taskId, expectedRevision, expectedContentHash }
}

const buildProjectTaskPrompt = (
  task: TaskRecord,
  taskBody: string,
  userPrompt: string,
): string => {
  const lines: Array<string | null> = [
    `# Project task: ${task.taskId} — ${task.title}`,
    `Status: ${task.status}`,
    task.dependencies.length > 0
      ? `Dependencies: ${task.dependencies.join(', ')}`
      : null,
    task.acceptanceCriteria.length > 0
      ? `Acceptance criteria:\n${task.acceptanceCriteria
          .map((criteria) => `- ${criteria}`)
          .join('\n')}`
      : null,
    taskBody ? `## Task background\n\n${taskBody}` : null,
    `## Assignment\n\n${userPrompt}`,
    `## Reporting`,
    `When you finish, end with a short report covering:`,
    `- what you completed and how you verified it (tests run, evidence);`,
    `- the files you created or modified;`,
    `- anything you could not finish or that needs human review.`,
    `This report is recorded as the delivery for this task, so keep it accurate and self-contained.`,
  ]
  return lines.filter((line): line is string => line !== null).join('\n\n')
}
