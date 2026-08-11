import { loadDesktopNodeModuleSync } from '../../utils/platform/desktopNodeModule'

const TOKEN_PREFIX = 'yolo_share_v1'
const TOKEN_HASH_VERSION = 'hmac-sha256-v1'
type RootHashPlatform = NodeJS.Platform | 'linux'

const getCrypto = () =>
  loadDesktopNodeModuleSync<typeof import('node:crypto')>('node:crypto')

const getPath = () =>
  loadDesktopNodeModuleSync<typeof import('node:path')>('node:path')

export type CreatedShareToken = {
  plaintext: string
  publicTokenId: string
}

export function createShareToken(): CreatedShareToken {
  const crypto = getCrypto()
  const publicTokenId = crypto.randomBytes(12).toString('hex')
  const secret = crypto.randomBytes(32).toString('hex')

  return {
    publicTokenId,
    plaintext: `${TOKEN_PREFIX}_${publicTokenId}_${secret}`,
  }
}

export function hashShareToken(plaintext: string, pepper: string): string {
  const crypto = getCrypto()
  const digest = crypto
    .createHmac('sha256', decodePepper(pepper))
    .update(plaintext, 'utf8')
    .digest('base64url')

  return `${TOKEN_HASH_VERSION}:${digest}`
}

export function verifyShareToken(
  plaintext: string,
  expectedHash: string,
  pepper: string,
): boolean {
  const expectedDigest = parseHashDigest(expectedHash)
  if (!expectedDigest) return false

  const actualDigest = parseHashDigest(hashShareToken(plaintext, pepper))
  if (!actualDigest || actualDigest.byteLength !== expectedDigest.byteLength) {
    return false
  }

  return getCrypto().timingSafeEqual(actualDigest, expectedDigest)
}

export function parsePublicTokenId(plaintext: string): string | null {
  const match = plaintext.match(/^yolo_share_v1_([^_]+)_[^_]+$/)
  return match?.[1] ?? null
}

export function normalizeVaultRootPath(input: string): string {
  let decoded: string
  try {
    decoded = decodeURIComponent(input || '/')
  } catch {
    throw new Error('invalid_root')
  }

  const slashPath = decoded.normalize('NFC').replace(/\\/g, '/')
  if (/^[A-Za-z]:($|\/)/.test(slashPath) || slashPath.startsWith('//')) {
    throw new Error('invalid_root')
  }

  const normalized = getPath().posix.normalize(`/${slashPath}`)
  return normalized.replace(/\/+$/g, '') || '/'
}

export function hashWorkspaceRoot(root: string, vaultIdentity: string): string {
  return hashWorkspaceRootForPlatform(root, vaultIdentity, process.platform)
}

export function hashWorkspaceRootForPlatform(
  root: string,
  vaultIdentity: string,
  platform: RootHashPlatform,
): string {
  const normalized = normalizeVaultRootPath(root)
  const hashInput =
    platform === 'win32'
      ? `${vaultIdentity}:${normalized}`.toLowerCase()
      : `${vaultIdentity}:${normalized}`

  return getCrypto()
    .createHash('sha256')
    .update(hashInput, 'utf8')
    .digest('base64url')
}

function decodePepper(pepper: string): Buffer {
  return Buffer.from(pepper, 'base64url')
}

function parseHashDigest(hash: string): Buffer | null {
  const prefix = `${TOKEN_HASH_VERSION}:`
  if (!hash.startsWith(prefix)) return null

  const digest = hash.slice(prefix.length)
  if (!isCanonicalBase64UrlDigest(digest)) return null

  let decoded: Buffer
  try {
    decoded = Buffer.from(digest, 'base64url')
  } catch {
    return null
  }

  if (decoded.length !== 32) {
    return null
  }

  return decoded.toString('base64url') === digest ? decoded : null
}

function isCanonicalBase64UrlDigest(digest: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(digest)
}
