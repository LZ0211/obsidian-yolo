import type { YoloSettings } from '../../../settings/schema/setting.types'
import { isLoopbackHost } from '../../share/shareTokenStore'
import type { ResolvedWebAgentContext } from '../webAgentTypes'
import { writeJson } from '../WebHttpServer'
import { type WebRouter } from '../WebRouter'

export type BootstrapRoutesContext = {
  host: string
  port: number
  getSettings: () => Pick<YoloSettings, 'webRuntime' | 'workspaceAgents'>
  getServerUrl?: () => string
  getSessionContext?: (
    sessionId: string | null,
  ) => ResolvedWebAgentContext | null
  getLanguage?: () => string
}

export function registerBootstrapRoutes(
  router: WebRouter,
  context: BootstrapRoutesContext,
): void {
  router.get('/api/bootstrap', (req, res) => {
    const settings = context.getSettings()
    const sessionContext =
      context.getSessionContext?.(
        getHeader(req.headers['x-yolo-web-session-id']),
      ) ?? null
    // Surface the active agent's workspace root so the web-ui scopes the
    // file tree and @-mention picker. For workspace agents the root lives in
    // activeAgent.workspacePolicy; for templates it's on the assistant's
    // workspaceAccessPolicy. Only included when non-empty — empty falls back
    // to whole-vault visibility on the client.
    const templatePolicy = sessionContext?.template.workspaceAccessPolicy
    const templateRoot =
      templatePolicy?.enabled && templatePolicy.workspaceRoot
        ? templatePolicy.workspaceRoot
        : undefined
    const agentRoot = sessionContext?.activeAgent.workspacePolicy.workspaceRoot
    // Prefer template root (when enabled), fall back to agent root. "/" means
    // vault root → treated as no scoping. Strip leading / for web-ui compat.
    const raw = (
      (templateRoot && templateRoot !== '/' ? templateRoot : undefined) ??
      (agentRoot && agentRoot !== '/' ? agentRoot : undefined) ??
      ''
    ).trim()
    const workspaceRoot = raw ? raw.replace(/^\/+/, '') : undefined
    writeJson(res, 200, {
      serverUrl:
        context.getServerUrl?.() ??
        `http://${context.host}:${String(context.port)}`,
      phase: 1,
      authRequired: !isLoopbackHost(context.host),
      workspaceAgentConfigured: settings.workspaceAgents.some(
        (agent) => !agent.disabled,
      ),
      session: sessionContext
        ? {
            agentId: sessionContext.activeAgent.id,
          }
        : null,
      allowedAgents: sessionContext?.allowedAgents ?? [],
      ...(workspaceRoot !== undefined ? { workspaceRoot } : {}),
      settings: {
        webRuntimeEnabled: settings.webRuntime.enabled,
      },
      ...(context.getLanguage ? { language: context.getLanguage() } : {}),
    })
  })
}

function getHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}
