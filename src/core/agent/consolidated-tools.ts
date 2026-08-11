// src/core/agent/consolidated-tools.ts
import type { McpTool } from '../../types/mcp.types'

export const CONSOLIDATED_TOOLS = [
  'context_manage',
  'fs_file_ops',
  'memory_ops',
  'scheduled_task_ops',
  'browser_ops',
  'project_ops',
] as const
export type ConsolidatedToolName = (typeof CONSOLIDATED_TOOLS)[number]

/**
 * The action set each consolidated tool advertises. Kept here (single source of
 * truth) so the schema builder, the settings UI, and the model-facing tool
 * list stay in lockstep with the migration's capability keys.
 */
export const CONSOLIDATED_TOOL_ACTIONS: Record<
  ConsolidatedToolName,
  readonly string[]
> = {
  context_manage: ['compact', 'prune'],
  fs_file_ops: ['delete', 'create_dir', 'move'],
  memory_ops: ['add', 'update', 'delete'],
  scheduled_task_ops: ['create', 'update', 'delete', 'list', 'get', 'run_now'],
  browser_ops: ['scroll', 'navigate', 'click', 'type'],
  project_ops: ['init', 'get', 'status', 'update', 'review'],
}

export type BuiltinToolCapability = {
  toolName: ConsolidatedToolName
  action: string
}

export const capabilityKey = ({
  toolName,
  action,
}: BuiltinToolCapability): string => `${toolName}:${action}`

export const LEGACY_TOOL_TO_CAPABILITY: Record<string, string> = {
  context_compact: 'context_manage:compact',
  context_prune_tool_results: 'context_manage:prune',
  fs_delete: 'fs_file_ops:delete',
  fs_create_dir: 'fs_file_ops:create_dir',
  fs_move: 'fs_file_ops:move',
  memory_add: 'memory_ops:add',
  memory_update: 'memory_ops:update',
  memory_delete: 'memory_ops:delete',
  scheduled_task_create: 'scheduled_task_ops:create',
  scheduled_task_update: 'scheduled_task_ops:update',
  scheduled_task_delete: 'scheduled_task_ops:delete',
  scheduled_task_list: 'scheduled_task_ops:list',
  scheduled_task_get: 'scheduled_task_ops:get',
  scheduled_task_run_now: 'scheduled_task_ops:run_now',
  browser_scroll: 'browser_ops:scroll',
  browser_navigate: 'browser_ops:navigate',
  browser_click: 'browser_ops:click',
  browser_type: 'browser_ops:type',
}

const getArg = (args: Record<string, unknown>, key: string): unknown =>
  args[key] === null ? undefined : args[key] // strict providers send null for absent optionals
const hasAny = (args: Record<string, unknown>, keys: string[]): boolean =>
  keys.some((k) => getArg(args, k) !== undefined)

const validators: Record<
  string,
  Record<string, (args: Record<string, unknown>) => void>
> = {
  context_manage: {
    compact: (a) => {
      if (hasAny(a, ['mode', 'toolCallIds']))
        throw new Error('compact rejects mode/toolCallIds')
    },
    prune: (a) => {
      if (getArg(a, 'instruction') !== undefined)
        throw new Error('prune rejects instruction')
      if (getArg(a, 'mode') === undefined || getArg(a, 'mode') === 'selected') {
        if (
          !Array.isArray(getArg(a, 'toolCallIds')) ||
          (getArg(a, 'toolCallIds') as unknown[]).length === 0
        ) {
          throw new Error('selected prune requires non-empty toolCallIds')
        }
      }
    },
  },
  fs_file_ops: {
    delete: (a) => {
      if (getArg(a, 'path') === undefined)
        throw new Error('delete requires path')
      if (hasAny(a, ['oldPath', 'newPath']))
        throw new Error('delete rejects oldPath/newPath')
    },
    create_dir: (a) => {
      if (getArg(a, 'path') === undefined)
        throw new Error('create_dir requires path')
      if (hasAny(a, ['recursive', 'oldPath', 'newPath']))
        throw new Error('create_dir rejects recursive/move fields')
    },
    move: (a) => {
      if (
        getArg(a, 'oldPath') === undefined ||
        getArg(a, 'newPath') === undefined
      ) {
        throw new Error('move requires oldPath and newPath')
      }
      if (hasAny(a, ['path', 'recursive']))
        throw new Error('move rejects path/recursive')
    },
  },
  memory_ops: {
    // When `operations` is present, reject standalone action fields; each batch
    // entry is validated against the same per-action rules below and the batch
    // gates approval as one unit (hermes-agent precedent).
    batch: (a) => {
      if (
        !Array.isArray(getArg(a, 'operations')) ||
        (getArg(a, 'operations') as unknown[]).length === 0
      ) {
        throw new Error('operations requires a non-empty array')
      }
      if (
        hasAny(a, [
          'content',
          'items',
          'id',
          'ids',
          'new_content',
          'keywords',
          'category',
        ])
      ) {
        throw new Error('operations rejects standalone action fields')
      }
    },
    add: (a) => {
      const content = getArg(a, 'content')
      const items = getArg(a, 'items')
      const hasContent =
        typeof content === 'string' && content.trim().length > 0
      const hasItems = Array.isArray(items) && items.length > 0
      if (hasContent === hasItems)
        throw new Error(
          'add requires exactly one of content or non-empty items',
        )
      if (hasAny(a, ['operations'])) throw new Error('add rejects operations')
    },
    update: (a) => {
      if (
        getArg(a, 'id') === undefined ||
        getArg(a, 'new_content') === undefined
      ) {
        throw new Error('update requires id and new_content')
      }
      if (hasAny(a, ['items', 'content', 'ids', 'operations']))
        throw new Error('update rejects batch fields')
    },
    delete: (a) => {
      const id = getArg(a, 'id')
      const ids = getArg(a, 'ids')
      const hasId = id !== undefined
      const hasIds = Array.isArray(ids) && ids.length > 0
      if (hasId === hasIds)
        throw new Error('delete requires exactly one of id or non-empty ids')
      if (hasAny(a, ['content', 'items', 'new_content', 'operations']))
        throw new Error('delete rejects add/update fields')
    },
  },
  scheduled_task_ops: {
    create: (a) => {
      if (
        getArg(a, 'name') === undefined ||
        getArg(a, 'scheduleType') === undefined ||
        getArg(a, 'agentPrompt') === undefined
      ) {
        throw new Error('create requires name, scheduleType, agentPrompt')
      }
      const byType: Record<string, string> = {
        once: 'oneTimeDateTime',
        cron: 'cronExpression',
        interval: 'intervalSeconds',
      }
      const required = byType[getArg(a, 'scheduleType') as string]
      if (!required || getArg(a, required) === undefined)
        throw new Error(
          `create for ${getArg(a, 'scheduleType')} requires ${required}`,
        )
    },
    update: (a) => {
      if (getArg(a, 'id') === undefined) throw new Error('update requires id')
    },
    delete: (a) => {
      if (getArg(a, 'id') === undefined) throw new Error('delete requires id')
      if (
        hasAny(a, [
          'name',
          'scheduleType',
          'agentPrompt',
          'cronExpression',
          'intervalSeconds',
          'oneTimeDateTime',
        ])
      ) {
        throw new Error('delete rejects mutation fields')
      }
    },
    get: (a) => {
      if (getArg(a, 'id') === undefined) throw new Error('get requires id')
      if (
        hasAny(a, [
          'name',
          'scheduleType',
          'agentPrompt',
          'cronExpression',
          'intervalSeconds',
          'oneTimeDateTime',
          'requestedToolNames',
          'priority',
          'timeoutSeconds',
          'maxRetries',
          'notifyOn',
          'enabled',
        ])
      ) {
        throw new Error('get rejects mutation fields')
      }
    },
    run_now: (a) => {
      if (getArg(a, 'id') === undefined) throw new Error('run_now requires id')
      if (
        hasAny(a, [
          'name',
          'scheduleType',
          'agentPrompt',
          'cronExpression',
          'intervalSeconds',
          'oneTimeDateTime',
          'requestedToolNames',
          'priority',
          'timeoutSeconds',
          'maxRetries',
          'notifyOn',
          'enabled',
        ])
      ) {
        throw new Error('run_now rejects mutation fields')
      }
    },
    list: (a) => {
      for (const key of Object.keys(a)) {
        if (key !== 'action' && key !== 'enabled')
          throw new Error(`list rejects ${key}`)
      }
    },
  },
  browser_ops: {
    scroll: (a) => {
      if (
        getArg(a, 'pageId') === undefined ||
        getArg(a, 'direction') === undefined
      ) {
        throw new Error('scroll requires pageId and direction')
      }
      if (hasAny(a, ['url', 'selector', 'text', 'replace']))
        throw new Error('scroll rejects navigate/click/type fields')
    },
    navigate: (a) => {
      if (getArg(a, 'pageId') === undefined || getArg(a, 'url') === undefined) {
        throw new Error('navigate requires pageId and url')
      }
      if (hasAny(a, ['direction', 'amount', 'selector', 'text', 'replace']))
        throw new Error('navigate rejects scroll/click/type fields')
    },
    click: (a) => {
      if (
        getArg(a, 'pageId') === undefined ||
        getArg(a, 'selector') === undefined
      ) {
        throw new Error('click requires pageId and selector')
      }
      if (hasAny(a, ['url', 'text', 'replace', 'direction', 'amount']))
        throw new Error('click rejects navigate/type/scroll fields')
    },
    type: (a) => {
      if (
        getArg(a, 'pageId') === undefined ||
        getArg(a, 'selector') === undefined ||
        getArg(a, 'text') === undefined
      ) {
        throw new Error('type requires pageId, selector, and text')
      }
      if (hasAny(a, ['url', 'direction', 'amount']))
        throw new Error('type rejects navigate/scroll fields')
    },
  },
  project_ops: {
    init: (a) => {
      if (getArg(a, 'projectName') === undefined)
        throw new Error('init requires projectName')
      if (
        hasAny(a, [
          'taskId',
          'expectedRevision',
          'expectedContentHash',
          'patch',
          'claim',
          'status',
          'decision',
          'evidence',
          'comments',
        ])
      ) {
        throw new Error('init rejects task-scoped / review fields')
      }
    },
    get: (a) => {
      if (getArg(a, 'projectId') === undefined)
        throw new Error('get requires projectId')
      if (
        hasAny(a, [
          'projectName',
          'overview',
          'tasks',
          'expectedRevision',
          'expectedContentHash',
          'patch',
          'claim',
          'decision',
          'evidence',
          'comments',
        ])
      ) {
        throw new Error('get rejects non-read fields')
      }
    },
    status: (a) => {
      if (getArg(a, 'projectId') === undefined)
        throw new Error('status requires projectId')
      if (hasAny(a, ['taskId', 'tasks', 'patch', 'claim', 'decision'])) {
        throw new Error('status accepts only projectId')
      }
    },
    update: (a) => {
      if (
        getArg(a, 'projectId') === undefined ||
        getArg(a, 'taskId') === undefined ||
        getArg(a, 'expectedRevision') === undefined ||
        getArg(a, 'expectedContentHash') === undefined
      ) {
        throw new Error(
          'update requires projectId, taskId, expectedRevision, expectedContentHash',
        )
      }
      const hasPatch = getArg(a, 'patch') !== undefined
      const hasClaim = getArg(a, 'claim') !== undefined
      if (hasPatch === hasClaim)
        throw new Error('update requires exactly one of patch or claim')
      if (hasAny(a, ['decision', 'evidence', 'comments', 'projectName', 'overview', 'tasks'])) {
        throw new Error('update rejects review / init fields')
      }
    },
    review: (a) => {
      if (
        getArg(a, 'projectId') === undefined ||
        getArg(a, 'taskId') === undefined ||
        getArg(a, 'decision') === undefined
      ) {
        throw new Error('review requires projectId, taskId, decision')
      }
      if (
        hasAny(a, [
          'patch',
          'claim',
          'status',
          'expectedRevision',
          'expectedContentHash',
          'projectName',
          'tasks',
        ])
      ) {
        throw new Error('review rejects patch/claim/init fields')
      }    },
  },
}

export function validateConsolidatedAction(
  c: BuiltinToolCapability,
  args: Record<string, unknown>,
): void {
  const family = validators[c.toolName]
  if (!family) throw new Error(`unknown consolidated tool: ${c.toolName}`)
  const validator = family[c.action]
  if (!validator)
    throw new Error(`unknown action ${c.action} for ${c.toolName}`)
  validator(args)
}

export function resolveConsolidatedAction(
  toolName: string,
  args: unknown,
): BuiltinToolCapability {
  const argRecord = (args ?? {}) as Record<string, unknown>
  const action = argRecord.action
  // memory_ops supports a batch mode: `operations` present with no standalone action.
  if (
    toolName === 'memory_ops' &&
    action === undefined &&
    Array.isArray(argRecord.operations) &&
    (argRecord.operations as unknown[]).length > 0
  ) {
    return { toolName: 'memory_ops', action: 'batch' }
  }
  if (typeof action !== 'string' || action.length === 0) {
    throw new Error(`${toolName} requires a string action`)
  }
  return { toolName: toolName as ConsolidatedToolName, action }
}

/**
 * Build the flat model-facing `inputSchema` objects for the consolidated
 * tools.
 *
 * Baseline: a flat object with every action's fields optional plus strict
 * runtime validation via `validateConsolidatedAction`. Every supported provider
 * adapter forwards `function.parameters` unchanged (Anthropic `input_schema`,
 * OpenAI-compatible `parameters`, Bedrock `inputSchema.json`, Gemini
 * `parametersJsonSchema` after sanitization strips only `additionalProperties`),
 * so a flat object with no top-level combinators is the most portable shape.
 *
 * If this flat baseline is ever insufficient, per-action `oneOf` branches would
 * be required only for adapters whose schema validation demands structural
 * exclusivity — e.g. a provider that rejects cross-action fields outright or
 * needs "exactly one of content|items" expressed in-schema rather than enforced
 * by the runtime validator. Repo precedent: `conversation_history` uses `oneOf`,
 * but existing tests require flat write schemas with no top-level combinators;
 * keep the baseline flat and lean on strict runtime validation.
 *
 * `memory_ops` is the exception to `action` in `required`: batch mode calls with
 * `operations` (and no standalone `action`) must remain representable, and the
 * runtime validator enforces "exactly one of `action` or non-empty `operations`".
 */
export type ConsolidatedToolSchemas = Record<
  ConsolidatedToolName,
  McpTool['inputSchema']
>

export function buildConsolidatedToolSchemas(): ConsolidatedToolSchemas {
  return {
    context_manage: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['compact', 'prune'],
          description:
            "Operation to perform: 'compact' summarizes earlier history into a fresh context window; 'prune' excludes selected historical tool results from future model-visible context.",
        },
        reason: {
          type: 'string',
          description: 'Optional short reason for compacting or pruning.',
        },
        instruction: {
          type: 'string',
          description:
            'Optional focus hint for the summary. Only valid when action is "compact".',
        },
        mode: {
          type: 'string',
          enum: ['selected', 'all'],
          description:
            'Prune mode. Use selected to prune specific toolCallIds, or all to prune all historical prunable tool results.',
        },
        toolCallIds: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Tool call ids to exclude from future prompt context when mode is selected.',
        },
      },
      required: ['action'],
    },
    fs_file_ops: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['delete', 'create_dir', 'move'],
          description:
            "Operation to perform: 'delete' removes a file or folder, 'create_dir' creates a folder, 'move' renames or relocates a path.",
        },
        path: {
          type: 'string',
          description:
            'Vault-relative file or folder path. Used by delete and create_dir.',
        },
        recursive: {
          type: 'boolean',
          description:
            'Folders only (delete). Default false; when false a non-empty folder cannot be deleted. Ignored for files.',
        },
        oldPath: {
          type: 'string',
          description:
            'Vault-relative source path. Only valid when action is "move".',
        },
        newPath: {
          type: 'string',
          description:
            'Vault-relative destination path. Only valid when action is "move".',
        },
      },
      required: ['action'],
    },
    memory_ops: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'update', 'delete'],
          description:
            "Operation to perform: 'add' stores new memory, 'update' rewrites an existing entry by id, 'delete' removes entries by id. Omit action when using the 'operations' batch mode.",
        },
        content: {
          type: 'string',
          description:
            'Memory content text to store (add). Batch adds can also use items instead.',
        },
        items: {
          type: 'array',
          description:
            'Batch add items (add). Each item accepts content, optional category, optional scope, and optional keywords. Mutually exclusive with a standalone content string.',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              category: {
                type: 'string',
                description:
                  'Memory category. Use profile, preferences, or other.',
              },
              scope: {
                type: 'string',
                enum: ['global', 'assistant'],
                description:
                  'Memory scope. Defaults to assistant; use "global" explicitly for global memory.',
              },
              keywords: { type: 'array', items: { type: 'string' } },
            },
            required: ['content'],
          },
        },
        id: {
          type: 'string',
          description:
            'Memory id such as Profile_2 or Memory_4 (update / delete).',
        },
        ids: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Batch delete ids (delete). Each id must exist in the selected memory scope.',
        },
        new_content: {
          type: 'string',
          description: 'Replacement content for the target memory id (update).',
        },
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional concise recall keywords (entities, projects, technologies, or concepts).',
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
            'Memory scope. Defaults to assistant, which requires a current valid assistant and is rejected otherwise. Use scope="global" explicitly for global memory; there is no automatic fallback between scopes.',
        },
        operations: {
          type: 'array',
          description:
            'Batch mode: a non-empty array of per-entry operations. Each entry repeats the action-specific fields (action, content, items, id, ids, new_content, keywords, category, scope). Mutually exclusive with a standalone action and action fields.',
          items: {
            type: 'object',
            properties: {
              action: {
                type: 'string',
                enum: ['add', 'update', 'delete'],
                description:
                  "Operation for this batch entry: 'add', 'update', or 'delete'.",
              },
              content: { type: 'string' },
              items: { type: 'array', items: { type: 'object' } },
              id: { type: 'string' },
              ids: { type: 'array', items: { type: 'string' } },
              new_content: { type: 'string' },
              keywords: { type: 'array', items: { type: 'string' } },
              category: { type: 'string' },
              scope: { type: 'string', enum: ['global', 'assistant'] },
            },
            required: ['action'],
          },
        },
      },
      required: [],
    },
    scheduled_task_ops: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'update', 'delete', 'list', 'get', 'run_now'],
          description:
            "Operation to perform: 'create' registers a new scheduled task, 'update' patches an existing task by id, 'delete' removes a task and its history, 'list' lists tasks, 'get' fetches one task, 'run_now' triggers an immediate run.",
        },
        id: {
          type: 'string',
          description: 'Id of the task to update / delete / get / run now.',
        },
        name: {
          type: 'string',
          description: 'Human-readable task name (create / update).',
        },
        scheduleType: {
          type: 'string',
          enum: ['once', 'cron', 'interval'],
          description:
            'How the task is scheduled. "once" requires oneTimeDateTime, "cron" requires cronExpression, "interval" requires intervalSeconds.',
        },
        cronExpression: {
          type: 'string',
          description:
            'Standard 5-field cron expression (required when scheduleType is "cron").',
        },
        intervalSeconds: {
          type: 'integer',
          description:
            'Seconds between runs (required when scheduleType is "interval").',
        },
        oneTimeDateTime: {
          type: 'integer',
          description:
            'Epoch milliseconds for the single run (required when scheduleType is "once").',
        },
        agentPrompt: {
          type: 'string',
          description:
            'The prompt that is sent to the agent each time this task runs (create / update).',
        },
        assistantId: {
          type: 'string',
          description:
            "Optional assistant id to run the prompt with. Defaults to the user's current default assistant.",
        },
        requestedToolNames: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional tools requested for this task. The user must approve the registration; approved tools are scoped to this task and remain bounded by the selected assistant policy. Replaces the task-scoped tool permissions on update.',
        },
        priority: {
          type: 'integer',
          description: 'Queue priority, 1-10. Higher runs first. Default 5.',
        },
        timeoutSeconds: {
          type: 'integer',
          description: 'Run timeout in seconds. Default 300.',
        },
        maxRetries: {
          type: 'integer',
          description: 'Max automatic retries on failure. Default 3.',
        },
        notifyOn: {
          type: 'array',
          items: { type: 'string', enum: ['success', 'failure'] },
          description:
            'Which outcomes should raise a notification. Defaults to none.',
        },
        enabled: {
          type: 'boolean',
          description: 'Whether the task is active. Defaults to true.',
        },
      },
      required: ['action'],
    },
    browser_ops: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['scroll', 'navigate', 'click', 'type'],
          description:
            "Browser operation: 'scroll' moves an open web page's viewport, 'navigate' loads a URL (https/http only), 'click' clicks a unique visible element, 'type' enters text into a unique editable element (credential/secret fields are hard-blocked and typed text is redacted).",
        },
        pageId: {
          type: 'string',
          description:
            'Exact page_id from <browser_context>, e.g. browser://page_<8 chars>_<8 chars> or page_<8 chars>_<8 chars>. Do not pass a URL.',
        },
        direction: {
          type: 'string',
          enum: ['up', 'down'],
          description: 'Scroll direction (scroll only).',
        },
        amount: {
          type: 'integer',
          minimum: 1,
          maximum: 20000,
          description:
            'Pixels to scroll (scroll only). Defaults to one viewport height when omitted.',
        },
        url: {
          type: 'string',
          description:
            'Absolute destination URL, https:// or http:// (navigate only). URLs with embedded credentials are rejected.',
        },
        waitUntil: {
          type: 'string',
          enum: ['dom_ready', 'load'],
          description:
            'Load state to wait for (navigate only). dom_ready is faster, load (default) waits for the full page.',
        },
        timeoutMs: {
          type: 'integer',
          minimum: 1000,
          maximum: 60000,
          description:
            'Maximum wait for the load state (navigate only). Defaults to 30000.',
        },
        selector: {
          type: 'string',
          description:
            'CSS selector matching exactly one element (click / type). Prefer stable attributes (id, name, aria-label, data-*).',
        },
        text: {
          type: 'string',
          description:
            'Text to type (type only). Treated as transient sensitive data; never echoed back in results.',
        },
        replace: {
          type: 'boolean',
          description:
            'Replace the current value (true) or append to it (false, default). type only.',
        },
      },
      required: ['action'],
    },
    project_ops: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['init', 'get', 'status', 'update', 'review'],
          description: 'Which project operation to perform.',
        },
        projectId: {
          type: 'string',
          description: 'Stable project identifier (vault-relative folder name).',
        },
        projectName: {
          type: 'string',
          description: 'Human-readable project name (init only).',
        },
        overview: {
          type: 'string',
          description: 'Optional project overview written to project.md (init only).',
        },
        tasks: {
          type: 'array',
          description: 'Task drafts for init.',
          items: {
            type: 'object',
            properties: {
              taskId: { type: 'string' },
              title: { type: 'string' },
              dependencies: { type: 'array', items: { type: 'string' } },
              acceptanceCriteria: { type: 'array', items: { type: 'string' } },
              priority: { type: 'string' },
            },
            required: ['taskId', 'title'],
          },
        },
        taskId: {
          type: 'string',
          description: 'Task identifier (get/update/review).',
        },
        status: {
          type: 'array',
          description: 'get filter (list mode).',
          items: {
            type: 'string',
            enum: [
              'pending',
              'in_progress',
              'running',
              'blocked',
              'awaiting_review',
              'completed',
              'rework',
              'cancelled',
            ],
          },
        },
        expectedRevision: {
          type: 'number',
          description: 'Revision from a prior get read; required for update.',
        },
        expectedContentHash: {
          type: 'string',
          description: 'Content hash from a prior get read; required for update.',
        },
        patch: {
          type: 'object',
          description:
            'update: metadata/status patch. blocked requires block_reason {kind: dependency|needs_input|capability|transient, detail?}.',
          properties: {
            status: {
              type: 'string',
              enum: [
                'pending',
                'in_progress',
                'running',
                'blocked',
                'awaiting_review',
                'completed',
                'rework',
                'cancelled',
              ],
            },
            title: { type: 'string' },
            assignee: { type: 'string' },
            dependencies: { type: 'array', items: { type: 'string' } },
            acceptanceCriteria: { type: 'array', items: { type: 'string' } },
            priority: { type: 'string' },
            block_reason: {
              type: 'object',
              properties: {
                kind: {
                  type: 'string',
                  enum: ['dependency', 'needs_input', 'capability', 'transient'],
                },
                detail: { type: 'string' },
              },
              required: ['kind'],
            },
          },
        },
        claim: {
          type: 'object',
          description:
            'update: claim the task for a delegated run (sets status running + lease; same runKey renews). runKey should match the subagent run about to be dispatched.',
          properties: {
            runKey: { type: 'string' },
            durationMs: { type: 'number' },
          },
          required: ['runKey'],
        },
        decision: {
          type: 'string',
          description:
            'review decision. approved requires >=1 evidence; rework requires >=1 comment.',
          enum: ['approved', 'rework', 'escalated'],
        },
        evidence: {
          type: 'array',
          description:
            'review evidence records; approval requires at least one (typically a tool_result referencing the reviewer run).',
          items: {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['test', 'file', 'tool_result', 'human_decision'],
              },
              reference: { type: 'string' },
              summary: { type: 'string' },
              timestamp: { type: 'string' },
            },
            required: ['kind', 'reference', 'summary'],
          },
        },
        comments: {
          type: 'array',
          description: 'review comments; rework requires at least one.',
          items: { type: 'string' },        },
      },
      required: ['action'],
    },
  }
}
