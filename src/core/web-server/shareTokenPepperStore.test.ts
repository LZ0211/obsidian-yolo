/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import * as crypto from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { loadOrCreateShareTokenPepper } from './shareTokenPepperStore'

describe('shareTokenPepperStore', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('defers Node crypto, fs, and path loading until desktop pepper storage runs', () => {
    const source = readFileSync(
      path.join(__dirname, 'shareTokenPepperStore.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:(crypto|fs|path)'/)
    expect(source).toContain('loadDesktopNodeModuleSync')
  })

  it('creates and reuses a plugin-private pepper file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    try {
      const first = loadOrCreateShareTokenPepper(dir)
      const second = loadOrCreateShareTokenPepper(dir)

      expect(first).toBe(second)
      expect(Buffer.from(first, 'base64url')).toHaveLength(32)
      expect(readFileSync(path.join(dir, 'share-token-pepper'), 'utf8')).toBe(
        first,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('generates a new pepper when the private file is missing', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    try {
      const first = loadOrCreateShareTokenPepper(dir)
      unlinkSync(path.join(dir, 'share-token-pepper'))
      const second = loadOrCreateShareTokenPepper(dir)

      expect(existsSync(path.join(dir, 'share-token-pepper'))).toBe(true)
      expect(second).not.toBe(first)
      expect(Buffer.from(second, 'base64url')).toHaveLength(32)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not expose a zero-byte pepper file during missing-file creation', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    const pepperPath = path.join(dir, 'share-token-pepper')
    const originalLinkSync = fs.linkSync
    let observedTargetDuringPublish = false

    try {
      jest.spyOn(fs, 'linkSync').mockImplementation(((
        existingPath,
        newPath,
      ) => {
        if (newPath === pepperPath) {
          observedTargetDuringPublish = existsSync(pepperPath)
        }
        return originalLinkSync(existingPath, newPath)
      }) as typeof fs.linkSync)

      const pepper = loadOrCreateShareTokenPepper(dir)

      expect(Buffer.from(pepper, 'base64url')).toHaveLength(32)
      expect(observedTargetDuringPublish).toBe(false)
      expect(readFileSync(pepperPath, 'utf8')).toBe(pepper)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces malformed existing pepper contents with a new valid pepper', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    const pepperPath = path.join(dir, 'share-token-pepper')
    try {
      writeFileSync(pepperPath, 'not-valid-base64url', 'utf8')

      const pepper = loadOrCreateShareTokenPepper(dir)

      expect(pepper).not.toBe('not-valid-base64url')
      expect(Buffer.from(pepper, 'base64url')).toHaveLength(32)
      expect(readFileSync(pepperPath, 'utf8')).toBe(pepper)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovers from a stale lock when the pepper file is still corrupt', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    const pepperPath = path.join(dir, 'share-token-pepper')
    const lockPath = `${pepperPath}.lock`
    try {
      writeFileSync(pepperPath, 'still-corrupt', 'utf8')
      writeFileSync(lockPath, 'stale-lock', 'utf8')
      utimesSync(lockPath, new Date(0), new Date(0))

      const pepper = loadOrCreateShareTokenPepper(dir)

      expect(Buffer.from(pepper, 'base64url')).toHaveLength(32)
      expect(readFileSync(pepperPath, 'utf8')).toBe(pepper)
      expect(existsSync(lockPath)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('recovers quickly from a fresh lock owned by a dead pid when the pepper file is corrupt', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    const pepperPath = path.join(dir, 'share-token-pepper')
    const lockPath = `${pepperPath}.lock`
    try {
      writeFileSync(pepperPath, 'still-corrupt', 'utf8')
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: 99_999,
          nonce: 'dead-owner',
          createdAt: Date.now(),
        }),
        'utf8',
      )

      const processKillSpy = jest.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: number | NodeJS.Signals,
      ) => {
        if (pid === 99_999 && signal === 0) {
          const error = new Error('ESRCH') as NodeJS.ErrnoException
          error.code = 'ESRCH'
          throw error
        }

        return true
      }) as typeof process.kill)
      const atomicsWaitSpy = jest
        .spyOn(Atomics, 'wait')
        .mockImplementation(() => 'timed-out')

      const pepper = loadOrCreateShareTokenPepper(dir)

      expect(Buffer.from(pepper, 'base64url')).toHaveLength(32)
      expect(readFileSync(pepperPath, 'utf8')).toBe(pepper)
      expect(existsSync(lockPath)).toBe(false)
      expect(processKillSpy).toHaveBeenCalledWith(99_999, 0)
      expect(atomicsWaitSpy).not.toHaveBeenCalled()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not reclaim a fresh lock from a live owner and returns the published pepper once it appears', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    const pepperPath = path.join(dir, 'share-token-pepper')
    const lockPath = `${pepperPath}.lock`
    const publishedPepper = Buffer.alloc(32, 7).toString('base64url')
    const originalReadFileSync = fs.readFileSync
    const originalDateNow = Date.now
    let fakeNow = 10_000

    try {
      writeFileSync(pepperPath, 'still-corrupt', 'utf8')
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: 4_242,
          nonce: 'live-owner',
          createdAt: fakeNow,
        }),
        'utf8',
      )

      jest.spyOn(Date, 'now').mockImplementation(() => fakeNow)
      jest.spyOn(Atomics, 'wait').mockImplementation(((
        _array,
        _index,
        _value,
        timeout,
      ) => {
        fakeNow += timeout ?? 0
        if (fakeNow >= 11_500) {
          writeFileSync(pepperPath, publishedPepper, 'utf8')
          rmSync(lockPath, { force: true })
        }
        return 'timed-out'
      }) as typeof Atomics.wait)
      const processKillSpy = jest.spyOn(process, 'kill').mockImplementation(((
        pid: number,
        signal?: number | NodeJS.Signals,
      ) => {
        if (pid === 4_242 && signal === 0) {
          return true
        }
        return true
      }) as typeof process.kill)
      jest.spyOn(fs, 'readFileSync').mockImplementation(((pathArg, options) => {
        if (pathArg === pepperPath) {
          return originalReadFileSync(pathArg, options as never)
        }
        return originalReadFileSync(pathArg as never, options as never)
      }) as typeof fs.readFileSync)

      const pepper = loadOrCreateShareTokenPepper(dir)

      expect(pepper).toBe(publishedPepper)
      expect(readFileSync(pepperPath, 'utf8')).toBe(publishedPepper)
      expect(processKillSpy).toHaveBeenCalledWith(4_242, 0)
      expect(fakeNow).toBeGreaterThanOrEqual(11_500)
    } finally {
      Date.now = originalDateNow
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not expose a metadata-less fresh lock during acquisition', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    const pepperPath = path.join(dir, 'share-token-pepper')
    const lockPath = `${pepperPath}.lock`
    const originalLinkSync = fs.linkSync
    let observedLockDuringPublish = false

    try {
      writeFileSync(pepperPath, 'still-corrupt', 'utf8')
      jest.spyOn(fs, 'linkSync').mockImplementation(((
        existingPath,
        newPath,
      ) => {
        if (newPath === lockPath) {
          observedLockDuringPublish = existsSync(lockPath)
        }
        return originalLinkSync(existingPath, newPath)
      }) as typeof fs.linkSync)

      const pepper = loadOrCreateShareTokenPepper(dir)

      expect(Buffer.from(pepper, 'base64url')).toHaveLength(32)
      expect(observedLockDuringPublish).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('does not delete a newly published live lock while reclaiming an old one', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    const pepperPath = path.join(dir, 'share-token-pepper')
    const lockPath = `${pepperPath}.lock`
    const liveMetadata = {
      pid: 5_555,
      nonce: 'new-live-owner',
      createdAt: Date.now(),
    }
    const originalRenameSync = fs.renameSync
    let renamedOldLock = false
    let waited = false

    try {
      writeFileSync(pepperPath, 'still-corrupt', 'utf8')
      writeFileSync(
        lockPath,
        JSON.stringify({
          pid: 99_999,
          nonce: 'old-dead-owner',
          createdAt: 1,
        }),
        'utf8',
      )
      jest.spyOn(process, 'kill').mockImplementation(((pid: number) => {
        if (pid === 99_999) {
          const error = new Error('ESRCH') as NodeJS.ErrnoException
          error.code = 'ESRCH'
          throw error
        }
        return true
      }) as typeof process.kill)
      jest.spyOn(fs, 'renameSync').mockImplementation(((oldPath, newPath) => {
        if (oldPath === lockPath && !renamedOldLock) {
          renamedOldLock = true
          originalRenameSync(oldPath, newPath)
          writeFileSync(lockPath, JSON.stringify(liveMetadata), 'utf8')
          return
        }
        return originalRenameSync(oldPath, newPath)
      }) as typeof fs.renameSync)
      jest.spyOn(Atomics, 'wait').mockImplementation((() => {
        waited = true
        const publishedPepper = Buffer.alloc(32, 4).toString('base64url')
        writeFileSync(pepperPath, publishedPepper, 'utf8')
        rmSync(lockPath, { force: true })
        return 'timed-out'
      }) as typeof Atomics.wait)

      const pepper = loadOrCreateShareTokenPepper(dir)

      expect(waited).toBe(true)
      expect(Buffer.from(pepper, 'base64url')).toHaveLength(32)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses a valid pepper created by another initializer during exclusive create', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    const pepperPath = path.join(dir, 'share-token-pepper')
    const competingPepper = Buffer.alloc(32, 9).toString('base64url')
    const originalLinkSync = fs.linkSync
    try {
      jest.spyOn(fs, 'linkSync').mockImplementation(((
        existingPath,
        newPath,
      ) => {
        if (newPath === pepperPath) {
          writeFileSync(pepperPath, competingPepper, 'utf8')
          const error = new Error('EEXIST') as NodeJS.ErrnoException
          error.code = 'EEXIST'
          throw error
        }

        return originalLinkSync(existingPath, newPath)
      }) as typeof fs.linkSync)

      const pepper = loadOrCreateShareTokenPepper(dir)

      expect(pepper).toBe(competingPepper)
      expect(readFileSync(pepperPath, 'utf8')).toBe(competingPepper)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns the same regenerated pepper for colliding corrupt-file initializers', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'yolo-pepper-'))
    const pepperPath = path.join(dir, 'share-token-pepper')
    const firstCandidate = Buffer.alloc(32, 1).toString('base64url')
    const secondCandidate = Buffer.alloc(32, 2).toString('base64url')
    const finalPepper = Buffer.alloc(32, 3).toString('base64url')
    const originalReadFileSync = fs.readFileSync
    const originalRenameSync = fs.renameSync

    try {
      writeFileSync(pepperPath, 'corrupt-pepper', 'utf8')

      jest
        .spyOn(crypto, 'randomBytes')
        .mockReturnValueOnce(
          Buffer.alloc(32, 1) as unknown as ReturnType<
            typeof crypto.randomBytes
          >,
        )
        .mockReturnValueOnce(
          Buffer.alloc(32, 2) as unknown as ReturnType<
            typeof crypto.randomBytes
          >,
        )
      jest.spyOn(fs, 'renameSync').mockImplementation(((oldPath, newPath) => {
        if (newPath === pepperPath) {
          writeFileSync(newPath, finalPepper, 'utf8')
          unlinkSync(oldPath)
          return
        }
        return originalRenameSync(oldPath, newPath)
      }) as typeof fs.renameSync)
      jest.spyOn(fs, 'readFileSync').mockImplementation(((pathArg, options) => {
        if (pathArg === pepperPath) {
          return originalReadFileSync(pathArg, options as never)
        }
        return originalReadFileSync(pathArg as never, options as never)
      }) as typeof fs.readFileSync)

      const first = loadOrCreateShareTokenPepper(dir)
      const second = loadOrCreateShareTokenPepper(dir)

      expect(first).toBe(finalPepper)
      expect(second).toBe(finalPepper)
      expect(first).not.toBe(firstCandidate)
      expect(second).not.toBe(secondCandidate)
      expect(readFileSync(pepperPath, 'utf8')).toBe(finalPepper)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
