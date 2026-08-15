import type { ChatConversationMetadata } from '../database/json/chat/types'
import { getConversationDisplayTitle } from '../hooks/useChatHistory'
import {
  createDiv,
  createEl,
  createSpan,
} from '../runtime/web/obsidianDomCompat'

import type { HistoryClient } from './webShellTypes'

type SvgIconSpec = {
  viewBox?: string
  width?: number
  height?: number
  paths: {
    tag: 'path' | 'rect' | 'circle' | 'line' | 'polyline' | 'polygon'
    attrs: Record<string, string>
    fill?: string
  }[]
}

function appendLucideIcon(parentEl: HTMLElement, spec: SvgIconSpec): void {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', spec.viewBox ?? '0 0 24 24')
  svg.setAttribute('width', String(spec.width ?? 16))
  svg.setAttribute('height', String(spec.height ?? 16))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.classList.add('svg-icon')
  for (const p of spec.paths) {
    const el = document.createElementNS('http://www.w3.org/2000/svg', p.tag)
    for (const [k, v] of Object.entries(p.attrs)) el.setAttribute(k, v)
    if (p.fill) el.setAttribute('fill', p.fill)
    svg.append(el)
  }
  parentEl.append(svg)
}

const ICONS: Record<string, SvgIconSpec> = {
  bot: {
    width: 14,
    height: 14,
    paths: [
      { tag: 'path', attrs: { d: 'M12 8V4H8' } },
      {
        tag: 'rect',
        attrs: { x: '4', y: '8', width: '16', height: '12', rx: '2' },
      },
      { tag: 'path', attrs: { d: 'M2 14h2' } },
      { tag: 'path', attrs: { d: 'M20 14h2' } },
      { tag: 'path', attrs: { d: 'M15 13v2' } },
      { tag: 'path', attrs: { d: 'M9 13v2' } },
    ],
  },
  trash: {
    paths: [
      { tag: 'path', attrs: { d: 'M3 6h18' } },
      { tag: 'path', attrs: { d: 'M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6' } },
      { tag: 'path', attrs: { d: 'M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2' } },
      { tag: 'line', attrs: { x1: '10', y1: '11', x2: '10', y2: '17' } },
      { tag: 'line', attrs: { x1: '14', y1: '11', x2: '14', y2: '17' } },
    ],
  },
  star: {
    paths: [
      {
        tag: 'polygon',
        attrs: {
          points:
            '12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2',
        },
      },
    ],
  },
  pencil: {
    paths: [
      { tag: 'path', attrs: { d: 'M12 20h9' } },
      {
        tag: 'path',
        attrs: {
          d: 'M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z',
        },
      },
    ],
  },
  retry: {
    paths: [
      { tag: 'path', attrs: { d: 'M3 12a9 9 0 1 0 3-6.7L3 8' } },
      { tag: 'path', attrs: { d: 'M3 3v5h5' } },
    ],
  },
  check: {
    paths: [{ tag: 'polyline', attrs: { points: '20 6 9 17 4 12' } }],
  },
  ellipsis: {
    paths: [
      {
        tag: 'circle',
        attrs: { cx: '12', cy: '12', r: '1' },
        fill: 'currentColor',
      },
      {
        tag: 'circle',
        attrs: { cx: '19', cy: '12', r: '1' },
        fill: 'currentColor',
      },
      {
        tag: 'circle',
        attrs: { cx: '5', cy: '12', r: '1' },
        fill: 'currentColor',
      },
    ],
  },
}

type HistoryGroup = {
  key: string
  label: string
  order: number
  items: ChatConversationMetadata[]
}

function formatChatTimestamp(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const sameYear = d.getFullYear() === now.getFullYear()
  const month = d.getMonth() + 1
  const day = d.getDate()
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const datePart = sameYear
    ? `${month}/${day}`
    : `${d.getFullYear()}/${month}/${day}`
  return `${datePart} ${hh}:${mm}`
}

function monthLabel(
  year: number,
  month: number,
  now: Date,
): { label: string; order: number } {
  const offset = (year - now.getFullYear()) * 12 + (month - now.getMonth())
  return { label: `${year}年${month + 1}月`, order: offset }
}

function groupChatsByTime(items: ChatConversationMetadata[]): HistoryGroup[] {
  const now = new Date()
  const todayStart = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime()
  const sevenDaysAgo = todayStart - 7 * 24 * 60 * 60 * 1000
  const thirtyDaysAgo = todayStart - 30 * 24 * 60 * 60 * 1000

  const within7: ChatConversationMetadata[] = []
  const within30: ChatConversationMetadata[] = []
  const monthBuckets = new Map<string, HistoryGroup>()

  for (const item of items) {
    const t = new Date(item.updatedAt).getTime()
    if (t >= sevenDaysAgo) {
      within7.push(item)
      continue
    }
    if (t >= thirtyDaysAgo) {
      within30.push(item)
      continue
    }
    const d = new Date(t)
    const { label, order } = monthLabel(d.getFullYear(), d.getMonth(), now)
    const key = `${d.getFullYear()}-${d.getMonth()}`
    const bucket = monthBuckets.get(key)
    if (bucket) {
      bucket.items.push(item)
    } else {
      monthBuckets.set(key, { key, label, order, items: [item] })
    }
  }

  const sortDesc = (a: ChatConversationMetadata, b: ChatConversationMetadata) =>
    b.updatedAt - a.updatedAt

  const groups: HistoryGroup[] = []
  if (within7.length > 0) {
    groups.push({
      key: 'within-7',
      label: '7天内',
      order: 1,
      items: within7.sort(sortDesc),
    })
  }
  if (within30.length > 0) {
    groups.push({
      key: 'within-30',
      label: '30天内',
      order: 0.5,
      items: within30.sort(sortDesc),
    })
  }
  for (const bucket of monthBuckets.values()) {
    bucket.items.sort(sortDesc)
    groups.push(bucket)
  }
  groups.sort((a, b) => b.order - a.order)
  return groups
}

function createIconButton(
  cls: string,
  ariaLabel: string,
  icon: SvgIconSpec,
  onClick: (event: MouseEvent) => void,
): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className = `clickable-icon ${cls}`
  btn.setAttribute('aria-label', ariaLabel)
  appendLucideIcon(btn, icon)
  btn.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick(event)
  })
  return btn
}

type HistoryRowState = {
  chat: ChatConversationMetadata
  editing: boolean
  editingTitle: string
  retrying: boolean
}

export async function renderHistoryPane(
  parentEl: HTMLElement,
  historyClient: HistoryClient,
  openConversation: (conversationId: string) => Promise<void>,
  onNewConversation: () => void,
  isCurrentRequest: () => boolean,
  deleteConversation: (conversationId: string) => Promise<void>,
): Promise<void> {
  const paneEl = createDiv(parentEl, 'yolo-web-history-pane')

  const navHeaderEl = createDiv(paneEl, 'yolo-web-history-nav-header')
  const newChatBtn = createEl(navHeaderEl, 'button', {
    cls: 'yolo-web-history-new-chat-button clickable-icon',
  }) as HTMLButtonElement
  appendLucideIcon(newChatBtn, ICONS.bot)
  createSpan(newChatBtn, 'yolo-web-history-new-chat-label', (label) =>
    label.setText('开启新对话'),
  )
  newChatBtn.addEventListener('click', () => onNewConversation())

  const searchBoxEl = createDiv(paneEl, 'search-input-container')
  const inputEl = createEl(searchBoxEl, 'input', {
    attr: { type: 'search', placeholder: '搜索对话', 'aria-label': '搜索对话' },
  }) as HTMLInputElement
  const searchClearBtn = createDiv(searchBoxEl, 'search-input-clear-button')
  searchClearBtn.setAttr('aria-label', '清空搜索')

  const listEl = createEl(paneEl, 'ul', {
    cls: 'yolo-model-select-list yolo-web-history-list',
  })
  createDiv(paneEl, 'yolo-web-demo-pane-footer')

  let allChats: ChatConversationMetadata[] = []
  let currentQuery = ''
  let moreMenuOpenId: string | null = null
  const rowStates = new Map<string, HistoryRowState>()

  const renderList = () => {
    listEl.empty()
    const q = currentQuery.trim().toLowerCase()
    const filtered = q
      ? allChats.filter((c) =>
          getConversationDisplayTitle(c.title, 'New chat')
            .toLowerCase()
            .includes(q),
        )
      : allChats
    const sorted = [...filtered].sort((a, b) => {
      const ap = a.isPinned ? 1 : 0
      const bp = b.isPinned ? 1 : 0
      if (ap !== bp) return bp - ap
      return b.updatedAt - a.updatedAt
    })

    if (sorted.length === 0) {
      createEl(listEl, 'li', { cls: 'yolo-chat-list-dropdown-empty' }, (li) =>
        li.setText(q ? '未找到匹配的对话' : '暂无对话历史'),
      )
      return
    }

    if (q) {
      for (const chat of sorted) renderHistoryRow(listEl, chat)
      return
    }

    for (const group of groupChatsByTime(sorted)) {
      renderHistoryDivider(listEl, group.label)
      for (const chat of group.items) renderHistoryRow(listEl, chat)
    }
  }

  const refresh = async () => {
    allChats = await historyClient.listChats()
    if (!isCurrentRequest()) return
    for (const id of [...rowStates.keys()]) {
      if (!allChats.some((c) => c.id === id)) rowStates.delete(id)
    }
    renderList()
  }

  const renderHistoryDivider = (parent: HTMLElement, label: string) => {
    createEl(parent, 'li', { cls: 'yolo-chat-list-dropdown-divider' }, (li) =>
      li.setText(label),
    )
  }

  const renderHistoryRow = (
    parent: HTMLElement,
    chat: ChatConversationMetadata,
  ) => {
    let state = rowStates.get(chat.id)
    if (!state) {
      state = {
        chat,
        editing: false,
        editingTitle: chat.title,
        retrying: false,
      }
      rowStates.set(chat.id, state)
    } else {
      state.chat = chat
    }
    const s = state

    const li = createEl(parent, 'li', { cls: 'yolo-chat-list-dropdown-item' })
    li.addEventListener('click', () => {
      if (s.editing) return
      void openConversation(chat.id).catch((error) => {
        console.error('Failed to open conversation', error)
      })
    })

    if (s.editing) {
      const input = createEl(li, 'input', {
        cls: 'yolo-chat-list-dropdown-item-title-input',
        attr: { type: 'text', value: s.editingTitle, maxlength: '100' },
      }) as HTMLInputElement
      input.addEventListener('mousedown', (e) => e.stopPropagation())
      input.addEventListener('click', (e) => e.stopPropagation())
      requestAnimationFrame(() => {
        input.focus()
        input.select()
      })
      const commit = async () => {
        const value = input.value.trim()
        if (value.length === 0) return
        try {
          await historyClient.updateChatTitle(chat.id, value)
          s.editing = false
          await refresh()
        } catch (err) {
          console.error('Failed to update conversation title', err)
          s.editing = false
          s.editingTitle = chat.title
          renderList()
        }
      }
      input.addEventListener('keydown', (e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          void commit()
        } else if (e.key === 'Escape') {
          s.editing = false
          s.editingTitle = chat.title
          renderList()
        }
      })
      const actionsEl = createDiv(li, 'yolo-chat-list-dropdown-item-actions')
      const saveBtn = createIconButton(
        'yolo-chat-list-dropdown-item-icon',
        'Save',
        ICONS.check,
        () => {
          void commit()
        },
      )
      actionsEl.append(saveBtn)
      return
    }

    const titleEl = createDiv(li, 'yolo-chat-list-dropdown-item-title')
    const titleGroupEl = createDiv(
      titleEl,
      'yolo-chat-list-dropdown-item-title-group',
    )
    const titleTextEl = createSpan(
      titleGroupEl,
      'yolo-chat-list-dropdown-item-title-text',
    )
    if (s.retrying) {
      titleTextEl.addClass('is-retrying')
      titleTextEl.setText(chat.title)
    } else {
      titleTextEl.setText(getConversationDisplayTitle(chat.title, '新会话'))
    }
    createSpan(titleGroupEl, 'yolo-chat-list-dropdown-item-meta', (meta) =>
      meta.setText(formatChatTimestamp(chat.updatedAt)),
    )

    const isMoreOpen = moreMenuOpenId === chat.id
    const actionsEl = createDiv(
      li,
      `yolo-chat-list-dropdown-item-actions${isMoreOpen ? ' is-more-open' : ''}`,
    )

    const deleteBtn = createIconButton(
      'yolo-chat-list-dropdown-item-icon',
      'Delete',
      ICONS.trash,
      () => {
        if (moreMenuOpenId === chat.id) moreMenuOpenId = null
        void deleteConversation(chat.id)
          .then(refresh)
          .catch((err) => console.error('Failed to delete conversation', err))
      },
    )
    actionsEl.append(deleteBtn)

    const pinBtn = createIconButton(
      `yolo-chat-list-pin-button${chat.isPinned ? ' is-pinned' : ''}`,
      chat.isPinned ? 'Unpin' : 'Pin',
      ICONS.star,
      () => {
        if (moreMenuOpenId === chat.id) moreMenuOpenId = null
        void historyClient
          .togglePinnedChat(chat.id)
          .then(refresh)
          .catch((err) => console.error('Failed to toggle pin', err))
      },
    )
    actionsEl.append(pinBtn)

    const inlineActionsEl = createDiv(
      actionsEl,
      `yolo-chat-list-inline-actions${isMoreOpen ? ' is-open' : ''}`,
    )
    const inlineInnerEl = createDiv(
      inlineActionsEl,
      'yolo-chat-list-inline-actions-inner',
    )

    inlineInnerEl.append(
      createIconButton(
        'yolo-chat-list-dropdown-item-icon',
        'Edit',
        ICONS.pencil,
        () => {
          moreMenuOpenId = null
          s.editing = true
          s.editingTitle = chat.title
          renderList()
        },
      ),
    )
    inlineInnerEl.append(
      createIconButton(
        `yolo-chat-list-dropdown-item-icon${s.retrying ? ' is-pending' : ''}`,
        'Retry title',
        ICONS.retry,
        () => {
          if (s.retrying) return
          moreMenuOpenId = null
          s.retrying = true
          renderList()
          void historyClient
            .retryChatTitle(chat.id)
            .then(refresh)
            .catch((err) => console.error('Failed to retry title', err))
        },
      ),
    )

    const moreBtn = createIconButton(
      `yolo-chat-list-more-button${isMoreOpen ? ' is-open' : ''}`,
      'More actions',
      ICONS.ellipsis,
      () => {
        moreMenuOpenId = isMoreOpen ? null : chat.id
        renderList()
      },
    )
    actionsEl.append(moreBtn)
  }

  inputEl.addEventListener('input', () => {
    currentQuery = inputEl.value
    renderList()
  })
  searchClearBtn.addEventListener('click', () => {
    inputEl.value = ''
    currentQuery = ''
    renderList()
    inputEl.focus()
  })

  createEl(listEl, 'li', { cls: 'yolo-chat-list-dropdown-empty' }, (li) =>
    li.setText('正在加载对话…'),
  )

  try {
    allChats = await historyClient.listChats()
    if (!isCurrentRequest()) return
    renderList()
  } catch (err) {
    if (!isCurrentRequest()) return
    listEl.empty()
    createEl(listEl, 'li', { cls: 'yolo-chat-list-dropdown-empty' }, (li) =>
      li.setText(err instanceof Error ? err.message : '加载对话失败'),
    )
  }
}
