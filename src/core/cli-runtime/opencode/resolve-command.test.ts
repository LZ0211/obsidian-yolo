/* eslint-disable import/no-nodejs-modules -- exercises the desktop-only OpenCode executable discovery boundary */
import { access } from 'node:fs/promises'
/* eslint-enable import/no-nodejs-modules */

import {
  findOpenCodeExecutable,
  resolveOpenCodeCommand,
} from './resolve-command'

jest.mock('node:fs/promises', () => ({
  access: jest.fn(),
  constants: { X_OK: 1 },
}))

const mockedAccess = jest.mocked(access)

describe('OpenCode executable discovery', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('finds opencode on PATH', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/usr/local/bin/opencode') return
      throw new Error('ENOENT')
    })

    await expect(
      findOpenCodeExecutable(
        { PATH: '/usr/local/bin', HOME: '/home/me' },
        'darwin',
      ),
    ).resolves.toBe('/usr/local/bin/opencode')
  })

  it('probes the Windows npm bin directory and command wrapper names', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (
        String(candidate) ===
        'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd'
      ) {
        return
      }
      throw new Error('ENOENT')
    })

    await expect(
      findOpenCodeExecutable(
        {
          PATH: '',
          APPDATA: 'C:\\Users\\me\\AppData\\Roaming',
          USERPROFILE: 'C:\\Users\\me',
        },
        'win32',
      ),
    ).resolves.toBe(
      'C:\\Users\\me\\AppData\\Roaming\\npm\\opencode.cmd',
    )
  })

  it('returns null when no candidate exists anywhere', async () => {
    await expect(
      findOpenCodeExecutable(
        { PATH: '/usr/bin', HOME: '/home/me' },
        'linux',
      ),
    ).resolves.toBeNull()
  })
})

describe('resolveOpenCodeCommand', () => {
  beforeEach(() => mockedAccess.mockRejectedValue(new Error('ENOENT')))

  it('prefers an existing configured cli-path override', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/opt/custom/opencode') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveOpenCodeCommand(
        { PATH: '/usr/bin', HOME: '/home/me' },
        'linux',
        '/opt/custom/opencode',
      ),
    ).resolves.toEqual({ command: '/opt/custom/opencode', args: ['acp'] })
  })

  it('falls through to auto-detection after a missing override', async () => {
    mockedAccess.mockImplementation(async (candidate) => {
      if (String(candidate) === '/home/me/.local/bin/opencode') return
      throw new Error('ENOENT')
    })

    await expect(
      resolveOpenCodeCommand(
        { PATH: '/usr/bin', HOME: '/home/me' },
        'linux',
        '/does/not/exist/opencode',
      ),
    ).resolves.toEqual({
      command: '/home/me/.local/bin/opencode',
      args: ['acp'],
    })
  })
})
