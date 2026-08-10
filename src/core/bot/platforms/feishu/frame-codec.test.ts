import {
  decodeFrame,
  decodeVarint,
  encodeFrame,
  encodeHeader,
  encodeVarint,
} from './frame-codec'

describe('varint round-trip', () => {
  it.each([0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 32])(
    'encodes and decodes %d',
    (value) => {
      const encoded = encodeVarint(value)
      const decoded = decodeVarint(encoded, 0)
      expect(decoded.value).toBe(BigInt(value))
      expect(decoded.length).toBe(encoded.length)
    },
  )

  it('round-trips large uint64 values beyond Number.MAX_SAFE_INTEGER', () => {
    const value = (BigInt(1) << BigInt(63)) - BigInt(1)
    const encoded = encodeVarint(value)
    const decoded = decodeVarint(encoded, 0)
    expect(decoded.value).toBe(value)
  })

  it('throws on negative values', () => {
    expect(() => encodeVarint(-1)).toThrow()
  })

  it('throws decoding a truncated buffer', () => {
    const truncated = Uint8Array.from([0x80])
    expect(() => decodeVarint(truncated, 0)).toThrow()
  })
})

describe('Header encode/decode', () => {
  it('round-trips key/value strings', () => {
    const encoded = encodeHeader({ key: 'type', value: 'event' })
    const frame = encodeFrame({
      seqId: 1,
      logId: 1,
      service: 1,
      method: 1,
      headers: [{ key: 'type', value: 'event' }],
    })
    const decoded = decodeFrame(frame)
    expect(decoded.headers).toEqual([{ key: 'type', value: 'event' }])
    expect(encoded.length).toBeGreaterThan(0)
  })

  it('round-trips empty string values', () => {
    const frame = encodeFrame({
      seqId: 0,
      logId: 0,
      service: 0,
      method: 0,
      headers: [{ key: '', value: '' }],
    })
    const decoded = decodeFrame(frame)
    expect(decoded.headers).toEqual([{ key: '', value: '' }])
  })
})

describe('Frame encode/decode', () => {
  it('round-trips a minimal control frame (ping, no payload)', () => {
    const encoded = encodeFrame({
      seqId: 0,
      logId: 0,
      service: 42,
      method: 0,
      headers: [{ key: 'type', value: 'ping' }],
    })
    const decoded = decodeFrame(encoded)
    expect(decoded).toEqual({
      seqId: BigInt(0),
      logId: BigInt(0),
      service: 42,
      method: 0,
      headers: [{ key: 'type', value: 'ping' }],
      payloadEncoding: undefined,
      payloadType: undefined,
      payload: undefined,
      logIdNew: undefined,
    })
  })

  it('round-trips a data frame with multiple headers and a JSON payload', () => {
    const payload = new TextEncoder().encode(
      JSON.stringify({
        schema: '2.0',
        header: { event_type: 'im.message.receive_v1' },
      }),
    )
    const encoded = encodeFrame({
      seqId: 12345,
      logId: 67890,
      service: 7,
      method: 1,
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'abc-123' },
        { key: 'sum', value: '1' },
        { key: 'seq', value: '0' },
        { key: 'trace_id', value: 'trace-1' },
      ],
      payloadEncoding: 'gzip',
      payloadType: 'application/json',
      payload,
      logIdNew: 'log-new-1',
    })
    const decoded = decodeFrame(encoded)

    expect(decoded.seqId).toBe(BigInt(12345))
    expect(decoded.logId).toBe(BigInt(67890))
    expect(decoded.service).toBe(7)
    expect(decoded.method).toBe(1)
    expect(decoded.headers).toEqual([
      { key: 'type', value: 'event' },
      { key: 'message_id', value: 'abc-123' },
      { key: 'sum', value: '1' },
      { key: 'seq', value: '0' },
      { key: 'trace_id', value: 'trace-1' },
    ])
    expect(decoded.payloadEncoding).toBe('gzip')
    expect(decoded.payloadType).toBe('application/json')
    expect(decoded.payload).toEqual(payload)
    expect(decoded.logIdNew).toBe('log-new-1')
  })

  it('round-trips large uint64 seqId/logId values', () => {
    const bigValue = (BigInt(1) << BigInt(40)) + BigInt(3)
    const encoded = encodeFrame({
      seqId: bigValue,
      logId: bigValue,
      service: 1,
      method: 1,
    })
    const decoded = decodeFrame(encoded)
    expect(decoded.seqId).toBe(bigValue)
    expect(decoded.logId).toBe(bigValue)
  })

  it('round-trips an empty headers array and undefined optional fields', () => {
    const encoded = encodeFrame({ seqId: 1, logId: 1, service: 1, method: 1 })
    const decoded = decodeFrame(encoded)
    expect(decoded.headers).toEqual([])
    expect(decoded.payloadEncoding).toBeUndefined()
    expect(decoded.payloadType).toBeUndefined()
    expect(decoded.payload).toBeUndefined()
    expect(decoded.logIdNew).toBeUndefined()
  })

  it('throws decoding a frame with an unsupported wire type', () => {
    // field number 1 (seqId) tagged with wire type 5 (fixed32) — invalid for this schema.
    const badTag = encodeVarint((1 << 3) | 5)
    expect(() => decodeFrame(badTag)).toThrow()
  })
})
