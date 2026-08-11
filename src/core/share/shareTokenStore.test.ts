/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import { ensureWebRuntimeToken, isLoopbackHost } from './shareTokenStore'

describe('shareTokenStore', () => {
  it('keeps loopback host checks free of eager Node crypto loading', () => {
    const source = readFileSync(
      path.join(__dirname, 'shareTokenStore.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:crypto'/)
    expect(source).toContain('loadDesktopNodeModuleSync')
  })

  it('identifies loopback bind hosts', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
  })

  it('generates a token when binding a non-loopback host without one', () => {
    const settings = {
      webRuntime: {
        enabled: true,
        host: '0.0.0.0',
        port: 18900,
        token: '',
      },
    }

    const token = ensureWebRuntimeToken(settings, () => 'generated-token')

    expect(token).toBe('generated-token')
    expect(settings.webRuntime.token).toBe('generated-token')
  })

  it('does not require a token for loopback hosts', () => {
    const settings = {
      webRuntime: {
        enabled: true,
        host: '127.0.0.1',
        port: 18900,
        token: '',
      },
    }

    expect(ensureWebRuntimeToken(settings, () => 'generated-token')).toBe('')
  })
})
