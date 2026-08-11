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

  it('serializes concurrent reconcile calls — the server is created and listens exactly once', async () => {
    // 回归：首启空 token 时 ensureWebRuntimeToken → saveSettings 同步触发
    // settings 监听 → reconcile 再入，与首轮并发会双建 WebHttpServer 双
    // listen（EADDRINUSE 误报）。单飞后第二次调用共享 in-flight promise，
    // 首轮完成后 boundKey 匹配直接返回。
    const settings = {
      webRuntime: {
        enabled: true,
        host: '127.0.0.1',
        port: 18900,
        token: '',
      },
    }
    const calls: string[] = []
    let releaseListen: () => void = () => undefined
    // Promise executor 同步执行：new Promise 返回前 releaseListen 必已赋值。
    const listenGate = new Promise<void>((resolve) => {
      releaseListen = resolve
    })
    const lifecycle = new WebServerLifecycle({
      getSettings: () => settings,
      createServer: () =>
        ({
          listen: async () => {
            calls.push('listen')
            // 挂起首个 listen，保证第二个 reconcile 在首轮完成前进入。
            await listenGate
          },
          close: async () => {
            calls.push('close')
          },
        }) as never,
    })

    const first = lifecycle.reconcile()
    const second = lifecycle.reconcile()
    releaseListen()
    await Promise.all([first, second])

    expect(calls).toEqual(['listen'])
    expect(lifecycle.isRunning).toBe(true)
  })

  it('re-evaluates current settings after an in-flight reconcile completes (toggle-off during startup)', async () => {
    const settings = {
      webRuntime: {
        enabled: true,
        host: '127.0.0.1',
        port: 18900,
        token: '',
      },
    }
    const calls: string[] = []
    let releaseListen: () => void = () => undefined
    // Promise executor 同步执行：new Promise 返回前 releaseListen 必已赋值。
    const listenGate = new Promise<void>((resolve) => {
      releaseListen = resolve
    })
    const lifecycle = new WebServerLifecycle({
      getSettings: () => settings,
      createServer: () =>
        ({
          listen: async () => {
            calls.push('listen')
            await listenGate
          },
          close: async () => {
            calls.push('close')
          },
        }) as never,
    })

    const first = lifecycle.reconcile()
    settings.webRuntime.enabled = false
    const second = lifecycle.reconcile()
    releaseListen()
    await Promise.all([first, second])

    expect(calls).toEqual(['listen', 'close'])
    expect(lifecycle.isRunning).toBe(false)
  })
})
