import { useSyncExternalStore } from 'react'

import { createWorkflowEditorModel } from './ui/workflow-editor-model'
import { WorkflowStudio } from './ui/workflow-studio'
import { createWorkflowRepository } from './domain/workflow-repository'
import { createWorkflowChatTools } from './domain/workflow-tools'
import { createWorkflowCopy, createWorkflowLocalizedText } from './i18n'

const MODULE_ID = 'workflow'
const VIEW_TYPE = 'yolo-workflow-view'

yolo.registerModule({
  id: MODULE_ID,
  activate(host) {
    const repository = createWorkflowRepository(host)
    const getCopy = () => createWorkflowCopy(host.i18n.getSnapshot().locale)
    const editors = new Map<
      string,
      ReturnType<typeof createWorkflowEditorModel>
    >()
    const getEditor = (context: YoloModuleHostViewContextV1) => {
      const existing = editors.get(context.id)
      if (existing) return existing
      const editor = createWorkflowEditorModel(repository, getCopy)
      editors.set(context.id, editor)
      context.lifecycle.add(() => {
        editor.dispose()
        editors.delete(context.id)
      })
      return editor
    }
    const tools = createWorkflowChatTools(repository, getCopy)
    const openView = (): Promise<void> => host.workspace.openView()

    host.workspace.registerView({
      type: VIEW_TYPE,
      name: createWorkflowLocalizedText('module.name'),
      icon: 'git-branch',
      render: (context) => (
        <WorkflowModuleView
          editor={getEditor(context)}
          getCopy={getCopy}
          getLocaleSnapshot={host.i18n.getSnapshot}
          subscribeLocale={host.i18n.subscribe}
          openFile={async (path) => {
            await host.ui.openFileAt({ path })
          }}
          notice={host.ui.notice}
          confirm={host.ui.confirm}
        />
      ),
      getState: (context) => ({ path: getEditor(context).getSnapshot().path }),
      setState: async (state, context) => {
        if (typeof state.path === 'string')
          await getEditor(context).load(state.path)
      },
    })
    host.workspace.registerRibbonAction({
      icon: 'git-branch',
      title: createWorkflowLocalizedText('module.open'),
      onClick: () => {
        void openView().catch((error: unknown) => {
          host.ui.notice(error instanceof Error ? error.message : String(error))
        })
      },
    })
    host.workspace.registerCommand({
      id: 'open-workflow-studio',
      name: createWorkflowLocalizedText('module.open'),
      callback: openView,
    })
    host.chat.registerMode({
      id: 'workflow',
      label: createWorkflowLocalizedText('module.name'),
      description: createWorkflowLocalizedText('mode.description'),
      icon: 'workflow',
      personaPrompt: getCopy().mode.persona,
      capability: 'none',
      skills: ['skills/workflow/SKILL.md'],
      tools: [tools.read, tools.create],
    })
  },
})

function WorkflowModuleView({
  editor,
  getCopy,
  getLocaleSnapshot,
  subscribeLocale,
  openFile,
  notice,
  confirm,
}: Readonly<{
  editor: ReturnType<typeof createWorkflowEditorModel>
  getCopy(): ReturnType<typeof createWorkflowCopy>
  getLocaleSnapshot(): Readonly<{ locale: string }>
  subscribeLocale(listener: () => void): () => void
  openFile(path: string): void | Promise<void>
  notice(message: string): void
  confirm(
    options: Readonly<{
      title: string
      message: string
      ctaText?: string
      cancelText?: string
    }>,
  ): Promise<boolean>
}>) {
  useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot)
  return (
    <div className="yolo-workflow-module-root">
      <WorkflowStudio
        model={editor}
        copy={getCopy()}
        openFile={openFile}
        notice={notice}
        confirm={confirm}
      />
    </div>
  )
}
