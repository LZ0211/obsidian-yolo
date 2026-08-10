import { X } from 'lucide-react'
import { useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { getEnabledAssistantToolNames } from '../../../core/agent/tool-preferences'
import type { WorkspaceAgentBehaviorOverrides } from '../../../settings/schema/setting.types'
import type {
  Assistant,
  AssistantToolApprovalMode,
  AssistantToolDisclosureMode,
} from '../../../types/assistant.types'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { SimpleSelect } from '../../common/SimpleSelect'

const DISCLOSURE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'always', label: 'Always' },
  { value: 'on_demand', label: 'On demand' },
]

const APPROVAL_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'full_access', label: 'Full access' },
  { value: 'require_approval', label: 'Require approval' },
]

type OverrideDraft = {
  disabledToolNames: string[]
  toolConfigOverrides: Record<
    string,
    {
      approvalMode?: AssistantToolApprovalMode
      disclosureMode?: AssistantToolDisclosureMode
    }
  >
}

const draftFromOverrides = (
  overrides: WorkspaceAgentBehaviorOverrides | undefined,
): OverrideDraft => ({
  disabledToolNames: overrides?.disabledToolNames ?? [],
  toolConfigOverrides: { ...(overrides?.toolConfigOverrides ?? {}) },
})

/**
 * Tool override editor for a workspace agent: each tool inherited from the
 * template can be disabled or hardened (approval mode tightened) relative to
 * the template. Only stricter settings are persisted as overrides.
 */
export function WorkspaceAgentToolOverridesModal({
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
  const templateToolNames = useMemo(
    () => getEnabledAssistantToolNames(template),
    [template],
  )
  const disabledSet = useMemo(
    () => new Set(draft.disabledToolNames),
    [draft.disabledToolNames],
  )

  const setToolDisabled = (toolName: string, disabled: boolean) => {
    setDraft((current) => {
      const nextDisabled = new Set(current.disabledToolNames)
      if (disabled) {
        nextDisabled.add(toolName)
      } else {
        nextDisabled.delete(toolName)
      }
      return { ...current, disabledToolNames: [...nextDisabled] }
    })
  }

  const setToolApprovalMode = (
    toolName: string,
    mode: string | null,
  ) => {
    setDraft((current) => {
      const next = { ...current.toolConfigOverrides }
      const existing = next[toolName]
      if (!mode || mode === 'inherit') {
        if (existing) {
          const { approvalMode: _removed, ...rest } = existing
          if (Object.keys(rest).length > 0) {
            next[toolName] = rest
          } else {
            delete next[toolName]
          }
        }
      } else {
        next[toolName] = {
          ...(existing ?? {}),
          approvalMode: mode as AssistantToolApprovalMode,
        }
      }
      return { ...current, toolConfigOverrides: next }
    })
  }

  const setToolDisclosureMode = (
    toolName: string,
    mode: string | null,
  ) => {
    setDraft((current) => {
      const next = { ...current.toolConfigOverrides }
      const existing = next[toolName]
      if (!mode || mode === 'inherit') {
        if (existing) {
          const { disclosureMode: _removed, ...rest } = existing
          if (Object.keys(rest).length > 0) {
            next[toolName] = rest
          } else {
            delete next[toolName]
          }
        }
      } else {
        next[toolName] = {
          ...(existing ?? {}),
          disclosureMode: mode as AssistantToolDisclosureMode,
        }
      }
      return { ...current, toolConfigOverrides: next }
    })
  }

  const save = () => {
    onChange({
      ...(value ?? {}),
      ...(draft.disabledToolNames.length > 0
        ? { disabledToolNames: draft.disabledToolNames }
        : {}),
      ...(Object.keys(draft.toolConfigOverrides).length > 0
        ? { toolConfigOverrides: draft.toolConfigOverrides }
        : {}),
    })
    onClose()
  }

  return (
    <div className="yolo-workspace-agent-tool-overrides">
      <div className="yolo-workspace-agent-tool-overrides-head">
        <span>
          {t(
            'settings.workspaceAgents.toolOverridesTitle',
            'Tool overrides',
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
      <div className="yolo-workspace-agent-tool-overrides-list">
        {templateToolNames.map((toolName) => (
          <div
            key={toolName}
            className="yolo-workspace-agent-tool-override-row"
          >
            <span className="yolo-workspace-agent-tool-override-name">
              {toolName}
            </span>
            <SimpleSelect
              value={
                draft.toolConfigOverrides[toolName]?.approvalMode ??
                'inherit'
              }
              options={APPROVAL_OPTIONS}
              onChange={(mode) => setToolApprovalMode(toolName, mode)}
              placeholder={t('settings.workspaceAgents.toolApprovalMode', 'Approval mode')}
            />
            <SimpleSelect
              value={
                draft.toolConfigOverrides[toolName]?.disclosureMode ??
                'inherit'
              }
              options={DISCLOSURE_OPTIONS}
              onChange={(mode) => setToolDisclosureMode(toolName, mode)}
              placeholder={t(
                'settings.workspaceAgents.toolDisclosureMode',
                'Disclosure mode',
              )}
            />
            <ObsidianToggle
              value={!disabledSet.has(toolName)}
              onChange={(enabled) => setToolDisabled(toolName, !enabled)}
            />
          </div>
        ))}
      </div>
      <div className="yolo-workspace-agent-tool-overrides-actions">
        <button type="button" className="mod-cta" onClick={save}>
          {t('common.save', 'Save')}
        </button>
      </div>
    </div>
  )
}
