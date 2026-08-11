import { App, Notice } from 'obsidian'
import React, { useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import YoloPlugin from '../../../main'
import {
  RerankModel,
  rerankModelSchema,
} from '../../../types/rerank-model.types'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'

import { parseOptionalRerankLimit } from './rerankModelLimits'

type EditRerankModelModalComponentProps = {
  plugin: YoloPlugin
  model: RerankModel
}

export class EditRerankModelModal extends ReactModal<EditRerankModelModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin, model: RerankModel) {
    super({
      app: app,
      Component: EditRerankModelModalComponent,
      props: { plugin, model },
      options: {
        title: plugin.t('settings.models.editRerankModel', 'Edit rerank model'),
      },
      plugin: plugin,
    })
  }
}

function EditRerankModelModalComponent({
  plugin,
  onClose,
  model,
}: EditRerankModelModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()

  React.useEffect(() => {
    const modalEl = document.querySelector('.modal .modal-title')
    if (modalEl) {
      modalEl.textContent = t('settings.models.editRerankModel')
    }
  }, [t])

  const [formData, setFormData] = useState<{
    model: string
    name: string | undefined
    maxDocuments: string
    maxInputChars: string
  }>({
    model: model.model,
    name: model.name,
    maxDocuments: model.maxDocuments?.toString() ?? '',
    maxInputChars: model.maxInputChars?.toString() ?? '',
  })

  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleSubmit = () => {
    if (!formData.model.trim()) {
      new Notice(t('common.error'))
      return
    }

    void (async () => {
      setIsSubmitting(true)
      try {
        const settings = plugin.settings
        const rerankModels = [...settings.rerankModels]
        const modelIndex = rerankModels.findIndex((m) => m.id === model.id)

        if (modelIndex === -1) {
          new Notice(t('settings.models.modelNotFound', 'Model not found'))
          return
        }

        const nextModel = {
          ...rerankModels[modelIndex],
          model: formData.model.trim(),
          name:
            formData.name && formData.name.trim().length > 0
              ? formData.name
              : undefined,
          maxDocuments: parseOptionalRerankLimit(
            formData.maxDocuments,
            'Maximum documents',
          ),
          maxInputChars: parseOptionalRerankLimit(
            formData.maxInputChars,
            'Maximum input characters',
          ),
        }
        const parsed = rerankModelSchema.safeParse(nextModel)
        if (!parsed.success) {
          new Notice(parsed.error.errors[0]?.message ?? t('settings.models.invalidModelData', 'Invalid model data'))
          return
        }
        rerankModels[modelIndex] = parsed.data

        await plugin.setSettings({
          ...settings,
          rerankModels,
        })

        new Notice(t('common.success'))
        onClose()
      } catch (error) {
        console.error('Failed to update rerank model:', error)
        new Notice(error instanceof Error ? error.message : t('common.error'))
      } finally {
        setIsSubmitting(false)
      }
    })()
  }

  return (
    <>
      <ObsidianSetting name={t('settings.models.modelName')}>
        <ObsidianTextInput
          value={formData.name ?? ''}
          placeholder={t('settings.models.modelNamePlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, name: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.models.modelId')}
        desc={t('settings.models.modelIdDesc')}
        required
      >
        <ObsidianTextInput
          value={formData.model}
          placeholder={t('settings.models.modelIdPlaceholder')}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, model: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.models.rerankMaxDocuments', 'Maximum documents')}
        desc={t(
          'settings.models.rerankMaxDocumentsDesc',
          'Leave blank when unknown',
        )}
      >
        <ObsidianTextInput
          type="number"
          inputMode="numeric"
          value={formData.maxDocuments}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, maxDocuments: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t(
          'settings.models.rerankMaxInputChars',
          'Maximum input characters',
        )}
        desc={t(
          'settings.models.rerankMaxInputCharsDesc',
          'Leave blank when unknown',
        )}
      >
        <ObsidianTextInput
          type="number"
          inputMode="numeric"
          value={formData.maxInputChars}
          onChange={(value: string) =>
            setFormData((prev) => ({ ...prev, maxInputChars: value }))
          }
        />
      </ObsidianSetting>

      <ObsidianSetting>
        <ObsidianButton
          text={isSubmitting ? t('common.submitting') : t('common.save')}
          onClick={handleSubmit}
          cta
          disabled={isSubmitting}
        />
        <ObsidianButton
          text={t('common.cancel')}
          onClick={onClose}
          disabled={isSubmitting}
        />
      </ObsidianSetting>
    </>
  )
}
