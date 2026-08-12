import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import type { Assistant } from '../../types/assistant.types'

import { listLiteSkillEntries } from './liteSkills'
import { isSkillEnabledForAssistant } from './skillPolicy'

export async function resolveAssistantSkillPaths({
  app,
  settings,
  assistant,
}: {
  app: App
  settings: YoloSettings
  assistant: Assistant | null
}): Promise<string[]> {
  if (!assistant) {
    return []
  }

  const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
  const entries = await listLiteSkillEntries(app, { settings })

  return entries
    .filter((entry) =>
      isSkillEnabledForAssistant({
        assistant,
        skillName: entry.name,
        disabledSkillNames,
        defaultLoadMode: entry.mode,
      }),
    )
    .map((entry) => entry.path)
}
