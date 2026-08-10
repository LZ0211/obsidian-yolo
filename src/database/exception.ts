export class DatabaseException extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseException'
  }
}

export class DatabaseNotInitializedException extends DatabaseException {
  constructor(message = 'Database not initialized') {
    super(message)
    this.name = 'DatabaseNotInitializedException'
  }
}

export class DuplicateTemplateException extends DatabaseException {
  constructor(templateName: string) {
    super(`Template with name "${templateName}" already exists`)
    this.name = 'DuplicateTemplateException'
  }
}

/**
 * Raised when persisting the vector database fails. Historically the PGlite
 * snapshot dump could OOM on large vector libraries (issue #408); swallowing
 * the error would let the index UI report 100% complete while the database
 * was, in fact, not flushed. Surfacing it moves the RAG run state to `failed`.
 *
 * Classified as `permanent` for retry-policy purposes — retrying immediately
 * is unlikely to help, and we don't want to thrash the user with auto-retries
 * on an OOM condition.
 */
export class DatabaseSaveFailedError extends DatabaseException {
  readonly cause: unknown
  constructor(cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    super(`Failed to save vector database snapshot: ${detail}`)
    this.name = 'DatabaseSaveFailedError'
    this.cause = cause
  }
}
