import {
  type MetadataFilter,
  MetadataResolutionError,
  canonicalizeMetadataKey,
  resolveMetadataFilter,
} from './metadataKeyResolution'

describe('canonicalizeMetadataKey', () => {
  it('trims, applies NFKC, lowercases ASCII, and folds separator runs to underscores', () => {
    expect(canonicalizeMetadataKey('  Ｐart Number / Rev-A  ')).toBe(
      'part_number_rev_a',
    )
    expect(canonicalizeMetadataKey('型号 / 版本-A')).toBe('型号_版本_a')
    expect(canonicalizeMetadataKey('already__ok')).toBe('already__ok')
  })

  it('rejects empty keys after normalization', () => {
    expect(() => canonicalizeMetadataKey('   ')).toThrow(
      MetadataResolutionError,
    )
    expect(() => canonicalizeMetadataKey('   ')).toThrow(
      'unresolved metadata key',
    )
  })
})

describe('resolveMetadataFilter', () => {
  const filter: MetadataFilter = {
    key: 'Tag',
    op: 'eq',
    value: 'ai',
  }

  it('prefers exact canonical key matches over alias expansion', () => {
    const resolved = resolveMetadataFilter(filter, {
      aliasEntries: [
        {
          alias: 'tag',
          canonicalKeys: ['label'],
          source: 'builtin',
          priority: 0,
        },
      ],
    })

    expect(resolved).toMatchObject({
      canonicalUserKey: 'tag',
      resolvedKeys: ['tag'],
      resolutionMethod: 'exact',
    })
  })

  it('supports deterministic one-to-many alias expansion as OR keys', () => {
    const resolved = resolveMetadataFilter(
      {
        key: 'product model',
        op: 'eq',
        value: 'RX-1',
      },
      {
        aliasEntries: [
          {
            alias: 'product model',
            canonicalKeys: ['model', 'part_number'],
            source: 'builtin',
            priority: 0,
          },
        ],
      },
    )

    expect(resolved).toMatchObject({
      canonicalUserKey: 'product_model',
      resolvedKeys: ['model', 'part_number'],
      resolutionMethod: 'alias',
    })
  })

  it('fails closed on ambiguous alias definitions', () => {
    expect(() =>
      resolveMetadataFilter(
        {
          key: 'identifier',
          op: 'eq',
          value: 'A-1',
        },
        {
          aliasEntries: [
            {
              alias: 'identifier',
              canonicalKeys: ['part_number'],
              source: 'builtin',
              priority: 0,
            },
            {
              alias: 'identifier',
              canonicalKeys: ['error_code'],
              source: 'builtin',
              priority: 0,
            },
          ],
        },
      ),
    ).toThrow('ambiguous metadata key')
  })
})
