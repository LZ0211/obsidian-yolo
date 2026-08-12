/** @jest-environment jsdom */

jest.mock('../../contexts/language-context', () => ({
  useLanguage: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}))

import { act } from 'react'
import { createRoot } from 'react-dom/client'

import { SelectionIndicator } from './SelectionIndicator'
import type { SelectionInfo } from './SelectionManager'

describe('SelectionIndicator', () => {
  const reactGlobal = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean
  }
  const originalActEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT

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

  it('exposes keyboard semantics when it has an action', () => {
    const container = document.createElement('div')
    container.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 800, height: 600 }) as DOMRect
    const selection = {
      text: 'selected text',
      range: {} as Range,
      rect: {
        left: 20,
        right: 100,
        top: 20,
        bottom: 40,
      } as DOMRect,
      isMultiLine: false,
    } satisfies SelectionInfo

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    act(() => {
      root.render(
        <SelectionIndicator
          selection={selection}
          containerEl={container}
          onHoverChange={() => undefined}
          onPress={() => undefined}
        />,
      )
    })
    const html = host.innerHTML
    act(() => root.unmount())
    host.remove()

    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
  })
})
