// eslint-disable-next-line import/no-nodejs-modules -- type-only import，编译后消失，无运行时 node 依赖
import type { IncomingMessage } from 'node:http'

import type { YoloSettings } from '../../../settings/schema/setting.types'
import {
  hashWorkspaceRoot,
  parsePublicTokenId,
  verifyShareToken,
} from '../shareTokenCrypto'
import type { createWebAgentContextResolver } from '../webAgentContextResolver'
import { writeJson } from '../WebHttpServer'
import type { WebRouter } from '../WebRouter'
import type { WebSessionStore } from '../webSessionStore'

import { apiError, readJsonBody } from './routeUtils'

export const WEB_SESSION_HEADER = 'x-yolo-web-session-id'
const DEFAULT_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000
const DEFAULT_ABSOLUTE_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000
const FAILED_LOGIN_LIMIT = 10
const FAILED_LOGIN_WINDOW_MS = 60 * 1000

type WebAgentContextResolver = ReturnType<typeof createWebAgentContextResolver>

type AuthRoutesContext = {
  getSettings: () => YoloSettings
  pepper: string
  sessionStore: WebSessionStore
  resolver: WebAgentContextResolver
  vaultIdentity: string
  now?: () => number
}

type FailedAttemptBucket = {
  count: number
  windowStartedAt: number
}

const failedLoginBuckets = new Map<string, FailedAttemptBucket>()

/** Test seam — clears the per-(IP+token-id) rate-limit buckets so tests
 *  can run in any order without one test's failures starving the next.
 *  Production code never calls this. */
export function __resetFailedLoginBucketsForTests(): void {
  failedLoginBuckets.clear()
}

export function registerAuthRoutes(
  router: WebRouter,
  context: AuthRoutesContext,
): void {
  const now = context.now ?? Date.now

  router.post('/api/web/auth/login', async (req, res) => {
    const parsed = await readJsonBody(req)
    if (!parsed.ok) {
      writeJson(res, parsed.statusCode, parsed.body)
      return
    }

    const token = parsed.value.token
    if (typeof token !== 'string' || token.length === 0) {
      writeJson(
        res,
        400,
        apiError('invalid_request', 'Share token is required.'),
      )
      return
    }

    const publicTokenId = parsePublicTokenId(token)
    const rateLimitKey = buildRateLimitKey(req, publicTokenId)
    if (isRateLimited(rateLimitKey, now())) {
      writeJson(
        res,
        429,
        apiError(
          'rate_limited',
          'Too many failed login attempts. Try again later.',
        ),
      )
      return
    }

    const settings = context.getSettings()
    if (!settings.workspaceAgents.some((agent) => !agent.disabled)) {
      writeJson(
        res,
        403,
        apiError('agent_unavailable', 'Remote web setup is incomplete.'),
      )
      return
    }

    const matchResult = findMatchingShareToken(
      settings,
      token,
      context.pepper,
      now(),
    )
    if (!matchResult.ok) {
      // Only count truly-invalid attempts against the rate limit. Expired /
      // disabled tokens are a state-of-record problem, not a brute-force
      // signal, so we surface a useful error without burning the bucket.
      if (matchResult.reason === 'invalid') {
        recordFailedLogin(rateLimitKey, now())
        writeJson(res, 401, apiError('unauthenticated', 'Invalid share token.'))
      } else if (matchResult.reason === 'expired') {
        writeJson(
          res,
          401,
          apiError('token_expired', 'This share token has expired.'),
        )
      } else {
        writeJson(
          res,
          401,
          apiError('token_disabled', 'This share token has been disabled.'),
        )
      }
      return
    }
    const matched = matchResult.match

    const activeAgentId =
      matched.token.scope.kind === 'agent'
        ? matched.token.scope.agentId
        : matched.token.scope.issuedForAgentId
    const activeAgent = settings.workspaceAgents.find(
      (agent) => agent.id === activeAgentId,
    )
    if (!activeAgent || activeAgent.disabled) {
      writeJson(
        res,
        403,
        apiError('agent_unavailable', 'Remote web setup is incomplete.'),
      )
      return
    }

    const rootHash =
      matched.token.scope.kind === 'workspaceRoot'
        ? matched.token.scope.rootHash
        : hashWorkspaceRoot(
            activeAgent.workspacePolicy.workspaceRoot,
            context.vaultIdentity,
          )

    // The session lifetime follows the token's configured deadline: a token
    // with an expiry keeps the session valid until that deadline (idle and
    // absolute alike), so "按截止日期" holds in the UI. Tokens without a
    // deadline fall back to the default idle/absolute windows.
    const tokenRemainingMs =
      matched.token.expiresAt != null
        ? Math.max(0, matched.token.expiresAt - now())
        : null
    const session = context.sessionStore.create({
      tokenRecordId: matched.token.id,
      tokenScope: matched.token.scope,
      activeAgentId,
      rootHash,
      idleTimeoutMs:
        tokenRemainingMs !== null && tokenRemainingMs > 0
          ? tokenRemainingMs
          : DEFAULT_IDLE_TIMEOUT_MS,
      absoluteTimeoutMs:
        tokenRemainingMs !== null && tokenRemainingMs > 0
          ? tokenRemainingMs
          : DEFAULT_ABSOLUTE_TIMEOUT_MS,
    })
    const resolved = context.resolver.resolve({ sessionId: session.id })
    if (!resolved.ok) {
      context.sessionStore.delete(session.id)
      writeJson(
        res,
        resolved.code === 'forbidden' ? 403 : 403,
        apiError(resolved.code, resolved.message),
      )
      return
    }

    failedLoginBuckets.delete(rateLimitKey)
    res.setHeader(WEB_SESSION_HEADER, session.id)
    writeJson(res, 200, authStateBody(resolved.context))
  })

  router.get('/api/web/auth/session', (req, res) => {
    const sessionId = getSessionId(req)
    const resolved = context.resolver.resolve({ sessionId })
    if (!resolved.ok) {
      writeJson(
        res,
        401,
        apiError('session_expired', 'The web session has expired.'),
      )
      return
    }
    writeJson(res, 200, authStateBody(resolved.context))
  })

  router.post('/api/web/auth/logout', (req, res) => {
    const sessionId = getSessionId(req)
    if (sessionId) {
      context.sessionStore.delete(sessionId)
    }
    res.setHeader(WEB_SESSION_HEADER, '')
    writeJson(res, 200, { ok: true })
  })

  router.post('/api/web/auth/switch-agent', async (req, res) => {
    const parsed = await readJsonBody(req)
    if (!parsed.ok) {
      writeJson(res, parsed.statusCode, parsed.body)
      return
    }
    const agentId = parsed.value.agentId
    if (typeof agentId !== 'string' || agentId.length === 0) {
      writeJson(res, 400, apiError('invalid_request', 'agentId is required.'))
      return
    }

    const sessionId = getSessionId(req)
    const session = sessionId ? context.sessionStore.resolve(sessionId) : null
    if (!session) {
      writeJson(
        res,
        401,
        apiError('session_expired', 'The web session has expired.'),
      )
      return
    }

    const canSwitch = context.resolver.canSwitch(
      {
        id: session.id,
        tokenRecordId: session.tokenRecordId,
        tokenScope: session.tokenScope,
        activeAgentId: session.activeAgentId,
        rootHash: session.rootHash,
        createdAt: session.createdAt,
        lastUsedAt: session.lastSeenAt,
        expiresAt: session.absoluteExpiresAt,
      },
      agentId,
    )
    if (!canSwitch.ok) {
      writeJson(
        res,
        canSwitch.code === 'forbidden' ? 403 : 403,
        apiError(canSwitch.code, canSwitch.message),
      )
      return
    }

    context.sessionStore.switchActiveAgent(session.id, agentId)
    const resolved = context.resolver.resolve({ sessionId: session.id })
    if (!resolved.ok) {
      writeJson(res, 403, apiError(resolved.code, resolved.message))
      return
    }
    writeJson(res, 200, authStateBody(resolved.context))
  })
}

type ShareTokenMatchResult =
  | {
      ok: true
      match: {
        agent: YoloSettings['workspaceAgents'][number]
        token: NonNullable<
          YoloSettings['workspaceAgents'][number]['shareTokens']
        >[number]
      }
    }
  | { ok: false; reason: 'invalid' | 'expired' | 'disabled' }

function findMatchingShareToken(
  settings: YoloSettings,
  plaintext: string,
  pepper: string,
  now: number,
): ShareTokenMatchResult {
  const publicTokenId = parsePublicTokenId(plaintext)
  // Distinguish "no record matched the hash at all" (invalid) from "matched
  // but state-of-record rejects it" (expired/disabled). The latter cases let
  // us surface a useful error in the login UI instead of generic "invalid".
  let matchedButRejected: 'expired' | 'disabled' | null = null
  for (const agent of settings.workspaceAgents) {
    for (const token of agent.shareTokens ?? []) {
      if (token.revokedAt) continue
      if (publicTokenId && token.id !== publicTokenId) continue
      if (!verifyShareToken(plaintext, token.tokenHash, pepper)) continue

      if (token.disabled === true) {
        matchedButRejected = 'disabled'
        continue
      }
      if (token.expiresAt != null && token.expiresAt <= now) {
        matchedButRejected = 'expired'
        continue
      }
      return { ok: true, match: { agent, token } }
    }
  }
  return matchedButRejected
    ? { ok: false, reason: matchedButRejected }
    : { ok: false, reason: 'invalid' }
}

function authStateBody(context: {
  activeAgent: { id: string }
  allowedAgents: unknown[]
}) {
  return {
    session: {
      agentId: context.activeAgent.id,
    },
    allowedAgents: context.allowedAgents,
  }
}

function getSessionId(req: IncomingMessage): string | null {
  const value = req.headers[WEB_SESSION_HEADER]
  if (Array.isArray(value)) return value[0] ?? null
  return typeof value === 'string' && value.length > 0 ? value : null
}

function buildRateLimitKey(
  req: IncomingMessage,
  publicTokenId: string | null,
): string {
  const remoteAddress = req.socket.remoteAddress ?? 'unknown'
  return `${remoteAddress}:${publicTokenId ?? 'unknown'}`
}

function isRateLimited(key: string, now: number): boolean {
  const bucket = failedLoginBuckets.get(key)
  if (!bucket || now - bucket.windowStartedAt >= FAILED_LOGIN_WINDOW_MS) {
    return false
  }
  return bucket.count >= FAILED_LOGIN_LIMIT
}

function recordFailedLogin(key: string, now: number): void {
  const bucket = failedLoginBuckets.get(key)
  if (!bucket || now - bucket.windowStartedAt >= FAILED_LOGIN_WINDOW_MS) {
    failedLoginBuckets.set(key, { count: 1, windowStartedAt: now })
    return
  }
  bucket.count += 1
}
