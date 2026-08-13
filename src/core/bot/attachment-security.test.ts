import { validateAttachmentPath } from './attachment-security'

const underDir = (dir: string) => (path: string) =>
  dir === '' || path === dir || path.startsWith(`${dir}/`)

describe('validateAttachmentPath', () => {
  it('rejects absolute unix paths', () => {
    const result = validateAttachmentPath('/etc/passwd', {
      isAllowed: underDir(''),
    })
    expect(result.ok).toBe(false)
  })

  it('rejects absolute windows drive paths', () => {
    const result = validateAttachmentPath('C:\\secrets\\x.txt', {
      isAllowed: underDir('secrets'),
    })
    expect(result.ok).toBe(false)
  })

  it('rejects path traversal via a ".." segment', () => {
    const result = validateAttachmentPath('charts/../../../etc/passwd', {
      isAllowed: underDir('charts'),
    })
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/traversal/i)
  })

  it('does not falsely reject filenames merely containing ".." as a substring', () => {
    const result = validateAttachmentPath('charts/v1..draft.md', {
      isAllowed: underDir('charts'),
    })
    expect(result.ok).toBe(true)
  })

  it('rejects hidden/system paths', () => {
    expect(
      validateAttachmentPath('.obsidian/config', { isAllowed: underDir('') })
        .ok,
    ).toBe(false)
    expect(
      validateAttachmentPath('.git/HEAD', { isAllowed: underDir('') }).ok,
    ).toBe(false)
    expect(
      validateAttachmentPath('.trash/x.png', { isAllowed: underDir('') }).ok,
    ).toBe(false)
    expect(
      validateAttachmentPath('charts/.hidden.png', {
        isAllowed: underDir('charts'),
      }).ok,
    ).toBe(false)
  })

  it('rejects sensitive filename patterns', () => {
    expect(
      validateAttachmentPath('config/.env', { isAllowed: underDir('config') })
        .ok,
    ).toBe(false)
    expect(
      validateAttachmentPath('keys/id_private_key.pem', {
        isAllowed: underDir('keys'),
      }).ok,
    ).toBe(false)
    expect(
      validateAttachmentPath('secrets/x.txt', {
        isAllowed: underDir('secrets'),
      }).ok,
    ).toBe(false)
  })

  it('rejects everything when isAllowed is omitted (fail closed)', () => {
    const result = validateAttachmentPath('charts/sales.png', {})
    expect(result.ok).toBe(false)
  })

  it('accepts a path the predicate allows', () => {
    const result = validateAttachmentPath('charts/sales.png', {
      isAllowed: underDir('charts'),
    })
    expect(result).toEqual({ ok: true, normalizedPath: 'charts/sales.png' })
  })

  it('rejects a path the predicate disallows', () => {
    const result = validateAttachmentPath('other/sales.png', {
      isAllowed: underDir('charts'),
    })
    expect(result.ok).toBe(false)
  })
})
