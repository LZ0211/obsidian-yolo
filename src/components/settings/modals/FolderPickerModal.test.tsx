/** @jest-environment jsdom */

import type { App, Vault } from 'obsidian'
import { act } from 'react'
import type { ComponentType } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

jest.mock('react', () => {
  const actual = jest.requireActual<typeof import('react')>('react')
  return { ...actual, __esModule: true, default: actual }
})

jest.mock('../../common/ReactModal', () => ({
  ReactModal: class {
    Component: unknown
    props: unknown

    constructor({ Component, props }: { Component: unknown; props: unknown }) {
      this.Component = Component
      this.props = props
    }
  },
}))

jest.mock('../../../utils/rag-utils', () => ({
  listAllFolderPaths: () => [
    '',
    'Projects',
    'Projects/Exam',
    'Projects/Exam/Notes',
  ],
}))

import { FolderPickerModal } from './FolderPickerModal'

type CapturedFolderPickerProps = {
  vault: Vault
  existing: string[]
  allowFiles?: boolean
  onPick: (folderPath: string) => void
  rootPath?: string
  isSelectable?: (folderPath: string) => boolean
}

type CapturedFolderPickerModal = {
  Component: ComponentType<CapturedFolderPickerProps & { onClose: () => void }>
  props: CapturedFolderPickerProps
}

describe('FolderPickerModal root path', () => {
  let container: HTMLDivElement
  let root: Root

  beforeAll(() => {
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    })
  })

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })

  function renderPicker({
    onPick,
    rootPath,
    isSelectable,
  }: {
    onPick: (folderPath: string) => void
    rootPath: string
    isSelectable?: (folderPath: string) => boolean
  }) {
    const modal = new FolderPickerModal(
      {} as App,
      {} as Vault,
      [],
      false,
      onPick,
      rootPath,
      isSelectable,
    ) as unknown as CapturedFolderPickerModal
    const Component = modal.Component

    act(() => {
      root.render(<Component {...modal.props} onClose={() => undefined} />)
    })
  }

  function findFolderRow(name: string, depth?: string) {
    return Array.from(
      container.querySelectorAll<HTMLElement>('.yolo-folder-row'),
    ).find(
      (row) =>
        (depth === undefined || row.dataset.depth === depth) &&
        row.querySelector('.yolo-folder-name')?.textContent === name,
    )
  }

  it('shows and selects the normalized root when the predicate allows it', () => {
    const onPick = jest.fn()
    const isSelectable = jest.fn((path: string) => path === 'Projects/Exam')

    renderPicker({
      onPick,
      rootPath: '\\Projects\\Exam\\',
      isSelectable,
    })

    const rootRow = findFolderRow('Exam', '0')
    expect(rootRow).toBeDefined()
    expect(rootRow?.classList.contains('is-disabled')).toBe(false)
    expect(isSelectable).toHaveBeenCalledWith('Projects/Exam')

    act(() => rootRow?.click())
    expect(onPick).toHaveBeenCalledWith('Projects/Exam')
  })

  it('keeps scoped child folders visible and selectable without a predicate', () => {
    const onPick = jest.fn()

    renderPicker({ onPick, rootPath: '/Projects/Exam/' })

    const childRow = findFolderRow('Notes')
    expect(childRow).toBeDefined()

    act(() => childRow?.click())
    expect(onPick).toHaveBeenCalledWith('Projects/Exam/Notes')
  })
})
