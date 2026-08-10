import {
  inferAndVerifyMimeType,
  validateAttachmentPath,
} from './attachment-security'

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

describe('inferAndVerifyMimeType', () => {
  const PNG_HEADER = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0,
  ])
  const JPEG_HEADER = new Uint8Array([0xff, 0xd8, 0xff, 0, 0, 0])
  const ZIP_HEADER = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])

  it('infers mime type from a matching magic number and extension', () => {
    const result = inferAndVerifyMimeType('charts/sales.png', PNG_HEADER)
    expect(result).toEqual({ ok: true, mimeType: 'image/png' })
  })

  it('rejects a mismatch between magic number and extension (spoofed file)', () => {
    const result = inferAndVerifyMimeType('charts/sales.png', JPEG_HEADER)
    expect(result.ok).toBe(false)
  })

  it('accepts a zip signature for docx/xlsx/pptx extensions', () => {
    expect(inferAndVerifyMimeType('report.docx', ZIP_HEADER)).toEqual({
      ok: true,
      mimeType: 'application/zip',
    })
  })

  it('accepts unknown extensions without a magic-number match (not an allowlist)', () => {
    const result = inferAndVerifyMimeType('notes.md', new Uint8Array([1, 2, 3]))
    expect(result.ok).toBe(true)
    expect(result.mimeType).toBeUndefined()
  })

  it('falls back to the extension-implied mime type when bytes are too short to sniff', () => {
    const result = inferAndVerifyMimeType(
      'charts/sales.png',
      new Uint8Array([1]),
    )
    expect(result).toEqual({ ok: true, mimeType: 'image/png' })
  })
})
