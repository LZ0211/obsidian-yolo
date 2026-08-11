import { FileText, Folder, Plus, X } from 'lucide-react'
import { App, TFile, TFolder, Vault } from 'obsidian'
import { useMemo } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { normalizePathSlashes } from '../../../core/paths/normalizePath'
import { type WorkspaceAgentPolicy } from '../../../settings/schema/setting.types'
import { FolderPickerModal } from '../modals/FolderPickerModal'

type AgentWorkspaceScopeEditorProps = {
  app: App
  vault: Vault
  value: WorkspaceAgentPolicy
  onChange: (next: WorkspaceAgentPolicy) => void
}

function getPathKind(vault: Vault, path: string): 'folder' | 'file' {
  const abstract = vault.getAbstractFileByPath(normalizePathSlashes(path))
  if (abstract instanceof TFile) return 'file'
  if (abstract instanceof TFolder) return 'folder'
  return 'folder'
}

export function AgentWorkspaceScopeEditor({
  app,
  vault,
  value,
  onChange,
}: AgentWorkspaceScopeEditorProps) {
  const { t } = useLanguage()
  const rootPath: string = normalizePathSlashes(value.workspaceRoot)
  const hasRoot = rootPath.length > 0

  const readAllowlist: string[] = useMemo(
    () => value.readAllowlist.map((p: string) => normalizePathSlashes(p)),
    [value.readAllowlist],
  )
  const readDenylist: string[] = useMemo(
    () => value.readDenylist.map((p: string) => normalizePathSlashes(p)),
    [value.readDenylist],
  )
  const writeDenylist: string[] = useMemo(
    () => value.writeDenylist.map((p: string) => normalizePathSlashes(p)),
    [value.writeDenylist],
  )

  const setWorkspaceRoot = () => {
    new FolderPickerModal(
      app,
      vault,
      [value.workspaceRoot],
      false,
      (picked) => {
        const newRoot =
          picked === '/' ? '/' : `/${normalizePathSlashes(picked)}`
        const rootChanged = newRoot !== value.workspaceRoot
        onChange({
          ...value,
          workspaceRoot: newRoot,
          ...(rootChanged ? { readDenylist: [], writeDenylist: [] } : {}),
        })
      },
    ).open()
  }

  const addPath = (
    current: string[],
    update: (next: string[]) => void,
    exclude: string[],
    scopeRoot?: string,
  ) => {
    new FolderPickerModal(
      app,
      vault,
      [value.workspaceRoot, ...current, ...exclude],
      true,
      (picked) => {
        const normalizedPicked = normalizePathSlashes(picked)
        if (current.includes(normalizedPicked)) return
        update([...current, normalizedPicked])
      },
      scopeRoot,
    ).open()
  }

  const removePath = (
    current: string[],
    index: number,
    update: (next: string[]) => void,
  ) => {
    const next = current.slice()
    next.splice(index, 1)
    update(next)
  }

  return (
    <div className="yolo-agent-workspace">
      <ScopeGroup
        title={t('settings.agent.workspace.rootTitle', 'Workspace root')}
        description={t(
          'settings.agent.workspace.rootDesc',
          'All relative reads and writes are resolved under this root.',
        )}
        badge="ROOT"
        addLabel={t('settings.agent.workspace.pick', 'Pick')}
        items={[value.workspaceRoot || '/']}
        vault={vault}
        onAdd={setWorkspaceRoot}
        emptyHint="/"
      />

      <ScopeGroup
        title={t(
          'settings.agent.workspace.readExtraTitle',
          'Extra readable paths',
        )}
        description={t(
          'settings.agent.workspace.readExtraDesc',
          'Additional readable paths outside the workspace root.',
        )}
        badge="READ"
        addLabel={t('common.add', 'Add')}
        items={readAllowlist}
        vault={vault}
        onAdd={() =>
          addPath(
            readAllowlist,
            (next) => onChange({ ...value, readAllowlist: next }),
            [...readDenylist, ...writeDenylist],
          )
        }
        onRemove={(index) =>
          removePath(readAllowlist, index, (next) =>
            onChange({ ...value, readAllowlist: next }),
          )
        }
        emptyHint={t(
          'settings.agent.workspace.readExtraEmpty',
          'No extra readable paths.',
        )}
      />

      <ScopeGroup
        title={t('settings.agent.workspace.readExcludeTitle', 'Read deny list')}
        description={t(
          'settings.agent.workspace.readExcludeDesc',
          'Subpaths hidden from reads, search, metadata, and mentions.',
        )}
        badge="DENY READ"
        addLabel={t('common.add', 'Add')}
        items={readDenylist}
        vault={vault}
        disabled={!hasRoot}
        disabledHint={t(
          'settings.agent.workspace.denyDisabledHint',
          'Set a workspace root first to configure deny lists.',
        )}
        onAdd={() =>
          addPath(
            readDenylist,
            (next) => onChange({ ...value, readDenylist: next }),
            [...readAllowlist, ...writeDenylist],
            rootPath,
          )
        }
        onRemove={(index) =>
          removePath(readDenylist, index, (next) =>
            onChange({ ...value, readDenylist: next }),
          )
        }
        emptyHint={t(
          'settings.agent.workspace.readExcludeEmpty',
          'No read exclusions.',
        )}
      />

      <ScopeGroup
        title={t(
          'settings.agent.workspace.writeExcludeTitle',
          'Write deny list',
        )}
        description={t(
          'settings.agent.workspace.writeExcludeDesc',
          'Subpaths where writes, edits, deletes, and moves are blocked.',
        )}
        badge="DENY WRITE"
        addLabel={t('common.add', 'Add')}
        items={writeDenylist}
        vault={vault}
        disabled={!hasRoot}
        disabledHint={t(
          'settings.agent.workspace.denyDisabledHint',
          'Set a workspace root first to configure deny lists.',
        )}
        onAdd={() =>
          addPath(
            writeDenylist,
            (next) => onChange({ ...value, writeDenylist: next }),
            [...readAllowlist, ...readDenylist],
            rootPath,
          )
        }
        onRemove={(index) =>
          removePath(writeDenylist, index, (next) =>
            onChange({ ...value, writeDenylist: next }),
          )
        }
        emptyHint={t(
          'settings.agent.workspace.writeExcludeEmpty',
          'No write exclusions.',
        )}
      />
    </div>
  )
}

type ScopeGroupProps = {
  title: string
  description: string
  badge: string
  addLabel: string
  items: string[]
  vault: Vault
  onAdd: () => void
  onRemove?: (index: number) => void
  emptyHint: string
  disabled?: boolean
  disabledHint?: string
}

function ScopeGroup({
  title,
  description,
  badge,
  addLabel,
  items,
  vault,
  onAdd,
  onRemove,
  emptyHint,
  disabled,
  disabledHint,
}: ScopeGroupProps) {
  return (
    <div
      className={`yolo-agent-workspace-group yolo-agent-workspace-group--include${disabled ? ' is-disabled' : ''}`}
    >
      <div className="yolo-agent-workspace-group-head">
        <span className="yolo-agent-workspace-badge">{badge}</span>
        <div className="yolo-agent-workspace-group-title">{title}</div>
        <div className="yolo-agent-workspace-group-desc">{description}</div>
        {disabled ? (
          disabledHint ? (
            <div className="yolo-agent-workspace-disabled-hint">
              {disabledHint}
            </div>
          ) : null
        ) : (
          <button
            type="button"
            className="yolo-agent-workspace-add"
            onClick={onAdd}
          >
            <Plus size={12} />
            <span>{addLabel}</span>
          </button>
        )}
      </div>
      {items.length === 0 ? (
        <div className="yolo-agent-workspace-empty">{emptyHint}</div>
      ) : (
        <div className="yolo-agent-workspace-rows">
          {items.map((path, index) => {
            const kind = getPathKind(vault, path)
            return (
              <div
                key={`${path}__${index}`}
                className="yolo-agent-workspace-row"
              >
                <span className="yolo-agent-workspace-row-icon">
                  {kind === 'folder' ? (
                    <Folder size={14} />
                  ) : (
                    <FileText size={14} />
                  )}
                </span>
                <span
                  className="yolo-agent-workspace-row-path"
                  title={path || '/'}
                >
                  {path || '/'}
                </span>
                <span className="yolo-agent-workspace-row-kind">{kind}</span>
                {onRemove ? (
                  <button
                    type="button"
                    className="yolo-agent-workspace-row-remove"
                    onClick={() => onRemove(index)}
                    aria-label="remove"
                  >
                    <X size={14} />
                  </button>
                ) : null}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
