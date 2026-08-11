import React, { useMemo, useState } from 'react'

import type { ChatLeafPlacement } from '../../features/chat/chatLeafSessionManager'

import Chat, { ChatProps, ChatRef } from './Chat'

type ChatSidebarTabsProps = {
  chatRef: React.RefObject<ChatRef>
  placement: ChatLeafPlacement
  initialChatProps?: ChatProps
  /** Web 端懒解析 CLI scope（远程组装）；透传给 Chat，桌面不传。 */
  getCliRuntimeScope?: ChatProps['getCliRuntimeScope']
  /** Web 端注入的契约 runtime 装配（RemoteChatRuntimeAdapter）；透传给 Chat。 */
  buildRuntime?: ChatProps['buildRuntime']
  onConversationContextChange?: ChatProps['onConversationContextChange']
  onRuntimeSnapshotChange?: ChatProps['onRuntimeSnapshotChange']
}

const ChatSidebarTabs: React.FC<ChatSidebarTabsProps> = ({
  chatRef,
  placement,
  initialChatProps,
  getCliRuntimeScope,
  buildRuntime,
  onConversationContextChange,
  onRuntimeSnapshotChange,
}) => {
  const [activeTab, setActiveTab] = useState<'chat' | 'composer'>('chat')

  // Keep the initial props stable even if parent clears them after render
  const chatProps = useMemo(() => initialChatProps, [initialChatProps])

  return (
    <div className="yolo-sidebar-root">
      <div className="yolo-sidebar-panels">
        <div className="yolo-sidebar-pane is-active" aria-hidden={false}>
          <Chat
            ref={chatRef}
            {...(chatProps ?? {})}
            placement={placement}
            getCliRuntimeScope={getCliRuntimeScope}
            buildRuntime={buildRuntime}
            onConversationContextChange={onConversationContextChange}
            onRuntimeSnapshotChange={onRuntimeSnapshotChange}
            activeView={activeTab}
            onChangeView={(view) => setActiveTab(view)}
          />
        </div>
      </div>
    </div>
  )
}

export default ChatSidebarTabs
