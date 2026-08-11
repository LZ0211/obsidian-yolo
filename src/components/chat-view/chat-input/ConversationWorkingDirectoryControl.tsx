import { FolderClosed, LockKeyhole, X } from 'lucide-react'

import { useLanguage } from '../../../contexts/language-context'

export type ConversationWorkingDirectoryControlProps = {
  value?: string
  displayValue?: string
  locked: boolean
  onChange: (path: string | undefined) => void
  onOpenPicker: () => void
}

export function ConversationWorkingDirectoryControl({
  value,
  displayValue,
  locked,
  onChange,
  onOpenPicker,
}: ConversationWorkingDirectoryControlProps) {
  const { t } = useLanguage()
  const selectLabel = locked
    ? t('chat.workingDirectory.locked', 'Working directory is locked')
    : t('chat.workingDirectory.select', 'Select working directory')
  const clearLabel = t('chat.workingDirectory.clear', 'Clear working directory')

  return (
    <div className="yolo-chat-working-directory-control">
      <button
        type="button"
        className="yolo-chat-user-input-submit-button yolo-chat-working-directory-button"
        aria-label={selectLabel}
        title={selectLabel}
        disabled={locked}
        onClick={onOpenPicker}
      >
        <span className="yolo-chat-user-input-submit-button-icons">
          {locked ? <LockKeyhole size={14} /> : <FolderClosed size={14} />}
        </span>
      </button>
      {displayValue ? (
        <span
          className={`yolo-chat-working-directory-chip${locked ? ' is-locked' : ''}`}
          title={displayValue}
        >
          {locked ? <LockKeyhole size={11} aria-hidden="true" /> : null}
          <span className="yolo-chat-working-directory-path">
            {displayValue}
          </span>
          {!locked && value ? (
            <button
              type="button"
              className="yolo-chat-working-directory-clear"
              aria-label={clearLabel}
              title={clearLabel}
              onClick={() => onChange(undefined)}
            >
              <X size={11} />
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  )
}
