import Ajv from 'ajv'
import type { AnySchema, ErrorObject, ValidateFunction } from 'ajv'

import { isJsonValue } from './workflow-run-types'

export type WorkflowSchemaValidator = Readonly<{
  validateSchema(
    schema: unknown,
  ): Readonly<{ ok: true } | { ok: false; message: string }>
  validateValue(
    schema: unknown,
    value: unknown,
  ): Readonly<{ ok: true } | { ok: false; message: string }>
}>

const MAX_REPORTED_ERRORS = 3

/**
 * Creates an isolated validator over its own Ajv instance. Production code
 * shares the module-level `workflowSchemaValidator`; the factory exists for
 * tests and for callers that need an independent instance.
 */
export function createWorkflowSchemaValidator(): WorkflowSchemaValidator {
  const ajv = new Ajv({
    strict: false,
    allErrors: true,
    logger: false,
  })
  const compiled = new WeakMap<object, ValidateFunction>()

  const compile = (
    schema: unknown,
  ):
    | Readonly<{ ok: true; validate: ValidateFunction }>
    | Readonly<{ ok: false; message: string }> => {
    if (!isJsonValue(schema))
      return {
        ok: false,
        message: 'The schema must be a JSON-compatible value',
      }
    if (typeof schema !== 'boolean' && !isRecord(schema))
      return {
        ok: false,
        message: 'The schema must be a JSON Schema object or boolean',
      }
    if (isRecord(schema)) {
      const cached = compiled.get(schema)
      if (cached) return { ok: true, validate: cached }
    }
    try {
      const validate = ajv.compile(schema as AnySchema)
      if (isRecord(schema)) compiled.set(schema, validate)
      return { ok: true, validate }
    } catch (error) {
      return {
        ok: false,
        message: `Invalid JSON Schema: ${error instanceof Error ? error.message : String(error)}`,
      }
    }
  }

  return Object.freeze({
    validateSchema: (schema: unknown) => {
      const compiledSchema = compile(schema)
      return compiledSchema.ok
        ? Object.freeze({ ok: true as const })
        : Object.freeze({ ok: false as const, message: compiledSchema.message })
    },
    validateValue: (schema: unknown, value: unknown) => {
      if (!isJsonValue(value))
        return Object.freeze({
          ok: false as const,
          message: 'The value must be a JSON-compatible value',
        })
      const compiledSchema = compile(schema)
      if (!compiledSchema.ok)
        return Object.freeze({
          ok: false as const,
          message: compiledSchema.message,
        })
      const valid = compiledSchema.validate(value)
      if (valid) return Object.freeze({ ok: true as const })
      return Object.freeze({
        ok: false as const,
        message: formatValidationErrors(compiledSchema.validate.errors ?? []),
      })
    },
  })
}

/** The one Ajv instance shared by the executor, coordinator, and preflight. */
export const workflowSchemaValidator: WorkflowSchemaValidator =
  createWorkflowSchemaValidator()

/** Definition preflight: every node outputSchema must compile. */
export function isJsonSchema(schema: unknown): boolean {
  return workflowSchemaValidator.validateSchema(schema).ok
}

/** Coordinator-side defensive output validation; [] means valid. */
export function validateJsonSchemaOutput(
  schema: unknown,
  value: unknown,
): readonly string[] {
  const result = workflowSchemaValidator.validateValue(schema, value)
  return result.ok ? [] : [result.message]
}

function formatValidationErrors(errors: readonly ErrorObject[]): string {
  return errors
    .slice(0, MAX_REPORTED_ERRORS)
    .map(
      (entry) =>
        `${entry.instancePath || '$'} ${entry.message ?? 'is invalid'}`,
    )
    .join('; ')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
