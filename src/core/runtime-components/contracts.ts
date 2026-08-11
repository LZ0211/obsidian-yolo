export type RuntimeComponentId =
  | 'tokenizer'
  | 'pdf-engine'
  | 'bash-engine'
  | 'jieba-engine'
  | 'sqlite-engine'

export type TokenizerComponentApi = Readonly<{
  count(text: string): number
  dispose(): void
}>

/** Chinese word segmentation (jieba-rs WASM) in a dedicated worker thread. */
export type JiebaComponentApi = Readonly<{
  /**
   * Search-engine mode: long words plus their sub-tokens, e.g.
   * "北京烤鸭" → ["北京", "烤鸭", "北京烤鸭"].
   */
  cutForSearch(text: string): Promise<string[]>
  dispose(): void
}>

export type PdfSliceErrorKind =
  | 'invalid-range'
  | 'load-failed'
  | 'too-many-pages'
  | 'too-large'

export type PdfEngineComponentApi = Readonly<{
  extractPages(
    bytes: Uint8Array,
    options: { maxPages: number; signal?: AbortSignal },
  ): Promise<{
    totalPages: number
    pages: { page: number; text: string }[]
  }>
  getPageCount(bytes: Uint8Array, signal?: AbortSignal): Promise<number>
  extractPageText(
    bytes: Uint8Array,
    page: number,
    signal?: AbortSignal,
  ): Promise<string>
  renderPages(
    bytes: Uint8Array,
    range: { startPage: number; endPage?: number },
    signal?: AbortSignal,
  ): Promise<{
    totalPages: number
    rendered: { page: number; dataUrl: string }[]
  }>
  slicePages(
    bytes: Uint8Array,
    range: { startPage: number; endPage?: number },
  ): Promise<{
    bytes: Uint8Array
    totalSourcePages: number
    actualStart: number
    actualEnd: number
  }>
  dispose(): void
}>

export type VectorMetaData = {
  startLine: number
  endLine: number
  page?: number
}

/**
 * Minimal filesystem surface the bash-engine component needs from its host.
 * Deliberately host-agnostic (no Obsidian/Vault types) so the component stays
 * decoupled from vault semantics — the host adapter (see
 * `src/core/agent/bash/vaultBashFileSystem.ts`) owns path mounting and vault
 * mapping; this type only describes the callback shapes it must implement.
 *
 * Content mutation (`writeFile`/`appendFile`/`cp`) is intentionally absent:
 * the component always rejects those internally and never calls out to the
 * host for them — content edits stay on the `fs_edit`/`fs_write` tools.
 */
export type BashFsStat = Readonly<{
  isFile: boolean
  isDirectory: boolean
  /** Milliseconds since epoch. */
  mtimeMs: number
  size: number
}>

export type BashFsDirentEntry = Readonly<{
  name: string
  isFile: boolean
  isDirectory: boolean
}>

export type BashFsRmResult = Readonly<{
  targetKind: 'file' | 'folder'
}>

export type BashFsCallbacks = Readonly<{
  readFile(path: string): Promise<string>
  readFileBuffer(path: string): Promise<Uint8Array>
  exists(path: string): Promise<boolean>
  stat(path: string): Promise<BashFsStat>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  readdir(path: string): Promise<BashFsDirentEntry[]>
  rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<BashFsRmResult>
  mv(oldPath: string, newPath: string): Promise<void>
  /** All known paths under the mount, for glob/find matching. */
  getAllPaths(): string[]
}>

export type BashDangerousOperationKind = 'rm' | 'mv'

/**
 * Host-provided gate consulted before an `rm`/`mv` target actually touches
 * the filesystem. The component collects every target belonging to a single
 * command invocation before calling this once, then performs the operation
 * per target only if it resolves `true`. Policy (which tier is active,
 * whether to prompt the user) is entirely the host's decision — the
 * component has no notion of approval tiers.
 */
export type BashConfirmDangerousOperation = (
  kind: BashDangerousOperationKind,
  targets: readonly string[],
) => Promise<boolean>

/**
 * One line of `search` command output. `path` is vault-relative; the
 * component owns mapping it back to `/vault/...` display form, mirroring how
 * `BashFsCallbacks` paths work.
 */
export type BashSearchResultEntry = Readonly<{
  kind: 'file' | 'dir' | 'content'
  path: string
  startLine?: number
  endLine?: number
  /** PDF hit: source page (1-based), shown instead of line numbers. */
  page?: number
  snippet?: string
}>

export type BashSearchOutcome =
  | Readonly<{
      status: 'success'
      results: readonly BashSearchResultEntry[]
      /** Non-fatal note (e.g. RAG-unavailable fallback), printed to stderr. */
      notice?: string
    }>
  | Readonly<{ status: 'error'; message: string }>

/**
 * Host-provided semantic retrieval behind the custom `search` command. The
 * component only parses arguments and formats output; ranking (hybrid
 * RAG + keyword fusion, keyword fallback) is entirely the host's concern.
 * `scopePath` is vault-relative (undefined = whole vault).
 */
export type BashSearchCallback = (
  request: Readonly<{
    query: string
    scopePath?: string
    maxResults: number
  }>,
) => Promise<BashSearchOutcome>

export type BashSessionOptions = Readonly<{
  fs: BashFsCallbacks
  confirmDangerousOperation: BashConfirmDangerousOperation
  /**
   * When provided, registers the custom `search` command (semantic vault
   * retrieval). Available in read-only sessions too — search is a read.
   */
  search?: BashSearchCallback
  cwd?: string
  signal?: AbortSignal
  /**
   * When true, the session structurally cannot perform path writes: `mkdir`,
   * `mv`, `rm`, and `rmdir` are excluded from the command set entirely
   * (command not found) and the underlying `fs.mkdir`/`fs.rm`/`fs.mv`
   * callbacks are never invoked, even if some other command reaches them
   * unexpectedly. `confirmDangerousOperation` is never consulted in this
   * mode — there is nothing to approve. Defaults to false.
   */
  readOnly?: boolean
}>

export type BashSessionResult = Readonly<{
  stdout: string
  stderr: string
  exitCode: number
}>

export type BashSession = Readonly<{
  exec(command: string): Promise<BashSessionResult>
  dispose(): void
}>

export type BashEngineComponentApi = Readonly<{
  createSession(options: BashSessionOptions): BashSession
  dispose(): void
}>

/** Minimal vault-adapter surface the sqlite-engine component needs. */
export type SqliteEngineVaultAdapter = {
  exists(path: string): Promise<boolean>
  readBinary(path: string): Promise<ArrayBuffer>
  writeBinary(path: string, data: ArrayBuffer): Promise<void>
  rename(oldPath: string, newPath: string): Promise<void>
}

export type SqliteEngineFacade = {
  exec(sql: string, params?: unknown[]): void
  query<T>(sql: string, params?: unknown[]): T[]
  queryOne<T>(sql: string, params?: unknown[]): T | undefined
  prepare(sql: string): {
    all: (...params: unknown[]) => unknown[]
    get: (...params: unknown[]) => unknown
    run: (...params: unknown[]) => unknown
  }
  transaction<T>(fn: (runtime: SqliteEngineFacade) => T): T
  close(): void
  getStatus(): { status: string; dbPath: string; isOpen: boolean }
  flush(): Promise<void>
}

/**
 * sql.js-backed SQLite (in-memory + debounced vault-file export) for
 * platforms without node:sqlite. The returned facade is a plain object owned
 * by the caller, independent of the component instance — safe to use after
 * the lease is released.
 */
export type SqliteEngineComponentApi = Readonly<{
  openSqliteJsRuntime(options: {
    relativePath: string
    adapter: SqliteEngineVaultAdapter
    flushDebounceMs?: number
  }): Promise<SqliteEngineFacade>
  dispose(): void
}>

export type RuntimeComponentApiMap = {
  tokenizer: TokenizerComponentApi
  'pdf-engine': PdfEngineComponentApi
  'bash-engine': BashEngineComponentApi
  'jieba-engine': JiebaComponentApi
  'sqlite-engine': SqliteEngineComponentApi
}

export type RuntimeComponentDefinition<
  I extends RuntimeComponentId = RuntimeComponentId,
> = Readonly<{
  id: I
  create(): RuntimeComponentApiMap[I] | Promise<RuntimeComponentApiMap[I]>
}>

export type RuntimeComponentLease<I extends RuntimeComponentId> = Readonly<{
  api: RuntimeComponentApiMap[I]
  release(): void
}>
