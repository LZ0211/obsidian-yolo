/**
 * Node 环境下的 obsidian 包运行时符号 stub。
 *
 * 真实 Obsidian 的 `obsidian` npm 包只带类型声明，运行时符号由插件宿主
 * 注入。e2e harness 在纯 Node（jest）进程里装配 WebServerLifecycle，因此
 * 需要一个提供运行时符号的替身。与 `__mocks__/obsidian.ts`（jest.fn 形态、
 * 缺 getLanguage 等）不同，这里提供的是可用的最小实现：
 * - Platform.isDesktop = true（桌面路径分支生效，web-server 依赖它）；
 * - FileSystemAdapter 是可继承的基类（fs-vault-mock 的子类覆盖
 *   getBasePath）；
 * - normalizePath 是真实语义的 posix 归一化（主 mock 是恒等函数，会把
 *   'YOLO//data' 这类路径原样传给真 fs adapter，导致目录错位）；
 * - getLanguage 返回 'zh'，避免 resolveWebLanguage 抛 TypeError。
 */

export class App {
  vault: unknown
  workspace: unknown
  fileManager: unknown
  metadataCache: unknown
}

export const apiVersion = '1.8.0'

export class Editor {}

export class MarkdownView {}

export const Platform = {
  isDesktop: true,
  isMobile: false,
  isIosApp: false,
  isAndroidApp: false,
}

export class TFile {
  path: string
  name: string
  extension: string
  basename: string
  parent: TFolder | null
  stat = { ctime: 0, mtime: 0, size: 0 }

  constructor(path = '') {
    this.path = path
    const segments = path.split('/')
    this.name = segments.at(-1) ?? ''
    const dot = this.name.lastIndexOf('.')
    this.extension = dot > 0 ? this.name.slice(dot + 1) : ''
    this.basename = dot > 0 ? this.name.slice(0, dot) : this.name
    this.parent = null
  }
}

export class TFolder {
  path: string
  name: string
  parent: TFolder | null
  children: Array<TFile | TFolder> = []

  constructor(path = '') {
    this.path = path
    const segments = path.split('/').filter(Boolean)
    this.name = segments.at(-1) ?? ''
    this.parent = null
  }
}

export class Vault {}

/**
 * Obsidian normalizePath 语义（posix 归一化）：
 * 反斜杠转正斜杠、去首尾空白与 './'、折叠多余斜杠、解析 '..'。
 */
export function normalizePath(path: string): string {
  const trimmed = String(path).replace(/\\/g, '/').trim()
  const parts = trimmed.split('/')
  const out: string[] = []
  for (const part of parts) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      out.pop()
      continue
    }
    out.push(part)
  }
  return out.join('/')
}

export class FileSystemAdapter {
  getBasePath(): string {
    return ''
  }
  getName(): string {
    return 'e2e-harness-vault'
  }
}

export function getLanguage(): string {
  return 'zh'
}

export const requestUrl = jest.fn()
export const htmlToMarkdown = jest.fn((html: string) => html)
export const renderMath = jest.fn()
export const finishRenderMath = jest.fn(async () => undefined)
export const parseYaml = jest.fn((input: string) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 与主 mock 一致复用 js-yaml
  const yaml = require('js-yaml') as { load: (input: string) => unknown }
  return yaml.load(input)
})
export const resolveSubpath = jest.fn(() => null)
export const getAllTags = jest.fn(() => [])
export const setIcon = jest.fn()
export const getLinkpath = jest.fn((path: string) => path)
export const Notice = class Notice {}
export const Modal = class Modal {}
export const Menu = class Menu {}
export const Setting = class Setting {}
export const Plugin = class Plugin {}
export const PluginSettingTab = class PluginSettingTab {}
export const Component = class Component {
  onload(): void {}
  onunload(): void {}
}
export const EventRef = class EventRef {}
export const TextComponent = class TextComponent {}
export const ToggleComponent = class ToggleComponent {}
export const SliderComponent = class SliderComponent {}
export const DropdownComponent = class DropdownComponent {}
export const ButtonComponent = class ButtonComponent {}
export const Keymap = class Keymap {}
export const requireApiVersion = jest.fn(() => false)
export const isRegularFile = jest.fn(() => true)
export const iterateCache = jest.fn()
