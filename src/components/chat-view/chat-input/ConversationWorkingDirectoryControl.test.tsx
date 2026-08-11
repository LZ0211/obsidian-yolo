/** @jest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}))

import { ConversationWorkingDirectoryControl } from './ConversationWorkingDirectoryControl'

describe('ConversationWorkingDirectoryControl', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })

  it('shows the selected directory and lets an empty conversation clear it', () => {
    const onChange = jest.fn()
    const onOpenPicker = jest.fn()

    act(() => {
      root.render(
        <ConversationWorkingDirectoryControl
          value="/Projects/Exam"
          displayValue="/Projects/Exam"
          locked={false}
          onChange={onChange}
          onOpenPicker={onOpenPicker}
        />,
      )
    })

    expect(container.textContent).toContain('/Projects/Exam')
    const clearButton = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Clear working directory"]',
    )
    expect(clearButton).not.toBeNull()
    act(() => clearButton?.click())
    expect(onChange).toHaveBeenCalledWith(undefined)
  })

  it('shows only the locked path (no picker button) after the conversation starts', () => {
    const onChange = jest.fn()
    const onOpenPicker = jest.fn()

    act(() => {
      root.render(
        <ConversationWorkingDirectoryControl
          displayValue="/Projects"
          locked
          onChange={onChange}
          onOpenPicker={onOpenPicker}
        />,
      )
    })

    expect(
      container.querySelector('button.yolo-chat-working-directory-button'),
    ).toBeNull()
    expect(container.textContent).toContain('/Projects')
    expect(
      container.querySelector('button[aria-label="Clear working directory"]'),
    ).toBeNull()
  })
})
