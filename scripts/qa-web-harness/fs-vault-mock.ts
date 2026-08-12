/**
 * 真 fs vault mock：以 Node 临时目录为 vault 根，提供
 * app.vault / app.vault.adapter / app.workspace / app.fileManager /
 * app.metadataCache 的最小可运行替身。
 *
 * 覆盖 registerWebServerRoutes 的全部消费面：
 * - `vault.adapter instanceof FileSystemAdapter` + `getBasePath()`（web 路由
 *   与路径解析的桌面分支判定）；
 * - `vault.getName()`（vaultIdentity，share-token 哈希输入）；
 * - `vault.getRoot()` / `vault.getAbstractFileByPath()`（web 路由的
 *   isVaultFolder / 文件树）；
 * - `vault.adapter.exists/mkdir/write/remove/read/list`（ChatManager /
 *   AbstractJsonRepository 的 JSON 落盘）；
 * - workspace / fileManager / metadataCache（vaultRoutes 与
 *   RequestContextBuilder 的消费面，e2e 主流程不触及，给最小 stub）。
 */
import * as fs from 'node:fs'
import * as path from 'node:path'

import { FileSystemAdapter, TFile, TFolder } from 'obsidian'

/**
 * 真 fs adapter：vault 相对路径 <-> 临时目录绝对路径。
 *
 * 每个文件/目录的操作用 per-path 异步互斥串行化。原因：真实 Obsidian 的
 * web 运行时会并发执行 read-modify-write（runAgent 的 webBinding patch 与
 * AgentService 的 persistConversationMessages 各自用独立 ChatManager 实例，
 * 每个实例有独立写队列），本 mock 若不串行化会复现这个生产竞态，导致
 * webBinding 被过期读覆盖（审批 404 / 历史列表消失）——竞态本身是真实 bug
 * （见 e2e-report），但 harness 需要 mock 表现为一致的文件系统。
 */
export class FsVaultAdapter extends FileSystemAdapter {
  private readonly opChains = new Map<string, Promise<unknown>>()

  constructor(private readonly root: string) {
    super()
  }

  /** 按绝对路径串行化一个异步操作。 */
  private serialized<T>(absPath: string, op: () => Promise<T>): Promise<T> {
    const key = absPath.toLowerCase()
    const previous = this.opChains.get(key) ?? Promise.resolve()
    const next = previous.then(op, op)
    this.opChains.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    )
    return next
  }

  override getBasePath(): string {
    return this.root
  }

  /** vault 相对路径 → 临时目录内绝对路径。 */
  resolve(vaultPath: string): string {
    const cleaned = String(vaultPath)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
    return path.join(this.root, ...cleaned)
  }

  async read(vaultPath: string): Promise<string> {
    const abs = this.resolve(vaultPath)
    return this.serialized(abs, () => fs.promises.readFile(abs, 'utf8'))
  }

  async write(vaultPath: string, data: string): Promise<void> {
    const abs = this.resolve(vaultPath)
    return this.serialized(abs, async () => {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true })
      await fs.promises.writeFile(abs, data, 'utf8')
    })
  }

  async exists(vaultPath: string): Promise<boolean> {
    const abs = this.resolve(vaultPath)
    return this.serialized(abs, async () => fs.existsSync(abs))
  }

  async mkdir(vaultPath: string): Promise<void> {
    await fs.promises.mkdir(this.resolve(vaultPath), { recursive: true })
  }

  async remove(vaultPath: string): Promise<void> {
    const abs = this.resolve(vaultPath)
    return this.serialized(abs, () =>
      fs.promises.rm(abs, { recursive: true, force: true }),
    )
  }

  async list(
    vaultPath: string,
  ): Promise<{ files: string[]; folders: string[] }> {
    const abs = this.resolve(vaultPath)
    const files: string[] = []
    const folders: string[] = []
    let entries: fs.Dirent[]
    try {
      entries = await fs.promises.readdir(abs, { withFileTypes: true })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { files, folders }
      }
      throw error
    }
    for (const entry of entries) {
      const relative = `${vaultPath.replace(/\/+$/, '')}/${entry.name}`
      if (entry.isDirectory()) {
        folders.push(relative)
      } else if (entry.isFile()) {
        files.push(relative)
      }
    }
    return { files, folders }
  }

  async rename(from: string, to: string): Promise<void> {
    const fromAbs = this.resolve(from)
    const toAbs = this.resolve(to)
    return this.serialized(fromAbs, () => this.serialized(toAbs, () =>
      fs.promises.rename(fromAbs, toAbs),
    ))
  }

  async writeBinary(vaultPath: string, data: ArrayBuffer): Promise<void> {
    const abs = this.resolve(vaultPath)
    return this.serialized(abs, async () => {
      await fs.promises.mkdir(path.dirname(abs), { recursive: true })
      await fs.promises.writeFile(abs, Buffer.from(data))
    })
  }

  async readBinary(vaultPath: string): Promise<ArrayBuffer> {
    const abs = this.resolve(vaultPath)
    return this.serialized(abs, async () => {
      const buffer = await fs.promises.readFile(abs)
      return buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength,
      ) as ArrayBuffer
    })
  }

  async rmdir(vaultPath: string): Promise<void> {
    await fs.promises.rm(this.resolve(vaultPath), {
      recursive: true,
      force: true,
    })
  }

  async stat(vaultPath: string): Promise<{
    type: 'file' | 'folder'
    ctime: number
    mtime: number
    size: number
  }> {
    const abs = this.resolve(vaultPath)
    return this.serialized(abs, async () => {
      const stats = await fs.promises.stat(abs)
      return {
        type: stats.isDirectory() ? 'folder' : 'file',
        ctime: Math.floor(stats.ctimeMs),
        mtime: Math.floor(stats.mtimeMs),
        size: stats.size,
      }
    })
  }

  getResourcePath(): string {
    return ''
  }
}

function buildFolder(vaultPath: string): TFolder {
  const folder = new TFolder(vaultPath === '' ? '/' : vaultPath)
  if (vaultPath === '' || vaultPath === '/') {
    folder.name = ''
  }
  return folder
}

function buildFile(vaultPath: string): TFile {
  return new TFile(vaultPath)
}

/** 把真 fs 树投影成 Obsidian TFile/TFolder 对象树（惰性，按需展开）。 */
export class FsVaultMock {
  readonly adapter: FsVaultAdapter
  readonly name = 'e2e-harness-vault'

  constructor(root: string) {
    this.adapter = new FsVaultAdapter(root)
  }

  getName(): string {
    return this.name
  }

  getRoot(): TFolder {
    return buildFolder('/')
  }

  getAbstractFileByPath(vaultPath: string): TFile | TFolder | null {
    const cleaned = String(vaultPath)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .join('/')
    if (!cleaned) {
      return this.getRoot()
    }
    const abs = this.adapter.resolve(cleaned)
    let stats: fs.Stats
    try {
      stats = fs.statSync(abs)
    } catch {
      return null
    }
    if (stats.isDirectory()) {
      const folder = buildFolder(cleaned)
      return folder
    }
    return buildFile(cleaned)
  }

  getFiles(): TFile[] {
    const out: TFile[] = []
    const walk = (dir: string): void => {
      const abs = this.adapter.resolve(dir)
      let dirents: fs.Dirent[]
      try {
        dirents = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of dirents) {
        const relative = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(relative)
        } else if (entry.isFile()) {
          out.push(buildFile(relative))
        }
      }
    }
    walk('')
    return out
  }

  getAllFolders(includeRoot = false): TFolder[] {
    const out: TFolder[] = includeRoot ? [this.getRoot()] : []
    const walk = (dir: string): void => {
      const abs = this.adapter.resolve(dir)
      let dirents: fs.Dirent[]
      try {
        dirents = fs.readdirSync(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of dirents) {
        const relative = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          out.push(buildFolder(relative))
          walk(relative)
        }
      }
    }
    walk('')
    return out
  }

  getFileByPath(vaultPath: string): TFile | null {
    const file = this.getAbstractFileByPath(vaultPath)
    return file instanceof TFile ? file : null
  }

  async read(file: TFile): Promise<string> {
    return this.adapter.read(file.path)
  }

  async readBinary(file: TFile): Promise<ArrayBuffer> {
    return this.adapter.readBinary(file.path)
  }

  async modify(file: TFile, content: string): Promise<void> {
    await this.adapter.write(file.path, content)
  }

  async create(filePath: string, content: string): Promise<TFile> {
    await this.adapter.write(filePath, content)
    return buildFile(filePath)
  }

  async createFolder(folderPath: string): Promise<unknown> {
    await this.adapter.mkdir(folderPath)
    return buildFolder(folderPath)
  }

  async delete(file: TFile | TFolder): Promise<void> {
    await this.adapter.remove(file.path)
  }

  async listDescendants(folderPath: string): Promise<string[]> {
    const abs = this.adapter.resolve(folderPath)
    const out: string[] = []
    const walk = (dir: string): void => {
      let dirents: fs.Dirent[]
      try {
        dirents = fs.readdirSync(abs ? path.join(abs, dir) : abs, {
          withFileTypes: true,
        })
      } catch {
        return
      }
      for (const entry of dirents) {
        const relative = dir ? `${dir}/${entry.name}` : entry.name
        if (entry.isDirectory()) {
          walk(relative)
        } else if (entry.isFile()) {
          out.push(relative)
        }
      }
    }
    walk('')
    return out
  }

  // 注意：vaultRoutes 把 `context.vault.realpath` 当裸回调传给
  // decideWorkspacePathAccess——用箭头函数属性避免 this 丢失。
  // workspacePermissionEngine.normalizeVaultPath 显式拒绝盘符/UNC 路径，
  // 期待的是 vault 相对规范路径；这里返回相对路径的归一化形态。
  readonly realpath = (vaultPath: string): string | null => {
    const cleaned = String(vaultPath)
      .replace(/\\/g, '/')
      .replace(/^\/+/, '')
      .split('/')
      .filter(Boolean)
      .join('/')
    return cleaned.length > 0 ? cleaned : '/'
  }

  on(): { then: () => void } {
    return { then: () => undefined } as never
  }

  off(): void {
    // no-op
  }

  configDir = ''
}

export type AppMock = {
  vault: FsVaultMock
  workspace: {
    getActiveFile: () => null
    getLeaf: () => null
    on: () => () => void
  }
  fileManager: {
    createNewMarkdownFile: () => Promise<null>
    getNewFileParent: () => null
  }
  metadataCache: {
    getFileCache: () => null
    getFirstLinkpathDest: () => null
    on: () => () => void
  }
}

export function createAppMock(root: string): AppMock {
  return {
    vault: new FsVaultMock(root),
    workspace: {
      getActiveFile: () => null,
      getLeaf: () => null,
      on: () => () => undefined,
    },
    fileManager: {
      createNewMarkdownFile: async () => null,
      getNewFileParent: () => null,
    },
    metadataCache: {
      getFileCache: () => null,
      getFirstLinkpathDest: () => null,
      on: () => () => undefined,
    },
  }
}
