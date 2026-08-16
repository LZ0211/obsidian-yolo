import {
  getInjectedToolGroup,
  getInjectedToolGroupKey,
  isLocalToolConfigurableInEditor,
} from './injectedToolGroup'
import {
  createInjectionBridgeToolServer,
  getInjectedBridgeTools,
  getInstalledInjectionBridge,
  installYoloInjectionBridge,
  uninstallYoloInjectionBridge,
  YOLO_BRIDGE_TOOL_SERVER_NAME,
} from './injectionBridge'
import { getToolName, parseToolName } from './tool-name-utils'

const TEST_SOURCE = 'inject/test'

describe('injected tool grouping in the agent settings render chain', () => {
  afterEach(() => {
    uninstallYoloInjectionBridge()
    getInstalledInjectionBridge()?.unregisterBySource(TEST_SOURCE)
  })

  const registerTestTool = (name: string, groupName?: string) => {
    const uninstall = installYoloInjectionBridge()
    getInstalledInjectionBridge()?.registerTool(
      {
        name,
        description: `${name} description`,
        inputSchema: { type: 'object', properties: {} },
      },
      async () => 'ok',
      'test',
      groupName,
    )
    return uninstall
  }

  it('passes the editor visibility filter and resolves its plugin group (regression: injected tools were dropped before grouping)', () => {
    registerTestTool('smart-docx_create_docx', 'Smart-Docx 插件能力')

    // 渲染链：注册 → in-process server → yolo_bridge__ 前缀 → parse 拆回
    const listed = getInjectedBridgeTools()
    expect(listed.map((tool) => tool.name)).toContain('smart-docx_create_docx')

    const fullName = getToolName(YOLO_BRIDGE_TOOL_SERVER_NAME, listed[0].name)
    expect(fullName).toBe('yolo_bridge__smart-docx_create_docx')

    const { toolName } = parseToolName(fullName)
    expect(toolName).toBe('smart-docx_create_docx')

    // 修复点 1：注入工具不再被 USER_FACING 白名单过滤
    expect(isLocalToolConfigurableInEditor(toolName)).toBe(true)

    // 修复点 2：分组解析到插件自定义组名
    expect(getInjectedToolGroup(toolName)).toEqual({
      name: 'Smart-Docx 插件能力',
    })
    expect(getInjectedToolGroupKey('Smart-Docx 插件能力')).toBe(
      '__injected:Smart-Docx 插件能力',
    )
  })

  it('keeps injected tools listed through the in-process server', () => {
    registerTestTool('browser_tools_open_url', '浏览器自动化插件能力')
    const names = createInjectionBridgeToolServer()
      .listTools()
      .map((tool) => tool.name)
    expect(names).toContain('browser_tools_open_url')
  })

  it('keeps builtin tools configurable and bot-only builtins filtered', () => {
    expect(isLocalToolConfigurableInEditor('fs_read')).toBe(true)
    expect(isLocalToolConfigurableInEditor('send_attachment')).toBe(false)
  })

  it('falls back to no group when the plugin registers without a group name', () => {
    registerTestTool('legacy_plugin_tool')
    const { toolName } = parseToolName(
      getToolName(YOLO_BRIDGE_TOOL_SERVER_NAME, 'legacy_plugin_tool'),
    )
    expect(isLocalToolConfigurableInEditor(toolName)).toBe(true)
    expect(getInjectedToolGroup(toolName)).toBeNull()
  })

  it('ignores names that are not registered on the bridge', () => {
    expect(isLocalToolConfigurableInEditor('not_registered_tool')).toBe(false)
    expect(getInjectedToolGroup('not_registered_tool')).toBeNull()
  })
})
