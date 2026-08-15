/** @jest-environment jsdom */

import type { AllowedAgent } from './webShellTypes'
import { createWebAgentSelector } from './webAgentSelector'

describe('createWebAgentSelector', () => {
  it('renders allowed agents and forwards a changed selection', () => {
    const agents: AllowedAgent[] = [
      { id: 'agent-1', name: 'Writing' },
      { id: 'agent-2', name: 'Review' },
    ]
    const onChange = jest.fn()

    const selector = createWebAgentSelector({
      agents,
      activeAgentId: 'agent-1',
      onChange,
    })

    expect(
      Array.from(selector.options).map((option) => [option.value, option.text]),
    ).toEqual([
      ['agent-1', 'Writing'],
      ['agent-2', 'Review'],
    ])
    expect(selector.value).toBe('agent-1')

    selector.value = 'agent-2'
    selector.dispatchEvent(new Event('change'))

    expect(onChange).toHaveBeenCalledWith('agent-2', selector)
  })
})
