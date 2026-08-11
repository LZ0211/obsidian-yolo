/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块 */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

describe('registerWebServerRoutes runtime boundary', () => {
  it('defers Node path loading until desktop route registration runs', () => {
    const source = readFileSync(
      path.join(__dirname, 'registerWebServerRoutes.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:path'/)
    expect(source).toContain('loadDesktopNodeModuleSync')
  })
})
