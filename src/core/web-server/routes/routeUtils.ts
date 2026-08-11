export type ApiError = {
  error: {
    code: string
    message: string
  }
}

/**
 * 会话乐观并发冲突错误（backup 的 src/core/conversation/errors.ts 定义；
 * master 会话层无此错误，由路由层保留以便未来实现方按契约抛出）。
 */
export class ConversationConflictError extends Error {
  readonly code = 'conversation_conflict'

  constructor(message = 'Conversation state changed. Refresh and retry.') {
    super(message)
    this.name = 'ConversationConflictError'
  }
}

export const isConversationConflictError = (
  error: unknown,
): error is ConversationConflictError =>
  error instanceof ConversationConflictError

const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024

export function apiError(code: string, message: string): ApiError {
  return { error: { code, message } }
}

export async function readJsonBody(
  req: AsyncIterable<Uint8Array | string>,
  options?: { maxBytes?: number },
): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; statusCode: number; body: ApiError }
> {
  const maxBytes = options?.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of req) {
    const buffer =
      typeof chunk === 'string'
        ? Buffer.from(chunk, 'utf8')
        : Buffer.from(chunk)
    totalBytes += buffer.byteLength
    if (totalBytes > maxBytes) {
      return {
        ok: false,
        statusCode: 413,
        body: apiError('request_too_large', 'JSON body is too large'),
      }
    }
    chunks.push(buffer)
  }

  if (totalBytes === 0) {
    return { ok: true, value: {} }
  }

  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        ok: false,
        statusCode: 400,
        body: apiError('invalid_request', 'JSON body must be an object'),
      }
    }
    return { ok: true, value: parsed as Record<string, unknown> }
  } catch {
    return {
      ok: false,
      statusCode: 400,
      body: apiError('invalid_request', 'Invalid JSON body'),
    }
  }
}
