import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { defineTool } from '../define'
import { getOptionalTextArg, getTextArg } from '../tool-args'

const PROJECT_OPS_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Manage durable project and task files under the host-managed Projects directory (parent-only; this is the sole way to read/write project/task state - those files are excluded from the normal fs tools). Pass action plus the action-specific fields: action="init" creates a project, "get" reads one task (taskId present) or lists tasks (status filter), "status" returns the project summary + signals (reclaimed, concurrent_running, all_terminal), "update" applies a patch or claims a task for a run (requires expectedRevision/expectedContentHash from a prior get), "review" records an approved/rework/escalated decision with evidence.',
  inputSchema: {
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
        description: 'Optional project overview written to project.md.',
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
      taskId: { type: 'string' },
      status: {
        type: 'array',
        description: 'get filter when listing tasks.',
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
        description: 'Revision from a prior get; required for update.',
      },
      expectedContentHash: {
        type: 'string',
        description: 'Content hash from a prior get; required for update.',
      },
      patch: {
        type: 'object',
        description: 'Metadata or status patch for update.',
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
          'Claim the task for a delegated run. The same runKey renews the lease.',
        properties: {
          runKey: { type: 'string' },
          durationMs: { type: 'number' },
        },
        required: ['runKey'],
      },
      decision: {
        type: 'string',
        enum: ['approved', 'rework', 'escalated'],
      },
      evidence: {
        type: 'array',
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
      comments: { type: 'array', items: { type: 'string' } },
    },
    required: ['action'],
  },
}

const getArg = (args: Record<string, unknown>, key: string): unknown =>
  args[key] === null ? undefined : args[key]

const hasAny = (args: Record<string, unknown>, keys: string[]): boolean =>
  keys.some((key) => getArg(args, key) !== undefined)

const validateProjectOpsAction = (
  action: string,
  args: Record<string, unknown>,
): void => {
  switch (action) {
    case 'init':
      if (getArg(args, 'projectName') === undefined) {
        throw new Error('init requires projectName')
      }
      if (
        hasAny(args, [
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
      return
    case 'get':
      if (getArg(args, 'projectId') === undefined) {
        throw new Error('get requires projectId')
      }
      if (
        hasAny(args, [
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
      return
    case 'status':
      if (getArg(args, 'projectId') === undefined) {
        throw new Error('status requires projectId')
      }
      if (hasAny(args, ['taskId', 'tasks', 'patch', 'claim', 'decision'])) {
        throw new Error('status accepts only projectId')
      }
      return
    case 'update': {
      if (
        getArg(args, 'projectId') === undefined ||
        getArg(args, 'taskId') === undefined ||
        getArg(args, 'expectedRevision') === undefined ||
        getArg(args, 'expectedContentHash') === undefined
      ) {
        throw new Error(
          'update requires projectId, taskId, expectedRevision, expectedContentHash',
        )
      }
      const hasPatch = getArg(args, 'patch') !== undefined
      const hasClaim = getArg(args, 'claim') !== undefined
      if (hasPatch === hasClaim) {
        throw new Error('update requires exactly one of patch or claim')
      }
      if (
        hasAny(args, [
          'decision',
          'evidence',
          'comments',
          'projectName',
          'overview',
          'tasks',
        ])
      ) {
        throw new Error('update rejects review / init fields')
      }
      return
    }
    case 'review':
      if (
        getArg(args, 'projectId') === undefined ||
        getArg(args, 'taskId') === undefined ||
        getArg(args, 'decision') === undefined
      ) {
        throw new Error('review requires projectId, taskId, decision')
      }
      if (
        hasAny(args, [
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
      }
      return
    default:
      throw new Error(`Unsupported project_ops action: ${action}`)
  }
}

export const projectOpsDefinition = defineTool({
  name: 'project_ops',
  getMcpTool: () => PROJECT_OPS_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinProjectOpsLabel',
    fallback: 'Project Management Toolset',
  },
  contextPrunable: true,
  execute: async (args, ctx) => {
    const tool = ctx.getProjectTool?.()
    if (!tool) throw new Error('Project tool is not available.')
    const action = getOptionalTextArg(args, 'action')
    if (!action) throw new Error('action is required.')
    validateProjectOpsAction(action, args)
    let result: unknown
    switch (action) {
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
        result = await tool.update(args as Parameters<typeof tool.update>[0])
        break
      case 'review':
        result = await tool.review(args as Parameters<typeof tool.review>[0])
        break
    }
    return {
      status: ToolCallResponseStatus.Success,
      text: JSON.stringify(result),
    }
  },
})
