import { isJsonValue } from './workflow-run-types'

const JSON_TYPES = new Set([
  'null',
  'boolean',
  'integer',
  'number',
  'string',
  'array',
  'object',
])

/** Structural draft-07 subset validation; unknown keywords are ignored. */
export function isJsonSchema(value: unknown): boolean {
  return schemaErrors(value).length === 0
}

export function schemaErrors(value: unknown, path = '$'): readonly string[] {
  if (!isRecord(value)) return [`${path} must be an object`]
  if (!isJsonValue(value)) return [`${path} must be JSON-compatible`]
  const errors: string[] = []
  if (value.type !== undefined && !isSchemaType(value.type))
    errors.push(`${path}.type must be a JSON type string or array`)
  if (value.properties !== undefined && !isRecord(value.properties))
    errors.push(`${path}.properties must be an object`)
  else if (value.properties !== undefined) {
    for (const [key, child] of Object.entries(value.properties)) {
      if (child === undefined) continue
      errors.push(...schemaErrors(child, `${path}.properties.${key}`))
    }
  }
  if (value.additionalProperties !== undefined) {
    if (
      typeof value.additionalProperties !== 'boolean' &&
      !isRecord(value.additionalProperties)
    )
      errors.push(`${path}.additionalProperties must be a boolean or schema`)
    else if (isRecord(value.additionalProperties))
      errors.push(
        ...schemaErrors(
          value.additionalProperties,
          `${path}.additionalProperties`,
        ),
      )
  }
  if (value.items !== undefined) {
    if (Array.isArray(value.items)) {
      for (const [index, child] of value.items.entries()) {
        if (child === undefined) continue
        errors.push(...schemaErrors(child, `${path}.items[${index}]`))
      }
    } else if (!isRecord(value.items)) {
      errors.push(`${path}.items must be a schema or array of schemas`)
    } else {
      errors.push(...schemaErrors(value.items, `${path}.items`))
    }
  }
  if (value.required !== undefined) {
    if (
      !Array.isArray(value.required) ||
      value.required.some((entry) => typeof entry !== 'string') ||
      new Set(value.required).size !== value.required.length
    )
      errors.push(`${path}.required must be an array of unique strings`)
  }
  if (value.enum !== undefined) {
    if (
      !Array.isArray(value.enum) ||
      value.enum.some((entry) => !isJsonValue(entry))
    )
      errors.push(`${path}.enum must be an array of JSON values`)
  }
  if (value.const !== undefined && !isJsonValue(value.const))
    errors.push(`${path}.const must be a JSON value`)
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    if (value[keyword] !== undefined) {
      if (
        !Array.isArray(value[keyword]) ||
        value[keyword].some((child) => !isRecord(child))
      )
        errors.push(`${path}.${keyword} must be an array of schemas`)
      else {
        for (const [index, child] of value[keyword].entries())
          errors.push(...schemaErrors(child, `${path}.${keyword}[${index}]`))
      }
    }
  }
  if (value.not !== undefined) {
    if (!isRecord(value.not)) errors.push(`${path}.not must be a schema`)
    else errors.push(...schemaErrors(value.not, `${path}.not`))
  }
  for (const keyword of [
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
  ] as const) {
    if (value[keyword] !== undefined && typeof value[keyword] !== 'number')
      errors.push(`${path}.${keyword} must be a number`)
  }
  for (const keyword of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ] as const) {
    if (
      value[keyword] !== undefined &&
      (!Number.isInteger(value[keyword]) || (value[keyword] as number) < 0)
    )
      errors.push(`${path}.${keyword} must be a non-negative integer`)
  }
  if (value.pattern !== undefined && typeof value.pattern !== 'string')
    errors.push(`${path}.pattern must be a string`)
  if (value.uniqueItems !== undefined && typeof value.uniqueItems !== 'boolean')
    errors.push(`${path}.uniqueItems must be a boolean`)
  return errors
}

/** Validates a JSON value against a structural draft-07 schema. */
export function validateJsonSchemaOutput(
  schema: unknown,
  value: unknown,
): readonly string[] {
  if (!isJsonSchema(schema)) return ['schema is not a valid JSON Schema']
  return validate(schema as Readonly<Record<string, unknown>>, value, '$')
    .errors
}

function isSchemaType(value: unknown): boolean {
  if (typeof value === 'string') return JSON_TYPES.has(value)
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === 'string' && JSON_TYPES.has(entry))
  )
}

function validate(
  schema: Readonly<Record<string, unknown>>,
  value: unknown,
  path: string,
): { errors: string[]; valid: boolean } {
  const errors: string[] = []
  const fail = (message: string): void => {
    errors.push(`${path}: ${message}`)
  }
  const type = schema.type
  if (type !== undefined) {
    const types = Array.isArray(type) ? type : [type]
    if (!types.some((candidate) => matchesType(candidate as string, value)))
      fail(`expected type ${types.join(' or ')}, got ${typeof value}`)
  }
  if (
    schema.enum !== undefined &&
    !(schema.enum as unknown[]).some((entry) => jsonEqual(entry, value))
  )
    fail('value is not in the enum')
  if (schema.const !== undefined && !jsonEqual(schema.const, value))
    fail('value does not match const')
  if (schema.type !== 'object' || !isRecord(value)) {
    if (schema.properties !== undefined || schema.required !== undefined)
      return { errors, valid: errors.length === 0 }
  }
  if (isRecord(value)) {
    if (schema.required !== undefined) {
      for (const key of schema.required as string[])
        if (!Object.prototype.hasOwnProperty.call(value, key))
          fail(`missing required property "${key}"`)
    }
    if (schema.properties !== undefined) {
      for (const [key, child] of Object.entries(
        schema.properties as Readonly<Record<string, unknown>>,
      )) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue
        const result = validate(
          child as Readonly<Record<string, unknown>>,
          value[key],
          `${path}.${key}`,
        )
        errors.push(...result.errors)
      }
    }
    if (
      schema.additionalProperties !== undefined &&
      schema.additionalProperties !== true
    ) {
      for (const key of Object.keys(value)) {
        if (
          schema.properties !== undefined &&
          Object.prototype.hasOwnProperty.call(schema.properties, key)
        )
          continue
        if (schema.additionalProperties === false) {
          fail(`additional property "${key}" is not allowed`)
        } else {
          const result = validate(
            schema.additionalProperties as Readonly<Record<string, unknown>>,
            value[key],
            `${path}.${key}`,
          )
          errors.push(...result.errors)
        }
      }
    }
    if (
      schema.minProperties !== undefined &&
      Object.keys(value).length < (schema.minProperties as number)
    )
      fail(`expected at least ${schema.minProperties as number} properties`)
    if (
      schema.maxProperties !== undefined &&
      Object.keys(value).length > (schema.maxProperties as number)
    )
      fail(`expected at most ${schema.maxProperties as number} properties`)
  }
  if (Array.isArray(value)) {
    const items = schema.items
    if (Array.isArray(items)) {
      for (let index = 0; index < value.length; index += 1) {
        if (index >= items.length) continue
        const result = validate(
          items[index] as Readonly<Record<string, unknown>>,
          value[index],
          `${path}[${index}]`,
        )
        errors.push(...result.errors)
      }
    } else if (isRecord(items)) {
      for (let index = 0; index < value.length; index += 1) {
        const result = validate(items, value[index], `${path}[${index}]`)
        errors.push(...result.errors)
      }
    }
    if (
      schema.minItems !== undefined &&
      value.length < (schema.minItems as number)
    )
      fail(`expected at least ${schema.minItems as number} items`)
    if (
      schema.maxItems !== undefined &&
      value.length > (schema.maxItems as number)
    )
      fail(`expected at most ${schema.maxItems as number} items`)
    if (schema.uniqueItems === true) {
      for (let left = 0; left < value.length; left += 1)
        for (let right = left + 1; right < value.length; right += 1)
          if (jsonEqual(value[left], value[right])) fail('items are not unique')
    }
  }
  if (typeof value === 'string') {
    if (
      schema.minLength !== undefined &&
      value.length < (schema.minLength as number)
    )
      fail(`expected at least ${schema.minLength as number} characters`)
    if (
      schema.maxLength !== undefined &&
      value.length > (schema.maxLength as number)
    )
      fail(`expected at most ${schema.maxLength as number} characters`)
    if (
      schema.pattern !== undefined &&
      !new RegExp(schema.pattern as string).test(value)
    )
      fail(`value does not match pattern ${schema.pattern as string}`)
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < (schema.minimum as number))
      fail(`expected >= ${schema.minimum as number}`)
    if (schema.maximum !== undefined && value > (schema.maximum as number))
      fail(`expected <= ${schema.maximum as number}`)
    if (
      schema.exclusiveMinimum !== undefined &&
      value <= (schema.exclusiveMinimum as number)
    )
      fail(`expected > ${schema.exclusiveMinimum as number}`)
    if (
      schema.exclusiveMaximum !== undefined &&
      value >= (schema.exclusiveMaximum as number)
    )
      fail(`expected < ${schema.exclusiveMaximum as number}`)
  }
  for (const keyword of ['allOf', 'anyOf', 'oneOf'] as const) {
    const group = schema[keyword]
    if (!Array.isArray(group)) continue
    if (keyword === 'allOf') {
      for (const [index, child] of group.entries()) {
        const result = validate(
          child as Readonly<Record<string, unknown>>,
          value,
          `${path}#allOf[${index}]`,
        )
        errors.push(...result.errors)
      }
    } else {
      const counts = group.map((child) =>
        validate(
          child as Readonly<Record<string, unknown>>,
          value,
          `${path}#${keyword}[?]`,
        ).errors.length === 0
          ? 1
          : 0,
      )
      const matches = counts.reduce((sum, count) => sum + count, 0)
      if (keyword === 'anyOf' && matches === 0)
        fail('value does not match anyOf')
      if (keyword === 'oneOf' && matches !== 1)
        fail('value must match exactly one oneOf schema')
    }
  }
  if (schema.not !== undefined) {
    const result = validate(
      schema.not as Readonly<Record<string, unknown>>,
      value,
      `${path}#not`,
    )
    if (result.errors.length === 0) fail('value matches the not schema')
  }
  return { errors, valid: errors.length === 0 }
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case 'null':
      return value === null
    case 'boolean':
      return typeof value === 'boolean'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number'
    case 'string':
      return typeof value === 'string'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isRecord(value)
    default:
      return false
  }
}

function jsonEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (typeof left !== typeof right) return false
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false
    return left.every((entry, index) => jsonEqual(entry, right[index]))
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    if (leftKeys.length !== rightKeys.length) return false
    return leftKeys.every((key) => jsonEqual(left[key], right[key]))
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
