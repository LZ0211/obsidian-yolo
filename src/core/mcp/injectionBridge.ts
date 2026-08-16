import { McpTool } from '../../types/mcp.types'
import {
  ToolCallResponseStatus,
  type ToolCallResponse,
} from '../../types/tool-call.types'

import type {
  InProcessToolApprovalPolicy,
  InProcessToolServer,
} from './inProcessToolServer'

/**
 * YOLO 原生注入桥。
 *
 * 背景:此前其他插件通过网络中转注入工具。现在 YOLO 自己成为注入目标:
 * 其他插件在 onload 里探测 window.__yoloBridge__ 并 registerTool,工具立即
 * 通过 `yolo_bridge__<name>` in-process server 进入统一 MCP 工具链。
 */

const BRIDGE_VERSION = '1.0.0'
const INJECT_SOURCE_PREFIX = 'inject/'
export const YOLO_BRIDGE_TOOL_SERVER_NAME = 'yolo_bridge'

/** 与 MCP Bridge 的 McpToolDescriptor 兼容的注入描述符。 */
export type InjectedToolDescriptor = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties?: Record<string, unknown>
    required?: string[]
    [keyword: string]: unknown
  }
  annotations?: McpTool['annotations']
  /** YOLO policy extension; this is intentionally separate from MCP hints. */
  requiresApproval?: boolean
}

export type InjectedToolHandler = (args: Record<string, unknown>) => unknown

export type InjectedToolEntry = {
  descriptor: InjectedToolDescriptor
  handler: InjectedToolHandler
}

/** 暴露到 window 的注入桥接口(与 MCP Bridge 合约一致)。 */
export type YoloInjectionBridge = {
  readonly version: string
  registerTool(
    descriptor: InjectedToolDescriptor,
    handler: InjectedToolHandler,
    sourceId?: string,
    groupName?: string,
  ): void
  registerTools(
    tools: InjectedToolEntry[],
    sourceId?: string,
    groupName?: string,
  ): void
  unregisterTool(name: string): void
  unregisterBySource(sourceId: string): void
  listTools(): Record<string, string[]>
}

class InjectedToolRegistry {
  private readonly tools = new Map<string, InjectedToolRegistryEntry>()
  private readonly listeners = new Set<() => void>()

  set(
    tool: McpTool,
    handler: InjectedToolHandler,
    source: string,
    groupName?: string,
    requiresApproval?: boolean,
  ): void {
    const existing = this.tools.get(tool.name)
    if (existing && existing.source !== source) {
      throw new Error(
        `Injected tool "${tool.name}" is already registered by source "${existing.source}".`,
      )
    }
    this.tools.set(tool.name, {
      tool,
      handler,
      source,
      groupName,
      requiresApproval,
    })
    this.notify()
  }

  getGroupName(name: string): string | undefined {
    return this.tools.get(name)?.groupName
  }

  getApprovalPolicy(name: string): InProcessToolApprovalPolicy | undefined {
    return this.tools.get(name)?.requiresApproval === true
      ? 'always-require-user'
      : undefined
  }

  delete(name: string): boolean {
    const removed = this.tools.delete(name)
    if (removed) this.notify()
    return removed
  }

  deleteBySource(source: string): boolean {
    let removedAny = false
    for (const [name, entry] of this.tools.entries()) {
      if (entry.source === source) {
        this.tools.delete(name)
        removedAny = true
      }
    }
    if (removedAny) this.notify()
    return removedAny
  }

  clear(): void {
    if (this.tools.size === 0) return
    this.tools.clear()
    this.notify()
  }

  getTools(): McpTool[] {
    return Array.from(this.tools.values()).map((entry) => entry.tool)
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const entry = this.tools.get(name)
    if (!entry) {
      throw new Error(`Injected tool not registered: "${name}"`)
    }
    return entry.handler(args)
  }

  listBySource(): Record<string, string[]> {
    const result: Record<string, string[]> = {}
    for (const [name, entry] of this.tools.entries()) {
      const source = entry.source
      const names = result[source] ?? []
      names.push(name)
      result[source] = names
    }
    return result
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch (error) {
        console.error('[YOLO] Injected tool registry listener failed:', error)
      }
    }
  }
}

type InjectedToolRegistryEntry = {
  tool: McpTool
  handler: InjectedToolHandler
  source: string
  /** 注入方自定义的插件能力分组名（如 "浏览器自动化插件能力"）。 */
  groupName?: string
  requiresApproval?: boolean
}

const injectedToolRegistry = new InjectedToolRegistry()

class YoloInjectionBridgeImpl implements YoloInjectionBridge {
  readonly version: string

  constructor(
    version: string,
    private readonly registry: InjectedToolRegistry,
  ) {
    this.version = version
  }

  registerTool(
    descriptor: InjectedToolDescriptor,
    handler: InjectedToolHandler,
    sourceId = 'unknown',
    groupName?: string,
  ): void {
    const source = normalizeSource(sourceId)
    this.registry.set(
      toMcpTool(descriptor),
      handler,
      source,
      groupName,
      descriptor.requiresApproval,
    )
  }

  registerTools(
    tools: InjectedToolEntry[],
    sourceId = 'unknown',
    groupName?: string,
  ): void {
    const source = normalizeSource(sourceId)
    for (const tool of tools) {
      this.registry.set(
        toMcpTool(tool.descriptor),
        tool.handler,
        source,
        groupName,
        tool.descriptor.requiresApproval,
      )
    }
  }

  unregisterTool(name: string): void {
    this.registry.delete(name)
  }

  unregisterBySource(sourceId: string): void {
    this.registry.deleteBySource(normalizeSource(sourceId))
  }

  listTools(): Record<string, string[]> {
    return this.registry.listBySource()
  }
}

function normalizeSource(sourceId: string): string {
  return sourceId.startsWith(INJECT_SOURCE_PREFIX)
    ? sourceId
    : `${INJECT_SOURCE_PREFIX}${sourceId}`
}

function toMcpTool(descriptor: InjectedToolDescriptor): McpTool {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema as McpTool['inputSchema'],
    ...(descriptor.annotations ? { annotations: descriptor.annotations } : {}),
  }
}

let installedBridge: YoloInjectionBridge | null = null

type BridgeWindow = {
  __yoloBridge__?: unknown
}

/**
 * Bridge target object. Prefers `window` (Obsidian renderer), falls back to
 * `globalThis` so the module stays testable and safe outside a DOM (Jest runs
 * with the `node` environment in this repo).
 */
function getBridgeTarget(): BridgeWindow {
  if (typeof window !== 'undefined') {
    return window as unknown as BridgeWindow
  }
  return globalThis as unknown as BridgeWindow
}

/** 探测当前 window 上可用的注入桥(本插件安装的 __yoloBridge__)。 */
export function getInstalledInjectionBridge(): YoloInjectionBridge | null {
  return installedBridge
}

/**
 * 把 YOLO 注入桥挂到 window 上。幂等;重复调用不重复挂载。
 * @param onToolsChanged 注入工具集合变化时回调(用于刷新 Agent 工具缓存)。
 * @returns 卸载函数。
 */
export function installYoloInjectionBridge(options?: {
  onToolsChanged?: () => void
}): () => void {
  if (installedBridge) {
    // Already installed by a previous call; the caller must not tear down an
    // installation it does not own.
    return () => undefined
  }

  const registry = injectedToolRegistry
  const bridge = new YoloInjectionBridgeImpl(BRIDGE_VERSION, registry)
  installedBridge = bridge

  const win = getBridgeTarget()
  win.__yoloBridge__ = bridge

  let unsubscribe: (() => void) | null = null
  if (options?.onToolsChanged) {
    unsubscribe = registry.subscribe(options.onToolsChanged)
  }

  return () => {
    if (unsubscribe) unsubscribe()
    uninstallYoloInjectionBridge()
  }
}

export function uninstallYoloInjectionBridge(): void {
  const win = getBridgeTarget()
  if (installedBridge) {
    if (win.__yoloBridge__ === installedBridge) {
      delete win.__yoloBridge__
    }
  }
  injectedToolRegistry.clear()
  installedBridge = null
}

/** 当前注入工具的描述符列表,供 getLocalFileTools() 附加。 */
export function getInjectedBridgeTools(): McpTool[] {
  return injectedToolRegistry.getTools()
}

export function isInjectedBridgeToolName(toolName: string): boolean {
  return injectedToolRegistry.has(toolName)
}

/** 注入工具的自定义插件能力分组名（未提供时回退到"外部能力"分组）。 */
export function getInjectedToolGroupName(toolName: string): string | undefined {
  return injectedToolRegistry.getGroupName(toolName)
}

export function callInjectedBridgeTool(
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return injectedToolRegistry.call(toolName, args)
}

export function subscribeInjectedBridgeTools(listener: () => void): () => void {
  return injectedToolRegistry.subscribe(listener)
}

export function createInjectionBridgeToolServer(): InProcessToolServer {
  return {
    listTools: () => getInjectedBridgeTools(),
    getToolApprovalPolicy: (toolName) =>
      injectedToolRegistry.getApprovalPolicy(toolName),
    async callTool({ toolName, args, signal }): Promise<ToolCallResponse> {
      if (signal.aborted) {
        return { status: ToolCallResponseStatus.Aborted }
      }
      const result = await callInjectedBridgeTool(toolName, args)
      return {
        status: ToolCallResponseStatus.Success,
        data: {
          type: 'text',
          text:
            typeof result === 'string'
              ? result
              : (JSON.stringify(result, null, 2) ?? String(result)),
        },
      }
    },
  }
}
