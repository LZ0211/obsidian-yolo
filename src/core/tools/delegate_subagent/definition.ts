import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { assertProjectTaskDispatchable } from '../../agent/project/delivery'
import { buildReviewPrompt } from '../../agent/project/review-prompt'
import { ProjectStore } from '../../agent/project/store'
import type { ProjectTaskBinding, TaskRecord } from '../../agent/project/types'
import {
  SUBAGENT_DELEGATION_BLOCKED_REASON,
  clearParentSubagentDeadline,
  isParentSubagentDelegationBlocked,
} from '../../agent/subagent/pending-timeout-registry'
import { resolveSubagentModelConfig } from '../../agent/subagent/model-config'
import { defineTool } from '../define'
import { getOptionalTextArg, getTextArg } from '../tool-args'

const DELEGATE_SUBAGENT_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Dispatch an isolated temporary sub-agent to work on a self-contained task asynchronously. ' +
    'The sub-agent does not see the parent conversation unless forkContext is requested, so the prompt must include all necessary context. ' +
    'Returns immediately with a taskId while the child runs in the background. ' +
    'When complete, a follow-up background message starting with [subagent_result taskId=...] will arrive.',
  inputSchema: {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description: 'Short title for this dispatch.',
      },
      prompt: {
        type: 'string',
        description: 'Complete task instructions for the temporary sub-agent.',
      },
      delegatedRoleId: {
        type: 'string',
        description:
          'Optional delegatable assistant id to use as the child role.',
      },
      modelPreferenceId: {
        type: 'string',
        description: 'Optional preferred model id for this dispatch.',
      },
      forkContext: {
        type: 'string',
        enum: ['none', 'last_turns', 'full'],
        description:
          'Optional read-only parent conversation context to include.',
      },
      projectTask: {
        type: 'object',
        description: 'Optional versioned project task binding.',
        properties: {
          projectId: { type: 'string' },
          taskId: { type: 'string' },
          expectedRevision: { type: 'number' },
          expectedContentHash: { type: 'string' },
          review: { type: 'boolean' },
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
}

const parseProjectTaskBinding = (value: unknown): ProjectTaskBinding => {
  if (typeof value !== 'object' || value === null) {
    throw new Error('projectTask must be an object.')
  }
  const { projectId, taskId, expectedRevision, expectedContentHash, review } =
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
  return {
    projectId,
    taskId,
    expectedRevision,
    expectedContentHash,
    ...(review === true ? { review: true } : {}),
  }
}

const buildProjectTaskPrompt = (
  task: TaskRecord,
  taskBody: string,
  userPrompt: string,
): string =>
  [
    `# Project task: ${task.taskId} - ${task.title}`,
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
    '## Reporting',
    'When you finish, report what you completed, how you verified it, the files changed, and anything left for human review.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n\n')

export const delegateSubagentDefinition = defineTool({
  name: 'delegate_subagent',
  getMcpTool: () => DELEGATE_SUBAGENT_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinDelegateSubagentLabel',
    fallback: 'Delegate Subagent',
  },
  contextPrunable: true,
  execute: async (args, ctx) => {
    const {
      app,
      subagentParentContext,
      runSubagent,
      conversationId,
      settings,
      conversationMessages,
      toolCallId,
      signal,
    } = ctx

    if (!subagentParentContext || !runSubagent) {
      throw new Error(
        'delegate_subagent is only available during an active parent agent run.',
      )
    }
    if (!conversationId) {
      throw new Error('conversationId is required for delegate_subagent.')
    }
    if (!settings) {
      throw new Error('settings are required for delegate_subagent.')
    }

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

      if (projectTask.review) {
        if (versioned.task.status !== 'awaiting_review') {
          throw new Error(
            `Project task ${projectTask.taskId} is not awaiting_review; it cannot be reviewed.`,
          )
        }
        const deliveries: string[] = []
        for (const ref of versioned.task.deliveryRefs) {
          const artifact = await store.readDeliveryArtifact(
            projectTask.projectId,
            projectTask.taskId,
            (ref.split('/').pop() ?? '').replace(/\.md$/, ''),
          )
          if (artifact) deliveries.push(artifact)
        }
        composedPrompt = buildReviewPrompt({
          task: versioned.task,
          body: (
            await store.readTaskBody(projectTask.projectId, projectTask.taskId)
          ).trim(),
          delivery: deliveries.join('\n\n---\n\n'),
          history: (versioned.task.reviewHistory ?? [])
            .map(
              (review) =>
                `${review.decision} (${review.at}): ${review.comments.join('; ')}`,
            )
            .join('\n'),
        })
        projectTask = undefined
      } else {
        assertProjectTaskDispatchable(versioned.task)
        composedPrompt = buildProjectTaskPrompt(
          versioned.task,
          (
            await store.readTaskBody(projectTask.projectId, projectTask.taskId)
          ).trim(),
          taskPrompt,
        )
      }
    }

    const delegatedRoleId =
      getOptionalTextArg(args, 'delegatedRoleId')?.trim() ?? ''
    const modelPreferenceId =
      getOptionalTextArg(args, 'modelPreferenceId')?.trim() ?? ''
    const requestedForkContext = getOptionalTextArg(args, 'forkContext')?.trim()
    if (
      requestedForkContext !== undefined &&
      !['none', 'last_turns', 'full'].includes(requestedForkContext)
    ) {
      throw new Error('forkContext must be "none", "last_turns", or "full".')
    }
    const forkContext = requestedForkContext ?? 'none'

    let delegatedProfile: unknown
    let selectedModelId: string
    if (delegatedRoleId) {
      const { resolveDelegatedAssistantProfile } = await import(
        '../../agent/subagent/delegated-assistant-profile'
      )
      const parent = subagentParentContext as {
        workspaceAccessPolicy?: Parameters<
          typeof resolveDelegatedAssistantProfile
        >[0]['parentWorkspacePolicy']
        requestContextBuilder: Parameters<
          typeof resolveDelegatedAssistantProfile
        >[0]['parentRequestContextBuilder']
      }
      const profile = await resolveDelegatedAssistantProfile({
        app,
        settings,
        assistantId: delegatedRoleId,
        parentWorkspacePolicy: parent.workspaceAccessPolicy,
        parentRequestContextBuilder: parent.requestContextBuilder,
      })
      if (!profile) {
        throw new Error(`Unknown delegated role "${delegatedRoleId}".`)
      }
      delegatedProfile = profile
      selectedModelId = profile.modelId
    } else {
      const requestedModelId =
        modelPreferenceId || (getOptionalTextArg(args, 'modelId')?.trim() ?? '')
      const config = resolveSubagentModelConfig(settings)
      if (config.allowedModelIds.length === 0) {
        throw new Error(
          'No registered chat models are configured for delegate_subagent.',
        )
      }
      if (
        requestedModelId &&
        !config.allowedModelIds.includes(requestedModelId)
      ) {
        throw new Error(
          `Model "${requestedModelId}" is not allowed for delegate_subagent.`,
        )
      }
      selectedModelId = requestedModelId || config.preferredModelId || ''
      if (!selectedModelId) {
        throw new Error(
          'No preferred chat model is configured for delegate_subagent.',
        )
      }
    }

    const { getChatModelClient } = await import('../../llm/manager')
    const selectedModelClient = getChatModelClient({
      settings,
      modelId: selectedModelId,
    })
    const selectedProvider = settings.providers.find(
      (provider) => provider.id === selectedModelClient.model.providerId,
    )
    const assistantMessageId =
      [...(conversationMessages ?? [])]
        .reverse()
        .find((message) => message.role === 'assistant')?.id ?? ''

    const accepted = await runSubagent({
      description,
      prompt: composedPrompt,
      conversationId,
      source: {
        type: 'llm_tool_call',
        toolCallId: toolCallId ?? '',
        assistantMessageId,
      },
      parent: { ...subagentParentContext, forkContext },
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
      const store = new ProjectStore({
        getSettings: () => settings,
        adapter: app.vault.adapter,
      })
      const backfill = await store.backfillClaimRunKey(
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
  },
})
