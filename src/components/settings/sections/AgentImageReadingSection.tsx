import { useEffect, useMemo, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import { useSettings } from '../../../contexts/settings-context'
import { chatModelSupportsVision } from '../../../utils/llm/model-modalities'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ObsidianToggle } from '../../common/ObsidianToggle'
import { SimpleSelect } from '../../common/SimpleSelect'

const IMAGE_COMPRESSION_QUALITY_MIN = 1
const IMAGE_COMPRESSION_QUALITY_MAX = 100
const IMAGE_COMPRESSION_QUALITY_FALLBACK = 85

export function AgentImageReadingSection() {
  const { settings, setSettings } = useSettings()
  const { t } = useLanguage()

  const isImageReadingEnabled = settings.chatOptions.imageReadingEnabled ?? true

  const isCompressionEnabled =
    settings.chatOptions.imageCompressionEnabled ?? true

  const isExternalFetchEnabled =
    settings.chatOptions.externalImageFetchEnabled ?? false

  const isFallbackEnabled =
    settings.chatOptions.imageReadingFallbackEnabled ?? true

  const fallbackModelIds =
    settings.chatOptions.imageReadingFallbackModelIds ?? []

  const fallbackModelOptionGroups = useMemo(() => {
    const providerOrder = settings.providers.map((provider) => provider.id)
    const visionModels = settings.chatModels.filter(
      (model) => model.enable !== false && chatModelSupportsVision(model),
    )
    const orderedProviderIds = [
      ...providerOrder.filter((id) =>
        visionModels.some((model) => model.providerId === id),
      ),
      ...Array.from(
        new Set(visionModels.map((model) => model.providerId)),
      ).filter((id) => !providerOrder.includes(id)),
    ]
    return orderedProviderIds
      .map((providerId) => {
        const models = visionModels.filter(
          (model) => model.providerId === providerId,
        )
        if (models.length === 0) {
          return null
        }
        return {
          label: providerId,
          options: models.map((model) => ({
            value: model.id,
            label: model.name?.trim()
              ? model.name.trim()
              : model.model || model.id,
          })),
        }
      })
      .filter(
        (
          group,
        ): group is {
          label: string
          options: { value: string; label: string }[]
        } => group !== null,
      )
  }, [settings.chatModels, settings.providers])

  const addFallbackModel = (modelId: string) => {
    if (!modelId || fallbackModelIds.includes(modelId)) return
    updateChatOptions(
      {
        imageReadingFallbackModelIds: [...fallbackModelIds, modelId],
      },
      'imageReadingFallbackModelIds',
    )
  }

  const removeFallbackModel = (modelId: string) => {
    updateChatOptions(
      {
        imageReadingFallbackModelIds: fallbackModelIds.filter(
          (id) => id !== modelId,
        ),
      },
      'imageReadingFallbackModelIds',
    )
  }

  const [qualityInput, setQualityInput] = useState(
    String(
      settings.chatOptions.imageCompressionQuality ??
        IMAGE_COMPRESSION_QUALITY_FALLBACK,
    ),
  )

  useEffect(() => {
    setQualityInput(
      String(
        settings.chatOptions.imageCompressionQuality ??
          IMAGE_COMPRESSION_QUALITY_FALLBACK,
      ),
    )
  }, [settings.chatOptions.imageCompressionQuality])

  const updateChatOptions = (
    patch: Partial<typeof settings.chatOptions>,
    context: string,
  ) => {
    void (async () => {
      try {
        await setSettings({
          ...settings,
          chatOptions: {
            ...settings.chatOptions,
            ...patch,
          },
        })
      } catch (error: unknown) {
        console.error(`Failed to update chat options: ${context}`, error)
      }
    })()
  }

  return (
    <>
      <ObsidianSetting
        name={t('settings.agent.imageReadingEnabled')}
        desc={t('settings.agent.imageReadingEnabledDesc')}
        className="yolo-settings-card"
      >
        <ObsidianToggle
          value={isImageReadingEnabled}
          onChange={(value) => {
            updateChatOptions(
              { imageReadingEnabled: value },
              'imageReadingEnabled',
            )
          }}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.agent.imageReadingFallbackEnabled')}
        desc={t('settings.agent.imageReadingFallbackEnabledDesc')}
        className="yolo-settings-card"
      >
        <ObsidianToggle
          value={isFallbackEnabled}
          onChange={(value) => {
            updateChatOptions(
              { imageReadingFallbackEnabled: value },
              'imageReadingFallbackEnabled',
            )
          }}
        />
      </ObsidianSetting>

      {isFallbackEnabled && (
        <ObsidianSetting
          name={t('settings.agent.imageReadingFallbackModelIds')}
          desc={t('settings.agent.imageReadingFallbackModelIdsDesc')}
          className="yolo-settings-card"
        >
          <div className="yolo-fallback-model-list">
            {fallbackModelIds.map((modelId) => (
              <div key={modelId} className="yolo-fallback-model-chip">
                <span>{modelId}</span>
                <button
                  type="button"
                  className="yolo-fallback-model-remove"
                  onClick={() => removeFallbackModel(modelId)}
                >
                  ×
                </button>
              </div>
            ))}
            <SimpleSelect
              value=""
              groupedOptions={fallbackModelOptionGroups}
              align="end"
              side="bottom"
              sideOffset={6}
              placeholder={t('common.select', 'Select')}
              onChange={(value: string) => addFallbackModel(value)}
            />
          </div>
        </ObsidianSetting>
      )}

      {isImageReadingEnabled && (
        <>
          <ObsidianSetting
            name={t('settings.agent.externalImageFetchEnabled')}
            desc={t('settings.agent.externalImageFetchEnabledDesc')}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={isExternalFetchEnabled}
              onChange={(value) => {
                updateChatOptions(
                  { externalImageFetchEnabled: value },
                  'externalImageFetchEnabled',
                )
              }}
            />
          </ObsidianSetting>

          <ObsidianSetting
            name={t('settings.agent.imageCompressionEnabled')}
            desc={t('settings.agent.imageCompressionEnabledDesc')}
            className="yolo-settings-card"
          >
            <ObsidianToggle
              value={isCompressionEnabled}
              onChange={(value) => {
                updateChatOptions(
                  { imageCompressionEnabled: value },
                  'imageCompressionEnabled',
                )
              }}
            />
          </ObsidianSetting>

          {isCompressionEnabled && (
            <ObsidianSetting
              name={t('settings.agent.imageCompressionQuality')}
              desc={t('settings.agent.imageCompressionQualityDesc')}
              className="yolo-settings-card"
            >
              <ObsidianTextInput
                value={qualityInput}
                type="number"
                onChange={(value) => {
                  setQualityInput(value)
                }}
                onBlur={(value) => {
                  const parsed = Number.parseInt(value, 10)
                  if (Number.isNaN(parsed)) {
                    setQualityInput(
                      String(
                        settings.chatOptions.imageCompressionQuality ??
                          IMAGE_COMPRESSION_QUALITY_FALLBACK,
                      ),
                    )
                    return
                  }
                  const clamped = Math.max(
                    IMAGE_COMPRESSION_QUALITY_MIN,
                    Math.min(IMAGE_COMPRESSION_QUALITY_MAX, parsed),
                  )
                  setQualityInput(String(clamped))
                  if (
                    clamped !== settings.chatOptions.imageCompressionQuality
                  ) {
                    updateChatOptions(
                      { imageCompressionQuality: clamped },
                      'imageCompressionQuality',
                    )
                  }
                }}
              />
            </ObsidianSetting>
          )}
        </>
      )}
    </>
  )
}
