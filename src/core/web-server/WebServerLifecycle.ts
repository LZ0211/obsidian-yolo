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

  constructor(private readonly options: WebServerLifecycleOptions<TSettings>) {}

  async reconcile(): Promise<void> {
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
