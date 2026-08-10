import { EventEmitter } from 'node:events'

type FakeChild = EventEmitter & {
  pid?: number
  kill: jest.Mock
  stdout: EventEmitter & { destroy: jest.Mock }
  stderr: EventEmitter & { destroy: jest.Mock }
  stdin: EventEmitter & { end: jest.Mock; destroy: jest.Mock }
  unref: jest.Mock
}

const makeFakeChild = (pid?: number): FakeChild => {
  const child = new EventEmitter() as FakeChild
  child.pid = pid
  child.kill = jest.fn()
  child.stdout = Object.assign(new EventEmitter(), { destroy: jest.fn() })
  child.stderr = Object.assign(new EventEmitter(), { destroy: jest.fn() })
  child.stdin = Object.assign(new EventEmitter(), {
    end: jest.fn(),
    destroy: jest.fn(),
  })
  child.unref = jest.fn()
  return child
}

const spawnMock = jest.fn()
const originalPlatform = process.platform

jest.mock('node:child_process', () => ({
  spawn: spawnMock,
}))

jest.mock('cross-spawn', () => ({
  spawn: spawnMock,
}))

describe('runGitCommand late Windows termination callbacks', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    jest.resetModules()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: 'win32',
    })
    spawnMock.mockReset()
  })

  afterEach(() => {
    jest.useRealTimers()
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    })
  })

  it('does not direct-kill after the finalization watchdog closes the run', async () => {
    const child = makeFakeChild(1234)
    const taskkill = makeFakeChild()
    const lateKillError = new Error('late direct kill failed')
    child.kill.mockImplementation(() => Promise.reject(lateKillError))
    let unhandledRejection: unknown
    const handleUnhandledRejection = (error: unknown): void => {
      unhandledRejection = error
    }
    process.on('unhandledRejection', handleUnhandledRejection)
    spawnMock.mockImplementation((command: string) => {
      if (command.toLowerCase().endsWith('taskkill.exe')) {
        return taskkill
      }
      queueMicrotask(() => child.emit('spawn'))
      return child
    })

    const { runGitCommand } = await import('./gitCommandRunner')
    const resultPromise = runGitCommand({
      binary: 'git',
      args: ['status'],
      cwd: process.cwd(),
      timeoutMs: 25,
      maxOutputBytes: 1024,
    })

    await jest.advanceTimersByTimeAsync(25)
    expect(spawnMock).toHaveBeenCalledTimes(2)
    await jest.advanceTimersByTimeAsync(2_000)
    await expect(resultPromise).resolves.toMatchObject({ timedOut: true })

    taskkill.emit('close', 1)
    await jest.advanceTimersByTimeAsync(0)
    process.removeListener('unhandledRejection', handleUnhandledRejection)

    expect(child.kill).not.toHaveBeenCalled()
    expect(unhandledRejection).toBeUndefined()
  })
})
