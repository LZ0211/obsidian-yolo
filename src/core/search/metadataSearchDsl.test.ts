import { parseMetadataSearchDsl } from './metadataSearchDsl'

describe('parseMetadataSearchDsl', () => {
  it('parses full select/from/where metadata queries', () => {
    expect(
      parseMetadataSearchDsl(
        'select model, tag from Projects where 型号 = "RTX-4090" and priority >= 3',
      ),
    ).toEqual({
      select: ['model', 'tag'],
      path: 'Projects',
      filters: [
        [
          { key: '型号', op: 'eq', value: 'RTX-4090' },
          { key: 'priority', op: 'gte', value: 3 },
        ],
      ],
    })
  })

  it('treats select ** from ** as full-vault full-metadata projection', () => {
    expect(parseMetadataSearchDsl('select ** from **')).toEqual({
      select: '**',
      path: undefined,
      filters: [],
    })
  })

  it('accepts SQL-style star projection and quoted paths', () => {
    expect(
      parseMetadataSearchDsl(
        'SELECT * FROM "Projects/GPU" WHERE `product model` LIKE "RTX"',
      ),
    ).toEqual({
      select: '**',
      path: 'Projects/GPU',
      filters: [[{ key: 'product model', op: 'like', value: 'RTX' }]],
    })
  })

  it('parses order by and limit clauses', () => {
    expect(
      parseMetadataSearchDsl(
        'select title from Projects where priority >= 3 order by priority desc limit 5',
      ),
    ).toEqual({
      select: ['title'],
      path: 'Projects',
      filters: [[{ key: 'priority', op: 'gte', value: 3 }]],
      orderBy: { key: 'priority', direction: 'desc' },
      limit: 5,
    })
  })

  it('treats bare distinct as regular column name', () => {
    expect(parseMetadataSearchDsl('select distinct status from *')).toEqual({
      select: ['distinct status'],
      path: undefined,
      filters: [],
    })
  })

  it('accepts select keys(*) in full SQL form', () => {
    expect(parseMetadataSearchDsl('select keys(*) from "Projects"')).toEqual({
      select: { distinct: 'available_keys' },
      path: 'Projects',
      filters: [],
    })
  })

  it('parses OR-separated filter groups from full SQL form', () => {
    expect(
      parseMetadataSearchDsl(
        'select * from "00-Email" where tag = "a" and date >= 2020 or tag = "b" and date < 2019',
      ),
    ).toEqual({
      select: '**',
      path: '00-Email',
      filters: [
        [
          { key: 'tag', op: 'eq', value: 'a' },
          { key: 'date', op: 'gte', value: 2020 },
        ],
        [
          { key: 'tag', op: 'eq', value: 'b' },
          { key: 'date', op: 'lt', value: 2019 },
        ],
      ],
    })
  })

  it('accepts TABLE as an alternative opening keyword to SELECT', () => {
    expect(
      parseMetadataSearchDsl(
        'table title from Projects where priority >= 3 order by priority desc limit 5',
      ),
    ).toEqual(
      parseMetadataSearchDsl(
        'select title from Projects where priority >= 3 order by priority desc limit 5',
      ),
    )
  })

  it('accepts TABLE with keys(*) discovery', () => {
    expect(parseMetadataSearchDsl('table keys(*) from "Projects"')).toEqual(
      parseMetadataSearchDsl('select keys(*) from "Projects"'),
    )
  })

  it('rejects metadata queries that do not start with select', () => {
    expect(() => parseMetadataSearchDsl('keys(*)')).toThrow(
      'metadata query must start with SELECT',
    )
    expect(() =>
      parseMetadataSearchDsl('keys(*) from "00-Email/Inbox"'),
    ).toThrow('metadata query must start with SELECT')
  })
})
