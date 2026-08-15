import type { AllowedAgent } from './webShellTypes'

/**
 * 当前智能体名称展示控件：以禁用 select 呈现（显示当前值、无法展开下拉）。
 * web 会话的 agent 由登录 token 绑定，切换入口不提供（与 OB 桌面一致）。
 */
export function createWebAgentSelector(options: {
  agents: AllowedAgent[]
  activeAgentId: string
}): HTMLSelectElement {
  const selector = document.createElement('select')
  selector.className = 'yolo-web-agent-selector'
  selector.setAttribute('aria-label', '当前智能体')
  selector.disabled = true

  for (const agent of options.agents) {
    if (agent.unavailable) continue
    const option = document.createElement('option')
    option.value = agent.id
    option.textContent = agent.name ?? agent.id
    selector.append(option)
  }

  selector.value = options.activeAgentId
  return selector
}
