import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import type {
  ScheduledTaskAgentConfig,
  TaskConfig,
} from '../../scheduler/scheduledTasksStore'
import { defineTool } from '../define'
import {
  formatJsonResult,
  getOptionalBoundedIntegerArg,
  getOptionalIntegerArg,
  getOptionalTextArg,
  getStringArrayArg,
} from '../tool-args'
import type { LocalToolCallResult, ScheduledTaskServiceLike } from '../types'

const SCHEDULED_TASK_OPS_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Manage scheduled agent tasks: a prompt that runs automatically once, on an interval, or on a cron schedule. Pass action plus the action-specific fields: action="create" registers a new task, "update" patches a task by id, "delete" removes a task and its run history, "list" lists tasks (optionally filtered by enabled), "get" fetches one task, "run_now" triggers an immediate run subject to queue/concurrency limits.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update', 'delete', 'list', 'get', 'run_now'],
        description:
          "Operation to perform: 'create' registers a new scheduled task, 'update' patches an existing task by id, 'delete' removes a task and its history, 'list' lists tasks, 'get' fetches one task, 'run_now' triggers an immediate run.",
      },
      id: { type: 'string', description: 'Task id.' },
      name: { type: 'string', description: 'Human-readable task name.' },
      scheduleType: {
        type: 'string',
        enum: ['once', 'cron', 'interval'],
        description:
          'How the task is scheduled. once requires oneTimeDateTime, cron requires cronExpression, interval requires intervalSeconds.',
      },
      cronExpression: { type: 'string' },
      intervalSeconds: { type: 'integer' },
      oneTimeDateTime: { type: 'integer' },
      agentPrompt: {
        type: 'string',
        description: 'Prompt sent to the agent each time the task runs.',
      },
      assistantId: { type: 'string' },
      requestedToolNames: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Task-scoped tools requested for this task. Replaces the task-scoped permissions on update.',
      },
      priority: { type: 'integer', description: 'Queue priority, 1-10.' },
      timeoutSeconds: {
        type: 'integer',
        description: 'Run timeout in seconds.',
      },
      maxRetries: {
        type: 'integer',
        description: 'Maximum automatic retries.',
      },
      notifyOn: {
        type: 'array',
        items: { type: 'string', enum: ['success', 'failure'] },
      },
      enabled: { type: 'boolean' },
    },
    required: ['action'],
  },
}

const getOptionalStringArrayArg = (
  args: Record<string, unknown>,
  key: string,
): string[] | undefined => {
  const value = args[key]
  if (value === undefined) return undefined
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

const getOptionalBooleanArg = (
  args: Record<string, unknown>,
  key: string,
): boolean | undefined => {
  const value = args[key]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean.`)
  return value
}

const withResultAction = <T extends Record<string, unknown>>(
  action: string,
  payload: T,
): Record<string, unknown> => ({ ...payload, action })

const getNotifyOn = (
  args: Record<string, unknown>,
): ('success' | 'failure')[] => {
  if (args.notifyOn === undefined) return []
  const values = getStringArrayArg(args, 'notifyOn')
  for (const value of values) {
    if (value !== 'success' && value !== 'failure') {
      throw new Error('notifyOn entries must be "success" or "failure".')
    }
  }
  return values as ('success' | 'failure')[]
}

const requireService = (ctx: {
  getScheduledTasksService?: () => ScheduledTaskServiceLike | null
}): ScheduledTaskServiceLike => {
  const service = ctx.getScheduledTasksService?.()
  if (!service) throw new Error('Scheduled tasks service is not available.')
  return service
}

const buildAgentConfig = (
  assistantId: string | undefined,
  requestedToolNames: string[] | undefined,
): ScheduledTaskAgentConfig | null =>
  assistantId || requestedToolNames?.length
    ? {
        ...(assistantId ? { assistantId } : {}),
        ...(requestedToolNames?.length
          ? { temporaryApprovedToolNames: requestedToolNames }
          : {}),
      }
    : null

const executeCreate = async (
  service: ScheduledTaskServiceLike,
  args: Record<string, unknown>,
): Promise<LocalToolCallResult> => {
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
    agentConfig: buildAgentConfig(assistantId, requestedToolNames),
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
    notifyOn: getNotifyOn(args),
  }
  const task = await service.createTask(config)
  return {
    status: ToolCallResponseStatus.Success,
    text: formatJsonResult(
      withResultAction('create', { tool: 'scheduled_task_ops', task }),
    ),
  }
}

const executeUpdate = async (
  service: ScheduledTaskServiceLike,
  args: Record<string, unknown>,
): Promise<LocalToolCallResult> => {
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
    patch.agentConfig = buildAgentConfig(
      assistantId,
      args.requestedToolNames === undefined
        ? undefined
        : getOptionalStringArrayArg(args, 'requestedToolNames'),
    )
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
  if (args.notifyOn !== undefined) patch.notifyOn = getNotifyOn(args)
  if (args.enabled !== undefined)
    patch.enabled = getOptionalBooleanArg(args, 'enabled')
  await service.updateTask(id, patch)
  const task = await service.getTask(id)
  return {
    status: ToolCallResponseStatus.Success,
    text: formatJsonResult(
      withResultAction('update', { tool: 'scheduled_task_ops', task }),
    ),
  }
}

export const scheduledTaskOpsDefinition = defineTool({
  name: 'scheduled_task_ops',
  getMcpTool: () => SCHEDULED_TASK_OPS_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinScheduledTaskOpsLabel',
    fallback: 'Scheduled Tasks Toolset',
  },
  contextPrunable: true,
  execute: async (args, ctx) => {
    const service = requireService(ctx)
    const action = getOptionalTextArg(args, 'action')
    if (!action) throw new Error('action is required.')
    switch (action) {
      case 'create':
        return executeCreate(service, args)
      case 'update':
        return executeUpdate(service, args)
      case 'delete': {
        const id = getOptionalTextArg(args, 'id')?.trim()
        if (!id) throw new Error('id is required.')
        await service.deleteTask(id)
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult(
            withResultAction('delete', {
              tool: 'scheduled_task_ops',
              id,
              deleted: true,
            }),
          ),
        }
      }
      case 'list': {
        const enabled = getOptionalBooleanArg(args, 'enabled')
        const tasks = await service.listTasks(
          enabled === undefined ? undefined : { enabled },
        )
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult(
            withResultAction('list', {
              tool: 'scheduled_task_ops',
              tasks,
              count: tasks.length,
            }),
          ),
        }
      }
      case 'get': {
        const id = getOptionalTextArg(args, 'id')?.trim()
        if (!id) throw new Error('id is required.')
        const task = await service.getTask(id)
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult(
            withResultAction('get', { tool: 'scheduled_task_ops', task }),
          ),
        }
      }
      case 'run_now': {
        const id = getOptionalTextArg(args, 'id')?.trim()
        if (!id) throw new Error('id is required.')
        const result = await service.executeTaskNow(id)
        return {
          status: ToolCallResponseStatus.Success,
          text: formatJsonResult(
            withResultAction('run_now', { tool: 'scheduled_task_ops', result }),
          ),
        }
      }
      default:
        throw new Error(`Unsupported scheduled_task_ops action: ${action}`)
    }
  },
})
