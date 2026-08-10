import { loadDesktopNodeModuleSync } from '../../../utils/platform/desktopNodeModule'

import { sha256HexPure } from './sha256Pure'

const SHA256_HEX = /^[a-f0-9]{64}$/

export function sha256Hex(value: string): string {
  try {
    const { createHash } =
      loadDesktopNodeModuleSync<typeof import('node:crypto')>('node:crypto')
    return createHash('sha256').update(value, 'utf8').digest('hex')
  } catch {
    return sha256HexPure(value)
  }
}

export function assertSha256Hex(value: string, field: string): void {
  if (!SHA256_HEX.test(value)) {
    throw new Error(`${field} must be a lowercase full SHA-256 hash`)
  }
}
