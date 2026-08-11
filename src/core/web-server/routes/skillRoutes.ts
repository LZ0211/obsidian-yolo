import type { App } from 'obsidian'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import { listLiteSkillEntries } from '../../skills/liteSkills'
import { writeJson } from '../WebHttpServer'
import { type WebRouter } from '../WebRouter'

import { WEB_SESSION_HEADER } from './authRoutes'
import { type ApiError } from './routeUtils'

export type SkillRoutesContext = {
  app: App
  getSettings: () => YoloSettings
  resolveSkillsAccess?: (
    sessionId: string | null,
  ) => { ok: true } | { ok: false; statusCode: number; body: ApiError }
}

export function registerSkillRoutes(
  router: WebRouter,
  context: SkillRoutesContext,
): void {
  router.get('/api/skills', async (req, res) => {
    const sessionId = getSessionId(req.headers)
    const access = context.resolveSkillsAccess?.(sessionId)
    if (access && !access.ok) {
      writeJson(res, access.statusCode, access.body)
      return
    }

    const skills = await listLiteSkillEntries(context.app, {
      settings: context.getSettings(),
    })
    writeJson(res, 200, skills)
  })
}

function getSessionId(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  const value = headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}
