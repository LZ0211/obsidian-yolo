import { App, Notice, requestUrl } from 'obsidian'
import React, { useEffect, useState } from 'react'

import { useLanguage } from '../../../contexts/language-context'
import YoloPlugin from '../../../main'
import { LLMProvider } from '../../../types/provider.types'
import {
  RerankModel,
  rerankModelSchema,
} from '../../../types/rerank-model.types'
import { resolveProviderBaseUrl } from '../../../utils/llm/provider-base-url'
import { providerSupportsRerank } from '../../../utils/llm/provider-config'
import { toProviderHeadersRecord } from '../../../utils/llm/provider-headers'
import { ensureUniqueModelId } from '../../../utils/model-id-utils'
import { ObsidianButton } from '../../common/ObsidianButton'
import { ObsidianSetting } from '../../common/ObsidianSetting'
import { ObsidianTextInput } from '../../common/ObsidianTextInput'
import { ReactModal } from '../../common/ReactModal'
import { SearchableDropdown } from '../../common/SearchableDropdown'

import { parseOptionalRerankLimit } from './rerankModelLimits'

type AddRerankModelModalComponentProps = {
  plugin: YoloPlugin
  provider?: LLMProvider
}

const MODEL_IDENTIFIER_KEYS = ['id', 'name', 'model'] as const

const extractModelIdentifier = (value: unknown): string | null => {
  if (typeof value === 'string') {
    return value
  }
  if (!value || typeof value !== 'object') {
    return null
  }
  const record = value as Record<string, unknown>
  for (const key of MODEL_IDENTIFIER_KEYS) {
    const candidate = record[key]
    if (typeof candidate === 'string' && candidate.length > 0) {
      return candidate
    }
  }
  return null
}

const collectModelIdentifiers = (values: unknown[]): string[] =>
  values
    .map((entry) => extractModelIdentifier(entry))
    .filter((id): id is string => Boolean(id))

const sortModelsForRerank = (models: string[]): string[] => {
  const rerankKeywords = ['rerank', 'reranker']
  const rerankModels: string[] = []
  const otherModels: string[] = []

  models.forEach((model) => {
    const modelLower = model.toLowerCase()
    if (rerankKeywords.some((keyword) => modelLower.includes(keyword))) {
      rerankModels.push(model)
      return
    }
    otherModels.push(model)
  })

  return [...rerankModels.sort(), ...otherModels.sort()]
}

export class AddRerankModelModal extends ReactModal<AddRerankModelModalComponentProps> {
  constructor(app: App, plugin: YoloPlugin, provider?: LLMProvider) {
    super({
      app: app,
      Component: AddRerankModelModalComponent,
      props: { plugin, provider },
      options: {
        title: plugin.t('settings.models.addRerankModel', 'Add rerank model'),
      },
      plugin: plugin,
    })
  }
}

function AddRerankModelModalComponent({
  plugin,
  onClose,
  provider: initialProvider,
}: AddRerankModelModalComponentProps & { onClose: () => void }) {
  const { t } = useLanguage()
  const settings = plugin.settings

  const selectedProvider: LLMProvider | undefined =
    initialProvider ?? settings.providers.find((p) => providerSupportsRerank(p))

  const [modelName, setModelName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [maxDocuments, setMaxDocuments] = useState('')
  const [maxInputChars, setMaxInputChars] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const [availableModels, setAvailableModels] = useState<string[]>([])
  const [loadingModels, setLoadingModels] = useState<boolean>(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    const modalEl = document.querySelector('.modal .modal-title')
    if (modalEl) {
      modalEl.textContent =
        t('settings.models.addRerankModel') ?? 'Add rerank model'
    }
  }, [t])

  useEffect(() => {
    const fetchModels = async () => {
      if (!selectedProvider || !providerSupportsRerank(selectedProvider)) {
        setAvailableModels([])
        setLoadingModels(false)
        return
      }

      const cachedModels = plugin.getCachedModelList(
        selectedProvider.id,
        'rerank',
      )
      if (cachedModels) {
        setAvailableModels(sortModelsForRerank(cachedModels))
        setLoadingModels(false)
        return
      }

      setLoadingModels(true)
      setLoadError(null)
      try {
        const providerHeaders = toProviderHeadersRecord(
          selectedProvider.customHeaders,
        )
        const base = resolveProviderBaseUrl(selectedProvider) ?? ''
        if (!base) {
          throw new Error('Provider base URL is not configured')
        }

        const baseNorm = base.replace(/\/+$/, '')
        const urlCandidates = baseNorm.endsWith('/v1')
          ? [`${baseNorm}/models`, `${baseNorm.replace(/\/v1$/, '')}/models`]
          : [`${baseNorm}/v1/models`, `${baseNorm}/models`]

        let fetched = false
        let lastErr: unknown = null
        for (const url of urlCandidates) {
          try {
            const response = await requestUrl({
              url,
              method: 'GET',
              headers: {
                ...(selectedProvider.apiKey
                  ? { Authorization: `Bearer ${selectedProvider.apiKey}` }
                  : {}),
                Accept: 'application/json',
                ...(providerHeaders ?? {}),
              },
            })
            if (response.status < 200 || response.status >= 300) {
              lastErr = new Error(`Failed to fetch models: ${response.status}`)
              continue
            }
            const json = response.json ?? JSON.parse(response.text)
            const buckets: string[] = []
            if (Array.isArray(json?.data))
              buckets.push(...collectModelIdentifiers(json.data))
            if (Array.isArray(json?.models))
              buckets.push(...collectModelIdentifiers(json.models))
            if (Array.isArray(json))
              buckets.push(...collectModelIdentifiers(json))

            if (buckets.length === 0) {
              lastErr = new Error('Empty models list in response')
              continue
            }
            const unique = Array.from(new Set(buckets))
            setAvailableModels(sortModelsForRerank(unique))
            plugin.setCachedModelList(selectedProvider.id, unique, 'rerank')
            fetched = true
            break
          } catch (error) {
            lastErr = error
            continue
          }
        }
        if (fetched) return
        if (lastErr instanceof Error) {
          throw lastErr
        }
        throw new Error('Failed to fetch models from all endpoints')
      } catch (err: unknown) {
        console.error('Failed to auto fetch rerank models', err)
        const errorMessage =
          err instanceof Error ? err.message : 'unknown error'
        setLoadError(errorMessage)
      } finally {
        setLoadingModels(false)
      }
    }

    void fetchModels()
  }, [plugin, selectedProvider])

  if (!selectedProvider || !providerSupportsRerank(selectedProvider)) {
    return (
      <div className="yolo-no-models" style={{ padding: '1rem 0' }}>
        {t(
          'settings.models.noRerankProvider',
          t('settings.models.noRerankProvider', 'No providers support rerank. Please configure an OpenAI-compatible provider (e.g. SiliconFlow, OpenRouter) first.'),
        )}
      </div>
    )
  }

  const handleSubmit = () => {
    if (!modelName.trim()) {
      new Notice(t('common.error'))
      return
    }

    void (async () => {
      setIsSubmitting(true)
      try {
        const model = modelName.trim()
        const parsedMaxDocuments = parseOptionalRerankLimit(
          maxDocuments,
          'Maximum documents',
        )
        const parsedMaxInputChars = parseOptionalRerankLimit(
          maxInputChars,
          'Maximum input characters',
        )
        const baseInternalId = `${selectedProvider.id}/${model}`
        const existingIds = settings.rerankModels.map((m) => m.id)
        const internalId = ensureUniqueModelId(existingIds, baseInternalId)

        const rerankModel: RerankModel = {
          providerId: selectedProvider.id,
          id: internalId,
          model,
          name:
            displayName && displayName.trim().length > 0
              ? displayName.trim()
              : undefined,
          maxDocuments: parsedMaxDocuments,
          maxInputChars: parsedMaxInputChars,
        }

        const parsed = rerankModelSchema.safeParse(rerankModel)
        if (!parsed.success) {
          new Notice(parsed.error.errors[0]?.message ?? 'Invalid model data')
          return
        }

        await plugin.setSettings({
          ...settings,
          rerankModels: [...settings.rerankModels, parsed.data],
        })
        new Notice(t('common.success'))
        onClose()
      } catch (error) {
        console.error('Failed to add rerank model:', error)
        new Notice(error instanceof Error ? error.message : t('common.error'))
      } finally {
        setIsSubmitting(false)
      }
    })()
  }

  return (
    <>
      <ObsidianSetting
        name={
          loadingModels
            ? t('common.loading')
            : t('settings.models.availableModelsAuto')
        }
        desc={
          loadError
            ? `${t('settings.models.fetchModelsFailed')}：${loadError}`
            : t('settings.models.rerankModelsFirst')
        }
      >
        <SearchableDropdown
          value={modelName}
          options={availableModels}
          onChange={(value: string) => {
            setModelName(value)
            setDisplayName(value)
          }}
          disabled={
            isSubmitting || loadingModels || availableModels.length === 0
          }
          loading={loadingModels}
          placeholder={t('settings.models.searchModels') || 'Search models...'}
        />
      </ObsidianSetting>

      <ObsidianSetting name={t('settings.models.modelName')}>
        <ObsidianTextInput
          value={displayName}
          placeholder={t('settings.models.modelNamePlaceholder')}
          onChange={(value) => setDisplayName(value)}
        />
      </ObsidianSetting>

      <ObsidianSetting
        name={t('settings.models.modelId')}
        desc={t(
          'settings.models.rerankModelIdDesc',
          'Model name for rerank API calls, e.g. BAAI/bge-reranker-v2-m3',
        )}
        required
      >
        <ObsidianTextInput
          value={modelName}
          placeholder="BAAI/bge-reranker-v2-m3"
          onChange={(value) => setModelName(value)}
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
          value={maxDocuments}
          onChange={setMaxDocuments}
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
          value={maxInputChars}
          onChange={setMaxInputChars}
        />
      </ObsidianSetting>

      <ObsidianSetting>
        <ObsidianButton
          text={isSubmitting ? t('common.submitting') : t('common.add')}
          onClick={handleSubmit}
          cta
          disabled={isSubmitting || !modelName.trim()}
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
