import { ChevronDown, ChevronUp } from 'lucide-react'
import { TFile } from 'obsidian'
import { memo, useCallback, useState } from 'react'

import { useApp } from '../../contexts/app-context'
import { useLanguage } from '../../contexts/language-context'
import type { AgentFileChange, AgentFileChangeKind } from '../../types/chat'

const FALLBACK_KIND_LABELS: Record<AgentFileChangeKind, string> = {
  created: 'Created',
  modified: 'Modified',
  deleted: 'Deleted',
  renamed: 'Renamed',
}

const KIND_TRANSLATION_KEYS: Record<AgentFileChangeKind, string> = {
  created: 'chat.fileChangeCreated',
  modified: 'chat.fileChangeModified',
  deleted: 'chat.fileChangeDeleted',
  renamed: 'chat.fileChangeRenamed',
}

const AssistantMessageFileChanges = memo(function AssistantMessageFileChanges({
  fileChanges,
}: {
  fileChanges: AgentFileChange[]
}) {
  const app = useApp()
  const { t } = useLanguage()
  const [isExpanded, setIsExpanded] = useState(false)

  const handleToggle = useCallback(() => {
    setIsExpanded((previous) => !previous)
  }, [])

  const openFile = useCallback(
    async (path: string) => {
      const file = app.vault.getAbstractFileByPath(path)
      if (file instanceof TFile) {
        await app.workspace.getLeaf('tab').openFile(file)
      }
    },
    [app],
  )

  if (fileChanges.length === 0) return null

  const label = t('chat.fileChanges', 'Workspace changes ({count})').replace(
    '{count}',
    String(fileChanges.length),
  )

  return (
    <div
      className={`yolo-assistant-message-metadata${
        isExpanded ? ' is-expanded' : ''
      }`}
    >
      <button
        type="button"
        className="yolo-assistant-message-metadata-toggle"
        onClick={handleToggle}
      >
        <span>{label}</span>
        {isExpanded ? (
          <ChevronUp className="yolo-assistant-message-metadata-toggle-icon" />
        ) : (
          <ChevronDown className="yolo-assistant-message-metadata-toggle-icon" />
        )}
      </button>
      {isExpanded && (
        <div className="yolo-assistant-message-metadata-content">
          <div className="yolo-assistant-message-metadata-annotations">
            {fileChanges.map((change) => {
              const kindLabel = t(
                KIND_TRANSLATION_KEYS[change.kind],
                FALLBACK_KIND_LABELS[change.kind],
              )
              return (
                <div
                  key={`${change.kind}:${change.oldPath ?? ''}:${change.path}`}
                >
                  <span className="yolo-url-citation-text">
                    {kindLabel} ·{' '}
                    {change.kind === 'deleted' ? (
                      change.path
                    ) : (
                      <a
                        href="#"
                        onClick={(event) => {
                          event.preventDefault()
                          void openFile(change.path)
                        }}
                      >
                        {change.kind === 'renamed' && change.oldPath
                          ? `${change.oldPath} → ${change.path}`
                          : change.path}
                      </a>
                    )}
                    {change.gitDiff && (
                      <span className="yolo-agent-edit-summary-deltas">
                        {change.gitDiff.binary ? (
                          <span className="yolo-agent-edit-summary-neutral">
                            {t('chat.fileChangeBinary', 'Binary')}
                          </span>
                        ) : (
                          <>
                            <span className="yolo-agent-edit-summary-added">
                              +{change.gitDiff.additions}
                            </span>
                            <span className="yolo-agent-edit-summary-removed">
                              −{change.gitDiff.deletions}
                            </span>
                          </>
                        )}
                      </span>
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
})

export default AssistantMessageFileChanges
