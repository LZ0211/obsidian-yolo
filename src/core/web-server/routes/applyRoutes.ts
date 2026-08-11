import type { ApplyViewState } from '../../../types/apply-view.types'
import { writeJson } from '../WebHttpServer'
import type { WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import { apiError, readJsonBody } from './routeUtils'

export type ApplyRoutesContext = {
  openApplyReview: (state: ApplyViewState) => Promise<boolean>
  resolveApplyAccess: (
    sessionId: string | null,
  ) =>
    | { ok: true }
    | { ok: false; statusCode: number; body: ReturnType<typeof apiError> }
}

export function registerApplyRoutes(
  router: WebRouter,
  context: ApplyRoutesContext,
): void {
  router.post('/api/ui/apply-review', async (req, res) => {
    const access = context.resolveApplyAccess(getSessionId(req.headers))
    if (!access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }

    const body = await readJsonBody(req)
    if (!body.ok) {
      writeJson(res, body.statusCode, body.body)
      return
    }

    const state = body.value.state
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      writeJson(res, 400, apiError('invalid_request', 'state is required'))
      return
    }

    const applied = await context.openApplyReview(state as ApplyViewState)
    writeJson(res, 200, { applied })
  })
}

function getSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}
