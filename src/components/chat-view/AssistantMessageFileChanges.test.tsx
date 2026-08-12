/**
 * @jest-environment jsdom
 */

import { TFile } from 'obsidian'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import type { AgentFileChange } from '../../types/chat'

import AssistantMessageFileChanges from './AssistantMessageFileChanges'

const mockGetAbstractFileByPath = jest.fn()
const mockOpenFile = jest.fn()

jest.mock('../../contexts/app-context', () => ({
  useApp: () => ({
    vault: {
      getAbstractFileByPath: mockGetAbstractFileByPath,
    },
    workspace: {
      getLeaf: () => ({ openFile: mockOpenFile }),
    },
  }),
}))

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (_key: string, fallback?: string) => fallback ?? '',
  }),
}))

type TestTree = {
  container: HTMLDivElement
  render: (children: ReactNode) => void
  unmount: () => void
}

const mountedTrees = new Set<TestTree>()
let originalActEnvironmentDescriptor: PropertyDescriptor | undefined

function createTestTree(): TestTree {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root: Root = createRoot(container)
  const tree: TestTree = {
    container,
    render: (children) => act(() => root.render(children)),
    unmount: () => {
      act(() => root.unmount())
      container.remove()
      mountedTrees.delete(tree)
    },
  }
  mountedTrees.add(tree)
  return tree
}

function renderExpanded(fileChanges: AgentFileChange[]): HTMLDivElement {
  const tree = createTestTree()
  tree.render(<AssistantMessageFileChanges fileChanges={fileChanges} />)

  const toggle = tree.container.querySelector(
    '.yolo-assistant-message-metadata-toggle',
  )
  if (!(toggle instanceof HTMLButtonElement)) {
    throw new Error('Missing workspace changes toggle')
  }

  act(() => toggle.click())
  return tree.container
}

describe('AssistantMessageFileChanges', () => {
  beforeAll(() => {
    originalActEnvironmentDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'IS_REACT_ACT_ENVIRONMENT',
    )
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
      configurable: true,
      value: true,
    })
  })

  afterEach(() => {
    for (const tree of [...mountedTrees]) tree.unmount()
    mockGetAbstractFileByPath.mockReset()
    mockOpenFile.mockReset()
  })

  afterAll(() => {
    if (originalActEnvironmentDescriptor) {
      Object.defineProperty(
        globalThis,
        'IS_REACT_ACT_ENVIRONMENT',
        originalActEnvironmentDescriptor,
      )
      return
    }
    Reflect.deleteProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT')
  })

  it('renders Git additions and deletions for a text file', () => {
    const container = renderExpanded([
      {
        kind: 'modified',
        path: 'Notes/updated.md',
        gitDiff: { additions: 12, deletions: 3 },
      },
    ])

    expect(container.textContent).toContain('Modified')
    expect(container.textContent).toContain('Notes/updated.md')
    expect(container.textContent).toContain('+12')
    expect(container.textContent).toContain('−3')
  })

  it('renders a localized marker instead of zero deltas for a binary file', () => {
    const container = renderExpanded([
      {
        kind: 'created',
        path: 'Assets/image.png',
        gitDiff: { additions: 0, deletions: 0, binary: true },
      },
    ])

    expect(container.textContent).toContain('Binary')
    expect(container.textContent).not.toContain('+0')
    expect(container.textContent).not.toContain('−0')
  })

  it('keeps fallback-only entries free of fabricated zero deltas', () => {
    const container = renderExpanded([
      {
        kind: 'created',
        path: 'Notes/fallback.md',
      },
    ])

    expect(container.textContent).toContain('Created')
    expect(container.textContent).toContain('Notes/fallback.md')
    expect(container.textContent).not.toContain('+0')
    expect(container.textContent).not.toContain('−0')
  })

  it('opens the new rename path while deleted entries remain non-clickable', async () => {
    const renamedFile = new TFile()
    mockGetAbstractFileByPath.mockReturnValue(renamedFile)
    const container = renderExpanded([
      {
        kind: 'renamed',
        oldPath: 'Notes/old.md',
        path: 'Notes/new.md',
      },
      {
        kind: 'deleted',
        path: 'Notes/deleted.md',
      },
    ])

    const renamedLink = Array.from(container.querySelectorAll('a')).find(
      (link) => link.textContent === 'Notes/old.md → Notes/new.md',
    )
    if (!(renamedLink instanceof HTMLAnchorElement)) {
      throw new Error('Missing renamed file link')
    }
    expect(
      Array.from(container.querySelectorAll('a')).some(
        (link) => link.textContent === 'Notes/deleted.md',
      ),
    ).toBe(false)

    await act(async () => {
      renamedLink.click()
      await Promise.resolve()
    })

    expect(mockGetAbstractFileByPath).toHaveBeenCalledWith('Notes/new.md')
    expect(mockOpenFile).toHaveBeenCalledWith(renamedFile)
  })
})
