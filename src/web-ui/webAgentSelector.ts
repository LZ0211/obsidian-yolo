import type { AllowedAgent } from './webShellTypes'

/** 当前智能体选择控件。 */
export function createWebAgentSelector(options: {
  agents: AllowedAgent[]
  activeAgentId: string
  onChange?: (agentId: string) => Promise<void> | void
}): HTMLSelectElement {
  const selector = document.createElement('select')
  selector.className = 'yolo-web-agent-selector'
  selector.setAttribute('aria-label', '当前智能体')

  const availableAgents = options.agents.filter((agent) => !agent.unavailable)
  for (const agent of availableAgents) {
    const option = document.createElement('option')
    option.value = agent.id
    option.textContent = agent.name ?? agent.id
    selector.append(option)
  }

  selector.value = options.activeAgentId
  selector.disabled = !options.onChange || availableAgents.length < 2

  if (options.onChange && availableAgents.length >= 2) {
    let lastValue = selector.value
    selector.addEventListener('change', () => {
      const nextValue = selector.value
      selector.disabled = true
      void (async () => {
        try {
          await options.onChange?.(nextValue)
          lastValue = nextValue
        } catch {
          selector.value = lastValue
        } finally {
          if (selector.isConnected) selector.disabled = false
        }
      })()
    })
  }

  return selector
}
