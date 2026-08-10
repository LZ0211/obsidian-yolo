import {
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import { getDefaultApprovalModeForTool } from '../agent/tool-preferences'
import { getToolName } from './tool-name-utils'

import {
  callInjectedBridgeTool,
  getInjectedBridgeTools,
  installYoloInjectionBridge,
  uninstallYoloInjectionBridge,
} from './injectionBridge'
import { callLocalFileTool, getLocalFileTools } from './localFileTools'

describe('injection bridge integration', () => {
  afterEach(() => {
    uninstallYoloInjectionBridge()
  })

  it('surfaces injected tools in getLocalFileTools and dispatches them through callLocalFileTool', async () => {
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

    const tool = getLocalFileTools().find((t) => t.name === 'plugin_calc')
    expect(tool).toBeDefined()
    expect(tool?.description).toBe('Calculate something')

    const result = await callLocalFileTool({
      app: {} as never,
      toolName: 'plugin_calc',
      args: { a: 1 },
    })
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status === ToolCallResponseStatus.Success) {
      expect(JSON.parse(result.text)).toEqual({ sum: 42 })
    }
    expect(handler).toHaveBeenCalledWith({ a: 1 })

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

    // Full-name dispatch (as emitted by the model after tool listing) works.
    const result = await callLocalFileTool({
      app: {} as never,
      toolName: getToolName('yolo_local', 'plugin_echo'),
      args: { x: 1 },
    })
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status === ToolCallResponseStatus.Success) {
      expect(JSON.parse(result.text)).toEqual({ x: 1 })
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
    await expect(
      callInjectedBridgeTool('plugin_gone', {}),
    ).rejects.toThrow('not registered')

    uninstall()
  })
})
