/* eslint-disable import/no-nodejs-modules -- 测试文件运行在 Node 环境，允许直接引入 node 内置模块进行 mock */
import { readFileSync } from 'node:fs'
import * as path from 'node:path'

import {
  createShareToken,
  hashShareToken,
  hashWorkspaceRoot,
  hashWorkspaceRootForPlatform,
  normalizeVaultRootPath,
  parsePublicTokenId,
  verifyShareToken,
} from './shareTokenCrypto'

describe('shareTokenCrypto', () => {
  it('defers Node crypto and path loading until desktop token operations run', () => {
    const source = readFileSync(
      path.join(__dirname, 'shareTokenCrypto.ts'),
      'utf8',
    )

    expect(source).not.toMatch(/from 'node:(crypto|path)'/)
    expect(source).toContain('loadDesktopNodeModuleSync')
  })

  it('creates versioned high entropy tokens with public id and secret', () => {
    const token = createShareToken()
    const match = token.plaintext.match(
      /^yolo_share_v1_([A-Za-z0-9-]+)_([A-Za-z0-9-]+)$/,
    )

    expect(token.plaintext).toMatch(
      /^yolo_share_v1_[A-Za-z0-9_-]+_[A-Za-z0-9_-]+$/,
    )
    expect(match).not.toBeNull()
    expect(token.publicTokenId.length).toBeGreaterThanOrEqual(12)
    expect(match?.[1]).toBe(token.publicTokenId)
    expect(Buffer.from(match?.[2] ?? '', 'hex')).toHaveLength(32)
  })

  it('hashes and verifies tokens with HMAC-SHA-256', () => {
    const token = createShareToken()
    const pepper = Buffer.alloc(32, 7).toString('base64url')
    const hash = hashShareToken(token.plaintext, pepper)

    expect(hash).toMatch(/^hmac-sha256-v1:/)
    expect(verifyShareToken(token.plaintext, hash, pepper)).toBe(true)
    expect(verifyShareToken(`${token.plaintext}x`, hash, pepper)).toBe(false)
    expect(
      verifyShareToken(
        token.plaintext,
        hash,
        Buffer.alloc(32, 8).toString('base64url'),
      ),
    ).toBe(false)
  })

  it('fails closed for malformed stored hash digests', () => {
    const token = createShareToken()
    const pepper = Buffer.alloc(32, 7).toString('base64url')
    const canonicalHash = hashShareToken(token.plaintext, pepper)
    const canonicalDigest = canonicalHash.slice('hmac-sha256-v1:'.length)
    const standardBase64Digest = Buffer.from(
      canonicalDigest,
      'base64url',
    ).toString('base64')

    expect(
      verifyShareToken(
        token.plaintext,
        `hmac-sha256-v1:${canonicalDigest}garbage`,
        pepper,
      ),
    ).toBe(false)
    expect(
      verifyShareToken(
        token.plaintext,
        `hmac-sha256-v1:${canonicalDigest.slice(0, 8)}!${canonicalDigest.slice(
          8,
        )}`,
        pepper,
      ),
    ).toBe(false)
    expect(
      verifyShareToken(
        token.plaintext,
        `hmac-sha256-v1:${standardBase64Digest}`,
        pepper,
      ),
    ).toBe(false)
    expect(
      verifyShareToken(
        token.plaintext,
        `hmac-sha256-v1:${standardBase64Digest}=`,
        pepper,
      ),
    ).toBe(false)
    expect(
      verifyShareToken(token.plaintext, 'hmac-sha256-v1:short', pepper),
    ).toBe(false)
  })

  it('parses only the public token id without returning secret substrings', () => {
    const token = createShareToken()
    const secret = token.plaintext.match(
      /^yolo_share_v1_[A-Za-z0-9-]+_([A-Za-z0-9-]+)$/,
    )?.[1]

    expect(parsePublicTokenId(token.plaintext)).toBe(token.publicTokenId)
    expect(parsePublicTokenId(token.plaintext)).not.toContain(secret)
    expect(parsePublicTokenId('not-a-token')).toBeNull()
  })

  it('normalizes equivalent vault roots and rejects absolute filesystem roots', () => {
    expect(normalizeVaultRootPath('')).toBe('/')
    expect(normalizeVaultRootPath('/')).toBe('/')
    expect(normalizeVaultRootPath('foo')).toBe('/foo')
    expect(normalizeVaultRootPath('/foo')).toBe('/foo')
    expect(normalizeVaultRootPath('foo/')).toBe('/foo')
    expect(normalizeVaultRootPath('./foo')).toBe('/foo')
    expect(normalizeVaultRootPath('foo/../bar')).toBe('/bar')
    expect(normalizeVaultRootPath('foo%2Fbar')).toBe('/foo/bar')
    expect(normalizeVaultRootPath('Cafe%CC%81')).toBe('/Café')
    expect(() => normalizeVaultRootPath('C:\\Users\\vault')).toThrow(
      'invalid_root',
    )
    expect(() => normalizeVaultRootPath('\\\\server\\share')).toThrow(
      'invalid_root',
    )
  })

  it('hashes canonically equivalent Unicode roots equally', () => {
    expect(hashWorkspaceRoot('Cafe\u0301', 'vault-a')).toBe(
      hashWorkspaceRoot('Café', 'vault-a'),
    )
  })

  it('hashes equivalent roots equally while POSIX remains case-sensitive', () => {
    expect(hashWorkspaceRootForPlatform('', 'vault-a', 'linux')).toBe(
      hashWorkspaceRootForPlatform('/', 'vault-a', 'linux'),
    )
    expect(hashWorkspaceRootForPlatform('foo/', 'vault-a', 'linux')).toBe(
      hashWorkspaceRootForPlatform('/foo', 'vault-a', 'linux'),
    )
    expect(hashWorkspaceRootForPlatform('foo/../bar', 'vault-a', 'linux')).toBe(
      hashWorkspaceRootForPlatform('/bar', 'vault-a', 'linux'),
    )
    expect(
      hashWorkspaceRootForPlatform('/Foo/Bar', 'vault-a', 'linux'),
    ).not.toBe(hashWorkspaceRootForPlatform('/foo/bar', 'vault-a', 'linux'))
    expect(hashWorkspaceRootForPlatform('/foo', 'vault-a', 'linux')).not.toBe(
      hashWorkspaceRootForPlatform('/foo', 'vault-b', 'linux'),
    )
  })

  it('folds root and vault identity casing for Windows hashing', () => {
    expect(hashWorkspaceRootForPlatform('/Foo/Bar', 'Vault-A', 'win32')).toBe(
      hashWorkspaceRootForPlatform('/foo/bar', 'vault-a', 'win32'),
    )
    expect(
      hashWorkspaceRootForPlatform('/Foo/Bar', 'Vault-A', 'linux'),
    ).not.toBe(hashWorkspaceRootForPlatform('/foo/bar', 'vault-a', 'linux'))
  })
})
