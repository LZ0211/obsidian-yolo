/**
 * SessionMapper — maps a platform session (`sessionKey`) to a persisted YOLO
 * conversation (`conversationId`), and back.
 *
 * Bot Platform design doc, "Session Mapping" section: persisted under
 * `bots.sessionMappings` in settings.json (accepted despite being a small
 * array living alongside `workspaceAgents`-style settings arrays — see v4
 * Review Notes item 7). Per that same note, writes should be throttled
 * rather than firing on every incoming message; this module exposes
 * `touchActiveSession` as the one high-frequency call site so a caller
 * (BotService, Phase 5) can decide the throttling policy without this class
 * needing to know about timers.
 *
 * Kept free of Obsidian imports per the implementation plan's Phase 1 list
 * ("session-mapper.ts ... no Obsidian deps, testable independently") — DI'd
 * via `getSettings`/`saveSettings`, matching the `McpCoordinator` /
 * `main.ts` convention (`getSettings: () => YoloSettings`,
 * `saveSettings: async (settings) => this.setSettings(settings)`), just
 * narrowed here to the `BotsSettings` slice.
 */
import type {
  BotsSettings,
  SessionMapping,
} from '../../settings/schema/setting.types'

export type SessionMapperDeps = {
  getSettings: () => BotsSettings
  saveSettings: (settings: BotsSettings) => Promise<void>
}

export class SessionMapper {
  private readonly getSettings: () => BotsSettings
  private readonly saveSettings: (settings: BotsSettings) => Promise<void>

  constructor(deps: SessionMapperDeps) {
    this.getSettings = deps.getSettings
    this.saveSettings = deps.saveSettings
  }

  getSessionByKey(
    sessionKey: string,
    platformInstanceId?: string,
    allowLegacyInstance = false,
  ): SessionMapping | undefined {
    return this.getSettings().sessionMappings.find(
      (mapping) =>
        mapping.sessionKey === sessionKey &&
        (platformInstanceId === undefined ||
          mapping.platformInstanceId === platformInstanceId ||
          (allowLegacyInstance === true &&
            mapping.platformInstanceId === undefined)),
    )
  }

  /**
   * Creates a new mapping, or replaces the existing one for the same
   * `sessionKey` (e.g. `/reset` rebinding a session to a fresh
   * conversationId). Persists immediately — callers that expect high-frequency
   * updates (e.g. per-message `lastActiveAt` bumps) should prefer
   * `touchActiveSession` instead.
   */
  async upsertSession(
    mapping: SessionMapping,
    allowLegacyInstance = false,
  ): Promise<SessionMapping> {
    const settings = this.getSettings()
    const existingIndex = settings.sessionMappings.findIndex(
      (existing) =>
        existing.sessionKey === mapping.sessionKey &&
        (existing.platformInstanceId === mapping.platformInstanceId ||
          (allowLegacyInstance && existing.platformInstanceId === undefined)),
    )
    const nextMappings = [...settings.sessionMappings]
    if (existingIndex === -1) {
      nextMappings.push(mapping)
    } else {
      nextMappings[existingIndex] = mapping
    }
    await this.saveSettings({ ...settings, sessionMappings: nextMappings })
    return mapping
  }

  /**
   * Bumps `lastActiveAt` on an existing session and auto-unarchives it (per
   * the design doc: "收到新消息时若 archivedAt 已设置且 disabled !== true，自动清除
   * archivedAt 恢复活跃"). No-ops (returns undefined) if the session doesn't
   * exist or is `disabled` — a disabled session must not silently reactivate
   * just because a message arrived.
   */
  async touchActiveSession(
    sessionKey: string,
    platformInstanceIdOrNow?: string | number,
    now: number = Date.now(),
    allowLegacyInstance = false,
  ): Promise<SessionMapping | undefined> {
    const platformInstanceId =
      typeof platformInstanceIdOrNow === 'string'
        ? platformInstanceIdOrNow
        : undefined
    const timestamp =
      typeof platformInstanceIdOrNow === 'number'
        ? platformInstanceIdOrNow
        : now
    const settings = this.getSettings()
    const existing = settings.sessionMappings.find(
      (mapping) =>
        mapping.sessionKey === sessionKey &&
        (platformInstanceId === undefined ||
          mapping.platformInstanceId === platformInstanceId ||
          (allowLegacyInstance && mapping.platformInstanceId === undefined)),
    )
    if (!existing || existing.disabled) return undefined

    const updated: SessionMapping = {
      ...existing,
      lastActiveAt: timestamp,
      // Auto-unarchive on any new activity (design doc: "收到新消息时若
      // archivedAt 已设置且 disabled !== true，自动清除 archivedAt 恢复活跃").
      archivedAt: undefined,
    }
    const nextMappings = settings.sessionMappings.map((mapping) =>
      mapping.sessionKey === sessionKey &&
      (platformInstanceId === undefined ||
        mapping.platformInstanceId === platformInstanceId ||
        (allowLegacyInstance && mapping.platformInstanceId === undefined))
        ? updated
        : mapping,
    )
    await this.saveSettings({ ...settings, sessionMappings: nextMappings })
    return updated
  }
}
