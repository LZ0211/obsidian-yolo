import { stableStringify } from './stableStringify'

describe('stableStringify', () => {
  it('sorts object keys deterministically', () => {
    const first = stableStringify({ b: 1, a: 2, c: { z: 1, y: 2 } })
    const second = stableStringify({ c: { y: 2, z: 1 }, a: 2, b: 1 })
    expect(first).toBe(second)
    expect(first).toBe('{"a":2,"b":1,"c":{"y":2,"z":1}}')
  })

  it('handles primitives, arrays and null', () => {
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(42)).toBe('42')
    expect(stableStringify('x')).toBe('"x"')
    expect(stableStringify(undefined)).toBe('null')
    expect(stableStringify([3, 1, 2])).toBe('[3,1,2]')
  })

  it('marks direct circular references instead of overflowing the stack', () => {
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular

    const result = stableStringify(circular)
    expect(result).toBe('{"name":"loop","self":"[Circular]"}')
  })

  it('marks indirect circular references', () => {
    const a: Record<string, unknown> = { name: 'a' }
    const b: Record<string, unknown> = { name: 'b', back: a }
    a.next = b

    expect(stableStringify(a)).toBe(
      '{"name":"a","next":{"back":"[Circular]","name":"b"}}',
    )
  })

  it('serializes shared-but-not-circular references fully on each occurrence', () => {
    const shared = { value: 1 }
    const data = { left: shared, right: shared }

    expect(stableStringify(data)).toBe(
      '{"left":{"value":1},"right":{"value":1}}',
    )
  })

  it('serializes circular arrays safely', () => {
    const arr: unknown[] = [1, 2]
    arr.push(arr)

    expect(stableStringify(arr)).toBe('[1,2,"[Circular]"]')
  })
})
