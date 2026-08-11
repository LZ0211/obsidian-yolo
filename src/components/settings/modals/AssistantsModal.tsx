import { App } from 'obsidian'
import React from 'react'

import { SettingsProvider } from '../../../contexts/settings-context'
import YoloPlugin from '../../../main'
import { ReactModal } from '../../common/ReactModal'
import { AgentsSectionContent } from '../sections/AgentsSectionContent'

type AssistantsModalComponentProps = {
  app: App
  plugin: YoloPlugin
  initialAssistantId?: string
  initialCreate?: boolean
  workspaceAgentId?: string
  workspaceAgentTemplateId?: string
  workspaceAgentName?: string
  workspaceRoot?: string
}

export class AssistantsModal extends ReactModal<AssistantsModalComponentProps> {
  constructor(
    app: App,
    plugin: YoloPlugin,
    initialAssistantId?: string,
    initialCreate?: boolean,
    workspaceAgentOptions?: {
      workspaceAgentId?: string
      workspaceAgentTemplateId?: string
      workspaceAgentName?: string
      workspaceRoot?: string
    },
  ) {
    super({
      app: app,
      Component: AssistantsModalComponentWrapper,
      props: {
        app,
        plugin,
        initialAssistantId,
        initialCreate,
        ...workspaceAgentOptions,
      },
      options: {
        title:
          initialAssistantId || initialCreate || workspaceAgentOptions
            ? undefined
            : plugin.t('settings.assistants.title', 'Agent Templates'),
      },
      plugin: plugin,
    })
    this.modalEl.classList.add('yolo-modal--wide')
    if (initialAssistantId || initialCreate || workspaceAgentOptions) {
      this.modalEl.classList.add('yolo-modal--agent-direct-edit')
    }
  }
}

function AssistantsModalComponentWrapper({
  app,
  plugin,
  initialAssistantId,
  initialCreate,
  workspaceAgentId,
  workspaceAgentTemplateId,
  workspaceAgentName,
  workspaceRoot,
  onClose,
}: AssistantsModalComponentProps & { onClose: () => void }) {
  return (
    <SettingsProvider
      settings={plugin.settings}
      setSettings={(newSettings) => plugin.setSettings(newSettings)}
      addSettingsChangeListener={(listener) =>
        plugin.addSettingsChangeListener(listener)
      }
    >
      <AgentsSectionContent
        app={app}
        onClose={onClose}
        initialAssistantId={initialAssistantId}
        initialCreate={initialCreate}
        workspaceAgentId={workspaceAgentId}
        workspaceAgentTemplateId={workspaceAgentTemplateId}
        workspaceAgentName={workspaceAgentName}
        workspaceRoot={workspaceRoot}
      />
    </SettingsProvider>
  )
}
