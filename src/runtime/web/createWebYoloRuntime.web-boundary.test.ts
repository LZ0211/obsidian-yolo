jest.mock('../../core/agent/service', () => {
  throw new Error('AgentService must not be loaded by the web runtime')
})

jest.mock('../../settings/schema/settings', () => {
  throw new Error('Desktop settings migrations must not load in the web runtime')
})

jest.mock('../../settings/schema/setting.types', () => {
  throw new Error('Desktop settings schema must not load in the web runtime')
})

jest.mock('../../core/mcp/localFileTools', () => {
  throw new Error('Desktop local file tools must not load in the web runtime')
})

jest.mock('./createWebCompatApp', () => ({
  createWebCompatApp: jest.fn(),
}))

jest.mock('./createWebCompatPlugin', () => ({
  createWebCompatPlugin: jest.fn(),
}))

jest.mock('./createWebCompatibilityBridge', () => ({
  createWebCompatibilityBridge: jest.fn(),
}))

jest.mock('./createWebMcpManager', () => ({
  createWebMcpManager: jest.fn(),
}))

jest.mock('./obsidianCompat', () => ({
  Notice: jest.fn(),
}))

// useChatHistory 模块加载会引入 React app-context，测试环境（node env）无
// React；本测试只验证桌面模块边界，序列化工具 mock 掉即可（对齐
// mcpRoutes.test.ts 的既有模式）。
jest.mock('../../hooks/useChatHistory', () => ({
  serializeChatMessage: jest.fn((message: never) => message),
  deserializeChatMessage: jest.fn((message: never) => message),
}))

import { createWebYoloRuntime } from './createWebYoloRuntime'

describe('createWebYoloRuntime web boundary', () => {
  it('does not load the desktop AgentService module', () => {
    expect(createWebYoloRuntime).toEqual(expect.any(Function))
  })
})
