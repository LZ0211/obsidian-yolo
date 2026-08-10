/**
 * Minimal hand-rolled protobuf codec for Feishu/Lark Socket Mode's
 * "pbbp2"/Bin Protocol V2" `Frame`/`Header` messages. Both messages only use
 * varint and length-delimited wire types (confirmed against
 * `@larksuiteoapi/node-sdk`'s compiled `pbbp2.js`), so a general protobuf
 * library isn't needed — this keeps the zero-new-dependency precedent set by
 * the DingTalk adapter.
 *
 * Field numbers (verified from the official SDK, do not change):
 *   Header:  key=1 (string), value=2 (string)
 *   Frame:   seqId=1 (uint64), logId=2 (uint64), service=3 (int32),
 *            method=4 (int32), headers=5 (repeated Header), payloadEncoding=6
 *            (string), payloadType=7 (string), payload=8 (bytes),
 *            logIdNew=9 (string)
 */

export type FrameHeader = {
  key: string
  value: string
}

export type FrameInput = {
  seqId: bigint | number
  logId: bigint | number
  service: number
  method: number
  headers?: FrameHeader[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  logIdNew?: string
}

export type DecodedFrame = {
  seqId: bigint
  logId: bigint
  service: number
  method: number
  headers: FrameHeader[]
  payloadEncoding?: string
  payloadType?: string
  payload?: Uint8Array
  logIdNew?: string
}

const WIRE_TYPE_VARINT = 0
const WIRE_TYPE_LENGTH_DELIMITED = 2

export function encodeVarint(valueInput: bigint | number): Uint8Array {
  let value = BigInt(valueInput)
  if (value < BigInt(0)) {
    throw new Error('encodeVarint: negative values are not supported')
  }
  const bytes: number[] = []
  do {
    let byte = Number(value & BigInt(0x7f))
    value >>= BigInt(7)
    if (value > BigInt(0)) byte |= 0x80
    bytes.push(byte)
  } while (value > BigInt(0))
  return Uint8Array.from(bytes)
}

export function decodeVarint(
  bytes: Uint8Array,
  offset: number,
): { value: bigint; length: number } {
  let result = BigInt(0)
  let shift = BigInt(0)
  let pos = offset
  for (;;) {
    if (pos >= bytes.length) {
      throw new Error('decodeVarint: unexpected end of buffer')
    }
    const byte = bytes[pos]
    result |= BigInt(byte & 0x7f) << shift
    pos++
    if ((byte & 0x80) === 0) break
    shift += BigInt(7)
  }
  return { value: result, length: pos - offset }
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

function encodeTag(fieldNumber: number, wireType: number): Uint8Array {
  return encodeVarint((fieldNumber << 3) | wireType)
}

function encodeVarintField(
  fieldNumber: number,
  value: bigint | number,
): Uint8Array {
  return concatBytes([
    encodeTag(fieldNumber, WIRE_TYPE_VARINT),
    encodeVarint(value),
  ])
}

function encodeLengthDelimitedField(
  fieldNumber: number,
  payload: Uint8Array,
): Uint8Array {
  return concatBytes([
    encodeTag(fieldNumber, WIRE_TYPE_LENGTH_DELIMITED),
    encodeVarint(payload.length),
    payload,
  ])
}

function encodeStringField(fieldNumber: number, value: string): Uint8Array {
  return encodeLengthDelimitedField(
    fieldNumber,
    new TextEncoder().encode(value),
  )
}

function decodeString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

export function encodeHeader(header: FrameHeader): Uint8Array {
  return concatBytes([
    encodeStringField(1, header.key),
    encodeStringField(2, header.value),
  ])
}

function decodeHeader(bytes: Uint8Array): FrameHeader {
  let key = ''
  let value = ''
  let offset = 0
  while (offset < bytes.length) {
    const tag = decodeVarint(bytes, offset)
    offset += tag.length
    const fieldNumber = Number(tag.value >> BigInt(3))
    const wireType = Number(tag.value & BigInt(0x7))
    if (wireType !== WIRE_TYPE_LENGTH_DELIMITED) {
      throw new Error(`decodeHeader: unexpected wire type ${wireType}`)
    }
    const len = decodeVarint(bytes, offset)
    offset += len.length
    const length = Number(len.value)
    const fieldBytes = bytes.subarray(offset, offset + length)
    offset += length
    if (fieldNumber === 1) key = decodeString(fieldBytes)
    else if (fieldNumber === 2) value = decodeString(fieldBytes)
  }
  return { key, value }
}

export function encodeFrame(frame: FrameInput): Uint8Array {
  const parts: Uint8Array[] = [
    encodeVarintField(1, frame.seqId),
    encodeVarintField(2, frame.logId),
    encodeVarintField(3, frame.service),
    encodeVarintField(4, frame.method),
  ]
  for (const header of frame.headers ?? []) {
    parts.push(encodeLengthDelimitedField(5, encodeHeader(header)))
  }
  if (frame.payloadEncoding !== undefined) {
    parts.push(encodeStringField(6, frame.payloadEncoding))
  }
  if (frame.payloadType !== undefined) {
    parts.push(encodeStringField(7, frame.payloadType))
  }
  if (frame.payload !== undefined) {
    parts.push(encodeLengthDelimitedField(8, frame.payload))
  }
  if (frame.logIdNew !== undefined) {
    parts.push(encodeStringField(9, frame.logIdNew))
  }
  return concatBytes(parts)
}

export function decodeFrame(bytes: Uint8Array): DecodedFrame {
  let seqId = BigInt(0)
  let logId = BigInt(0)
  let service = 0
  let method = 0
  const headers: FrameHeader[] = []
  let payloadEncoding: string | undefined
  let payloadType: string | undefined
  let payload: Uint8Array | undefined
  let logIdNew: string | undefined

  let offset = 0
  while (offset < bytes.length) {
    const tag = decodeVarint(bytes, offset)
    offset += tag.length
    const fieldNumber = Number(tag.value >> BigInt(3))
    const wireType = Number(tag.value & BigInt(0x7))

    if (wireType === WIRE_TYPE_VARINT) {
      const val = decodeVarint(bytes, offset)
      offset += val.length
      switch (fieldNumber) {
        case 1:
          seqId = val.value
          break
        case 2:
          logId = val.value
          break
        case 3:
          service = Number(val.value)
          break
        case 4:
          method = Number(val.value)
          break
        default:
          break
      }
    } else if (wireType === WIRE_TYPE_LENGTH_DELIMITED) {
      const len = decodeVarint(bytes, offset)
      offset += len.length
      const length = Number(len.value)
      const fieldBytes = bytes.subarray(offset, offset + length)
      offset += length
      switch (fieldNumber) {
        case 5:
          headers.push(decodeHeader(fieldBytes))
          break
        case 6:
          payloadEncoding = decodeString(fieldBytes)
          break
        case 7:
          payloadType = decodeString(fieldBytes)
          break
        case 8:
          payload = fieldBytes
          break
        case 9:
          logIdNew = decodeString(fieldBytes)
          break
        default:
          break
      }
    } else {
      throw new Error(
        `decodeFrame: unsupported wire type ${wireType} for field ${fieldNumber}`,
      )
    }
  }

  return {
    seqId,
    logId,
    service,
    method,
    headers,
    payloadEncoding,
    payloadType,
    payload,
    logIdNew,
  }
}
