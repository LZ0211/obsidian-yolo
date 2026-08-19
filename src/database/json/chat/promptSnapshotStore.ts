import { App, normalizePath } from 'obsidian'
import path from 'path-browserify'

import { ensureUserDataRootDir } from '../../../core/paths/yoloManagedData'
import {
  SerializedChatMessage,
  SerializedChatUserMessage,
} from '../../../types/chat'
import { ContentPart } from '../../../types/llm/request'
import { CHAT_DIR } from '../constants'

type PromptSnapshotEntry = {
  hash: string
  content: string | ContentPart[]
  createdAt: number
  updatedAt: number
}

type PromptSnapshotStore = {
  schemaVersion: 1
  entries: Record<string, PromptSnapshotEntry>
}

const SNAPSHOT_DIR = 'chat_snapshots'

const EMPTY_STORE: PromptSnapshotStore = {
  schemaVersion: 1,
  entries: {},
}

type YoloSettingsLike = {
  yolo?: {
    baseDir?: string
  }
}

/**
 * 浏览器 web 运行时标记：createWebYoloRuntime 在 bootstrap 时注入
 * `app.__yoloWebChat`（useJsonManagers 用同一标记切换 web ChatManager）。
 * 桌面端与 web 服务端（运行在 Obsidian 宿主进程里，vault 写入直连 adapter）
 * 都没有该标记。
 *
 * 浏览器 web 会话里 vault 写入走 /api/vault/*，workspace 权限引擎按受保护
 * 路径前缀拒绝 YOLO 托管区（protectedPaths）——桌面数据目录迁移/快照仓库
 * 是桌面-only 路径，在浏览器里必然 403。快照 JSON 在 web 架构下只落服务端
 * （服务端 AgentService 持久化在宿主侧执行，adapter 直写）；浏览器侧跳过
 * 整个快照仓库，消息原样通过。
 */
const isBrowserWebRuntime = (app: App): boolean =>
  (app as { __yoloWebChat?: unknown }).__yoloWebChat !== undefined

const getSnapshotDirPath = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<string> => {
  const rootDir = await ensureUserDataRootDir(app, settings ?? null)
  return normalizePath(path.join(rootDir, CHAT_DIR, SNAPSHOT_DIR))
}

const getSnapshotFilePath = async (
  app: App,
  conversationId: string,
  settings?: YoloSettingsLike | null,
): Promise<string> => {
  const snapshotDir = await getSnapshotDirPath(app, settings)
  return normalizePath(path.join(snapshotDir, `${conversationId}.json`))
}

const shouldStorePromptSnapshot = (
  message: SerializedChatUserMessage,
): boolean =>
  (message.selectedSkills?.length ?? 0) > 0 ||
  message.mentionables.some(
    (mentionable) =>
      mentionable.type === 'file' ||
      mentionable.type === 'folder' ||
      mentionable.type === 'block' ||
      mentionable.type === 'url',
  )

const fnv1aHash = (text: string): string => {
  let hash = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

const buildSnapshotHash = (content: string | ContentPart[]): string =>
  fnv1aHash(JSON.stringify(content))

const ensureSnapshotDir = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  const snapshotDir = await getSnapshotDirPath(app, settings)
  if (!(await app.vault.adapter.exists(snapshotDir))) {
    await app.vault.adapter.mkdir(snapshotDir)
  }
}

const readSnapshotStore = async (
  app: App,
  conversationId: string,
  settings?: YoloSettingsLike | null,
): Promise<PromptSnapshotStore> => {
  const filePath = await getSnapshotFilePath(app, conversationId, settings)
  if (!(await app.vault.adapter.exists(filePath))) {
    return EMPTY_STORE
  }

  try {
    const content = await app.vault.adapter.read(filePath)
    const parsed = JSON.parse(content) as PromptSnapshotStore
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      return EMPTY_STORE
    }
    return {
      schemaVersion: 1,
      entries: parsed.entries,
    }
  } catch (error) {
    console.error('[YOLO] Failed to read prompt snapshots', error)
    return EMPTY_STORE
  }
}

const writeSnapshotStore = async (
  app: App,
  conversationId: string,
  store: PromptSnapshotStore,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  await ensureSnapshotDir(app, settings)
  const filePath = await getSnapshotFilePath(app, conversationId, settings)
  await app.vault.adapter.write(filePath, JSON.stringify(store, null, 2))
}

export const compactConversationMessagesForStorage = async ({
  app,
  conversationId,
  messages,
  previousMessages,
  settings,
}: {
  app: App
  conversationId: string
  messages: SerializedChatMessage[]
  previousMessages?: SerializedChatMessage[]
  settings?: YoloSettingsLike | null
}): Promise<SerializedChatMessage[]> => {
  if (isBrowserWebRuntime(app)) {
    // 浏览器 web：快照仓库是桌面本地 JSON 仓库概念（落 YOLO 托管区），服务端
    // AgentService 持久化在宿主侧做同款压缩。浏览器侧原样通过——既不触发
    // ensureUserDataRootDir 的桌面迁移路径（web 权限引擎 403），也不丢失
    // promptContent（服务端压缩会负责它）。
    return messages
  }
  const store = await readSnapshotStore(app, conversationId, settings)
  const nextEntries = { ...store.entries }
  const usedHashes = new Set<string>()
  let changed = false
  const previousSnapshotRefByMessageId = new Map<string, string>()

  previousMessages?.forEach((message) => {
    if (message.role !== 'user') {
      return
    }
    if (!message.snapshotRef?.hash) {
      return
    }
    previousSnapshotRefByMessageId.set(message.id, message.snapshotRef.hash)
  })

  const compactedMessages = messages.map((message): SerializedChatMessage => {
    if (message.role !== 'user') {
      return message
    }

    const userMessage = message
    if (userMessage.promptContent && shouldStorePromptSnapshot(userMessage)) {
      const hash = buildSnapshotHash(userMessage.promptContent)
      const now = Date.now()
      const existing = nextEntries[hash]
      if (!existing) {
        nextEntries[hash] = {
          hash,
          content: userMessage.promptContent,
          createdAt: now,
          updatedAt: now,
        }
        changed = true
      }
      usedHashes.add(hash)

      return {
        ...userMessage,
        promptContent: null,
        snapshotRef: { hash },
      }
    }

    if (userMessage.snapshotRef?.hash) {
      if (shouldStorePromptSnapshot(userMessage)) {
        usedHashes.add(userMessage.snapshotRef.hash)
        return {
          ...userMessage,
          promptContent: null,
        }
      }
      changed = true
      return {
        ...userMessage,
        promptContent: null,
        snapshotRef: undefined,
      }
    }

    if (shouldStorePromptSnapshot(userMessage)) {
      const previousHash = previousSnapshotRefByMessageId.get(userMessage.id)
      if (previousHash && nextEntries[previousHash]) {
        usedHashes.add(previousHash)
        return {
          ...userMessage,
          promptContent: null,
          snapshotRef: { hash: previousHash },
        }
      }
    }

    return {
      ...userMessage,
      promptContent: null,
      snapshotRef: shouldStorePromptSnapshot(userMessage)
        ? userMessage.snapshotRef
        : undefined,
    }
  })

  const filteredEntries = Object.fromEntries(
    Object.entries(nextEntries).filter(([hash]) => usedHashes.has(hash)),
  )
  if (Object.keys(filteredEntries).length !== Object.keys(nextEntries).length) {
    changed = true
  }

  if (changed) {
    await writeSnapshotStore(
      app,
      conversationId,
      {
        schemaVersion: 1,
        entries: filteredEntries,
      },
      settings,
    )
  }

  return compactedMessages
}

export const readPromptSnapshotContent = async ({
  app,
  conversationId,
  hash,
  settings,
}: {
  app: App
  conversationId: string
  hash: string
  settings?: YoloSettingsLike | null
}): Promise<string | ContentPart[] | null> => {
  if (isBrowserWebRuntime(app)) {
    return null
  }
  const store = await readSnapshotStore(app, conversationId, settings)
  return store.entries[hash]?.content ?? null
}

export const readPromptSnapshotEntries = async ({
  app,
  conversationId,
  settings,
}: {
  app: App
  conversationId: string
  settings?: YoloSettingsLike | null
}): Promise<Record<string, string | ContentPart[]>> => {
  if (isBrowserWebRuntime(app)) {
    // 空 entries → requestContextBuilder 对带 snapshotRef 的历史 user 消息
    // 走 compileUserMessagePrompt 重建（与快照缺失语义一致），而非 403。
    return {}
  }
  const store = await readSnapshotStore(app, conversationId, settings)
  const entries: Record<string, string | ContentPart[]> = {}
  Object.keys(store.entries).forEach((hash) => {
    entries[hash] = store.entries[hash].content
  })
  return entries
}

export const deletePromptSnapshotStore = async (
  app: App,
  conversationId: string,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  if (isBrowserWebRuntime(app)) {
    return
  }
  const filePath = await getSnapshotFilePath(app, conversationId, settings)
  if (await app.vault.adapter.exists(filePath)) {
    await app.vault.adapter.remove(filePath)
  }
}

export const clearAllPromptSnapshotStores = async (
  app: App,
  settings?: YoloSettingsLike | null,
): Promise<void> => {
  if (isBrowserWebRuntime(app)) {
    return
  }
  const snapshotDir = await getSnapshotDirPath(app, settings)
  if (!(await app.vault.adapter.exists(snapshotDir))) {
    return
  }

  const listing = await app.vault.adapter.list(snapshotDir)
  for (const filePath of listing.files) {
    await app.vault.adapter.remove(filePath)
  }
}
