import type { AllowedAgent } from './webShellTypes'

export function createWebAgentSelector(options: {
  agents: AllowedAgent[]
  activeAgentId: string
  onChange: (
    agentId: string,
    selector: HTMLSelectElement,
  ) => Promise<void> | void
}): HTMLSelectElement {
  const selector = document.createElement('select')
  selector.className = 'yolo-web-agent-selector'
  selector.setAttribute('aria-label', '选择智能体')

  for (const agent of options.agents) {
    if (agent.unavailable) continue
    const option = document.createElement('option')
    option.value = agent.id
    option.textContent = agent.name ?? agent.id
    selector.append(option)
  }

  selector.value = options.activeAgentId
  selector.addEventListener('change', () => {
    void options.onChange(selector.value, selector)
  })

  return selector
}
