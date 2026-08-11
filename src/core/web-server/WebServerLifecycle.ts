import { ensureWebRuntimeToken } from '../share/shareTokenStore'

import { WebHttpServer } from './WebHttpServer'

export type WebRuntimeSettings = {
  enabled: boolean
  host: string
  port: number
  token: string
}

export type WebRuntimeSettingsHolder = {
  webRuntime: WebRuntimeSettings
}

export type WebServerLifecycleOptions<
  TSettings extends WebRuntimeSettingsHolder,
> = {
  getSettings: () => TSettings
  saveSettings?: (settings: TSettings) => Promise<void> | void
  createServer?: (settings: WebRuntimeSettings) => WebHttpServer
}

export class WebServerLifecycle<TSettings extends WebRuntimeSettingsHolder> {
  private server: WebHttpServer | null = null
  private boundKey: string | null = null
  /**
   * 在飞的 reconcile（单飞串行化）。首启空 token 时 `ensureWebRuntimeToken`
   * 经 saveSettings 落库会同步触发 settings 变更监听 → reconcile 再入，与首轮
   * 并发时 server 仍为 null，若各自建 server 会双 listen（EADDRINUSE 误报）。
   * 再入调用共享此 promise；首轮完成后按最新 settings 重新评估（boundKey
   * 匹配即返回，开关翻转则 stop）。
   */
  private reconcileInFlight: Promise<void> | null = null

  constructor(private readonly options: WebServerLifecycleOptions<TSettings>) {}

  async reconcile(): Promise<void> {
    const inFlight = this.reconcileInFlight
    if (inFlight != null) {
      await inFlight
      return this.reconcile()
    }

    const run = this.runReconcile()
    this.reconcileInFlight = run
    try {
      await run
    } finally {
      if (this.reconcileInFlight === run) {
        this.reconcileInFlight = null
      }
    }
  }

  private async runReconcile(): Promise<void> {
    const settings = this.options.getSettings()
    const runtime = settings.webRuntime
    if (!runtime.enabled) {
      await this.stop()
      return
    }

    const beforeToken = runtime.token
    ensureWebRuntimeToken(settings)
    if (runtime.token !== beforeToken) {
      await this.options.saveSettings?.(settings)
    }

    const nextKey = `${runtime.host}:${runtime.port}:${runtime.token}`
    if (this.server != null && this.boundKey === nextKey) {
      return
    }

    await this.stop()
    const server =
      this.options.createServer?.(runtime) ??
      new WebHttpServer({
        host: runtime.host,
        port: runtime.port,
        token: runtime.token,
      })
    await server.listen()
    this.server = server
    this.boundKey = nextKey
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    this.boundKey = null
    if (server != null) {
      await server.close()
    }
  }

  get isRunning(): boolean {
    return this.server != null
  }
}
