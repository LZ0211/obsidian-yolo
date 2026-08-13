/** @jest-environment jsdom */

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

jest.mock('../../../contexts/app-context', () => ({
  useApp: () => ({}),
}))

jest.mock('../../modals/ConfirmModal', () => ({
  ConfirmModal: jest.fn().mockImplementation(function (
    this: { open: jest.Mock; options: unknown },
    _app: unknown,
    options: unknown,
  ) {
    this.open = jest.fn()
    this.options = options
  }),
}))

// Shared per-test mocks: the component captures `actions` once at render, so
// the fns must be stable module-scope objects (jest.mock factory allows
// `mock*`-prefixed references).
const mockApproveTool = jest.fn().mockResolvedValue({ kind: 'handled' })
const mockRejectTool = jest.fn().mockResolvedValue({ kind: 'handled' })

jest.mock('../chat-runtime-actions-context', () => ({
  useChatRuntimeActions: () => ({
    actions: {
      approveTool: mockApproveTool,
      rejectTool: mockRejectTool,
    },
    conversation: { conversationId: 'conv' },
  }),
}))

import { act } from 'react'
import { createRoot } from 'react-dom/client'

import type { ToolCallRequest } from '../../../types/tool-call.types'
import { ConfirmModal } from '../../modals/ConfirmModal'
import type { SubagentPendingApproval } from './SubagentApprovalBlock'
import { SubagentApprovalBlock } from './SubagentApprovalBlock'

const reactGlobal = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}
const originalActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT

const makeApproval = (
  toolCallId: string,
  toolName = 'fs_edit',
): SubagentPendingApproval => ({
  toolCallId,
  request: {
    id: toolCallId,
    name: toolName,
    arguments: { kind: 'complete', value: { path: `/vault/${toolCallId}.md` } },
  } as ToolCallRequest,
})

describe('SubagentApprovalBlock (F13)', () => {
  let container: HTMLDivElement

  beforeAll(() => {
    reactGlobal.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterAll(() => {
    if (originalActEnvironment === undefined) {
      delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
    } else {
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = originalActEnvironment
    }
  })

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    ;(ConfirmModal as unknown as jest.Mock).mockClear()
    mockApproveTool.mockReset().mockResolvedValue({ kind: 'handled' })
    mockRejectTool.mockReset().mockResolvedValue({ kind: 'handled' })
  })

  afterEach(() => {
    container.remove()
  })

  const renderBlock = (pendingApprovals: SubagentPendingApproval[]) => {
    const root = createRoot(container)
    act(() => {
      root.render(
        <SubagentApprovalBlock
          conversationId="conv"
          pendingApprovals={pendingApprovals}
        />,
      )
    })
    return root
  }

  const unmountRoot = async (root: {
    unmount(): void
  }): Promise<void> => {
    await act(async () => {
      root.unmount()
    })
  }

  const findButton = (label: string): HTMLButtonElement => {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent?.trim() === label,
    )
    expect(button).toBeDefined()
    return button as HTMLButtonElement
  }

  it('disables the approve/reject buttons while the decision is in flight and re-enables them after', async () => {
    let resolveApproval: (value: { kind: string }) => void = () => {}
    mockApproveTool.mockReturnValue(
      new Promise((resolve) => {
        resolveApproval = resolve
      }),
    )

    const root = renderBlock([makeApproval('call-1')])
    const approveButton = findButton('Approve')

    expect(approveButton.disabled).toBe(false)
    await act(async () => {
      approveButton.click()
    })
    // In flight: the click was received and duplicate clicks are blocked.
    expect(approveButton.disabled).toBe(true)
    expect(approveButton.getAttribute('aria-busy')).toBe('true')

    await act(async () => {
      resolveApproval({ kind: 'handled' })
      await Promise.resolve()
    })
    expect(approveButton.disabled).toBe(false)
    expect(mockApproveTool).toHaveBeenCalledTimes(1)
    await unmountRoot(root)
  })

  it('opens a ConfirmModal before dispatching approve-all (irreversible bulk decision)', async () => {
    const root = renderBlock([makeApproval('call-1'), makeApproval('call-2')])

    findButton('Approve all').click()

    expect(ConfirmModal).toHaveBeenCalledTimes(1)
    const options = (ConfirmModal as unknown as jest.Mock).mock.calls[0][1] as {
      title: string
      message: string
      ctaText: string
      onConfirm: () => void
    }
    expect(options.title).toBe('Approve all pending tool calls?')
    expect(options.message).toContain('cannot be undone')
    // Confirming dispatches the per-call approvals (async — flush inside act).
    await act(async () => {
      options.onConfirm()
    })
    expect(mockApproveTool).toHaveBeenCalledTimes(2)
    await unmountRoot(root)
  })

  it('opens a ConfirmModal before dispatching reject-all', async () => {
    const root = renderBlock([makeApproval('call-1'), makeApproval('call-2')])

    findButton('Reject all').click()

    expect(ConfirmModal).toHaveBeenCalledTimes(1)
    const options = (ConfirmModal as unknown as jest.Mock).mock.calls[0][1] as {
      title: string
      message: string
      onConfirm: () => void
    }
    expect(options.title).toBe('Reject all pending tool calls?')
    await act(async () => {
      options.onConfirm()
    })
    expect(mockRejectTool).toHaveBeenCalledTimes(2)
    await unmountRoot(root)
  })
})
