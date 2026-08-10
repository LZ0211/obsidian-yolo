import {
  MetadataFilterDslError,
  parseMetadataFilterDsl,
} from './metadataFilterDsl'

const expectDslError = (
  input: string,
  code: MetadataFilterDslError['code'],
  messageIncludes?: string,
) => {
  try {
    parseMetadataFilterDsl(input)
    throw new Error(`Expected MetadataFilterDslError ${code}`)
  } catch (error) {
    expect(error).toBeInstanceOf(MetadataFilterDslError)
    expect((error as MetadataFilterDslError).code).toBe(code)
    if (messageIncludes) {
      expect((error as MetadataFilterDslError).message).toContain(
        messageIncludes,
      )
    }
  }
}

describe('parseMetadataFilterDsl', () => {
  it('returns empty list for empty input and bare where', () => {
    expect(parseMetadataFilterDsl('')).toEqual([])
    expect(parseMetadataFilterDsl('   ')).toEqual([])
    expect(parseMetadataFilterDsl('where')).toEqual([])
    expect(parseMetadataFilterDsl(' WHERE   ')).toEqual([])
  })

  it('parses unicode keys with string, number, and contains operators', () => {
    expect(
      parseMetadataFilterDsl(
        '型号 = "RTX-4090" and version >= 3 and tag contains "gpu"',
      ),
    ).toEqual([
      [
        { key: '型号', op: 'eq', value: 'RTX-4090' },
        { key: 'version', op: 'gte', value: 3 },
        { key: 'tag', op: 'contains', value: 'gpu' },
      ],
    ])
  })

  it('supports where prefix, booleans, and case-insensitive AND/contains', () => {
    expect(
      parseMetadataFilterDsl(
        "WhErE 型号 = 'RTX-4090' AnD published = true aNd tag CoNtAiNs 'gpu'",
      ),
    ).toEqual([
      [
        { key: '型号', op: 'eq', value: 'RTX-4090' },
        { key: 'published', op: 'eq', value: true },
        { key: 'tag', op: 'contains', value: 'gpu' },
      ],
    ])
  })

  it('supports common SQL key quoting and LIKE as contains', () => {
    expect(
      parseMetadataFilterDsl(
        'where `product model` like "RTX" and [release year] >= 2024',
      ),
    ).toEqual([
      [
        { key: 'product model', op: 'like', value: 'RTX' },
        { key: 'release year', op: 'gte', value: 2024 },
      ],
    ])
  })

  it('accepts INCLUDES as a contains alias', () => {
    expect(
      parseMetadataFilterDsl(
        'where tags includes "gpu" and note InClUdEs "cuda"',
      ),
    ).toEqual([
      [
        { key: 'tags', op: 'contains', value: 'gpu' },
        { key: 'note', op: 'contains', value: 'cuda' },
      ],
    ])
  })

  it('accepts ILIKE as a contains alias', () => {
    expect(
      parseMetadataFilterDsl('title ilike "gpu" and note ILIKE "cuda"'),
    ).toEqual([
      [
        { key: 'title', op: 'contains', value: 'gpu' },
        { key: 'note', op: 'contains', value: 'cuda' },
      ],
    ])
  })

  it('accepts IS as eq alias', () => {
    expect(parseMetadataFilterDsl('status is "active"')).toEqual([
      [{ key: 'status', op: 'eq', value: 'active' }],
    ])
    expect(parseMetadataFilterDsl('published is true')).toEqual([
      [{ key: 'published', op: 'eq', value: true }],
    ])
    expect(parseMetadataFilterDsl('score is 42')).toEqual([
      [{ key: 'score', op: 'eq', value: 42 }],
    ])
  })

  it('accepts IS NOT as neq alias', () => {
    expect(parseMetadataFilterDsl('status is not "archived"')).toEqual([
      [{ key: 'status', op: 'neq', value: 'archived' }],
    ])
    expect(parseMetadataFilterDsl('published is not true')).toEqual([
      [{ key: 'published', op: 'neq', value: true }],
    ])
  })

  it('parses strict and non-strict comparisons', () => {
    expect(parseMetadataFilterDsl('version > 3 and score < 10')).toEqual([
      [
        { key: 'version', op: 'gt', value: 3 },
        { key: 'score', op: 'lt', value: 10 },
      ],
    ])
  })

  it('parses escaped quotes and backslashes in strings', () => {
    expect(
      parseMetadataFilterDsl(
        `path = "C:\\\\gpu\\\\share" and note = "say \\"hi\\"" and text = 'it\\'s ready'`,
      ),
    ).toEqual([
      [
        { key: 'path', op: 'eq', value: 'C:\\gpu\\share' },
        { key: 'note', op: 'eq', value: 'say "hi"' },
        { key: 'text', op: 'eq', value: "it's ready" },
      ],
    ])
  })

  it('strips SQL LIKE wildcards from contains values', () => {
    expect(parseMetadataFilterDsl("file_name like '%2026-05%'")).toEqual([
      [{ key: 'file_name', op: 'like', value: '2026-05' }],
    ])
    expect(parseMetadataFilterDsl("file_name like '2026-05%'")).toEqual([
      [{ key: 'file_name', op: 'like', value: '2026-05' }],
    ])
    expect(parseMetadataFilterDsl("file_name like '%2026-05'")).toEqual([
      [{ key: 'file_name', op: 'like', value: '2026-05' }],
    ])
    expect(parseMetadataFilterDsl('file_name like "%2026-05%"')).toEqual([
      [{ key: 'file_name', op: 'like', value: '2026-05' }],
    ])
  })

  it('splits AND-groups on OR keyword', () => {
    expect(parseMetadataFilterDsl('tag = "a" or tag = "b"')).toEqual([
      [{ key: 'tag', op: 'eq', value: 'a' }],
      [{ key: 'tag', op: 'eq', value: 'b' }],
    ])
  })

  it('evaluates AND within each OR group', () => {
    expect(
      parseMetadataFilterDsl(
        'tag = "a" and date >= 2020 or tag = "b" and date < 2019',
      ),
    ).toEqual([
      [
        { key: 'tag', op: 'eq', value: 'a' },
        { key: 'date', op: 'gte', value: 2020 },
      ],
      [
        { key: 'tag', op: 'eq', value: 'b' },
        { key: 'date', op: 'lt', value: 2019 },
      ],
    ])
  })

  it('supports case-insensitive OR', () => {
    expect(
      parseMetadataFilterDsl('tag = "a" Or tag = "b" oR tag = "c"'),
    ).toEqual([
      [{ key: 'tag', op: 'eq', value: 'a' }],
      [{ key: 'tag', op: 'eq', value: 'b' }],
      [{ key: 'tag', op: 'eq', value: 'c' }],
    ])
  })

  it('rejects OR at end of query', () => {
    expectDslError('tag = "a" or', 'malformed_query')
  })

  it('rejects select statements as unsupported syntax', () => {
    expectDslError(
      'select * from notes where tag = "gpu"',
      'unsupported_syntax',
      'unsupported keyword: "select"',
    )
  })

  it('rejects reserved DSL keywords as bare metadata keys', () => {
    expectDslError(
      'where where = "x"',
      'unsupported_syntax',
      'unsupported keyword: "where"',
    )
    expectDslError(
      'from = "mail"',
      'unsupported_syntax',
      'unsupported keyword: "from"',
    )
    expectDslError(
      'order = "desc"',
      'unsupported_syntax',
      'unsupported keyword: "order"',
    )
    expectDslError(
      'limit = 10',
      'unsupported_syntax',
      'unsupported keyword: "limit"',
    )
  })

  it('allows reserved words when quoted as metadata keys', () => {
    expect(
      parseMetadataFilterDsl('where [where] = "x" and `from` = "mail"'),
    ).toEqual([
      [
        { key: 'where', op: 'eq', value: 'x' },
        { key: 'from', op: 'eq', value: 'mail' },
      ],
    ])
  })

  it('allows SQL-like words inside quoted string values', () => {
    expect(
      parseMetadataFilterDsl('note = "select or join are literal text"'),
    ).toEqual([
      [
        {
          key: 'note',
          op: 'eq',
          value: 'select or join are literal text',
        },
      ],
    ])
  })

  it('rejects bare string values to avoid ambiguity', () => {
    expectDslError('tag = gpu', 'malformed_query')
  })

  it('rejects trailing garbage after a valid clause', () => {
    expectDslError('tag = "gpu" trailing', 'malformed_query')
  })

  it('accepts == as eq alias', () => {
    expect(parseMetadataFilterDsl('version == 3')).toEqual([
      [{ key: 'version', op: 'eq', value: 3 }],
    ])
  })

  it('accepts != and <> as neq', () => {
    expect(parseMetadataFilterDsl('version != 3')).toEqual([
      [{ key: 'version', op: 'neq', value: 3 }],
    ])
    expect(parseMetadataFilterDsl('version <> 3')).toEqual([
      [{ key: 'version', op: 'neq', value: 3 }],
    ])
  })

  it('parses NOT keyword negating a single filter', () => {
    expect(parseMetadataFilterDsl('not tag = "a"')).toEqual([
      [{ key: 'tag', op: 'neq', value: 'a' }],
    ])
  })

  it('parses NOT over a parenthesized OR group via De Morgan', () => {
    // NOT (A or B) = NOT A and NOT B (single AND-group)
    expect(parseMetadataFilterDsl('not (tag = "a" or tag = "b")')).toEqual([
      [
        { key: 'tag', op: 'neq', value: 'a' },
        { key: 'tag', op: 'neq', value: 'b' },
      ],
    ])
  })

  it('parses NOT over parenthesized AND group via De Morgan', () => {
    // NOT (A and B) = NOT A or NOT B (two OR-groups)
    expect(parseMetadataFilterDsl('not (tag = "a" and date > 2020)')).toEqual([
      [{ key: 'tag', op: 'neq', value: 'a' }],
      [{ key: 'date', op: 'lte', value: 2020 }],
    ])
  })

  it('parses parenthesized AND-group combined with outer condition', () => {
    expect(
      parseMetadataFilterDsl('(tag = "a" or tag = "b") and date > 2020'),
    ).toEqual([
      [
        { key: 'tag', op: 'eq', value: 'a' },
        { key: 'date', op: 'gt', value: 2020 },
      ],
      [
        { key: 'tag', op: 'eq', value: 'b' },
        { key: 'date', op: 'gt', value: 2020 },
      ],
    ])
  })

  it('parses nested parentheses with OR at top level', () => {
    expect(
      parseMetadataFilterDsl(
        '((tag = "a" or tag = "b") and date > 2020) or status = "x"',
      ),
    ).toEqual([
      [
        { key: 'tag', op: 'eq', value: 'a' },
        { key: 'date', op: 'gt', value: 2020 },
      ],
      [
        { key: 'tag', op: 'eq', value: 'b' },
        { key: 'date', op: 'gt', value: 2020 },
      ],
      [{ key: 'status', op: 'eq', value: 'x' }],
    ])
  })
})
