import {
  createWorkflowSchemaValidator,
  isJsonSchema,
  validateJsonSchemaOutput,
} from './workflow-schema'

const objectSchema = {
  type: 'object',
  required: ['result'],
  properties: {
    result: { type: 'string', minLength: 1 },
    count: { type: 'integer', minimum: 0 },
    items: { type: 'array', items: { type: 'number' } },
  },
  additionalProperties: false,
}

describe('workflow json schema', () => {
  it('validateSchema accepts valid draft-07 schemas', () => {
    const validator = createWorkflowSchemaValidator()
    for (const schema of [
      objectSchema,
      { type: ['string', 'null'] },
      true,
      { enum: ['a', 'b', 3] },
      { const: { a: 1 } },
      {
        type: 'array',
        items: [{ type: 'number' }, { type: 'string' }],
        minItems: 2,
        maxItems: 2,
      },
      {
        definitions: { pos: { type: 'integer', minimum: 0 } },
        type: 'object',
        required: ['x'],
        properties: { x: { $ref: '#/definitions/pos' } },
      },
      { allOf: [{ type: 'number' }, { minimum: 2 }] },
      { not: { type: 'string' } },
    ]) {
      expect(validator.validateSchema(schema)).toEqual({ ok: true })
    }
  })

  it('validateSchema rejects malformed and non-JSON schemas', () => {
    const validator = createWorkflowSchemaValidator()
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
      { items: 5 },
      { items: ['a'] },
      { items: [{}], additionalProperties: 'no' },
      { enum: 'nope' },
      { enum: [BigInt(1)] },
      { allOf: {} },
      { oneOf: [{}], not: 5 },
      { minimum: 'zero' },
      { minLength: -1 },
      { minLength: 1.5 },
      { pattern: 5 },
      { minItems: 1, uniqueItems: 'yes' },
      { $ref: 'https://example.com/missing-schema.json' },
      { type: 'object', extra: BigInt(1) },
    ]) {
      expect(validator.validateSchema(schema)).toEqual({
        ok: false,
        message: expect.any(String),
      })
    }
  })

  it('validateSchema ignores unknown keywords', () => {
    const validator = createWorkflowSchemaValidator()
    expect(
      validator.validateSchema({
        type: 'object',
        properties: { a: { type: 'string', xCustom: 1 } },
        xUnknown: { deep: [1] },
      }),
    ).toEqual({ ok: true })
  })

  it('validateValue enforces type, required, properties, and additionalProperties', () => {
    const validator = createWorkflowSchemaValidator()
    expect(
      validator.validateValue(objectSchema, { result: 'ok', count: 2 }),
    ).toEqual({
      ok: true,
    })
    expect(validator.validateValue(objectSchema, { count: 2 }).ok).toBe(false)
    expect(validator.validateValue(objectSchema, { result: 5 }).ok).toBe(false)
    expect(
      validator.validateValue(objectSchema, { result: 'ok', count: 2.5 }).ok,
    ).toBe(false)
    expect(
      validator.validateValue(objectSchema, { result: 'ok', extra: 1 }).ok,
    ).toBe(false)
    expect(validator.validateValue({ type: ['string', 'null'] }, 'x')).toEqual({
      ok: true,
    })
    expect(validator.validateValue({ type: ['string', 'null'] }, 3).ok).toBe(
      false,
    )
  })

  it('validateValue enforces arrays, tuples, enums, and const', () => {
    const validator = createWorkflowSchemaValidator()
    const tuple = {
      type: 'array',
      items: [{ type: 'number' }, { type: 'string' }],
      minItems: 2,
      maxItems: 2,
    }
    expect(validator.validateValue(tuple, [1, 'a'])).toEqual({ ok: true })
    expect(validator.validateValue(tuple, ['a', 1]).ok).toBe(false)
    expect(validator.validateValue(tuple, [1]).ok).toBe(false)
    expect(validator.validateValue({ enum: ['a', 'b', 3] }, 'b')).toEqual({
      ok: true,
    })
    expect(validator.validateValue({ enum: ['a', 'b'] }, 'c').ok).toBe(false)
    expect(validator.validateValue({ const: { a: 1 } }, { a: 1 })).toEqual({
      ok: true,
    })
    expect(validator.validateValue({ const: { a: 1 } }, { a: 2 }).ok).toBe(
      false,
    )
  })

  it('validateValue enforces strings, patterns, and uniqueItems', () => {
    const validator = createWorkflowSchemaValidator()
    expect(validator.validateValue({ type: 'string' }, 'x')).toEqual({
      ok: true,
    })
    expect(
      validator.validateValue(
        { type: 'string', minLength: 2, maxLength: 3 },
        'abc',
      ),
    ).toEqual({ ok: true })
    expect(
      validator.validateValue({ type: 'string', minLength: 2 }, 'a').ok,
    ).toBe(false)
    expect(validator.validateValue({ pattern: '^[a-z]+$' }, 'abc')).toEqual({
      ok: true,
    })
    expect(validator.validateValue({ pattern: '^[a-z]+$' }, 'ABC').ok).toBe(
      false,
    )
    expect(
      validator.validateValue({ type: 'array', uniqueItems: true }, [1, 2]),
    ).toEqual({ ok: true })
    expect(
      validator.validateValue({ type: 'array', uniqueItems: true }, [1, 1]).ok,
    ).toBe(false)
  })

  it('validateValue enforces numbers and composition keywords', () => {
    const validator = createWorkflowSchemaValidator()
    expect(validator.validateValue({ type: 'number' }, 1.5)).toEqual({
      ok: true,
    })
    expect(
      validator.validateValue({ type: 'number', minimum: 1, maximum: 3 }, 2),
    ).toEqual({ ok: true })
    expect(validator.validateValue({ type: 'number', minimum: 3 }, 2).ok).toBe(
      false,
    )
    expect(validator.validateValue({ type: 'boolean' }, true)).toEqual({
      ok: true,
    })

    expect(
      validator.validateValue(
        { allOf: [{ type: 'number' }, { minimum: 2 }] },
        3,
      ),
    ).toEqual({ ok: true })
    expect(
      validator.validateValue(
        { allOf: [{ type: 'number' }, { minimum: 2 }] },
        1,
      ).ok,
    ).toBe(false)
    expect(
      validator.validateValue(
        { anyOf: [{ type: 'string' }, { type: 'number' }] },
        2,
      ),
    ).toEqual({ ok: true })
    expect(validator.validateValue({ anyOf: [{ type: 'string' }] }, 2).ok).toBe(
      false,
    )
    expect(
      validator.validateValue(
        { oneOf: [{ type: 'string' }, { const: 'x' }] },
        'x',
      ).ok,
    ).toBe(false)
    expect(
      validator.validateValue(
        { oneOf: [{ type: 'string' }, { type: 'number' }] },
        'x',
      ),
    ).toEqual({ ok: true })
    expect(validator.validateValue({ not: { type: 'string' } }, 2)).toEqual({
      ok: true,
    })
    expect(validator.validateValue({ not: { type: 'string' } }, 'x').ok).toBe(
      false,
    )
  })

  it('validateValue resolves local $ref definitions', () => {
    const validator = createWorkflowSchemaValidator()
    const schema = {
      definitions: { pos: { type: 'integer', minimum: 0 } },
      type: 'object',
      required: ['x'],
      properties: { x: { $ref: '#/definitions/pos' } },
    }
    expect(validator.validateValue(schema, { x: 3 })).toEqual({ ok: true })
    expect(validator.validateValue(schema, { x: -1 }).ok).toBe(false)
    expect(validator.validateValue(schema, { x: 's' }).ok).toBe(false)
  })

  it('validateValue rejects values that are not finite JSON-compatible', () => {
    const validator = createWorkflowSchemaValidator()
    for (const value of [
      BigInt(1),
      Number.NaN,
      Number.POSITIVE_INFINITY,
      undefined,
      () => 1,
      new Date(),
      { nested: BigInt(1) },
    ]) {
      expect(validator.validateValue({}, value)).toEqual({
        ok: false,
        message: expect.any(String),
      })
    }
    expect(validator.validateValue({}, 1)).toEqual({ ok: true })
    expect(validator.validateValue({}, null)).toEqual({ ok: true })
  })

  it('validateValue reports a readable message on failure', () => {
    const validator = createWorkflowSchemaValidator()
    const result = validator.validateValue(objectSchema, { result: 5 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message.length).toBeGreaterThan(5)
  })

  it('the module wrappers share one validator instance', () => {
    expect(isJsonSchema(objectSchema)).toBe(true)
    expect(isJsonSchema({ type: 42 })).toBe(false)
    expect(isJsonSchema({ type: 'object', extra: BigInt(1) })).toBe(false)
    expect(
      validateJsonSchemaOutput(objectSchema, { result: 'ok', count: 2 }),
    ).toEqual([])
    expect(validateJsonSchemaOutput(objectSchema, { result: 5 })).not.toEqual(
      [],
    )
    expect(validateJsonSchemaOutput(objectSchema, BigInt(1))).not.toEqual([])
  })

  it('the validator stays independent of provider and model settings', () => {
    // Unknown provider-ish keywords and format strings must not change results.
    const validator = createWorkflowSchemaValidator()
    expect(
      validator.validateValue(
        {
          type: 'string',
          format: 'email',
          providerHint: 'x',
          modelHint: 'y',
        },
        'not-an-email',
      ),
    ).toEqual({ ok: true })
  })
})
