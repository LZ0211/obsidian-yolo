/** @jest-environment jsdom */

import { createWebAgentSelector } from './webAgentSelector'

describe('createWebAgentSelector', () => {
  it('allows switching when a switch handler is provided', () => {
    const onChange = jest.fn()
    const selector = createWebAgentSelector({
      agents: [
        { id: 'agent-1', name: 'Agent One' },
        { id: 'agent-2', name: 'Agent Two' },
      ],
      activeAgentId: 'agent-1',
      onChange,
    })

    expect(selector.disabled).toBe(false)
    selector.value = 'agent-2'
    selector.dispatchEvent(new Event('change'))

    expect(onChange).toHaveBeenCalledWith('agent-2')
  })
})
