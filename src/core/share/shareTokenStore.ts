import { loadDesktopNodeModuleSync } from '../../utils/platform/desktopNodeModule'

type WebRuntimeSettingsHolder = {
  webRuntime: {
    host: string
    token: string
  }
}

const getCrypto = () =>
  loadDesktopNodeModuleSync<typeof import('node:crypto')>('node:crypto')

export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1'
  )
}

export function createWebRuntimeServerToken(): string {
  return getCrypto().randomBytes(32).toString('base64url')
}

export function ensureWebRuntimeToken<T extends WebRuntimeSettingsHolder>(
  settings: T,
  generateToken: () => string = createWebRuntimeServerToken,
): string {
  if (isLoopbackHost(settings.webRuntime.host)) {
    return settings.webRuntime.token
  }
  if (!settings.webRuntime.token) {
    settings.webRuntime.token = generateToken()
  }
  return settings.webRuntime.token
}
