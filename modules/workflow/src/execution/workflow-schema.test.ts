import { isJsonSchema, validateJsonSchemaOutput } from './workflow-schema'

describe('workflow json schema', () => {
  it('accepts a valid draft-07 style schema', () => {
    expect(
      isJsonSchema({
        type: 'object',
        required: ['result'],
        properties: {
          result: { type: 'string', minLength: 1 },
          count: { type: 'integer', minimum: 0 },
          items: { type: 'array', items: { type: 'number' } },
        },
        additionalProperties: false,
      }),
    ).toBe(true)
  })

  it('rejects malformed schemas without throwing', () => {
    for (const schema of [
      42,
      null,
      'object',
      { type: 42 },
      { type: 'unknown-kind' },
      { type: ['object', 'nope'] },
      { properties: 5 },
      { properties: { a: 'string' } },
      { required: 'a' },
      { required: ['a', 2] },
      { required: ['a', 'a'] },
      { items: 5 },
      { items: ['a'] },
      { items: [{}], additionalProperties: 'no' },
      { enum: 'nope' },
      { allOf: {} },
      { oneOf: [{}], not: 5 },
      { minimum: 'zero' },
      { minLength: -1 },
      { minLength: 1.5 },
      { pattern: 5 },
      { minItems: 1, uniqueItems: 'yes' },
    ]) {
      expect(isJsonSchema(schema)).toBe(false)
    }
  })

  it('rejects non-JSON schema values such as bigint', () => {
    expect(isJsonSchema({ type: 'object', extra: BigInt(1) })).toBe(false)
    expect(isJsonSchema({ enum: [BigInt(1)] })).toBe(false)
  })

  it('validates type, required, properties, and additionalProperties', () => {
    const schema = {
      type: 'object',
      required: ['result'],
      properties: {
        result: { type: 'string' },
        count: { type: 'integer' },
      },
      additionalProperties: false,
    }
    expect(
      validateJsonSchemaOutput(schema, { result: 'ok', count: 2 }),
    ).toEqual([])
    expect(validateJsonSchemaOutput(schema, { count: 2 })).not.toEqual([])
    expect(validateJsonSchemaOutput(schema, { result: 5 })).not.toEqual([])
    expect(
      validateJsonSchemaOutput(schema, { result: 'ok', count: 2.5 }),
    ).not.toEqual([])
    expect(
      validateJsonSchemaOutput(schema, { result: 'ok', extra: 1 }),
    ).not.toEqual([])
  })

  it('validates arrays, tuples, enums, and const', () => {
    const schema = {
      type: 'array',
      items: [{ type: 'number' }, { type: 'string' }],
      minItems: 2,
      maxItems: 2,
    }
    expect(validateJsonSchemaOutput(schema, [1, 'a'])).toEqual([])
    expect(validateJsonSchemaOutput(schema, ['a', 1])).not.toEqual([])
    expect(validateJsonSchemaOutput(schema, [1])).not.toEqual([])

    expect(validateJsonSchemaOutput({ enum: ['a', 'b', 3] }, 'b')).toEqual([])
    expect(validateJsonSchemaOutput({ enum: ['a', 'b'] }, 'c')).not.toEqual([])
    expect(validateJsonSchemaOutput({ const: { a: 1 } }, { a: 1 })).toEqual([])
    expect(validateJsonSchemaOutput({ const: { a: 1 } }, { a: 2 })).not.toEqual(
      [],
    )
  })

  it('validates strings, patterns, and uniqueItems', () => {
    expect(validateJsonSchemaOutput({ type: 'string' }, 'x')).toEqual([])
    expect(
      validateJsonSchemaOutput(
        { type: 'string', minLength: 2, maxLength: 3 },
        'abc',
      ),
    ).toEqual([])
    expect(
      validateJsonSchemaOutput({ type: 'string', minLength: 2 }, 'a'),
    ).not.toEqual([])
    expect(validateJsonSchemaOutput({ pattern: '^[a-z]+$' }, 'abc')).toEqual([])
    expect(
      validateJsonSchemaOutput({ pattern: '^[a-z]+$' }, 'ABC'),
    ).not.toEqual([])
    expect(
      validateJsonSchemaOutput({ type: 'array', uniqueItems: true }, [1, 2]),
    ).toEqual([])
    expect(
      validateJsonSchemaOutput({ type: 'array', uniqueItems: true }, [1, 1]),
    ).not.toEqual([])
  })

  it('validates numbers, allOf, anyOf, oneOf, and not', () => {
    expect(validateJsonSchemaOutput({ type: 'number' }, 1.5)).toEqual([])
    expect(
      validateJsonSchemaOutput({ type: 'number', minimum: 1, maximum: 3 }, 2),
    ).toEqual([])
    expect(
      validateJsonSchemaOutput({ type: 'number', minimum: 3 }, 2),
    ).not.toEqual([])
    expect(validateJsonSchemaOutput({ type: 'boolean' }, true)).toEqual([])

    expect(
      validateJsonSchemaOutput(
        { allOf: [{ type: 'number' }, { minimum: 2 }] },
        3,
      ),
    ).toEqual([])
    expect(
      validateJsonSchemaOutput(
        { allOf: [{ type: 'number' }, { minimum: 2 }] },
        1,
      ),
    ).not.toEqual([])
    expect(
      validateJsonSchemaOutput(
        { anyOf: [{ type: 'string' }, { type: 'number' }] },
        2,
      ),
    ).toEqual([])
    expect(
      validateJsonSchemaOutput({ anyOf: [{ type: 'string' }] }, 2),
    ).not.toEqual([])
    expect(
      validateJsonSchemaOutput(
        { oneOf: [{ type: 'string' }, { const: 'x' }] },
        'x',
      ),
    ).not.toEqual([])
    expect(
      validateJsonSchemaOutput(
        { oneOf: [{ type: 'string' }, { type: 'number' }] },
        'x',
      ),
    ).toEqual([])
    expect(validateJsonSchemaOutput({ not: { type: 'string' } }, 2)).toEqual([])
    expect(
      validateJsonSchemaOutput({ not: { type: 'string' } }, 'x'),
    ).not.toEqual([])
  })

  it('ignores unknown keywords and nested property schemas', () => {
    expect(
      validateJsonSchemaOutput(
        { type: 'object', properties: { a: { type: 'string', xCustom: 1 } } },
        { a: 'v' },
      ),
    ).toEqual([])
  })
})
