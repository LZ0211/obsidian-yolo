import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { getCapability, getToolDefinition } from '../registry'
import type { ToolContext } from '../types'

describe('project_ops definition', () => {
  it('is registered as the projects capability', () => {
    expect(getCapability('projects')?.tools.map((tool) => tool.name)).toEqual([
      'project_ops',
    ])
  })

  it('dispatches status to the injected project tool', async () => {
    const status = jest.fn().mockResolvedValue({ projectId: 'project-1' })
    const definition = getToolDefinition('project_ops')
    const result = await definition?.execute(
      { action: 'status', projectId: 'project-1' },
      { getProjectTool: () => ({ status }) } as unknown as ToolContext,
    )

    expect(status).toHaveBeenCalledWith('project-1')
    expect(result).toEqual({
      status: ToolCallResponseStatus.Success,
      text: JSON.stringify({ projectId: 'project-1' }),
    })
  })

  it.each([
    [
      'init',
      { action: 'init', projectId: 'project-1', tasks: [] },
      'init requires projectName',
    ],
    [
      'get',
      { action: 'get', projectId: 'project-1', patch: {} },
      'get rejects non-read fields',
    ],
    [
      'status',
      { action: 'status', projectId: 'project-1', taskId: 'task-1' },
      'status accepts only projectId',
    ],
    [
      'update',
      {
        action: 'update',
        projectId: 'project-1',
        taskId: 'task-1',
        expectedRevision: 1,
        expectedContentHash: 'hash-1',
        patch: {},
        claim: { runKey: 'run-1' },
      },
      'update requires exactly one of patch or claim',
    ],
    [
      'review',
      {
        action: 'review',
        projectId: 'project-1',
        taskId: 'task-1',
        decision: 'escalated',
        patch: {},
      },
      'review rejects patch/claim/init fields',
    ],
  ])(
    'preserves the %s action field constraints',
    async (_action, args, error) => {
      const definition = getToolDefinition('project_ops')
      const tool = {
        init: jest.fn(),
        get: jest.fn(),
        status: jest.fn(),
        update: jest.fn(),
        review: jest.fn(),
      }

      await expect(
        definition?.execute(args, {
          getProjectTool: () => tool,
        } as unknown as ToolContext),
      ).rejects.toThrow(error)
    },
  )
})
