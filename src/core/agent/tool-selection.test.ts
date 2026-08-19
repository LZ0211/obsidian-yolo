import type { YoloSettings } from '../../settings/schema/setting.types'
import type { McpTool } from '../../types/mcp.types'
import {
  clearFlightLog,
  getFlightEvents,
  setFlightLogEnabled,
} from '../../utils/debug/flightLog'

import {
  buildRequestTools,
  selectAllowedTools,
} from './tool-selection'

describe('selectAllowedTools', () => {
  it('bounds oversized external tool descriptions and schemas', () => {
    const requestTools = buildRequestTools([
      {
        name: 'external__huge',
        description: 'description '.repeat(5000),
        inputSchema: {
          type: 'object',
          properties: {
            payload: {
              type: 'string',
              description: 'schema '.repeat(5000),
            },
          },
        },
      },
    ])

    expect(requestTools?.[0]?.function.description?.length).toBeLessThanOrEqual(
      2_000,
    )
    expect(
      JSON.stringify(requestTools?.[0]?.function.parameters).length,
    ).toBeLessThanOrEqual(20_000)
  })

  it('keeps full schemas for tools left in always mode', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
        },
      },
    ]

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
      toolServerPreferences: { server: { disclosureMode: 'always' } },
    })

    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
    expect(result.requestTools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { foo: { type: 'string' } },
    })
  })

  it('injects delegate_subagent model pool into the request schema', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'yolo_local__delegate_subagent',
        description: 'Dispatch a subagent.',
        inputSchema: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            prompt: { type: 'string' },
          },
          required: ['description', 'prompt'],
        },
      },
    ]
    const settings = {
      providers: [{ id: 'openai', apiType: 'openai-compatible' }],
      chatModelId: 'openai/gpt-5',
      chatModels: [
        {
          id: 'openai/gpt-5',
          providerId: 'openai',
          model: 'gpt-5',
          enable: true,
        },
        {
          id: 'openai/gpt-4.1-mini',
          providerId: 'openai',
          model: 'gpt-4.1-mini',
          enable: true,
        },
      ],
      mcp: {
        servers: [],
        enableToolDisclosure: false,
        builtinCapabilityOptions: {
          subagent_delegation: {
            allowedModelIds: ['openai/gpt-4.1-mini'],
            preferredModelId: 'openai/gpt-4.1-mini',
          },
        },
      },
    } as unknown as YoloSettings

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['yolo_local__delegate_subagent'],
      toolPreferences: {
        yolo_local__delegate_subagent: {
          enabled: true,
        },
      },
      settings,
    })

    const delegateTool = result.requestTools?.[0]
    expect(delegateTool?.function.description).toContain(
      'Recommended default: openai/gpt-4.1-mini',
    )
    expect(delegateTool?.function.parameters).toMatchObject({
      properties: {
        modelId: {
          type: 'string',
          enum: ['openai/gpt-4.1-mini'],
        },
      },
    })
  })

  it('replaces on-demand tools with a permissive stub schema (non-Gemini)', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A real schema',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: ['foo'],
        },
      },
    ]

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: { enabled: true },
      },
      toolServerPreferences: { server: { disclosureMode: 'on_demand' } },
      apiType: 'anthropic',
    })

    // The loader is injected automatically whenever any surviving tool is
    // on-demand; it stays as a full schema and rides at the head of the list.
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'yolo_local__load_tool_schemas',
      'server__tool_a',
    ])
    const stub = result.requestTools?.find(
      (tool) => tool.function.name === 'server__tool_a',
    )
    expect(stub?.function.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true,
    })
    expect(stub?.function.description).toContain('load_tool_schemas')
  })

  it('uses args_json stub form on Gemini', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object', properties: {} },
      },
    ]

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: { enabled: true },
      },
      toolServerPreferences: { server: { disclosureMode: 'on_demand' } },
      apiType: 'gemini',
    })

    const stub = result.requestTools?.find(
      (tool) => tool.function.name === 'server__tool_a',
    )
    expect(stub?.function.parameters).toEqual({
      type: 'object',
      properties: {
        args_json: expect.objectContaining({ type: 'string' }),
      },
      required: ['args_json'],
    })
  })

  it('uses full schemas and skips loader injection when disclosure is disabled', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A real schema',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: ['foo'],
        },
      },
    ]

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      enableToolDisclosure: false,
      toolPreferences: {
        server__tool_a: { enabled: true },
      },
      toolServerPreferences: { server: { disclosureMode: 'on_demand' } },
    })

    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
    expect(result.requestTools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { foo: { type: 'string' } },
      required: ['foo'],
    })
  })

  it('omits the loader when no surviving tool is on-demand', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object', properties: {} },
      },
    ]

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
        },
      },
      toolServerPreferences: { server: { disclosureMode: 'always' } },
    })

    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
  })

  it('defaults lightweight MCP servers to always-loaded full schemas', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
        },
      },
    ]

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
    })

    expect(result.hasOnDemandTools).toBe(false)
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'server__tool_a',
    ])
    expect(result.requestTools?.[0]?.function.parameters).toEqual({
      type: 'object',
      properties: { foo: { type: 'string' } },
    })
  })

  it('defaults heavy MCP servers to on-demand stubs', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A '.repeat(12000),
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
          required: ['foo'],
        },
      },
    ]

    const result = await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: {
          enabled: true,
          approvalMode: 'full_access',
        },
      },
      apiType: 'anthropic',
    })

    expect(result.hasOnDemandTools).toBe(true)
    expect(result.requestTools?.map((tool) => tool.function.name)).toEqual([
      'yolo_local__load_tool_schemas',
      'server__tool_a',
    ])
    const stub = result.requestTools?.find(
      (tool) => tool.function.name === 'server__tool_a',
    )
    expect(stub?.function.parameters).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: true,
    })
    expect(stub?.function.description).toContain('ON-DEMAND')
  })

  it('keeps the tools-field stable across identical selections', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: {
          type: 'object',
          properties: { foo: { type: 'string' } },
        },
      },
    ]
    const params = {
      availableTools,
      allowedToolNames: ['server__tool_a'],
      toolPreferences: {
        server__tool_a: { enabled: true },
      },
      toolServerPreferences: {
        server: { disclosureMode: 'on_demand' as const },
      },
      apiType: 'anthropic' as const,
    }

    const before = await selectAllowedTools(params)
    const after = await selectAllowedTools(params)

    expect(JSON.stringify(before.requestTools)).toEqual(
      JSON.stringify(after.requestTools),
    )
  })

  it('injects the subagent allowed model list into the delegate tool schema', async () => {
    const settings = {
      chatModels: [
        { id: 'model-a', providerId: 'p', model: 'model-a' },
        { id: 'model-b', providerId: 'p', model: 'model-b' },
      ],
      chatModelId: 'model-a',
      mcp: {
        builtinCapabilityOptions: {
          subagent_delegation: {
            allowedModelIds: ['model-a', 'model-b'],
            preferredModelId: 'model-a',
          },
        },
      },
    } as unknown as YoloSettings
    const delegateTool: McpTool = {
      name: 'yolo_local__delegate_subagent',
      description: 'Dispatch an isolated temporary sub-agent',
      inputSchema: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          modelId: { type: 'string' },
        },
      },
    }

    const result = await selectAllowedTools({
      availableTools: [delegateTool],
      allowedToolNames: ['yolo_local__delegate_subagent'],
      toolPreferences: {
        'yolo_local__delegate_subagent': { enabled: true },
      },
      settings,
    })

    const requestTool = result.requestTools?.[0]
    const modelParam = (
      requestTool?.function.parameters as {
        properties?: { modelId?: { enum?: string[] } }
      }
    )?.properties?.modelId
    expect(modelParam).toMatchObject({
      type: 'string',
      enum: ['model-a', 'model-b'],
    })
    // The full list lives in the parameter description; the tool description
    // carries the policy line with the recommended default.
    expect(requestTool?.function.description).toContain('model-a')
    expect((modelParam as { description?: string }).description).toContain(
      'model-b',
    )
    expect((modelParam as { description?: string }).description).toContain(
      'Allowed modelIds',
    )
  })

  it('leaves the delegate tool schema static when settings are absent', async () => {
    const delegateTool: McpTool = {
      name: 'yolo_local__delegate_subagent',
      description: 'Dispatch an isolated temporary sub-agent',
      inputSchema: {
        type: 'object',
        properties: { modelId: { type: 'string' } },
      },
    }

    const result = await selectAllowedTools({
      availableTools: [delegateTool],
      allowedToolNames: ['yolo_local__delegate_subagent'],
      toolPreferences: {
        'yolo_local__delegate_subagent': { enabled: true },
      },
    })

    const modelParam = (
      result.requestTools?.[0]?.function.parameters as {
        properties?: { modelId?: { enum?: string[] } }
      }
    )?.properties?.modelId
    expect(modelParam?.enum).toBeUndefined()
    expect(result.requestTools?.[0]?.function.description).not.toContain(
      'Allowed modelIds',
    )
  })
})

describe('selectAllowedTools: flight log filter events', () => {
  beforeEach(() => {
    jest.spyOn(console, 'debug').mockImplementation(() => undefined)
    setFlightLogEnabled(true)
    clearFlightLog()
  })

  afterEach(() => {
    setFlightLogEnabled(false)
    clearFlightLog()
    jest.restoreAllMocks()
  })

  it('records a tools:filtered event for each tool dropped by the allow list', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object' },
      },
      {
        name: 'server__tool_b',
        description: 'Tool B',
        inputSchema: { type: 'object' },
      },
    ]

    await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
    })

    const filtered = getFlightEvents().filter(
      (event) => event.event === 'filtered',
    )
    expect(filtered).toHaveLength(1)
    expect(filtered[0]).toMatchObject({
      scope: 'tools',
      detail: 'name=server__tool_b reason=not-allowed',
    })
  })

  it('does not record filter events when every tool is allowed', async () => {
    const availableTools: McpTool[] = [
      {
        name: 'server__tool_a',
        description: 'Tool A',
        inputSchema: { type: 'object' },
      },
    ]

    await selectAllowedTools({
      availableTools,
      allowedToolNames: ['server__tool_a'],
    })

    expect(
      getFlightEvents().filter((event) => event.event === 'filtered'),
    ).toHaveLength(0)
  })
})
