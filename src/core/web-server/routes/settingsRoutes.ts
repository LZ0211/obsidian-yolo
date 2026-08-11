import type { YoloSettings } from '../../../settings/schema/setting.types'
import { getUnifiedAgentList } from '../../agent/workspaceAgentResolver'
import type { ResolvedWebAgentContext } from '../webAgentTypes'
import { writeJson } from '../WebHttpServer'
import { type WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import { type ApiError, apiError } from './routeUtils'

export type SettingsRoutesContext = {
  getSettings: () => YoloSettings
  getSessionContext?: (
    sessionId: string | null,
  ) => ResolvedWebAgentContext | null
  resolveSettingsAccess?: (
    sessionId: string | null,
  ) => { ok: true } | { ok: false; statusCode: number; body: ApiError }
}

export function registerSettingsRoutes(
  router: WebRouter,
  context: SettingsRoutesContext,
): void {
  // Lean agent-list endpoint: unified list filtered to session scope.
  router.get('/api/agents', (req, res) => {
    const sessionContext = context.getSessionContext?.(
      getSessionId(req.headers),
    )
    if (!sessionContext) {
      writeJson(res, 401, apiError('unauthenticated', 'No active web session.'))
      return
    }
    const full = context.getSettings()
    const unified = getUnifiedAgentList(full)
    const allowedIds = new Set(sessionContext.allowedAgents.map((a) => a.id))
    const filtered = unified.filter((a) => allowedIds.has(a.id))
    writeJson(res, 200, filtered)
  })

  router.get('/api/settings', (req, res) => {
    const sessionId = getSessionId(req.headers)
    const access = context.resolveSettingsAccess?.(sessionId)
    if (access && !access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }
    const full = context.getSettings()
    const sessionContext = context.getSessionContext?.(sessionId) ?? null
    const allowedIds = sessionContext
      ? new Set(sessionContext.allowedAgents.map((a) => a.id))
      : undefined

    // Deep-clone so mutations below don't touch the live settings object.
    const settings = JSON.parse(JSON.stringify(full)) as YoloSettings

    // allowedIds holds *agent* ids (workspace agents, or standalone template
    // ids used directly as an agent). A workspace agent's own id is distinct
    // from its templateId, so filtering settings.assistants by allowedIds
    // directly would strip out the very templates the allowed agents are
    // built from — getUnifiedAgentList() needs those templates present to
    // resolve each workspace agent, otherwise it silently drops it. Expand
    // allowedIds to the set of template ids actually needed before filtering.
    const allowedTemplateIds = allowedIds
      ? new Set([
          ...allowedIds,
          ...(full.workspaceAgents ?? [])
            .filter((wa) => allowedIds.has(wa.id))
            .map((wa) => wa.templateId),
        ])
      : undefined

    // Scope-filter assistant templates the same way workspace agents are
    // scoped below — otherwise the web client's runtime.getAgents() (which
    // re-derives the unified list from these raw arrays) shows every
    // template regardless of the session's token scope.
    settings.assistants = (settings.assistants ?? []).filter(
      (a) => !allowedTemplateIds || allowedTemplateIds.has(a.id),
    )

    // Scope-filter workspace agents: only send agents the session is permitted
    // to use, then redact share-token secrets so the web client never sees them.
    settings.workspaceAgents = (settings.workspaceAgents ?? [])
      .filter((wa) => !allowedIds || allowedIds.has(wa.id))
      .map((wa) => ({
        ...wa,
        shareTokens: (wa.shareTokens ?? []).map((token) => ({
          ...token,
          tokenHash: '',
          plaintext: token.plaintext ? '' : undefined,
        })),
      }))

    // Redact provider API keys
    if (settings.providers) {
      settings.providers = settings.providers.map((p) => ({ ...p, apiKey: '' }))
    }

    // Redact web runtime token
    if (settings.webRuntime) {
      settings.webRuntime.token = ''
    }

    // Redact the local MCP server bearer token (management UI regenerates it)
    if (settings.mcp?.localServer?.token) {
      settings.mcp.localServer.token = ''
    }

    writeJson(res, 200, settings)
  })
}

function getSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}
