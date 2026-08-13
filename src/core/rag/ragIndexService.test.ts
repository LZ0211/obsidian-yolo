import { DatabaseSaveFailedError } from '../../database/exception'
import { BackgroundActivityRegistry } from '../background/backgroundActivityRegistry'

import { RagIndexBusyError, RagIndexService } from './ragIndexService'

const waitForNextTick = async () =>
  await new Promise<void>((resolve) => setTimeout(resolve, 0))

describe('RagIndexService', () => {
  afterEach(() => {
    jest.useRealTimers()
  })

  it('restores an interrupted rebuild as a sync resume', async () => {
    // Even when the prior run was a rebuild, recovery downgrades to sync so the
    // reconcile loop skips chunks already in the DB instead of truncating.
    // Users who really want a fresh rebuild trigger it explicitly from the UI.
    const saved: Record<string, string> = {
      yolo_rag_index_run: JSON.stringify({
        runId: 'old-run',
        status: 'running',
        mode: 'rebuild',
        trigger: 'manual',
        retryPolicy: 'transient',
        completedFiles: 30,
        totalFiles: 200,
        completedChunks: 600,
        totalChunks: 4000,
      }),
    }

    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn((key: string) => saved[key] ?? null),
        saveLocalStorage: jest.fn((key: string, value: string) => {
          saved[key] = value
        }),
      } as never,
      getRagEngine: jest.fn(),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    expect(service.getSnapshot()).toMatchObject({
      status: 'retry_scheduled',
      failureKind: 'transient',
      retryPolicy: 'transient',
      mode: 'sync',
      trigger: 'manual',
      // Progress is preserved so the UI can show "已索引 X / Y".
      completedFiles: 30,
      totalFiles: 200,
      completedChunks: 600,
      totalChunks: 4000,
    })
  })

  it('restores an interrupted sync as sync (idempotent)', async () => {
    const saved: Record<string, string> = {
      yolo_rag_index_run: JSON.stringify({
        runId: 'old-run',
        status: 'running',
        mode: 'sync',
        trigger: 'auto',
        retryPolicy: 'transient',
      }),
    }

    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn((key: string) => saved[key] ?? null),
        saveLocalStorage: jest.fn((key: string, value: string) => {
          saved[key] = value
        }),
      } as never,
      getRagEngine: jest.fn(),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    expect(service.getSnapshot()).toMatchObject({
      status: 'retry_scheduled',
      mode: 'sync',
      trigger: 'auto',
    })
  })

  it('restores interrupted non-retryable runs as failed on initialize', async () => {
    const saved: Record<string, string> = {
      yolo_rag_index_run: JSON.stringify({
        runId: 'old-run',
        status: 'running',
        mode: 'sync',
        trigger: 'manual',
        retryPolicy: 'none',
      }),
    }

    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn((key: string) => saved[key] ?? null),
        saveLocalStorage: jest.fn((key: string, value: string) => {
          saved[key] = value
        }),
      } as never,
      getRagEngine: jest.fn(),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    expect(service.getSnapshot()).toMatchObject({
      status: 'failed',
      failureKind: 'unknown',
      retryPolicy: 'none',
    })
  })

  it('publishes progress and blocks concurrent runs', async () => {
    let resolveRun: () => void = () => undefined
    const updateVaultIndex = jest.fn().mockImplementation(
      async (
        _options: unknown,
        onProgress?: (progress: {
          type: 'indexing'
          indexProgress: {
            completedChunks: number
            totalChunks: number
            totalFiles: number
            completedFiles: number
            currentFile: string
          }
        }) => void,
      ) => {
        onProgress?.({
          type: 'indexing',
          indexProgress: {
            completedChunks: 1,
            totalChunks: 2,
            totalFiles: 1,
            completedFiles: 0,
            currentFile: 'foo.md',
          },
        })
        await new Promise<void>((resolve) => {
          resolveRun = resolve
        })
        return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
      },
    )
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    const firstRun = service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })

    await waitForNextTick()
    expect(service.getSnapshot()).toMatchObject({
      status: 'running',
      currentFile: 'foo.md',
      completedChunks: 1,
      retryPolicy: 'none',
    })

    await expect(
      service.runIndex({
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'none',
      }),
    ).rejects.toBeInstanceOf(RagIndexBusyError)

    resolveRun()
    await firstRun

    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
    })
  })

  it('serializes in-flight progress writes before the terminal snapshot so the final localStorage value is completed', async () => {
    // Simulates a slow progress localStorage write that resolves only after
    // the run has finished. Without the serialization tail the progress
    // snapshot ('running') would land LAST, so the next initialize() would
    // misreport the finished run as interrupted (failed / retry_scheduled).
    const saved: Record<string, string> = {}
    let releaseProgressWrite: (() => void) | null = null
    const progressWriteGate = new Promise<void>((resolve) => {
      releaseProgressWrite = resolve
    })
    let writeCount = 0
    const updateVaultIndex = jest.fn().mockImplementation(
      async (
        _options: unknown,
        onProgress?: (progress: {
          type: 'indexing'
          indexProgress: {
            completedChunks: number
            totalChunks: number
            totalFiles: number
            completedFiles: number
            currentFile: string
          }
        }) => void,
      ) => {
        onProgress?.({
          type: 'indexing',
          indexProgress: {
            completedChunks: 3,
            totalChunks: 10,
            totalFiles: 1,
            completedFiles: 0,
            currentFile: 'foo.md',
          },
        })
        return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
      },
    )
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn((_key: string, value: string) => {
          writeCount += 1
          // Write 1 is the run-start snapshot; write 2 is the coalesced
          // progress snapshot and is the one that lands late.
          if (writeCount === 2) {
            return progressWriteGate.then(() => {
              saved.yolo_rag_index_run = value
            })
          }
          saved.yolo_rag_index_run = value
          return undefined
        }),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    const runPromise = service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })
    await waitForNextTick()
    releaseProgressWrite!()
    await runPromise

    expect(JSON.parse(saved.yolo_rag_index_run)).toMatchObject({
      status: 'completed',
    })
  })

  it('recovers from a failed progress write: terminal snapshot still lands completed and later progress writes still execute', async () => {
    // A failed progress persist (localStorage error) must not poison the
    // serialization tail: a rejected tail would (a) block every later
    // progress write while progressPersistInFlight stays stuck true, and
    // (b) make persistTerminalSnapshot throw so the catch path overwrites
    // the already-successful run with failed/retry_scheduled.
    const saved: Record<string, string> = {}
    const writtenValues: string[] = []
    let writeCount = 0
    const updateVaultIndex = jest.fn().mockImplementation(
      async (
        _options: unknown,
        onProgress?: (progress: {
          type: 'indexing'
          indexProgress: {
            completedChunks: number
            totalChunks: number
            totalFiles: number
            completedFiles: number
            currentFile: string
          }
        }) => void,
      ) => {
        onProgress?.({
          type: 'indexing',
          indexProgress: {
            completedChunks: 1,
            totalChunks: 10,
            totalFiles: 1,
            completedFiles: 0,
            currentFile: 'a.md',
          },
        })
        // Let the first (failing) progress write settle so the second
        // callback enqueues a fresh coalesced write.
        await new Promise<void>((resolve) => setTimeout(resolve, 0))
        onProgress?.({
          type: 'indexing',
          indexProgress: {
            completedChunks: 2,
            totalChunks: 10,
            totalFiles: 1,
            completedFiles: 0,
            currentFile: 'b.md',
          },
        })
        return { permanentFailedPaths: [], chunkifyFailedPaths: [] }
      },
    )
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const service = new RagIndexService({
        app: {
          loadLocalStorage: jest.fn().mockReturnValue(null),
          saveLocalStorage: jest.fn((_key: string, value: string) => {
            writeCount += 1
            // Write 1 is the run-start snapshot; write 2 is the first
            // progress write and fails like a localStorage error.
            if (writeCount === 2) {
              throw new Error('localStorage write failed')
            }
            writtenValues.push(value)
            saved.yolo_rag_index_run = value
            return undefined
          }),
        } as never,
        getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
        activityRegistry: new BackgroundActivityRegistry(),
        isRagEnabled: () => true,
        t: (_key, fallback) => fallback ?? '',
      })

      await service.initialize()
      await service.runIndex({
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'none',
      })

      // The terminal snapshot still lands as completed...
      expect(JSON.parse(saved.yolo_rag_index_run)).toMatchObject({
        status: 'completed',
      })
      // ...and the progress write after the failed one still executed
      // (run-start + later progress + terminal = 3 successful writes). The
      // later write's snapshot is stringified when its microtask runs, which
      // may be after the run marked itself completed — the progress content
      // (completedChunks from the second callback) is what proves it ran.
      expect(writtenValues).toHaveLength(3)
      expect(JSON.parse(writtenValues[1])).toMatchObject({
        completedChunks: 2,
      })
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('invokes onIndexCompleted only after a successful run', async () => {
    const onIndexCompleted = jest.fn()
    const updateVaultIndex = jest
      .fn()
      .mockResolvedValue({ permanentFailedPaths: [], chunkifyFailedPaths: [] })
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
      onIndexCompleted,
    })
    await service.initialize()

    await service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })

    expect(onIndexCompleted).toHaveBeenCalledTimes(1)
    expect(onIndexCompleted).toHaveBeenCalledWith({
      permanentFailedPaths: [],
      chunkifyFailedPaths: [],
    })
  })

  it('does not invoke onIndexCompleted when the run fails', async () => {
    const onIndexCompleted = jest.fn()
    const updateVaultIndex = jest
      .fn()
      .mockRejectedValue(new Error('network timeout'))
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
      onIndexCompleted,
    })
    await service.initialize()

    await expect(
      service.runIndex({
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'none',
      }),
    ).rejects.toThrow('network timeout')

    expect(onIndexCompleted).not.toHaveBeenCalled()
  })

  describe('cross-window index lock', () => {
    const vaultName = 'Test Vault'
    const makeService = (updateVaultIndex: jest.Mock) =>
      new RagIndexService({
        app: {
          vault: { getName: () => vaultName },
          loadLocalStorage: jest.fn().mockReturnValue(null),
          saveLocalStorage: jest.fn(),
        } as never,
        getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
        activityRegistry: new BackgroundActivityRegistry(),
        isRagEnabled: () => true,
        t: (_key, fallback) => fallback ?? '',
      })
    const runOptions = {
      mode: 'sync' as const,
      scope: { kind: 'all' as const },
      trigger: 'manual' as const,
      retryPolicy: 'none' as const,
    }

    afterEach(() => {
      delete (globalThis as { navigator?: unknown }).navigator
    })

    it('acquires the vault-scoped web lock and runs the reconcile inside it', async () => {
      const updateVaultIndex = jest.fn().mockResolvedValue({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
      const request = jest.fn(
        (_name: string, _options: unknown, callback: () => Promise<unknown>) =>
          callback(),
      )
      ;(globalThis as { navigator?: unknown }).navigator = {
        locks: {
          request,
          query: jest.fn().mockResolvedValue({ held: [], pending: [] }),
        },
      }
      const service = makeService(updateVaultIndex)
      await service.initialize()

      const result = await service.runIndex(runOptions)

      expect(request).toHaveBeenCalledWith(
        `yolo-rag-index:${vaultName}`,
        { mode: 'exclusive' },
        expect.any(Function),
      )
      expect(updateVaultIndex).toHaveBeenCalledTimes(1)
      expect(result).toEqual({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
      expect(service.getSnapshot()).toMatchObject({ status: 'completed' })
    })

    it('rejects with the busy error when another window holds the index lock', async () => {
      const request = jest.fn()
      ;(globalThis as { navigator?: unknown }).navigator = {
        locks: {
          request,
          query: jest.fn().mockResolvedValue({
            held: [{ name: `yolo-rag-index:${vaultName}` }],
            pending: [],
          }),
        },
      }
      const updateVaultIndex = jest.fn().mockResolvedValue({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
      const service = makeService(updateVaultIndex)
      await service.initialize()

      await expect(service.runIndex(runOptions)).rejects.toBeInstanceOf(
        RagIndexBusyError,
      )
      expect(request).not.toHaveBeenCalled()
      expect(updateVaultIndex).not.toHaveBeenCalled()
    })

    it('falls back to unguarded runs when navigator.locks is unavailable', async () => {
      const updateVaultIndex = jest.fn().mockResolvedValue({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
      const service = makeService(updateVaultIndex)
      await service.initialize()

      await expect(service.runIndex(runOptions)).resolves.toEqual({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
      expect(updateVaultIndex).toHaveBeenCalledTimes(1)
      expect(service.getSnapshot()).toMatchObject({ status: 'completed' })
    })
  })

  it('schedules retry for transient manual rebuild failures', async () => {
    jest.useFakeTimers()
    const updateVaultIndex = jest
      .fn()
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    await expect(
      service.runIndex({
        mode: 'rebuild',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('network timeout')

    expect(service.getSnapshot()).toMatchObject({
      status: 'retry_scheduled',
      retryPolicy: 'transient',
      mode: 'rebuild',
    })

    await jest.advanceTimersByTimeAsync(5 * 60_000)

    expect(updateVaultIndex).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
    })
  })

  it('stops a manual run after three automatic retries', async () => {
    jest.useFakeTimers()
    const updateVaultIndex = jest
      .fn()
      .mockRejectedValue(new Error('network timeout'))
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    await expect(
      service.runIndex({
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('network timeout')

    await jest.advanceTimersByTimeAsync(5 * 60_000)
    await jest.advanceTimersByTimeAsync(15 * 60_000)
    await jest.advanceTimersByTimeAsync(30 * 60_000)

    expect(updateVaultIndex).toHaveBeenCalledTimes(4)
    expect(service.getSnapshot()).toMatchObject({
      status: 'failed',
      retryCount: 3,
    })
    await jest.advanceTimersByTimeAsync(60 * 60_000)
    expect(updateVaultIndex).toHaveBeenCalledTimes(4)
  })

  it('brings a pending manual retry forward on reconnect without resetting its budget', async () => {
    jest.useFakeTimers()
    const updateVaultIndex = jest
      .fn()
      .mockRejectedValue(new Error('network timeout'))
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    await expect(
      service.runIndex({
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('network timeout')
    expect(service.getSnapshot()).toMatchObject({ retryCount: 1 })

    service.onOnline()
    await jest.advanceTimersByTimeAsync(0)

    expect(updateVaultIndex).toHaveBeenCalledTimes(2)
    expect(service.getSnapshot()).toMatchObject({
      status: 'retry_scheduled',
      retryCount: 2,
    })
  })

  it('does not schedule retry for permanent manual failures', async () => {
    const permanentError = Object.assign(new Error('invalid api key'), {
      status: 401,
    })
    const updateVaultIndex = jest.fn().mockRejectedValue(permanentError)
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    await expect(
      service.runIndex({
        mode: 'rebuild',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toThrow('invalid api key')

    expect(service.getSnapshot()).toMatchObject({
      status: 'failed',
      failureKind: 'permanent',
      retryPolicy: 'transient',
    })
  })

  it('records DatabaseSaveFailedError as a permanent failure (no retry)', async () => {
    // #408: dumpDataDir OOM previously got swallowed and the run reported
    // 100% complete on a database that was never flushed. After the fix
    // VectorManager re-throws on the success path, surfacing here as a
    // DatabaseSaveFailedError. We classify it permanent so the run lands
    // on `failed` (not auto-retried) and the user sees real feedback.
    const oom = new RangeError('Array buffer allocation failed')
    const saveError = new DatabaseSaveFailedError(oom)
    const updateVaultIndex = jest.fn().mockRejectedValue(saveError)
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()

    await expect(
      service.runIndex({
        mode: 'sync',
        scope: { kind: 'all' },
        trigger: 'manual',
        retryPolicy: 'transient',
      }),
    ).rejects.toBeInstanceOf(DatabaseSaveFailedError)

    expect(service.getSnapshot()).toMatchObject({
      status: 'failed',
      failureKind: 'permanent',
      retryPolicy: 'transient',
    })
    expect(updateVaultIndex).toHaveBeenCalledTimes(1)
  })

  it('restores scheduled manual retries', async () => {
    jest.useFakeTimers()
    const updateVaultIndex = jest
      .fn()
      .mockResolvedValue({ permanentFailedPaths: [], chunkifyFailedPaths: [] })
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(
          JSON.stringify({
            runId: 'retry-run',
            status: 'retry_scheduled',
            mode: 'rebuild',
            trigger: 'manual',
            retryPolicy: 'transient',
            retryAt: Date.now() + 1_000,
          }),
        ),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    service.restoreRetryScheduledRun()
    await jest.advanceTimersByTimeAsync(1_000)

    expect(updateVaultIndex).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
    })
  })

  it('resets an exhausted retry episode only on explicit reset', async () => {
    const saved: Record<string, string> = {
      yolo_rag_index_run: JSON.stringify({
        runId: 'failed-run',
        status: 'failed',
        mode: 'sync',
        trigger: 'auto',
        retryPolicy: 'transient',
        retryCount: 3,
        failureKind: 'transient',
        failureMessage: 'network timeout',
      }),
    }
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn((key: string) => saved[key] ?? null),
        saveLocalStorage: jest.fn((key: string, value: string) => {
          saved[key] = value
        }),
      } as never,
      getRagEngine: jest.fn(),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    expect(service.getSnapshot()).toMatchObject({
      status: 'failed',
      retryCount: 3,
    })

    await service.resetRetryState()
    expect(service.getSnapshot()).toMatchObject({
      status: 'idle',
      retryPolicy: 'none',
      retryCount: 0,
    })
  })

  it('persists permanentFailedPaths on a completed run and returns the result', async () => {
    const updateVaultIndex = jest.fn().mockResolvedValue({
      permanentFailedPaths: ['bad.md', 'broken.md'],
      chunkifyFailedPaths: ['transient.md'],
    })
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    const result = await service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'transient',
    })

    // runIndex returns the reconcile result for the manual-path Notice.
    expect(result).toEqual({
      permanentFailedPaths: ['bad.md', 'broken.md'],
      chunkifyFailedPaths: ['transient.md'],
    })
    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
      // Permanent failures persist; chunkify failures (self-healing) do not.
      permanentFailedPaths: ['bad.md', 'broken.md'],
    })
  })

  it('clears permanentFailedPaths on a clean completion', async () => {
    const updateVaultIndex = jest
      .fn()
      .mockResolvedValueOnce({
        permanentFailedPaths: ['bad.md'],
        chunkifyFailedPaths: [],
      })
      .mockResolvedValueOnce({
        permanentFailedPaths: [],
        chunkifyFailedPaths: [],
      })
    const service = new RagIndexService({
      app: {
        loadLocalStorage: jest.fn().mockReturnValue(null),
        saveLocalStorage: jest.fn(),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })

    await service.initialize()
    await service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'transient',
    })
    expect(service.getSnapshot().permanentFailedPaths).toEqual(['bad.md'])

    await service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'auto',
      retryPolicy: 'transient',
    })
    expect(service.getSnapshot().permanentFailedPaths).toBeUndefined()
  })
})

describe('ragIndexService consecutive runs', () => {
  const buildService = (updateVaultIndex: jest.Mock) => {
    const saved: Record<string, string> = {}
    return new RagIndexService({
      app: {
        loadLocalStorage: jest.fn((key: string) => saved[key] ?? null),
        saveLocalStorage: jest.fn((key: string, value: string) => {
          saved[key] = value
        }),
      } as never,
      getRagEngine: jest.fn().mockResolvedValue({ updateVaultIndex }),
      activityRegistry: new BackgroundActivityRegistry(),
      isRagEnabled: () => true,
      t: (_key, fallback) => fallback ?? '',
    })
  }

  it('starts a new run with cleared progress and notifies subscribers', async () => {
    const updateVaultIndex = jest
      .fn()
      .mockImplementation(
        async (
          _options: unknown,
          onProgress?: (progress: {
            type: 'indexing'
            indexProgress: { completedFiles: number; totalFiles: number }
          }) => void,
        ) => {
          onProgress?.({
            type: 'indexing',
            indexProgress: { completedFiles: 40, totalFiles: 40 },
          })
          return { permanentFailedPaths: [] }
        },
      )
    const service = buildService(updateVaultIndex)

    const seenSnapshots: Array<{ status: string; completedFiles?: number }> = []
    service.subscribe((snapshot) => {
      seenSnapshots.push({
        status: snapshot.status,
        completedFiles: snapshot.completedFiles,
      })
    })

    // First run completes at 40/40.
    await service.runIndex({
      mode: 'rebuild',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })
    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
      completedFiles: 40,
      totalFiles: 40,
    })

    // Second run must start with progress cleared, not 40/40.
    updateVaultIndex.mockImplementationOnce(
      async (
        _options: unknown,
        onProgress?: (progress: {
          type: 'indexing'
          indexProgress: { completedFiles: number; totalFiles: number }
        }) => void,
      ) => {
        onProgress?.({
          type: 'indexing',
          indexProgress: { completedFiles: 1, totalFiles: 10 },
        })
        return { permanentFailedPaths: [] }
      },
    )
    await service.runIndex({
      mode: 'sync',
      scope: { kind: 'all' },
      trigger: 'manual',
      retryPolicy: 'none',
    })

    // The snapshot published when the second run started must have no
    // leftover progress from the first run.
    const startedSnapshots = seenSnapshots.filter(
      (snapshot) => snapshot.status === 'running',
    )
    const lastStarted = startedSnapshots[startedSnapshots.length - 1]
    expect(lastStarted).toBeDefined()
    expect(lastStarted.completedFiles).toBeUndefined()
    expect(service.getSnapshot()).toMatchObject({
      status: 'completed',
      completedFiles: 1,
      totalFiles: 10,
    })
  })
})
