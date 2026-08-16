import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { getDefaultApprovalModeForTool } from '../agent/tool-preferences'
import { getToolName } from './tool-name-utils'

import {
  callInjectedBridgeTool,
  createInjectionBridgeToolServer,
  getInstalledInjectionBridge,
  getInjectedBridgeTools,
  installYoloInjectionBridge,
  uninstallYoloInjectionBridge,
  YOLO_BRIDGE_TOOL_SERVER_NAME,
} from './injectionBridge'

describe('injection bridge integration', () => {
  afterEach(() => {
    uninstallYoloInjectionBridge()
  })

  it('surfaces and dispatches injected tools through the in-process server', async () => {
    const uninstall = installYoloInjectionBridge()
    const handler = jest.fn(() => ({ sum: 42 }))
    const bridge = (globalThis as Record<string, unknown>).__yoloBridge__ as {
      registerTool: (
        descriptor: { name: string; description: string; inputSchema: object },
        handler: (args: Record<string, unknown>) => unknown,
      ) => void
    }
    bridge.registerTool(
      {
        name: 'plugin_calc',
        description: 'Calculate something',
        inputSchema: { type: 'object', properties: { a: { type: 'number' } } },
      },
      handler,
    )

    const server = createInjectionBridgeToolServer()
    const tool = server.listTools().find((t) => t.name === 'plugin_calc')
    expect(tool).toBeDefined()
    expect(tool?.description).toBe('Calculate something')

    const result = await server.callTool({
      toolName: 'plugin_calc',
      args: { a: 1 },
      signal: new AbortController().signal,
    })
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status === ToolCallResponseStatus.Success) {
      expect(JSON.parse(result.data.text)).toEqual({ sum: 42 })
    }
    expect(handler).toHaveBeenCalledWith({ a: 1 })

    uninstall()
  })

  it('preserves MCP annotations and exposes an explicit hard-approval policy', () => {
    const uninstall = installYoloInjectionBridge()
    const bridge = (globalThis as Record<string, unknown>).__yoloBridge__ as {
      registerTool: (
        descriptor: {
          name: string
          description: string
          inputSchema: object
          annotations: {
            title: string
            readOnlyHint: boolean
            destructiveHint: boolean
            idempotentHint: boolean
            openWorldHint: boolean
          }
          requiresApproval: boolean
        },
        handler: (args: Record<string, unknown>) => unknown,
      ) => void
    }
    bridge.registerTool(
      {
        name: 'plugin_delete',
        description: 'Delete a remote item',
        inputSchema: { type: 'object', properties: {} },
        annotations: {
          title: 'Delete item',
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: true,
        },
        requiresApproval: true,
      },
      () => 'deleted',
    )

    const server = createInjectionBridgeToolServer()
    expect(server.listTools()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'plugin_delete',
          annotations: {
            title: 'Delete item',
            readOnlyHint: false,
            destructiveHint: true,
            idempotentHint: true,
            openWorldHint: true,
          },
        }),
      ]),
    )
    expect(server.getToolApprovalPolicy?.('plugin_delete')).toBe(
      'always-require-user',
    )

    uninstall()
  })

  it('leaves approval policy unspecified when the injector does not require hard approval', () => {
    const uninstall = installYoloInjectionBridge()
    getInstalledInjectionBridge()?.registerTool(
      {
        name: 'plugin_read',
        description: 'Read a local item',
        inputSchema: { type: 'object', properties: {} },
      },
      () => 'value',
    )

    expect(
      createInjectionBridgeToolServer().getToolApprovalPolicy?.('plugin_read'),
    ).toBeUndefined()

    uninstall()
  })

  it('defaults injected tools to require_approval and keeps them dispatchable by full name', async () => {
    const uninstall = installYoloInjectionBridge()
    const bridge = (globalThis as Record<string, unknown>).__yoloBridge__ as {
      registerTool: (
        descriptor: { name: string; description: string; inputSchema: object },
        handler: (args: Record<string, unknown>) => unknown,
      ) => void
    }
    bridge.registerTool(
      {
        name: 'plugin_echo',
        description: 'Echo input',
        inputSchema: { type: 'object' },
      },
      (args) => args,
    )

    expect(getDefaultApprovalModeForTool('plugin_echo')).toBe(
      'require_approval',
    )

    const server = createInjectionBridgeToolServer()
    expect(
      getDefaultApprovalModeForTool(
        getToolName(YOLO_BRIDGE_TOOL_SERVER_NAME, 'plugin_echo'),
      ),
    ).toBe('require_approval')

    const result = await server.callTool({
      toolName: 'plugin_echo',
      args: { x: 1 },
      signal: new AbortController().signal,
    })
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status === ToolCallResponseStatus.Success) {
      expect(JSON.parse(result.data.text)).toEqual({ x: 1 })
    }

    uninstall()
  })

  it('removes injected tools after unregisterBySource', async () => {
    const uninstall = installYoloInjectionBridge()
    const bridge = (globalThis as Record<string, unknown>).__yoloBridge__ as {
      registerTool: (
        descriptor: { name: string; description: string; inputSchema: object },
        handler: (args: Record<string, unknown>) => unknown,
        sourceId?: string,
      ) => void
      unregisterBySource: (sourceId: string) => void
    }
    bridge.registerTool(
      {
        name: 'plugin_gone',
        description: 'Temporary tool',
        inputSchema: { type: 'object' },
      },
      () => 'ok',
      'my-plugin',
    )
    expect(getInjectedBridgeTools().some((t) => t.name === 'plugin_gone')).toBe(
      true,
    )

    bridge.unregisterBySource('my-plugin')
    expect(getInjectedBridgeTools().some((t) => t.name === 'plugin_gone')).toBe(
      false,
    )
    await expect(callInjectedBridgeTool('plugin_gone', {})).rejects.toThrow(
      'not registered',
    )

    uninstall()
  })
})
