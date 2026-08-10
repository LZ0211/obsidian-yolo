import { rerankModelSchema } from '../../../types/rerank-model.types'

import { parseOptionalRerankLimit } from './rerankModelLimits'

describe('rerank model limits', () => {
  it('represents a blank limit as unknown', () => {
    expect(parseOptionalRerankLimit('  ', 'Maximum documents')).toBeUndefined()
  })

  it('accepts positive safe integers and rejects invalid values', () => {
    expect(parseOptionalRerankLimit('80', 'Maximum documents')).toBe(80)
    expect(() => parseOptionalRerankLimit('1.5', 'Maximum documents')).toThrow(
      'Maximum documents must be a positive integer',
    )
    expect(() => parseOptionalRerankLimit('0', 'Maximum documents')).toThrow(
      'Maximum documents must be a positive integer',
    )
  })

  it('round-trips optional limits through settings schema', () => {
    expect(
      rerankModelSchema.parse({
        providerId: 'provider',
        id: 'provider/model',
        model: 'model',
        maxDocuments: 80,
        maxInputChars: 40000,
      }),
    ).toMatchObject({ maxDocuments: 80, maxInputChars: 40000 })
  })
})
