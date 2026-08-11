import { computeSimhash, hammingDistance, isNearDuplicate } from './simhash'

describe('memory SimHash', () => {
  it('returns the zero hash for empty and punctuation-only input', () => {
    expect(computeSimhash('')).toBe('0000000000000000')
    expect(computeSimhash('... --- !!!')).toBe('0000000000000000')
  })

  it('normalizes NFC/NFD input and returns a lowercase 64-bit hash', () => {
    const nfc = computeSimhash('Café alpha')
    const nfd = computeSimhash('Cafe\u0301 alpha')

    expect(nfc).toBe(nfd)
    expect(nfc).toMatch(/^[0-9a-f]{16}$/)
    expect(computeSimhash('alpha beta')).toBe(computeSimhash('beta alpha'))
  })

  it('keeps the ASCII and CJK SimHash golden vectors stable', () => {
    expect(computeSimhash('alpha beta')).toBe('0206219b85442023')
    expect(computeSimhash('你好')).toBe('3d262481d7d5eaa3')
  })

  it('computes exact bit distances', () => {
    expect(hammingDistance('0000000000000000', '0000000000000001')).toBe(1)
    expect(hammingDistance('0000000000000000', '000000000000000f')).toBe(4)
  })

  it('rejects malformed hashes instead of truncating them', () => {
    expect(() =>
      hammingDistance('0000000000000000', '0x0000000000000000'),
    ).toThrow(RangeError)
    expect(isNearDuplicate('0000000000000000', '0000000000000000extra')).toBe(
      false,
    )
    expect(isNearDuplicate('ABCDEFABCDEFABCD', 'abcdefabcdefabcd')).toBe(false)
  })

  it('uses the threshold for near duplicate decisions', () => {
    expect(isNearDuplicate('0000000000000000', '0000000000000001')).toBe(true)
    expect(isNearDuplicate('0000000000000000', '000000000000000f')).toBe(false)
  })

  it('does not treat a single equal 16-bit band as a near duplicate', () => {
    expect(isNearDuplicate('0123456789abcdef', '0123456789abc000')).toBe(false)
  })

  it('treats identical real Chinese content as a near duplicate', () => {
    const a = computeSimhash('用户偏好深色模式的代码编辑器')
    const b = computeSimhash('用户偏好深色模式的代码编辑器')

    expect(a).toBe(b)
    expect(isNearDuplicate(a, b)).toBe(true)
  })

  it('treats punctuation-normalized variants as near duplicate', () => {
    const base = computeSimhash('全极耳电芯设计参数')
    const trailingPunctuation = computeSimhash('全极耳电芯设计参数.')

    // Trailing punctuation is dropped by the tokenizer, so hashes match exactly.
    expect(trailingPunctuation).toBe(base)
    expect(isNearDuplicate(base, trailingPunctuation)).toBe(true)
  })

  it('treats any rewording as beyond the threshold (documented limitation)', () => {
    // Whole CJK runs tokenize as one token, so even a small edit shifts the
    // run token and pushes the distance past the default threshold of 3.
    // isNearDuplicate therefore recognizes only identical / punctuation-normalized
    // content, not semantic paraphrases.
    const base = computeSimhash('全极耳电芯设计参数')
    const extraChar = computeSimhash('全极耳电芯设计参数表')
    const rewording = computeSimhash('全极耳电芯N/P比设计')

    expect(hammingDistance(base, extraChar)).toBeGreaterThan(3)
    expect(isNearDuplicate(base, extraChar)).toBe(false)
    expect(isNearDuplicate(base, rewording)).toBe(false)
  })

  it('keeps unrelated Chinese topics far apart', () => {
    const battery = computeSimhash('电池设计参数')
    const weather = computeSimhash('今天天气很好')

    expect(hammingDistance(battery, weather)).toBeGreaterThan(15)
    expect(isNearDuplicate(battery, weather)).toBe(false)
  })
})
