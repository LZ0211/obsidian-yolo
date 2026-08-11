import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React, { useState } from 'react'
import { type Root, createRoot } from 'react-dom/client'

import type { ChatProps, ChatRef } from '../components/chat-view/Chat'
import ChatSidebarTabs from '../components/chat-view/ChatSidebarTabs'
import { AppProvider } from '../contexts/app-context'
import { ChatViewProvider } from '../contexts/chat-view-context'
import { DarkModeProvider } from '../contexts/dark-mode-context'
import { DialogContainerProvider } from '../contexts/dialog-container-context'
import { LanguageProvider } from '../contexts/language-context'
import { McpProvider } from '../contexts/mcp-context'
import { PluginProvider } from '../contexts/plugin-context'
import { SettingsProvider } from '../contexts/settings-context'
import { AgentModeAllowedProvider } from '../contexts/web-agent-capability-context'
import type { McpManager } from '../core/mcp/mcpManager'
import { YoloRuntimeProvider } from '../runtime/web-entry'
import type { YoloRuntime } from '../runtime/yoloRuntime.types'

type ChatTabsMountProps = {
  chatRef: React.RefObject<ChatRef>
  initialChatProps?: ChatProps
  getCliRuntimeScope?: ChatProps['getCliRuntimeScope']
  buildRuntime?: ChatProps['buildRuntime']
  onConversationContextChange?: ChatProps['onConversationContextChange']
}

// Task 11 硬性要求：传给 ChatSidebarTabs 的 buildRuntime 必须 memoize——
// Chat 的注入 effect 依赖 props.buildRuntime 的函数身份（Chat.tsx 注释），
// 身份不稳会导致每次 render 重建 SSE adapter（dispose/重建循环）。这里用
// useState 惰性初始化冻结首次传入的身份：本树按 tab 挂载一次，会话/智能体
// 切换由组装层重建整个 React tree（webChatTabs.createTab 每 tab 一次），
// 不存在「冻结后需要跟随更新」的场景。
function ChatTabsMount({
  chatRef,
  initialChatProps,
  getCliRuntimeScope,
  buildRuntime,
  onConversationContextChange,
}: ChatTabsMountProps): React.ReactElement {
  const [stableBuildRuntime] = useState(() => buildRuntime)
  return React.createElement(ChatSidebarTabs, {
    chatRef,
    placement: 'tab',
    initialChatProps,
    getCliRuntimeScope,
    buildRuntime: stableBuildRuntime,
    onConversationContextChange,
  })
}

export type RenderChatOptions = {
  onConversationContextChange?: ChatProps['onConversationContextChange']
  dialogContainer?: HTMLElement | null
  /** Whether the active workspace agent allows Agent mode. Surfaced from
   *  bootstrap `allowedAgents[active].agentModeAllowed`. `null`/`undefined`
   *  means "no opinion" — the chat tree defaults to allowed (matches
   *  desktop Obsidian behaviour). */
  agentModeAllowed?: boolean | null
  initialChatProps?: ChatProps
  /** Desktop-only: bridges the CLI runtime scope through web-server routes. */
  getCliRuntimeScope?: ChatProps['getCliRuntimeScope']
  /** 契约 runtime 装配注入（Web 端 RemoteChatRuntimeAdapter）。 */
  buildRuntime?: ChatProps['buildRuntime']
}

export function renderChatIntoTarget(
  targetEl: HTMLElement,
  runtime: YoloRuntime,
  chatRef: React.RefObject<ChatRef>,
  options?: RenderChatOptions,
): { root: Root; unmount: () => void } {
  const dialogContainer =
    options?.dialogContainer ?? document.getElementById('app-root')
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { gcTime: 0 },
      mutations: { gcTime: 0 },
    },
  })
  const root: Root = createRoot(targetEl)
  const getMcpManager = () =>
    (
      runtime.plugin as {
        getMcpManagerForRequest?: () => Promise<McpManager>
        getMcpManager: () => Promise<McpManager>
      }
    ).getMcpManagerForRequest?.() ??
    (
      runtime.plugin as {
        getMcpManager: () => Promise<McpManager>
      }
    ).getMcpManager()
  root.render(
    <QueryClientProvider client={queryClient}>
      <YoloRuntimeProvider runtime={runtime}>
        <PluginProvider plugin={runtime.plugin as never}>
          {/* master 的 LanguageProvider 无 props（locale 走 localeStore/navigator） */}
          <LanguageProvider>
            <AppProvider app={runtime.app as never}>
              <SettingsProvider
                settings={runtime.settings.get()}
                setSettings={(next) =>
                  runtime.settings.update(next).then(() => true)
                }
                addSettingsChangeListener={(listener) =>
                  runtime.settings.subscribe(listener)
                }
              >
                <DarkModeProvider>
                  <McpProvider getMcpManager={getMcpManager}>
                    <DialogContainerProvider container={dialogContainer}>
                      <AgentModeAllowedProvider
                        value={options?.agentModeAllowed}
                      >
                        <ChatViewProvider chatView={{} as never}>
                          <ChatTabsMount
                            chatRef={chatRef}
                            initialChatProps={options?.initialChatProps}
                            getCliRuntimeScope={options?.getCliRuntimeScope}
                            buildRuntime={options?.buildRuntime}
                            onConversationContextChange={
                              options?.onConversationContextChange
                            }
                          />
                        </ChatViewProvider>
                      </AgentModeAllowedProvider>
                    </DialogContainerProvider>
                  </McpProvider>
                </DarkModeProvider>
              </SettingsProvider>
            </AppProvider>
          </LanguageProvider>
        </PluginProvider>
      </YoloRuntimeProvider>
    </QueryClientProvider>,
  )
  return {
    root,
    unmount: () => root.unmount(),
  }
}
