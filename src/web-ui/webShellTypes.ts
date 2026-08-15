import type { ChatConversationMetadata } from '../database/json/chat/types'
import type { WebApiClient, WebBootstrapPayload } from '../runtime/web-entry'
import type { YoloRuntime } from '../runtime/yoloRuntime.types'

// Mirrors PublicWorkspaceAgentSummary (src/core/web-server/webAgentTypes.ts).
// Capability fields are optional on the wire so legacy servers don't break
// the chat UI — chat falls back to "allowed" when absent.
export type AllowedAgent = {
  id: string
  name?: string
  agentModeAllowed?: boolean
  unavailable?: boolean
}
export type LeftPaneMode = 'files' | 'history'

export type ShellClient = {
  readonly currentSessionId: string | null
  getBootstrap: () => Promise<WebBootstrapPayload>
  getSettings: () => Promise<unknown>
  getAgents: () => Promise<unknown>
  getSkills: WebApiClient['getSkills']
  getWebAuthState: () => Promise<{
    session: { agentId: string }
    allowedAgents: AllowedAgent[]
  } | null>
  switchAgent: WebApiClient['switchAgent']
  loginWithShareToken: (
    token: string,
  ) => Promise<{ session: { agentId: string }; allowedAgents: AllowedAgent[] }>
  logout: () => Promise<void>
  listVaultFolder: WebApiClient['listVaultFolder']
  listVaultIndex: WebApiClient['listVaultIndex']
  searchVault: WebApiClient['searchVault']
  previewVaultText: WebApiClient['previewVaultText']
  readVaultBinary: WebApiClient['readVaultBinary']
  downloadVaultFile: WebApiClient['downloadVaultFile']
  writeVaultText: WebApiClient['writeVaultText']
  writeVaultBinary: WebApiClient['writeVaultBinary']
  createVaultFile: WebApiClient['createVaultFile']
  createVaultFolder: WebApiClient['createVaultFolder']
  renameVaultPath: WebApiClient['renameVaultPath']
  moveVaultPath: WebApiClient['moveVaultPath']
  deleteVaultFile: WebApiClient['deleteVaultFile']
  deleteVaultFolder: WebApiClient['deleteVaultFolder']
  uploadVaultFiles: WebApiClient['uploadVaultFiles']
}

export type HistoryClient = {
  listChats: () => Promise<ChatConversationMetadata[]>
  togglePinnedChat: (id: string) => Promise<void>
  updateChatTitle: (id: string, title: string) => Promise<void>
  retryChatTitle: (id: string) => Promise<void>
}

export type ReadyShellState = {
  status: 'ready'
  client: ShellClient
  historyClient: HistoryClient
  runtime: YoloRuntime
  allowedAgents: AllowedAgent[]
  agentId: string
  mock: boolean
  /** Vault-absolute path of the active agent's workspace root ("home"). When
   *  set, the file tree and @-mention scope to this folder. Empty means
   *  no scoping (whole vault visible). */
  workspaceRoot: string
}

export type ShellState =
  | { status: 'loading' }
  | { status: 'setup'; client: ShellClient; mock: boolean }
  | {
      status: 'login'
      client: ShellClient
      loginError: string | null
      loggingIn: boolean
      mock: boolean
    }
  | ReadyShellState
  | { status: 'error'; message: string }

export type ModalSpec = {
  title: string
  description: string
  submitLabel?: string
  error?: string | null
  loading?: boolean
  password?: boolean
  onSubmit?: (value: string) => Promise<void> | void
}
