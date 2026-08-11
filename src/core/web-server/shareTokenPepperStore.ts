import { loadDesktopNodeModuleSync } from '../../utils/platform/desktopNodeModule'

const PEPPER_FILE_NAME = 'share-token-pepper'
const PEPPER_SIZE_BYTES = 32
const LOCK_WAIT_INTERVAL_MS = 10
const STALE_LOCK_TIMEOUT_MS = 30_000

type LockMetadata = {
  pid: number
  nonce: string
  createdAt: number
}

type LockState = 'live' | 'reclaimable' | 'missing'

const getCrypto = () =>
  loadDesktopNodeModuleSync<typeof import('node:crypto')>('node:crypto')

const getFs = () =>
  loadDesktopNodeModuleSync<typeof import('node:fs')>('node:fs')

const getPath = () =>
  loadDesktopNodeModuleSync<typeof import('node:path')>('node:path')

export function loadOrCreateShareTokenPepper(yoloBaseDir: string): string {
  getFs().mkdirSync(yoloBaseDir, { recursive: true })

  const pepperPath = getPath().join(yoloBaseDir, PEPPER_FILE_NAME)
  const existingPepper = readValidPepper(pepperPath)
  if (existingPepper) {
    return existingPepper
  }

  const pepper = createPepper()
  try {
    publishPepperIfMissing(pepperPath, pepper)
    return pepper
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      const racedPepper = readValidPepper(pepperPath)
      if (racedPepper) {
        return racedPepper
      }
    } else {
      throw error
    }
  }

  return regenerateCorruptPepper(pepperPath)
}

function readValidPepper(pepperPath: string): string | null {
  if (!getFs().existsSync(pepperPath)) {
    return null
  }

  const pepper = getFs().readFileSync(pepperPath, 'utf8').trim()
  if (!pepper) {
    return null
  }

  let decoded: Buffer
  try {
    decoded = Buffer.from(pepper, 'base64url')
  } catch {
    return null
  }

  if (decoded.length !== PEPPER_SIZE_BYTES) {
    return null
  }

  return decoded.toString('base64url') === pepper ? pepper : null
}

function regenerateCorruptPepper(pepperPath: string): string {
  const lockPath = `${pepperPath}.lock`
  const lockAcquired = tryAcquireLock(lockPath)
  if (lockAcquired) {
    try {
      const currentPepper = readValidPepper(pepperPath)
      if (currentPepper) {
        return currentPepper
      }

      const pepper = createPepper()
      replacePepperAtomically(pepperPath, pepper)

      const persistedPepper = readValidPepper(pepperPath)
      if (!persistedPepper) {
        throw new Error('Failed to persist regenerated share token pepper')
      }

      return persistedPepper
    } finally {
      getFs().rmSync(lockPath, { force: true })
    }
  }

  return waitForValidPepper(pepperPath, lockPath)
}

function tryAcquireLock(lockPath: string): boolean {
  for (;;) {
    const tempLockPath = `${lockPath}.${process.pid}.${getCrypto().randomUUID()}.tmp`
    try {
      writeLockMetadataFile(tempLockPath)
      getFs().linkSync(tempLockPath, lockPath)
      return true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw error
      }

      if (getLockState(lockPath) !== 'reclaimable') {
        return false
      }

      if (!reclaimLock(lockPath)) {
        return false
      }
    } finally {
      getFs().rmSync(tempLockPath, { force: true })
    }
  }
}

function waitForValidPepper(pepperPath: string, lockPath: string): string {
  for (;;) {
    const pepper = readValidPepper(pepperPath)
    if (pepper) {
      return pepper
    }

    const lockState = getLockState(lockPath)
    if (lockState === 'missing') {
      return regenerateCorruptPepper(pepperPath)
    }

    if (lockState === 'reclaimable') {
      if (reclaimLock(lockPath)) {
        return regenerateCorruptPepper(pepperPath)
      }
    }

    sleep(LOCK_WAIT_INTERVAL_MS)
  }
}

function getLockState(lockPath: string): LockState {
  try {
    const stats = getFs().statSync(lockPath)
    const metadata = readLockMetadata(lockPath)
    if (!metadata) {
      return 'reclaimable'
    }

    if (
      Date.now() - stats.mtimeMs >= STALE_LOCK_TIMEOUT_MS ||
      Date.now() - metadata.createdAt >= STALE_LOCK_TIMEOUT_MS
    ) {
      return 'reclaimable'
    }

    return isProcessAlive(metadata.pid) ? 'live' : 'reclaimable'
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 'missing'
    }
    throw error
  }
}

function readLockMetadata(lockPath: string): LockMetadata | null {
  let rawMetadata: string
  try {
    rawMetadata = getFs().readFileSync(lockPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }

  let metadata: unknown
  try {
    metadata = JSON.parse(rawMetadata)
  } catch {
    return null
  }

  if (
    !metadata ||
    typeof metadata !== 'object' ||
    typeof (metadata as LockMetadata).pid !== 'number' ||
    !Number.isInteger((metadata as LockMetadata).pid) ||
    (metadata as LockMetadata).pid <= 0 ||
    typeof (metadata as LockMetadata).nonce !== 'string' ||
    (metadata as LockMetadata).nonce.length === 0 ||
    typeof (metadata as LockMetadata).createdAt !== 'number' ||
    !Number.isFinite((metadata as LockMetadata).createdAt)
  ) {
    return null
  }

  return metadata as LockMetadata
}

function writeLockMetadataFile(lockPath: string): void {
  const metadata: LockMetadata = {
    pid: process.pid,
    nonce: getCrypto().randomUUID(),
    createdAt: Date.now(),
  }
  getFs().writeFileSync(lockPath, JSON.stringify(metadata), {
    encoding: 'utf8',
    mode: 0o600,
  })
}

function reclaimLock(lockPath: string): boolean {
  const before = readLockMetadata(lockPath)
  const reclaimPath = `${lockPath}.reclaim.${process.pid}.${getCrypto().randomUUID()}`
  try {
    getFs().renameSync(lockPath, reclaimPath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }

  if (!before) {
    getFs().rmSync(reclaimPath, { force: true })
    return true
  }

  const moved = readLockMetadata(reclaimPath)
  if (moved && sameLockMetadata(before, moved)) {
    getFs().rmSync(reclaimPath, { force: true })
    return true
  }

  try {
    if (!getFs().existsSync(lockPath)) {
      getFs().renameSync(reclaimPath, lockPath)
    }
  } catch {
    // Best effort: if another process won the path, leave the moved file for
    // stale cleanup instead of deleting a lock we no longer recognize.
  }
  return false
}

function replacePepperAtomically(pepperPath: string, pepper: string): void {
  const tempPath = `${pepperPath}.${process.pid}.${getCrypto().randomUUID()}.tmp`
  getFs().writeFileSync(tempPath, pepper, { encoding: 'utf8', mode: 0o600 })
  getFs().renameSync(tempPath, pepperPath)
}

function publishPepperIfMissing(pepperPath: string, pepper: string): void {
  const tempPath = `${pepperPath}.${process.pid}.${getCrypto().randomUUID()}.tmp`
  try {
    getFs().writeFileSync(tempPath, pepper, { encoding: 'utf8', mode: 0o600 })
    getFs().linkSync(tempPath, pepperPath)
  } finally {
    getFs().rmSync(tempPath, { force: true })
  }
}

function createPepper(): string {
  return getCrypto().randomBytes(PEPPER_SIZE_BYTES).toString('base64url')
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') {
      return false
    }

    if (code === 'EPERM') {
      return true
    }

    throw error
  }
}

function sameLockMetadata(left: LockMetadata, right: LockMetadata): boolean {
  return (
    left.pid === right.pid &&
    left.nonce === right.nonce &&
    left.createdAt === right.createdAt
  )
}
