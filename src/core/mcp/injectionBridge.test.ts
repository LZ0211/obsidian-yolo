import {
  callInjectedBridgeTool,
  getInjectedBridgeTools,
  getInstalledInjectionBridge,
  installYoloInjectionBridge,
  isInjectedBridgeToolName,
  subscribeInjectedBridgeTools,
  uninstallYoloInjectionBridge,
} from './injectionBridge'

const TEST_SOURCE = 'inject/test'

describe('YOLO injection bridge', () => {
  afterEach(() => {
    uninstallYoloInjectionBridge()
    const bridge = getInstalledInjectionBridge()
    bridge?.unregisterBySource(TEST_SOURCE)
  })

  it('installs __yoloBridge__ and the __mcpBridge__ compatibility alias', () => {
    const uninstall = installYoloInjectionBridge()
    const win = globalThis as unknown as Record<string, unknown>
    expect(win['__yoloBridge__']).toBeDefined()
    expect(win['__mcpBridge__']).toBe(win['__yoloBridge__'])
    expect(getInstalledInjectionBridge()).toBe(win['__yoloBridge__'])
    uninstall()
    expect(win['__yoloBridge__']).toBeUndefined()
    expect(win['__mcpBridge__']).toBeUndefined()
  })

  it('does not clobber an existing __mcpBridge__ from another plugin', () => {
    const win = globalThis as unknown as Record<string, unknown>
    const fakeBridge = { version: 'other' }
    win['__mcpBridge__'] = fakeBridge
    try {
      installYoloInjectionBridge()
      expect(win['__mcpBridge__']).toBe(fakeBridge)
      expect(win['__yoloBridge__']).toBeDefined()
    } finally {
      delete win['__mcpBridge__']
      uninstallYoloInjectionBridge()
    }
  })

  it('is idempotent and a second install is a no-op uninstall', () => {
    const firstUninstall = installYoloInjectionBridge()
    const secondUninstall = installYoloInjectionBridge()
    secondUninstall()
    const win = globalThis as unknown as Record<string, unknown>
    expect(win['__yoloBridge__']).toBeDefined()
    firstUninstall()
    expect(win['__yoloBridge__']).toBeUndefined()
  })

  it('registers, lists and unregisters tools with source normalization', async () => {
    const uninstall = installYoloInjectionBridge()
    const bridge = getInstalledInjectionBridge()
    expect(bridge).not.toBeNull()
    bridge?.registerTool(
      {
        name: 'test_echo',
        description: 'Echo args',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
        },
      },
      async (args) => ({ echoed: args['value'] }),
      'test',
    )

    expect(isInjectedBridgeToolName('test_echo')).toBe(true)
    expect(getInjectedBridgeTools().map((tool) => tool.name)).toContain(
      'test_echo',
    )
    expect(bridge?.listTools()['inject/test']).toContain('test_echo')
    expect(await callInjectedBridgeTool('test_echo', { value: 'hi' })).toEqual({
      echoed: 'hi',
    })

    bridge?.unregisterTool('test_echo')
    expect(isInjectedBridgeToolName('test_echo')).toBe(false)
    uninstall()
  })

  it('supports batch registration and unregisterBySource', () => {
    const uninstall = installYoloInjectionBridge()
    const bridge = getInstalledInjectionBridge()
    bridge?.registerTools(
      [
        {
          descriptor: {
            name: 'test_a',
            description: 'A',
            inputSchema: { type: 'object', properties: {} },
          },
          handler: async () => 'a',
        },
        {
          descriptor: {
            name: 'test_b',
            description: 'B',
            inputSchema: { type: 'object', properties: {} },
          },
          handler: async () => 'b',
        },
      ],
      'test',
    )
    expect(isInjectedBridgeToolName('test_a')).toBe(true)
    expect(isInjectedBridgeToolName('test_b')).toBe(true)

    bridge?.unregisterBySource('test')
    expect(isInjectedBridgeToolName('test_a')).toBe(false)
    expect(isInjectedBridgeToolName('test_b')).toBe(false)
    uninstall()
  })

  it('notifies subscribers when tools change (supports late injection)', () => {
    const uninstall = installYoloInjectionBridge()
    const bridge = getInstalledInjectionBridge()
    const changes: number[] = []
    const stop = subscribeInjectedBridgeTools(() =>
      changes.push(changes.length),
    )
    bridge?.registerTool(
      {
        name: 'test_late',
        description: 'Late',
        inputSchema: { type: 'object', properties: {} },
      },
      async () => 'late',
      'test',
    )
    expect(changes.length).toBe(1)
    stop()
    uninstall()
  })
})
