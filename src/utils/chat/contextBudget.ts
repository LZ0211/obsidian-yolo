import type { ContentPart, RequestMessage } from '../../types/llm/request'

import { compressToolResult } from './contentCompressor'

export const DEFAULT_TOOL_RESULT_MAX_CHARS = 16_000
export const MIN_TOOL_RESULT_MAX_CHARS = 1_024
export const MAX_TOOL_RESULT_MAX_CHARS = 200_000

export const MAX_ASSISTANT_CONTENT_CONTEXT_CHARS = 32_000
export const MAX_ASSISTANT_REASONING_CONTEXT_CHARS = 16_000
export const MAX_TOOL_ARGUMENT_CONTEXT_CHARS = 16_000
export const MAX_USER_MESSAGE_CONTEXT_CHARS = 200_000

const buildTruncationMarker = (label: string, originalLength: number): string =>
  `\n…[${label} truncated; original ${originalLength} chars]…\n`

export function resolveToolResultMaxChars(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_TOOL_RESULT_MAX_CHARS
  }

  return Math.min(
    MAX_TOOL_RESULT_MAX_CHARS,
    Math.max(MIN_TOOL_RESULT_MAX_CHARS, Math.floor(value as number)),
  )
}

export function truncateContextText(
  text: string,
  maxChars: number,
  label = 'context',
): string {
  if (text.length <= maxChars) {
    return text
  }

  const safeMaxChars = Math.max(0, Math.floor(maxChars))
  if (safeMaxChars === 0) {
    return ''
  }

  const marker = buildTruncationMarker(label, text.length)
  if (marker.length >= safeMaxChars) {
    return marker.slice(0, safeMaxChars)
  }

  const contentChars = safeMaxChars - marker.length
  const headChars = Math.ceil(contentChars / 2)
  const tailChars = contentChars - headChars
  return `${text.slice(0, headChars)}${marker}${
    tailChars > 0 ? text.slice(text.length - tailChars) : ''
  }`
}

export function truncateJsonStrings(
  value: unknown,
  maxChars: number,
  label = 'argument',
): unknown {
  if (typeof value === 'string') {
    return truncateContextText(value, maxChars, label)
  }
  if (Array.isArray(value)) {
    return value.map((item) => truncateJsonStrings(item, maxChars, label))
  }
  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      truncateJsonStrings(entry, maxChars, label),
    ]),
  )
}

function truncateContentParts(
  content: ContentPart[],
  maxChars: number,
  label: string,
): ContentPart[] {
  return content.map((part) => {
    if (part.type !== 'text') {
      return part
    }
    return {
      ...part,
      text: truncateContextText(part.text, maxChars, label),
    }
  })
}

export function boundRequestMessagesForContext(
  messages: RequestMessage[],
  toolResultMaxChars: number,
): RequestMessage[] {
  const normalizedToolResultMaxChars =
    resolveToolResultMaxChars(toolResultMaxChars)

  return messages.map((message) => {
    if (message.role === 'system') {
      return message
    }

    if (message.role === 'user') {
      return {
        ...message,
        content:
          typeof message.content === 'string'
            ? truncateContextText(
                message.content,
                MAX_USER_MESSAGE_CONTEXT_CHARS,
                'user context',
              )
            : truncateContentParts(
                message.content,
                MAX_USER_MESSAGE_CONTEXT_CHARS,
                'user context',
              ),
      }
    }

    if (message.role === 'tool') {
      const boundedToolCall = message.tool_call
      const boundedArguments = boundedToolCall.arguments
      const boundedToolCallRequest = boundedArguments
        ? {
            ...boundedToolCall,
            arguments: {
              ...boundedArguments,
              ...(boundedArguments.kind === 'complete'
                ? {
                    value: truncateJsonStrings(
                      boundedArguments.value,
                      MAX_TOOL_ARGUMENT_CONTEXT_CHARS,
                    ) as Record<string, unknown>,
                  }
                : {
                    rawText: truncateContextText(
                      boundedArguments.rawText,
                      MAX_TOOL_ARGUMENT_CONTEXT_CHARS,
                      'tool arguments',
                    ),
                  }),
            },
          }
        : boundedToolCall
      return {
        ...message,
        tool_call: boundedToolCallRequest,
        content: compressToolResult(message.content, normalizedToolResultMaxChars),
      }
    }

    return {
      ...message,
      content: truncateContextText(
        message.content,
        MAX_ASSISTANT_CONTENT_CONTEXT_CHARS,
        'assistant content',
      ),
      ...(typeof message.reasoning === 'string'
        ? {
            reasoning: truncateContextText(
              message.reasoning,
              MAX_ASSISTANT_REASONING_CONTEXT_CHARS,
              'assistant reasoning',
            ),
          }
        : {}),
      tool_calls: message.tool_calls?.map((toolCall) => {
        const args = toolCall.arguments
        if (!args) return toolCall
        if (args.kind === 'partial') {
          return {
            ...toolCall,
            arguments: {
              ...args,
              rawText: truncateContextText(
                args.rawText,
                MAX_TOOL_ARGUMENT_CONTEXT_CHARS,
                'tool arguments',
              ),
            },
          }
        }
        return {
          ...toolCall,
          arguments: {
            ...args,
            value: truncateJsonStrings(
              args.value,
              MAX_TOOL_ARGUMENT_CONTEXT_CHARS,
            ) as Record<string, unknown>,
          },
        }
      }),
    }
  })
}
