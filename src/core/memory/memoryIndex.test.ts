import { buildMemoryKey, buildMemoryPartition } from './memoryIndex'

describe('memory index partition and canonical keys', () => {
  it('builds the global partition without an assistant identity', () => {
    expect(buildMemoryPartition({ scope: 'global' })).toEqual({
      scope: 'global',
      assistantId: null,
      partitionKey: 'global',
    })
  })

  it('encodes assistant IDs as unpadded UTF-8 base64url', () => {
    expect(
      buildMemoryPartition({ scope: 'assistant', assistantId: 'a/1' }),
    ).toEqual({
      scope: 'assistant',
      assistantId: 'a/1',
      partitionKey: 'assistant:YS8x',
    })
    expect(
      buildMemoryPartition({ scope: 'assistant', assistantId: '你好' })
        .partitionKey,
    ).toBe('assistant:5L2g5aW9')
  })

  it('builds a stable canonical memory key', () => {
    expect(buildMemoryKey('assistant:YS8x', 'Memory_1')).toBe(
      'assistant:YS8x::Memory_1',
    )
  })

  it.each([
    { scope: 'assistant' as const },
    { scope: 'assistant' as const, assistantId: '' },
    { scope: 'assistant' as const, assistantId: '   ' },
    { scope: 'global' as const, assistantId: 'a/1' },
  ])('rejects an invalid partition input %#', (input) => {
    expect(() => buildMemoryPartition(input)).toThrow()
  })
})
