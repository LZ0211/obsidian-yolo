/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only ACP process boundary */
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
/* eslint-enable import/no-nodejs-modules */

import { Platform } from 'obsidian'

import { AcpChildProcess } from './process'

jest.mock('shell-env', () => ({ shellEnvSync: () => ({}) }))

class FakeChildProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  exitCode: number | null = null
  killed = false

  kill(): boolean {
    this.killed = true
    return true
  }
}

let fakeChild: FakeChildProcess | undefined

jest.mock('../../../utils/platform/desktopNodeModule', () => ({
  loadDesktopNodeModule: async (specifier: string) => {
    if (specifier === 'node:child_process') {
      return {
        spawn: () => {
          fakeChild = new FakeChildProcess()
          queueMicrotask(() => fakeChild?.emit('spawn'))
          return fakeChild
        },
      }
    }
    return jest.requireActual(specifier) as unknown
  },
}))

describe('AcpChildProcess', () => {
  const originalIsDesktop = Platform.isDesktop

  beforeEach(() => {
    Platform.isDesktop = true
    fakeChild = undefined
  })

  afterEach(() => {
    Platform.isDesktop = originalIsDesktop
  })

  it('waits for the child close event after sending SIGTERM', async () => {
    const process = await AcpChildProcess.start({
      runtimeId: 'hermes',
      command: 'hermes',
      args: [],
      cwd: '/vault',
    })
    let settled = false
    const shutdown = process.shutdown().then(() => {
      settled = true
    })

    await Promise.resolve()
    expect(fakeChild?.killed).toBe(true)
    expect(settled).toBe(false)

    expect(fakeChild).toBeDefined()
    if (fakeChild) fakeChild.exitCode = 0
    fakeChild?.emit('close', 0, null)
    await shutdown

    expect(settled).toBe(true)
  })
})
