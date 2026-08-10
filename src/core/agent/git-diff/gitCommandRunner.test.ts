import { runGitCommand } from './gitCommandRunner'

const MAX_PROMPT_EXIT_MS = 7_500
const MAX_FAST_TERMINATION_MS = 1_900

const isPositivePid = (pid: number): boolean =>
  Number.isSafeInteger(pid) && pid > 0

const parsePositivePid = (value: string): number | null => {
  if (!/^[1-9]\d*$/.test(value)) return null
  const pid = Number(value)
  return isPositivePid(pid) ? pid : null
}

const isProcessRunning = (pid: number): boolean => {
  if (!isPositivePid(pid)) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

const waitForProcessExit = async (
  pid: number,
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessRunning(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  return !isProcessRunning(pid)
}

const forceKillProcess = (pid: number): void => {
  if (!isPositivePid(pid) || !isProcessRunning(pid)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    return
  }
}

describe('runGitCommand', () => {
  jest.setTimeout(15_000)

  const baseRequest = {
    binary: process.execPath,
    cwd: process.cwd(),
    timeoutMs: 2_000,
    maxOutputBytes: 1_024,
  }

  it('captures stdout from a successful command', async () => {
    const result = await runGitCommand({
      ...baseRequest,
      args: ['-e', 'process.stdout.write("ok")'],
    })

    expect(result).toEqual({
      code: 0,
      stdout: 'ok',
      stderr: '',
      timedOut: false,
      outputExceeded: false,
    })
  })

  it('terminates a command after its timeout', async () => {
    const startedAt = Date.now()

    const result = await runGitCommand({
      ...baseRequest,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      timeoutMs: 25,
    })

    expect(result.timedOut).toBe(true)
    expect(Date.now() - startedAt).toBeLessThan(MAX_PROMPT_EXIT_MS)
  })

  it('terminates a command when combined output exceeds the byte cap', async () => {
    const startedAt = Date.now()

    const result = await runGitCommand({
      ...baseRequest,
      args: ['-e', 'process.stdout.write("x".repeat(4096))'],
      maxOutputBytes: 128,
    })

    expect(result.outputExceeded).toBe(true)
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBeLessThanOrEqual(128)
    expect(Date.now() - startedAt).toBeLessThan(MAX_FAST_TERMINATION_MS)
  })

  it('applies one combined cap across mixed stdout and stderr', async () => {
    const result = await runGitCommand({
      ...baseRequest,
      args: [
        '-e',
        [
          'process.stdout.write("o".repeat(64))',
          'setTimeout(() => process.stderr.write("e".repeat(4096)), 100)',
          'setTimeout(() => {}, 10_000)',
        ].join(';'),
      ],
      maxOutputBytes: 128,
    })

    expect(result.outputExceeded).toBe(true)
    expect(result.stdout).toBe('o'.repeat(64))
    expect(result.stderr).toBe('e'.repeat(64))
    expect(
      Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
    ).toBe(128)
  })

  it('drops an incomplete trailing UTF-8 code point', async () => {
    const result = await runGitCommand({
      ...baseRequest,
      args: ['-e', 'process.stdout.write("a🙂")'],
      maxOutputBytes: 2,
    })

    expect(result.outputExceeded).toBe(true)
    expect(result.stdout).toBe('a')
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(2)
  })

  it('resolves with stderr and the exit code for a failed command', async () => {
    const result = await runGitCommand({
      ...baseRequest,
      args: ['-e', 'process.stderr.write("failed"); process.exit(7)'],
    })

    expect(result).toEqual({
      code: 7,
      stdout: '',
      stderr: 'failed',
      timedOut: false,
      outputExceeded: false,
    })
  })

  it('resolves spawn failures as bounded error data', async () => {
    const result = await runGitCommand({
      ...baseRequest,
      binary: `${process.execPath}.smart-rag-missing`,
      args: [],
    })

    expect(result.code).toBeNull()
    expect(result.stdout).toBe('')
    expect(result.stderr.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(
      baseRequest.maxOutputBytes,
    )
    expect(result.timedOut).toBe(false)
    expect(result.outputExceeded).toBe(false)
  })

  it.each([
    ['timeoutMs', 0],
    ['timeoutMs', Number.NaN],
    ['timeoutMs', Number.POSITIVE_INFINITY],
    ['maxOutputBytes', 0],
    ['maxOutputBytes', -1],
    ['maxOutputBytes', Number.NaN],
    ['maxOutputBytes', Number.POSITIVE_INFINITY],
  ] as const)(
    'rejects invalid %s value %p before spawning',
    async (key, value) => {
      const result = await runGitCommand({
        ...baseRequest,
        args: ['-e', 'process.stdout.write("started")'],
        [key]: value,
      })

      expect(result.code).toBeNull()
      expect(result.stdout).toBe('')
      expect(result.stderr).toContain(key)
      expect(result.timedOut).toBe(false)
      expect(result.outputExceeded).toBe(false)
    },
  )

  it('tolerates stdin closing before all input is written', async () => {
    const result = await runGitCommand({
      ...baseRequest,
      args: [
        '-e',
        'process.stdin.destroy(); setTimeout(() => process.exit(0), 100)',
      ],
      stdin: 'x'.repeat(1024 * 1024),
    })

    expect(result.code).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.outputExceeded).toBe(false)
  })

  it('force kills descendant processes on timeout', async () => {
    const descendantScript = 'setTimeout(() => {}, 10_000)'
    const parentScript = [
      'const { spawn } = require("node:child_process")',
      `const descendant = spawn(${JSON.stringify(process.execPath)}, ['-e', ${JSON.stringify(descendantScript)}], { stdio: 'ignore' })`,
      'process.stdout.write(String(descendant.pid))',
      'process.on("SIGTERM", () => {})',
      'setTimeout(() => {}, 10_000)',
    ].join(';')
    const startedAt = Date.now()

    const result = await runGitCommand({
      ...baseRequest,
      args: ['-e', parentScript],
      timeoutMs: 250,
    })
    const descendantPid = parsePositivePid(result.stdout)

    expect(result.timedOut).toBe(true)
    expect(descendantPid).not.toBeNull()
    if (descendantPid === null) {
      throw new Error('Expected a positive descendant PID')
    }
    try {
      if (process.platform === 'win32') {
        expect(isProcessRunning(descendantPid)).toBe(false)
      } else {
        expect(await waitForProcessExit(descendantPid, 2_000)).toBe(true)
      }
    } finally {
      if (isProcessRunning(descendantPid)) forceKillProcess(descendantPid)
    }
    expect(Date.now() - startedAt).toBeLessThan(MAX_PROMPT_EXIT_MS)
  })
})
