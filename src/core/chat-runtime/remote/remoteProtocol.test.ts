import {
  CHAT_RUNTIME_PROTOCOL_VERSION,
  type WireEventEnvelope,
  decodeChatRuntimeEvent,
  encodeChatRuntimeEvent,
} from './remoteProtocol'

const wire: WireEventEnvelope = {
  protocolVersion: 1,
  eventId: 'e1',
  sequence: 3,
  runId: 'run-1',
  conversationId: 'conv-1',
  sessionRef: null,
  timestamp: 1000,
  type: 'run.state',
  payload: { state: 'running' },
}

describe('remote protocol codec', () => {
  it('round-trips an envelope through JSON', () => {
    const encoded = encodeChatRuntimeEvent(wire)
    expect(decodeChatRuntimeEvent(JSON.parse(encoded))).toEqual(wire)
  })

  it('rejects an unsupported protocol version', () => {
    expect(() =>
      decodeChatRuntimeEvent({ ...wire, protocolVersion: 99 }),
    ).toThrow(/protocol/i)
  })

  it('exports a stable protocol version constant', () => {
    expect(CHAT_RUNTIME_PROTOCOL_VERSION).toBe(1)
  })
})
