import {
  resolveCompressionEncoding,
  shouldCompressJsonChunk,
} from './WebHttpServer'

describe('resolveCompressionEncoding', () => {
  it('prefers brotli over gzip', () => {
    expect(resolveCompressionEncoding('gzip, deflate, br')).toBe('br')
    expect(resolveCompressionEncoding('br')).toBe('br')
  })

  it('falls back to gzip when brotli is absent', () => {
    expect(resolveCompressionEncoding('gzip, deflate')).toBe('gzip')
    expect(resolveCompressionEncoding('deflate, gzip')).toBe('gzip')
  })

  it('returns null when neither br nor gzip is advertised', () => {
    expect(resolveCompressionEncoding(undefined)).toBeNull()
    expect(resolveCompressionEncoding('')).toBeNull()
    expect(resolveCompressionEncoding('deflate')).toBeNull()
  })
})

describe('shouldCompressJsonChunk', () => {
  it('compresses large JSON without an existing content-encoding', () => {
    expect(
      shouldCompressJsonChunk({
        contentType: 'application/json; charset=utf-8',
        chunkByteLength: 2048,
        hasContentEncoding: false,
      }),
    ).toBe(true)
  })

  it('skips small payloads where compression would add overhead', () => {
    expect(
      shouldCompressJsonChunk({
        contentType: 'application/json',
        chunkByteLength: 1023,
        hasContentEncoding: false,
      }),
    ).toBe(false)
  })

  it('skips non-JSON content (e.g. SSE/static assets)', () => {
    expect(
      shouldCompressJsonChunk({
        contentType: 'text/event-stream',
        chunkByteLength: 4096,
        hasContentEncoding: false,
      }),
    ).toBe(false)
  })

  it('never double-compresses an already-encoded response', () => {
    expect(
      shouldCompressJsonChunk({
        contentType: 'application/json',
        chunkByteLength: 4096,
        hasContentEncoding: true,
      }),
    ).toBe(false)
  })
})
