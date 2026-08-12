import type { App } from 'obsidian'

import type { YoloSettings } from '../../settings/schema/setting.types'
import { findUnifiedAgentById } from '../agent/workspaceAgentResolver'
import { type LiteSkillEntry, listLiteSkillEntries } from '../skills/liteSkills'
import { isSkillEnabledForAssistant } from '../skills/skillPolicy'

import type { CliAssistantBinding } from './types'

type ListSkillEntries = (
  app: App,
  options: { settings: YoloSettings },
) => Promise<LiteSkillEntry[]>

export type ResolveCliAssistantBindingInput = {
  app: App
  settings: YoloSettings
  assistantId: string
  listSkillEntries?: ListSkillEntries
}

/**
 * Resolve the exact session-level persona and skill set used by CLI agents.
 *
 * fork 适配：assistant 查找走 `findUnifiedAgentById`（unified agent 列表 =
 * settings.assistants 模板 + workspaceAgents 解析结果），而非 backup 的
 * `settings.assistants.find(...)`——语义等价，但覆盖 workspace agent。
 */
export const resolveCliAssistantBinding = async ({
  app,
  settings,
  assistantId,
  listSkillEntries = listLiteSkillEntries,
}: ResolveCliAssistantBindingInput): Promise<CliAssistantBinding> => {
  const assistant = findUnifiedAgentById(settings, assistantId)
  if (!assistant) {
    throw new Error(`Assistant is unavailable: ${assistantId}`)
  }

  const disabledSkillNames = settings.skills?.disabledSkillIds ?? []
  const enabledSkillNames = (await listSkillEntries(app, { settings }))
    .filter((skill) =>
      isSkillEnabledForAssistant({
        assistant,
        skillName: skill.name,
        disabledSkillNames,
        defaultLoadMode: skill.mode,
      }),
    )
    .map((skill) => skill.name)
    .sort((left, right) => left.localeCompare(right))

  return {
    assistantId: assistant.id,
    systemPrompt: assistant.systemPrompt,
    enabledSkillNames,
  }
}
