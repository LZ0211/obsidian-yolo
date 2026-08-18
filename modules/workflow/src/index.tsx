import { useEffect, useState, useSyncExternalStore } from 'react'

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
    const readStyle = (): Promise<string> => host.assets.readText('style.css')

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
          agent={host.agent}
          getModelSnapshot={host.settings.getModelSnapshot}
          subscribeModels={host.settings.subscribeModels}
          readStyle={readStyle}
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
      capability: 'vault-write',
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
  agent,
  getModelSnapshot,
  subscribeModels,
  readStyle,
  openFile,
  notice,
  confirm,
}: Readonly<{
  editor: ReturnType<typeof createWorkflowEditorModel>
  getCopy(): ReturnType<typeof createWorkflowCopy>
  getLocaleSnapshot(): Readonly<{ locale: string }>
  subscribeLocale(listener: () => void): () => void
  agent: YoloModuleHostApiV1['agent']
  getModelSnapshot(): YoloModuleHostModelSnapshotV1
  subscribeModels(listener: () => void): () => void
  readStyle(): Promise<string>
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
  const [styleText, setStyleText] = useState('')
  useSyncExternalStore(subscribeLocale, getLocaleSnapshot, getLocaleSnapshot)
  const models = useSyncExternalStore(
    subscribeModels,
    getModelSnapshot,
    getModelSnapshot,
  )
  useEffect(() => {
    let active = true
    void readStyle()
      .then((css) => {
        if (active) setStyleText(css)
      })
      .catch((error: unknown) => {
        if (active) console.error('Workflow module style failed to load', error)
      })
    return () => {
      active = false
    }
  }, [readStyle])
  return (
    <div className="yolo-workflow-module-root">
      {styleText ? (
        <style data-yolo-workflow-style="true">{styleText}</style>
      ) : null}
      <WorkflowStudio
        model={editor}
        copy={getCopy()}
        openFile={openFile}
        notice={notice}
        confirm={confirm}
        agent={agent}
        models={models}
      />
    </div>
  )
}
