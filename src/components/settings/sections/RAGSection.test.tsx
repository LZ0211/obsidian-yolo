import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const mockUseSettings = jest.fn()
const mockUseLanguage = jest.fn()
const mockObsidianSetting = jest.fn()
const mockObsidianDropdown = jest.fn()
const mockObsidianToggle = jest.fn()
const mockObsidianButton = jest.fn()

// Mutable holder so tests can flip the platform: the RAG log ribbon toggle
// must be hidden on mobile (the ribbon itself only exists on desktop).
const mockPlatform = { isDesktop: true }
jest.mock('obsidian', () => ({
  Notice: jest.fn(),
  Platform: mockPlatform,
}))

jest.mock('../../../contexts/settings-context', () => ({
  useSettings: () => mockUseSettings(),
}))

jest.mock('../../../contexts/language-context', () => ({
  useLanguage: () => mockUseLanguage(),
}))

jest.mock('../../../constants', () => ({
  RECOMMENDED_MODELS_FOR_EMBEDDING: [],
}))

jest.mock('../../../core/paths/yoloPaths', () => ({
  getYoloBaseDir: () => 'YOLO',
}))

jest.mock('../../../utils/glob-utils', () => ({
  findFilesMatchingPatterns: jest.fn(),
}))

jest.mock('../../../utils/rag-utils', () => ({
  folderPathsToIncludePatterns: (value: string[]) => value,
  includePatternsToFolderPaths: (value: string[]) => value,
}))

jest.mock('../../chat-view/QueryProgress', () => ({
  IndexProgress: () => null,
}))

jest.mock('../../common/ObsidianButton', () => ({
  ObsidianButton: (props: { text?: string; onClick?: () => void }) => {
    mockObsidianButton(props)
    return <button>{props.text}</button>
  },
}))

jest.mock('../../common/ObsidianDropdown', () => ({
  ObsidianDropdown: (props: Record<string, unknown>) => {
    mockObsidianDropdown(props)
    return null
  },
}))

jest.mock('../../common/ObsidianSetting', () => ({
  ObsidianSetting: (props: {
    name?: string
    desc?: string
    nameExtra?: React.ReactNode
    children?: React.ReactNode
  }) => {
    mockObsidianSetting(props)
    return (
      <section data-name={props.name} data-desc={props.desc}>
        {props.nameExtra}
        {props.children}
      </section>
    )
  },
}))

jest.mock('../../common/ObsidianTextInput', () => ({
  ObsidianTextInput: () => null,
}))

jest.mock('../../common/ObsidianToggle', () => ({
  ObsidianToggle: (props: Record<string, unknown>) => {
    mockObsidianToggle(props)
    return null
  },
}))

jest.mock('../IndexProgressRing', () => ({
  IndexProgressRing: () => null,
}))

jest.mock('../inputs/FolderSelectionList', () => ({
  FolderSelectionList: () => null,
}))

jest.mock('../modals/ExcludedFilesModal', () => ({
  ExcludedFilesModal: class {},
}))

jest.mock('../modals/IncludedFilesModal', () => ({
  IncludedFilesModal: class {},
}))

import {
  RAGSection,
  formatProgressPercent,
  getProgressPercent,
  isRagLogRibbonVisible,
  mergeRagSettingsPatch,
  rebuildRequiredLabel,
} from './RAGSection'

describe('getProgressPercent', () => {
  it('floors to two decimals and never reports 100 before work is complete', () => {
    expect(
      getProgressPercent({
        completedFiles: 999,
        totalFiles: 1000,
        completedChunks: 0,
        totalChunks: 0,
      }),
    ).toBe(99.9)
    expect(
      getProgressPercent({
        completedFiles: 999999,
        totalFiles: 1000000,
        completedChunks: 0,
        totalChunks: 0,
      }),
    ).toBe(99.99)
  })

  it('always renders progress with two decimal places', () => {
    expect(formatProgressPercent(99.9)).toBe('99.90')
    expect(formatProgressPercent(100)).toBe('100.00')
  })
})

describe('RAG log settings entry points', () => {
  const baseSettings = {
    ragOptions: {
      enabled: true,
      indexPdf: true,
      chunkSize: 1000,
      chunkOverlap: 50,
      minSimilarity: 0,
      limit: 10,
      rerankEnabled: true,
      embeddingConcurrency: 10,
      includePatterns: [],
      excludePatterns: [],
      excludeYoloBaseDir: true,
      autoUpdateEnabled: true,
      autoUpdateIntervalHours: 0,
      lastAutoUpdateAt: 0,
      diagnosticsEnabled: true,
      showRagLogRibbonIcon: true,
    },
    ragBackendSettings: {
      productionBackend: 'sqlite' as const,
      rebuildRequired: false,
    },
    webRuntime: {
      enabled: false,
      port: 18900,
      host: '127.0.0.1',
      token: '',
    },
    providers: [],
    embeddingModels: [],
    embeddingModelId: '',
    rerankModels: [],
    rerankModelId: '',
  }
  const plugin = {
    app: {
      vault: {},
    },
    getRagIndexSnapshot: () => ({
      status: 'idle',
      mode: null,
      permanentFailedPaths: [],
    }),
    subscribeToRagIndexRuns: () => () => {},
    getRetrievalInspectStatus: jest.fn(),
    getVectorBackendStatus: jest.fn(),
    cancelRagIndex: jest.fn(),
    openRagLogModal: jest.fn(),
  }

  beforeEach(() => {
    mockUseSettings.mockReturnValue({
      settings: baseSettings,
      setSettings: jest.fn(),
    })
    mockUseLanguage.mockReturnValue({
      t: (_key: string, fallback?: string) => fallback ?? '',
    })
    mockObsidianSetting.mockClear()
    mockObsidianDropdown.mockClear()
    mockObsidianToggle.mockClear()
    mockObsidianButton.mockClear()
  })

  it('treats the ribbon icon as visible by default and respects saved off state', () => {
    expect(isRagLogRibbonVisible(baseSettings)).toBe(true)
    expect(
      isRagLogRibbonVisible({
        ...baseSettings,
        ragOptions: {
          ...baseSettings.ragOptions,
          showRagLogRibbonIcon: false,
        },
      }),
    ).toBe(false)
  })

  it('merges RAG settings patches without replacing unrelated stale fields', () => {
    const latestSettings = {
      ...baseSettings,
      ragOptions: {
        ...baseSettings.ragOptions,
        enabled: false,
        indexPdf: true,
      },
    }

    expect(
      mergeRagSettingsPatch(latestSettings, {
        ragOptions: {
          indexPdf: false,
        },
      }).ragOptions,
    ).toEqual(
      expect.objectContaining({
        enabled: false,
        indexPdf: false,
      }),
    )
  })

  it('renders independent rows for opening the RAG log and toggling the ribbon icon', () => {
    const markup = renderToStaticMarkup(
      <RAGSection app={{} as never} plugin={plugin as never} />,
    )

    expect(markup).toContain('打开')
    expect(markup).not.toContain('检索状态')
    expect(mockObsidianSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'RAG 日志',
      }),
    )
    expect(mockObsidianSetting).toHaveBeenCalledWith(
      expect.objectContaining({
        name: '显示 RAG 日志侧边栏图标',
      }),
    )
  })

  it('hides the RAG log ribbon toggle on mobile where no ribbon exists', () => {
    mockPlatform.isDesktop = false
    try {
      mockObsidianSetting.mockClear()
      renderToStaticMarkup(
        <RAGSection app={{} as never} plugin={plugin as never} />,
      )

      expect(
        mockObsidianSetting.mock.calls.some(
          ([props]) =>
            (props as { name?: string }).name === '显示 RAG 日志侧边栏图标',
        ),
      ).toBe(false)
      // The RAG log modal itself is still reachable from settings.
      expect(
        mockObsidianSetting.mock.calls.some(
          ([props]) => (props as { name?: string }).name === 'RAG 日志',
        ),
      ).toBe(true)
    } finally {
      mockPlatform.isDesktop = true
    }
  })

  it('disables desktop-only RAG maintenance controls on mobile', () => {
    mockPlatform.isDesktop = false
    try {
      renderToStaticMarkup(
        <RAGSection app={{} as never} plugin={plugin as never} />,
      )

      const manageButton = mockObsidianButton.mock.calls
        .map(([props]) => props as { text?: string; disabled?: boolean })
        .find((props) => props.text === '管理')
      expect(manageButton?.disabled).toBe(true)
    } finally {
      mockPlatform.isDesktop = true
    }
  })

  it('renders the auto-update toggle and last-sync row', () => {
    mockUseSettings.mockReturnValue({
      settings: {
        ...baseSettings,
        ragOptions: {
          ...baseSettings.ragOptions,
          lastAutoUpdateAt: 1_720_000_000_000,
        },
      },
      setSettings: jest.fn(),
    })

    const markup = renderToStaticMarkup(
      <RAGSection app={{} as never} plugin={plugin as never} />,
    )

    expect(mockObsidianSetting).toHaveBeenCalledWith(
      expect.objectContaining({ name: '自动更新索引' }),
    )
    expect(mockObsidianSetting).toHaveBeenCalledWith(
      expect.objectContaining({ name: '最近同步' }),
    )
    // The last-sync row surfaces the recorded auto-update time.
    expect(markup).toContain(new Date(1_720_000_000_000).toLocaleString())
    // The auto-update toggle reflects the saved state.
    expect(mockObsidianToggle).toHaveBeenCalledWith(
      expect.objectContaining({ value: true }),
    )
  })

  it('reflects a disabled auto-update toggle in the settings row', () => {
    mockUseSettings.mockReturnValue({
      settings: {
        ...baseSettings,
        ragOptions: {
          ...baseSettings.ragOptions,
          autoUpdateEnabled: false,
        },
      },
      setSettings: jest.fn(),
    })

    renderToStaticMarkup(
      <RAGSection app={{} as never} plugin={plugin as never} />,
    )

    // The only off toggle in the default fixture is the auto-update switch.
    expect(mockObsidianToggle).toHaveBeenCalledWith(
      expect.objectContaining({ value: false }),
    )
  })

  it('labels scope-change rebuilds as "Rebuild required", empty indexes as "Not indexed yet"', () => {
    const t = (key: string, fallback?: string) => fallback ?? ''
    // Persisted scope-change flag set → rebuild demanded by changed options.
    expect(rebuildRequiredLabel(true, t)).toBe('Rebuild required')
    // Store-derived only (empty index, no scope change) → not-indexed state.
    expect(rebuildRequiredLabel(false, t)).toBe('Not indexed yet')
  })

  it('routes an explicit update action through the maintenance controller', async () => {
    const startJob = jest.fn().mockResolvedValue({ status: 'completed' })
    const maintenancePlugin = {
      ...plugin,
      getVectorBackendStatus: jest.fn().mockResolvedValue({
        backend: 'sqlite',
        readiness: 'ready',
        rebuildRequired: false,
      }),
      getDatabaseMaintenanceController: jest.fn(() => ({ startJob })),
    }

    renderToStaticMarkup(
      <RAGSection app={{} as never} plugin={maintenancePlugin as never} />,
    )

    const updateButton = mockObsidianButton.mock.calls
      .map(([props]) => props as { text?: string; onClick?: () => void })
      .find((props) => props.text === '更新索引')
    updateButton?.onClick?.()
    await new Promise<void>((resolve) => setImmediate(resolve))
    await new Promise<void>((resolve) => setImmediate(resolve))

    expect(
      maintenancePlugin.getDatabaseMaintenanceController,
    ).toHaveBeenCalledWith('rag')
    expect(startJob).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'update_changed_sources',
        operationKey: 'rag:update_changed_sources',
      }),
    )
  })

  it('does not render legacy retrieval strategy toggles', () => {
    const markup = renderToStaticMarkup(
      <RAGSection app={{} as never} plugin={plugin as never} />,
    )

    expect(markup).not.toContain('Default retrieval mode')
    expect(markup).not.toContain('Enable lexical retrieval')
    expect(markup).not.toContain('Enable metadata retrieval')
    expect(markup).not.toContain('Enable hybrid merge')
    expect(markup).not.toContain('Enable semantic metadata key resolution')
    expect(markup).not.toContain(
      'Lexical mode requires lexical retrieval to be enabled.',
    )
    expect(markup).not.toContain(
      'Hybrid mode requires lexical or metadata retrieval to be enabled.',
    )
  })

  it('renders indexing progress without a lexical-only maintenance phase', () => {
    const lexicalPlugin = {
      ...plugin,
      getRagIndexSnapshot: () => ({
        runId: 'run-1',
        trigger: 'manual',
        retryPolicy: 'none',
        mode: 'sync',
        scopeKind: 'all',
        status: 'running',
        startedAt: 1,
        updatedAt: 2,
        phase: 'lexical',
        completedChunks: 4,
        totalChunks: 10,
        totalFiles: 0,
        completedFiles: 0,
        currentFile: 'notes/should-not-show.md',
        retryCount: 0,
      }),
    }

    const markup = renderToStaticMarkup(
      <RAGSection app={{} as never} plugin={lexicalPlugin as never} />,
    )

    expect(markup).toContain('40.00% Indexing...')
    expect(markup).not.toContain('Building keyword index...')
  })
})
