/** @jest-environment jsdom */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { Root } from 'react-dom/client'

import type { MaintenanceSnapshot } from '../../../core/maintenance/types'

import { useDatabaseMaintenanceProjection } from './useDatabaseMaintenanceProjection'

const snapshot = (pageCursor: string | null): MaintenanceSnapshot => ({
  status: 'idle',
  summary: null,
  activeJob: null,
  page: { cursor: pageCursor, rows: [], nextCursor: null },
  query: null,
  error: null,
})

describe('useDatabaseMaintenanceProjection', () => {
  let root: Root
  let container: HTMLDivElement

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

  it('subscribes to the controller and renders the latest immutable snapshot', () => {
    let current = snapshot('first')
    const listeners = new Set<() => void>()
    const controller = {
      getSnapshot: jest.fn(() => current),
      subscribe: jest.fn((listener: () => void) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }),
    }

    function Reader() {
      const projection = useDatabaseMaintenanceProjection(controller as never)
      return <span>{projection.page?.cursor}</span>
    }

    act(() => root.render(<Reader />))
    expect(container.textContent).toBe('first')

    current = snapshot('second')
    act(() => {
      for (const listener of listeners) listener()
    })
    expect(container.textContent).toBe('second')
    expect(controller.subscribe).toHaveBeenCalled()
  })
})
