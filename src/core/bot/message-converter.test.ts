import type { ChatMessage, ChatToolMessage } from '../../types/chat'
import type { Mentionable } from '../../types/mentionable'
import {
  ToolCallResponseStatus,
  createCompleteToolCallArguments,
} from '../../types/tool-call.types'

import {
  convertAttachmentsToReply,
  platformToUserMessage,
  scanForSendAttachment,
} from './message-converter'
import { encodeSessionKey } from './types'
import type { PlatformMessageEvent } from './types'

function makeEvent(
  overrides: Partial<PlatformMessageEvent> = {},
): PlatformMessageEvent {
  return {
    platformName: 'telegram',
    messageId: 'm1',
    sessionKey: encodeSessionKey('telegram', 'private', '123'),
    chatType: 'private',
    senderId: 'u1',
    senderName: 'Alice',
    message: {
      components: [{ type: 'text', text: 'hello there' }],
      plainText: 'hello there',
      rawMessage: {},
      timestamp: 0,
    },
    ...overrides,
  }
}

describe('platformToUserMessage', () => {
  it('uses plainText as the base prompt content', () => {
    const result = platformToUserMessage(makeEvent())
    expect(result.promptContent).toBe('hello there')
    expect(result.mentionables).toEqual([])
  })

  it('prefixes a reply_to preview', () => {
    const event = makeEvent({
      message: {
        components: [
          { type: 'reply_to', messageId: 'm0', preview: 'original text' },
          { type: 'text', text: 'reply body' },
        ],
        plainText: 'reply body',
        rawMessage: {},
        timestamp: 0,
      },
    })
    const result = platformToUserMessage(event)
    expect(result.promptContent).toBe(
      '[Replying to: original text]\nreply body',
    )
  })

  it('prefixes mention components', () => {
    const event = makeEvent({
      message: {
        components: [
          { type: 'mention', userId: 'u2', displayName: 'Bob' },
          { type: 'text', text: 'hi @Bob' },
        ],
        plainText: 'hi @Bob',
        rawMessage: {},
        timestamp: 0,
      },
    })
    const result = platformToUserMessage(event)
    expect(result.promptContent).toBe('[Mentioned: Bob]\nhi @Bob')
  })

  it('describes unsupported components', () => {
    const event = makeEvent({
      message: {
        components: [
          {
            type: 'unsupported',
            kind: 'sticker',
            raw: {},
            summary: 'a sticker',
          },
        ],
        plainText: '',
        rawMessage: {},
        timestamp: 0,
      },
    })
    const result = platformToUserMessage(event)
    expect(result.promptContent).toBe(
      '[Unsupported sticker content: a sticker]',
    )
  })

  it('appends a description for each attachment and resolves mentionables via DI', () => {
    const fakeMentionable = { type: 'file' } as unknown as Mentionable
    const resolveMentionableFile = jest.fn(() => fakeMentionable)
    const result = platformToUserMessage(makeEvent(), {
      attachments: [
        {
          component: { type: 'image', fileId: 'f1', mimeType: 'image/jpeg' },
          vaultPath: '.yolo/bot-attachments/telegram/m1/photo.jpg',
          size: 1024,
        },
      ],
      resolveMentionableFile,
    })
    expect(result.promptContent).toContain('[User shared: image (1024 bytes)]')
    expect(resolveMentionableFile).toHaveBeenCalledWith(
      '.yolo/bot-attachments/telegram/m1/photo.jpg',
    )
    expect(result.mentionables).toEqual([fakeMentionable])
  })

  it('describes a skipped (too-large) attachment without a mentionable', () => {
    const resolveMentionableFile = jest.fn()
    const result = platformToUserMessage(makeEvent(), {
      attachments: [
        {
          component: {
            type: 'file',
            name: 'big.zip',
            mimeType: 'application/zip',
          },
          skippedReason: 'too large',
        },
      ],
      resolveMentionableFile,
    })
    expect(result.promptContent).toContain('[User shared: big.zip, too large]')
    expect(resolveMentionableFile).not.toHaveBeenCalled()
    expect(result.mentionables).toEqual([])
  })
})

function makeToolMessage(
  toolCallId: string,
  name: string,
  args: Record<string, unknown> | undefined,
  status: ToolCallResponseStatus = ToolCallResponseStatus.Success,
): ChatToolMessage {
  return {
    role: 'tool',
    id: `tool-${toolCallId}`,
    toolCalls: [
      {
        request: {
          id: toolCallId,
          name,
          arguments: args
            ? createCompleteToolCallArguments({ value: args })
            : undefined,
        },
        response:
          status === ToolCallResponseStatus.Success
            ? { status, data: { type: 'text', text: 'File ready' } }
            : { status: ToolCallResponseStatus.Error, error: 'boom' },
      },
    ],
  }
}

describe('scanForSendAttachment', () => {
  it('finds a completed send_attachment call, prefixed or not', () => {
    const messages: ChatMessage[] = [
      makeToolMessage('t1', 'yolo_local__send_attachment', {
        path: 'charts/sales.png',
        label: 'Sales chart',
      }),
    ]
    const calls = scanForSendAttachment(messages)
    expect(calls).toEqual([
      { toolCallId: 't1', path: 'charts/sales.png', label: 'Sales chart' },
    ])
  })

  it('matches an unprefixed tool name too', () => {
    const messages: ChatMessage[] = [
      makeToolMessage('t1', 'send_attachment', { path: 'charts/sales.png' }),
    ]
    expect(scanForSendAttachment(messages)).toEqual([
      { toolCallId: 't1', path: 'charts/sales.png', label: undefined },
    ])
  })

  it('ignores other tool calls and non-success responses', () => {
    const messages: ChatMessage[] = [
      makeToolMessage('t1', 'yolo_local__fs_read', { path: 'x.md' }),
      makeToolMessage(
        't2',
        'yolo_local__send_attachment',
        { path: 'charts/sales.png' },
        ToolCallResponseStatus.Error,
      ),
    ]
    expect(scanForSendAttachment(messages)).toEqual([])
  })

  it('ignores calls with no path argument', () => {
    const messages: ChatMessage[] = [
      makeToolMessage('t1', 'yolo_local__send_attachment', {
        label: 'oops, no path',
      }),
    ]
    expect(scanForSendAttachment(messages)).toEqual([])
  })
})

describe('convertAttachmentsToReply', () => {
  it('routes image extensions into images[] and everything else into files[]', () => {
    const result = convertAttachmentsToReply([
      { toolCallId: 't1', path: 'charts/sales.png', label: 'Sales' },
      { toolCallId: 't2', path: 'reports/q1.pdf' },
    ])
    expect(result.images).toEqual([
      {
        source: 'vault-path',
        path: 'charts/sales.png',
        mimeType: 'image/png',
        label: 'Sales',
      },
    ])
    expect(result.files).toEqual([
      {
        source: 'vault-path',
        path: 'reports/q1.pdf',
        mimeType: 'application/octet-stream',
        name: 'q1.pdf',
      },
    ])
  })

  it('returns empty arrays for no calls', () => {
    expect(convertAttachmentsToReply([])).toEqual({ images: [], files: [] })
  })
})
