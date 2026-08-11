import type { ChatRuntimeEvent, ChatRuntimeEventType } from '../contract'

export const CHAT_RUNTIME_PROTOCOL_VERSION = 1 as const

export type WireEventEnvelope = {
  protocolVersion: typeof CHAT_RUNTIME_PROTOCOL_VERSION
  eventId: string
  sequence: number
  runId: string
  conversationId: string | null
  sessionRef: ChatRuntimeEvent['sessionRef']
  timestamp: number
  type: ChatRuntimeEventType
  payload: unknown
}

export const CHAT_RUNTIME_ENDPOINTS = {
  stream: (runtimeId: string) => `/api/chat-runtime/${runtimeId}/stream`,
  snapshot: (runtimeId: string) => `/api/chat-runtime/${runtimeId}/snapshot`,
  turn: (runtimeId: string) => `/api/chat-runtime/${runtimeId}/turn`,
  cancel: (runtimeId: string) => `/api/chat-runtime/${runtimeId}/cancel`,
  approval: (runtimeId: string) => `/api/chat-runtime/${runtimeId}/approval`,
  question: (runtimeId: string) => `/api/chat-runtime/${runtimeId}/question`,
  config: (runtimeId: string) => `/api/chat-runtime/${runtimeId}/config`,
  permission: (runtimeId: string) =>
    `/api/chat-runtime/${runtimeId}/permission`,
  sessions: (runtimeId: string) => `/api/chat-runtime/${runtimeId}/sessions`,
  sessionOpen: (runtimeId: string) =>
    `/api/chat-runtime/${runtimeId}/sessions/open`,
  sessionRename: (runtimeId: string) =>
    `/api/chat-runtime/${runtimeId}/sessions/rename`,
  sessionTitle: (runtimeId: string) =>
    `/api/chat-runtime/${runtimeId}/sessions/title`,
  sessionDelete: (runtimeId: string) =>
    `/api/chat-runtime/${runtimeId}/sessions/delete`,
  sessionPin: (runtimeId: string) =>
    `/api/chat-runtime/${runtimeId}/sessions/pin`,
} as const

export function encodeChatRuntimeEvent(event: WireEventEnvelope): string {
  return JSON.stringify(event)
}

export function decodeChatRuntimeEvent(data: unknown): WireEventEnvelope {
  if (
    typeof data !== 'object' ||
    data === null ||
    (data as { protocolVersion?: unknown }).protocolVersion !==
      CHAT_RUNTIME_PROTOCOL_VERSION
  ) {
    throw new Error(
      `Unsupported chat runtime protocol version (expected ${CHAT_RUNTIME_PROTOCOL_VERSION})`,
    )
  }
  return data as WireEventEnvelope
}

export function eventToWire(event: ChatRuntimeEvent): WireEventEnvelope {
  return {
    protocolVersion: CHAT_RUNTIME_PROTOCOL_VERSION,
    eventId: event.eventId,
    sequence: event.sequence,
    runId: event.runId,
    conversationId: event.conversationId,
    sessionRef: event.sessionRef,
    timestamp: event.timestamp,
    type: event.type,
    payload: event.payload,
  }
}
