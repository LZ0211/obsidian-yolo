import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { getCapability, getToolDefinition } from '../registry'
import type { ScheduledTaskServiceLike, ToolContext } from '../types'

describe('scheduled_task_ops definition', () => {
  it('is registered as the scheduled_tasks capability', () => {
    const capability = getCapability('scheduled_tasks')

    expect(capability?.tools.map((tool) => tool.name)).toEqual([
      'scheduled_task_ops',
    ])
  })

  it('lists scheduled tasks through the injected service', async () => {
    const listTasks = jest.fn().mockResolvedValue([{ id: 'task-1' }])
    const service = { listTasks } as unknown as ScheduledTaskServiceLike
    const definition = getToolDefinition('scheduled_task_ops')

    const result = await definition?.execute(
      { action: 'list', enabled: true },
      {
        getScheduledTasksService: () => service,
      } as ToolContext,
    )

    expect(listTasks).toHaveBeenCalledWith({ enabled: true })
    expect(result).toEqual({
      status: ToolCallResponseStatus.Success,
      text: JSON.stringify(
        {
          tool: 'scheduled_task_ops',
          tasks: [{ id: 'task-1' }],
          count: 1,
          action: 'list',
        },
        null,
        2,
      ),
    })
  })
})
