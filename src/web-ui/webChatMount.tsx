import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
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
  onConversationContextChange?: ChatProps['onConversationContextChange']
}

// Web 端 yolo 主面不注入契约 runtime（buildRuntime）——直接走 Chat 桌面路径
// createYoloChatRuntimeActions(agentService)，web agentService 代理已路由到
// /api/agent/*（createWebYoloRuntime.ts），服务端 agentRoutes 全量接线。
// 契约注入保留给未来 CLI/契约面（Chat.tsx 注入分支），届时再由本层按需传递。
function ChatTabsMount({
  chatRef,
  initialChatProps,
  getCliRuntimeScope,
  onConversationContextChange,
}: ChatTabsMountProps): React.ReactElement {
  return React.createElement(ChatSidebarTabs, {
    chatRef,
    placement: 'tab',
    initialChatProps,
    getCliRuntimeScope,
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
  // 注意：不再提供 buildRuntime——yolo 主面走 Chat 桌面路径
  // （createYoloChatRuntimeActions(agentService)，web agentService 代理
  // /api/agent/*）；契约注入（Chat.tsx buildRuntime 分支）保留给未来
  // CLI/契约面，届时恢复本字段并按需传递。
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
