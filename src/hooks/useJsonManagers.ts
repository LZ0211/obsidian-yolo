import { useMemo } from 'react'

import { useApp } from '../contexts/app-context'
import { useSettings } from '../contexts/settings-context'
import { ChatManager } from '../database/json/chat/ChatManager'
import type { WebChatManager } from '../runtime/web/webChatManager'
// templates feature removed

export function useChatManager() {
  const app = useApp()
  const { settings } = useSettings()
  return useMemo(() => {
    // Web 端：会话由服务器端持久化（session 作用域），客户端本地 JSON 仓库
    // 的内存缓存看不到这些写入——使用 web runtime 注入的服务端适配器。
    const webChat = (app as { __yoloWebChat?: WebChatManager }).__yoloWebChat
    if (webChat) return webChat
    return new ChatManager(app, settings)
  }, [app, settings])
}
