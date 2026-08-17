import {
  getInjectedToolApprovalPolicy as getBridgeInjectedToolApprovalPolicy,
  getInjectedToolGroupName,
  isInjectedBridgeToolName,
} from './injectionBridge'
import type { InProcessToolApprovalPolicy } from './inProcessToolServer'
import { USER_FACING_LOCAL_TOOL_SHORT_NAMES } from './localFileToolNames'

/**
 * 智能体设置工具树中本地工具的可见性：内置工具按
 * `USER_FACING_LOCAL_TOOL_SHORT_NAMES` 白名单，注入工具由第三方插件主动
 * 注册，天然是用户可配置面。返回 false 的工具会被从工具树剔除。
 */
export function isLocalToolConfigurableInEditor(toolName: string): boolean {
  return (
    USER_FACING_LOCAL_TOOL_SHORT_NAMES.includes(toolName) ||
    isInjectedBridgeToolName(toolName)
  )
}

/** 注入工具的分组信息；未注册或未提供组名时返回 null（回落外部能力分组）。 */
export function getInjectedToolGroup(
  toolName: string,
): { name: string } | null {
  if (!isInjectedBridgeToolName(toolName)) {
    return null
  }
  const name = getInjectedToolGroupName(toolName)
  return name ? { name } : null
}

/** 注入分组在设置工具树中的唯一 key。 */
export function getInjectedToolGroupKey(name: string): string {
  return `__injected:${name}`
}

export function getInjectedToolApprovalPolicy(
  toolName: string,
): InProcessToolApprovalPolicy | undefined {
  if (!isInjectedBridgeToolName(toolName)) {
    return undefined
  }
  return getBridgeInjectedToolApprovalPolicy(toolName)
}
