import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import type { ChatTimelineItem } from '../../types/chat-timeline'

jest.mock('./SharedConversationSurface', () => ({
  SharedConversationSurface: (props: {
    overlaySlot?: React.ReactNode
    scrollContainerClassName?: string
    virtualizationThreshold?: number
  }) => {
    mockSharedSurfaceProps = props
    return (
      <div className={props.scrollContainerClassName ?? 'surface'}>
        {props.overlaySlot}
      </div>
    )
  },
}))

jest.mock('./InstallationIncompleteBanner', () => ({
  InstallationIncompleteBanner: () => (
    <div className="installation-incomplete-banner" />
  ),
}))

let mockSharedSurfaceProps: {
  virtualizationThreshold?: number
} | null = null

import { ChatConversationPane } from './ChatConversationPane'

function renderPane(): string {
  return renderToStaticMarkup(
    <ChatConversationPane
      chatMode="ask"
      yoloEnabled={false}
      groupedChatMessagesLength={0}
      showEmptyState
      isAutoFollowEnabled
      currentConversationId="conv-1"
      chatTimelineItems={[]}
      chatMessagesRef={{ current: null }}
      onScrollContainerChange={() => {}}
      onBottomSentinelChange={() => {}}
      renderChatTimelineItem={() => null}
      editingAssistantMessageId={null}
      onForceScrollToBottom={() => {}}
      hasStreamingMessages={false}
      scrollToBottomLabel="Scroll"
      scrollToBottomWhileStreamingLabel="Scroll streaming"
      emptyStateAskTitle="Ask"
      emptyStateAgentTitle="Agent"
      emptyStateAgentFullTitle="Agent Full"
      emptyStateAskDescription="Ask desc"
      emptyStateAgentDescription="Agent desc"
      emptyStateAgentFullDescription="Agent full desc"
      footerContent={null}
    />,
  )
}

describe('ChatConversationPane', () => {
  afterEach(() => {
    mockSharedSurfaceProps = null
  })

  it('wires the installation incomplete banner above the conversation surface', () => {
    const html = renderPane()

    expect(html).toContain('installation-incomplete-banner')
  })

  it('virtualizes only while a message is being edited', () => {
    renderPane()
    expect(mockSharedSurfaceProps?.virtualizationThreshold).toBeUndefined()

    const html = renderToStaticMarkup(
      <ChatConversationPane
        chatMode="ask"
        yoloEnabled={false}
        groupedChatMessagesLength={0}
        showEmptyState
        isAutoFollowEnabled
        currentConversationId="conv-1"
        chatTimelineItems={[{}, {}] as ChatTimelineItem[]}
        chatMessagesRef={{ current: null }}
        onScrollContainerChange={() => {}}
        onBottomSentinelChange={() => {}}
        renderChatTimelineItem={() => null}
        editingAssistantMessageId="editing-1"
        onForceScrollToBottom={() => {}}
        hasStreamingMessages={false}
        scrollToBottomLabel="Scroll"
        scrollToBottomWhileStreamingLabel="Scroll streaming"
        emptyStateAskTitle="Ask"
        emptyStateAgentTitle="Agent"
        emptyStateAgentFullTitle="Agent Full"
        emptyStateAskDescription="Ask desc"
        emptyStateAgentDescription="Agent desc"
        emptyStateAgentFullDescription="Agent full desc"
        footerContent={null}
      />,
    )
    expect(html).toContain('yolo-chat-messages')
    expect(mockSharedSurfaceProps?.virtualizationThreshold).toBe(2)
  })

  it('renders the shared footer beside the conversation surface', () => {
    const html = renderPane()

    expect(html).toContain('yolo-chat-footer')
    expect(html).toContain('yolo-chat-messages')
  })
})
