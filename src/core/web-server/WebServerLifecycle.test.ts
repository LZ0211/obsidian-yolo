import { WebServerLifecycle } from './WebServerLifecycle'

describe('WebServerLifecycle', () => {
  it('starts, reuses, and stops the configured server', async () => {
    const calls: string[] = []
    const settings = {
      webRuntime: {
        enabled: true,
        host: '127.0.0.1',
        port: 18900,
        token: '',
      },
    }
    const lifecycle = new WebServerLifecycle({
      getSettings: () => settings,
      createServer: (runtime) =>
        ({
          listen: async () => {
            calls.push(`listen:${runtime.host}:${runtime.port}`)
          },
          close: async () => {
            calls.push('close')
          },
        }) as never,
    })

    await lifecycle.reconcile()
    await lifecycle.reconcile()
    settings.webRuntime.enabled = false
    await lifecycle.reconcile()

    expect(calls).toEqual(['listen:127.0.0.1:18900', 'close'])
    expect(lifecycle.isRunning).toBe(false)
  })

  it('generates and persists a token before binding non-loopback hosts', async () => {
    const settings = {
      webRuntime: {
        enabled: true,
        host: '0.0.0.0',
        port: 18900,
        token: '',
      },
    }
    let savedToken = ''
    const lifecycle = new WebServerLifecycle({
      getSettings: () => settings,
      saveSettings: async (next) => {
        savedToken = next.webRuntime.token
      },
      createServer: () =>
        ({
          listen: async () => undefined,
          close: async () => undefined,
        }) as never,
    })

    await lifecycle.reconcile()

    expect(settings.webRuntime.token).not.toBe('')
    expect(savedToken).toBe(settings.webRuntime.token)
  })
})
