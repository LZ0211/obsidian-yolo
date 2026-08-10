import { McpTool } from '../../types/mcp.types'

/**
 * YOLO 原生注入桥。
 *
 * 背景:此前其他插件把工具注册进 MCP Bridge(window.__mcpBridge__),YOLO 再
 * 通过 HTTP MCP 服务拉取,中间隔了一层网络中转。现在 YOLO 自己成为注入目标:
 * 其他插件在 onload 里探测 window.__yoloBridge__ 并 registerTool,工具立即
 * 以 `yolo_local__<name>` 形式出现在 Agent 工具列表里,进程内直接调用。
 *
 * 为兼容已按 MCP Bridge 合约编写的插件,当 window.__mcpBridge__ 尚未被
 * 占用时,YOLO 会以相同接口挂载一个别名;安装了原版 MCP Bridge 时则跳过,
 * 避免互相覆盖。
 */

const BRIDGE_VERSION = '1.0.0'
const INJECT_SOURCE_PREFIX = 'inject/'

/** 与 MCP Bridge 的 McpToolDescriptor 兼容的注入描述符。 */
export type InjectedToolDescriptor = {
  name: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  annotations?: {
    capabilities?: string[]
  }
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
  ): void
  registerTools(tools: InjectedToolEntry[], sourceId?: string): void
  unregisterTool(name: string): void
  unregisterBySource(sourceId: string): void
  listTools(): Record<string, string[]>
}

class InjectedToolRegistry {
  private readonly tools = new Map<string, InjectedToolRegistryEntry>()
  private readonly listeners = new Set<() => void>()

  set(tool: McpTool, handler: InjectedToolHandler, source: string): void {
    this.tools.set(tool.name, { tool, handler, source })
    this.notify()
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
  ): void {
    const source = normalizeSource(sourceId)
    this.registry.set(toMcpTool(descriptor), handler, source)
  }

  registerTools(tools: InjectedToolEntry[], sourceId = 'unknown'): void {
    const source = normalizeSource(sourceId)
    for (const tool of tools) {
      this.registry.set(toMcpTool(tool.descriptor), tool.handler, source)
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
    // `annotations` in the MCP SDK is a fixed hint shape, not the free-form
    // `capabilities` metadata mcp-bridge plugins may attach; keep the schema
    // surface minimal and ignore it.
  } as McpTool
}

let installedBridge: YoloInjectionBridge | null = null
let legacyAliasInstalled = false

type BridgeWindow = {
  __yoloBridge__?: unknown
  __mcpBridge__?: unknown
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

  // Drop-in 兼容:MCP Bridge 未安装时以同名全局提供相同合约,
  // 已按 __mcpBridge__ 编写的第三方插件无需改动即可直连 YOLO。
  legacyAliasInstalled = win.__mcpBridge__ === undefined
  if (legacyAliasInstalled) {
    win.__mcpBridge__ = bridge
  }

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
    if (legacyAliasInstalled && win.__mcpBridge__ === installedBridge) {
      delete win.__mcpBridge__
    }
  }
  installedBridge = null
  legacyAliasInstalled = false
}

/** 当前注入工具的描述符列表,供 getLocalFileTools() 附加。 */
export function getInjectedBridgeTools(): McpTool[] {
  return injectedToolRegistry.getTools()
}

export function isInjectedBridgeToolName(toolName: string): boolean {
  return injectedToolRegistry.has(toolName)
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
