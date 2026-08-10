import { X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import type { WorkspaceAgentBehaviorOverrides } from '../../../settings/schema/setting.types'
import type {
  Assistant,
  AssistantSkillLoadMode,
} from '../../../types/assistant.types'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { SimpleSelect } from '../../common/SimpleSelect'

const LOAD_MODE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'always', label: 'Always' },
  { value: 'lazy', label: 'Lazy' },
]

type OverrideDraft = {
  disabledSkillIds: string[]
  skillConfigOverrides: Record<string, { loadMode?: AssistantSkillLoadMode }>
}

const draftFromOverrides = (
  overrides: WorkspaceAgentBehaviorOverrides | undefined,
): OverrideDraft => ({
  disabledSkillIds: overrides?.disabledSkillIds ?? [],
  skillConfigOverrides: { ...(overrides?.skillConfigOverrides ?? {}) },
})

/**
 * Skill override editor for a workspace agent: each skill inherited from the
 * template can be disabled or its load mode overridden.
 */
export function WorkspaceAgentSkillOverridesModal({
  template,
  value,
  onChange,
  onClose,
}: {
  template: Assistant
  value: WorkspaceAgentBehaviorOverrides | undefined
  onChange: (next: WorkspaceAgentBehaviorOverrides) => void
  onClose: () => void
}) {
  const { t } = useLanguage()
  const [draft, setDraft] = useState<OverrideDraft>(() =>
    draftFromOverrides(value),
  )
  const templateSkillNames = useMemo(
    () => template.enabledSkills ?? [],
    [template.enabledSkills],
  )
  const disabledSet = useMemo(
    () => new Set(draft.disabledSkillIds),
    [draft.disabledSkillIds],
  )

  const setSkillDisabled = (skillName: string, disabled: boolean) => {
    setDraft((current) => {
      const nextDisabled = new Set(current.disabledSkillIds)
      if (disabled) {
        nextDisabled.add(skillName)
      } else {
        nextDisabled.delete(skillName)
      }
      return { ...current, disabledSkillIds: [...nextDisabled] }
    })
  }

  const setSkillLoadMode = (skillName: string, mode: string | null) => {
    setDraft((current) => {
      const next = { ...current.skillConfigOverrides }
      if (!mode || mode === 'inherit') {
        delete next[skillName]
      } else {
        next[skillName] = { loadMode: mode as AssistantSkillLoadMode }
      }
      return { ...current, skillConfigOverrides: next }
    })
  }

  const save = () => {
    onChange({
      ...(value ?? {}),
      ...(draft.disabledSkillIds.length > 0
        ? { disabledSkillIds: draft.disabledSkillIds }
        : {}),
      ...(Object.keys(draft.skillConfigOverrides).length > 0
        ? { skillConfigOverrides: draft.skillConfigOverrides }
        : {}),
    })
    onClose()
  }

  return (
    <div className="yolo-workspace-agent-skill-overrides">
      <div className="yolo-workspace-agent-skill-overrides-head">
        <span>
          {t(
            'settings.workspaceAgents.skillOverridesTitle',
            'Skill overrides',
          )}
        </span>
        <button
          type="button"
          className="clickable-icon"
          onClick={onClose}
          aria-label={t('common.close', 'Close')}
        >
          <X size={14} />
        </button>
      </div>
      <div className="yolo-workspace-agent-skill-overrides-list">
        {templateSkillNames.map((skillName) => (
          <div
            key={skillName}
            className="yolo-workspace-agent-skill-override-row"
          >
            <span className="yolo-workspace-agent-skill-override-name">
              {skillName}
            </span>
            <SimpleSelect
              value={
                draft.skillConfigOverrides[skillName]?.loadMode ?? 'inherit'
              }
              options={LOAD_MODE_OPTIONS}
              onChange={(mode) => setSkillLoadMode(skillName, mode)}
              placeholder={t(
                'settings.workspaceAgents.skillLoadMode',
                'Load mode',
              )}
            />
            <ObsidianToggle
              value={!disabledSet.has(skillName)}
              onChange={(enabled) => setSkillDisabled(skillName, !enabled)}
            />
          </div>
        ))}
      </div>
      <div className="yolo-workspace-agent-skill-overrides-actions">
        <button type="button" className="mod-cta" onClick={save}>
          {t('common.save', 'Save')}
        </button>
      </div>
    </div>
  )
}
