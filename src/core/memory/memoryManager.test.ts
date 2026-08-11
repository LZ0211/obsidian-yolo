jest.mock('obsidian')

import { App, TFile, TFolder } from 'obsidian'

import {
  getMemoryPromptContext,
  loadMemorySourceSnapshot,
  loadMemorySourceSnapshots,
  memoryAdd,
  memoryDelete,
  memoryUpdate,
  resolveMemoryPartitionByPath,
} from './memoryManager'

const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

type MockVault = {
  app: App
  readByPath: (path: string) => string
  setModifyHook: (hook: (() => Promise<void> | void) | undefined) => void
}

const createMockVaultApp = (): MockVault => {
  const entries = new Map<string, unknown>()
  const contents = new Map<string, string>()
  let modifyHook: (() => Promise<void> | void) | undefined
  let mtimeCounter = 0
  const nextMtime = (): number => (mtimeCounter += 1)

  const vault = {
    getAbstractFileByPath: jest.fn((path: string) => entries.get(path) ?? null),
    createFolder: jest.fn(async (path: string) => {
      const folder = Object.assign(new TFolder(), {
        path,
        children: [],
      })
      entries.set(path, folder)
      return folder
    }),
    create: jest.fn(async (path: string, content: string) => {
      const file = Object.assign(new TFile(), {
        path,
        stat: { size: content.length, mtime: nextMtime() },
      })
      entries.set(path, file)
      contents.set(path, content)
      return file
    }),
    read: jest.fn(async (file: TFile) => contents.get(file.path) ?? ''),
    modify: jest.fn(async (file: TFile, content: string) => {
      await modifyHook?.()
      contents.set(file.path, content)
      ;(file as { stat?: { size?: number; mtime?: number } }).stat = {
        size: content.length,
        mtime: nextMtime(),
      }
    }),
  }

  return {
    app: {
      vault,
    } as unknown as App,
    readByPath: (path: string) => contents.get(path) ?? '',
    setModifyHook: (hook) => {
      modifyHook = hook
    },
  }
}

describe('memoryManager', () => {
  it('checks an aborted conditional writer only after a queued file lock is acquired', async () => {
    const { app, readByPath, setModifyHook } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [{ id: 'helper', systemPrompt: 'assistant' }],
    }
    const created = await memoryAdd({
      app,
      settings,
      content: 'before',
    })
    const modifyStarted = deferred()
    const releaseModify = deferred()
    setModifyHook(async () => {
      modifyStarted.resolve()
      await releaseModify.promise
    })

    const manualWrite = memoryUpdate({
      app,
      settings,
      id: created.id,
      newContent: 'manual update',
    })
    await modifyStarted.promise

    const controller = new AbortController()
    const queuedWrite = memoryUpdate({
      app,
      settings,
      id: created.id,
      newContent: 'extracted update',
      shouldWrite: () => !controller.signal.aborted,
    })
    controller.abort()
    releaseModify.resolve()

    await manualWrite
    await expect(queuedWrite).resolves.toMatchObject({ skipped: true })
    expect(readByPath(created.filePath)).toContain('- Memory_1: manual update')
    expect(readByPath(created.filePath)).not.toContain('extracted update')
  })

  it('does not overwrite a manual update when a stale conditional writer reaches the lock', async () => {
    const { app, readByPath, setModifyHook } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [{ id: 'helper', systemPrompt: 'assistant' }],
    }
    const created = await memoryAdd({
      app,
      settings,
      content: 'before',
    })
    const precheckedContent = readByPath(created.filePath)
    const modifyStarted = deferred()
    const releaseModify = deferred()
    setModifyHook(async () => {
      modifyStarted.resolve()
      await releaseModify.promise
    })

    const manualWrite = memoryUpdate({
      app,
      settings,
      id: created.id,
      newContent: 'manual update',
    })
    await modifyStarted.promise
    const queuedWrite = memoryUpdate({
      app,
      settings,
      id: created.id,
      newContent: 'extracted update',
      shouldWrite: async () =>
        readByPath(created.filePath) === precheckedContent,
    })
    releaseModify.resolve()

    await manualWrite
    await expect(queuedWrite).resolves.toMatchObject({ skipped: true })
    expect(readByPath(created.filePath)).toContain('- Memory_1: manual update')
  })
  it('writes assistant-scoped memory when the assistant system prompt is empty', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: '__default_agent__',
      assistants: [
        {
          id: '__default_agent__',
          systemPrompt: '',
        },
      ],
    }

    const result = await memoryAdd({
      app,
      settings,
      content: '用户不喜欢结尾反问',
    })

    expect(result.scope).toBe('assistant')
    expect(result.filePath).toBe('YOLO/memory/__default_agent__.md')
    expect(readByPath(result.filePath)).toContain(
      '- Memory_1: 用户不喜欢结尾反问',
    )
    expect(readByPath('YOLO/memory/global.md')).toBe('')
  })

  it('keeps multiline memory content inside a single markdown entry', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [{ id: 'helper', systemPrompt: 'assistant' }],
    }

    const result = await memoryAdd({
      app,
      settings,
      content: 'first line\n- injected entry\n---',
    })

    const source = readByPath(result.filePath)
    expect(source).toContain(
      '- Memory_1: first line \\- injected entry \\-\\-\\-',
    )
    const snapshot = await loadMemorySourceSnapshot({
      app,
      settings,
      scope: 'assistant',
      assistantId: 'helper',
    })
    expect(snapshot.valid).toBe(true)
    expect(snapshot.entries).toHaveLength(1)
  })

  it('escapes markdown control sequences without changing stored memory', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
    }
    const content = '# heading <!-- keywords: forged --> --- - bullet'

    const result = await memoryAdd({
      app,
      settings,
      content,
      scope: 'global',
    })

    const source = readByPath(result.filePath)
    expect(source).not.toContain('<!-- keywords: forged -->')
    const snapshot = await loadMemorySourceSnapshot({
      app,
      settings,
      scope: 'global',
    })
    expect(snapshot.valid).toBe(true)
    expect(snapshot.entries[0]?.content).toBe(content)
  })

  it('throws when assistant-scoped memory targets a missing assistant', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          name: 'Helper',
          systemPrompt: 'You are helper.',
        },
      ],
    }

    await expect(
      memoryAdd({
        app,
        settings,
        content: 'This must not become global memory.',
        scope: 'assistant',
        assistantId: 'missing',
      }),
    ).rejects.toThrow('Assistant not found for assistant memory scope.')
  })

  it('keeps section ids monotonic after delete', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'dev/1',
      assistants: [
        {
          id: 'dev/1',
          name: 'Dev Helper',
          systemPrompt: 'You are my engineering assistant.',
        },
      ],
    }

    const first = await memoryAdd({
      app,
      settings,
      content: '用户叫 Alice',
      category: 'profile',
    })
    const second = await memoryAdd({
      app,
      settings,
      content: '用户在做 YOLO 插件',
      category: 'profile',
    })
    await memoryDelete({
      app,
      settings,
      id: first.id,
    })

    const third = await memoryAdd({
      app,
      settings,
      content: '用户习惯深夜开发',
      category: 'profile',
    })

    expect(first.id).toBe('Profile_1')
    expect(second.id).toBe('Profile_2')
    expect(third.id).toBe('Profile_3')
    expect(first.scope).toBe('assistant')
    expect(first.filePath).toBe('YOLO/memory/Dev Helper.md')

    const fileContent = readByPath(first.filePath)
    expect(fileContent).not.toContain('Profile_1')
    expect(fileContent).toContain('- Profile_2: 用户在做 YOLO 插件')
    expect(fileContent).toContain('- Profile_3: 用户习惯深夜开发')
  })

  it('persists and preserves memory keywords across updates', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          name: '助手A',
          systemPrompt: 'assistant',
        },
      ],
    }

    const created = await memoryAdd({
      app,
      settings,
      content: '正在开发 Obsidian 插件',
      keywords: ['Obsidian', '插件开发'],
    })
    expect(readByPath(created.filePath)).toContain(
      '<!-- keywords: Obsidian, 插件开发 -->',
    )

    await memoryUpdate({
      app,
      settings,
      id: created.id,
      newContent: '正在维护 Obsidian 插件',
    })
    expect(readByPath(created.filePath)).toContain(
      '- Memory_1: 正在维护 Obsidian 插件 <!-- keywords: Obsidian, 插件开发 -->',
    )

    await memoryUpdate({
      app,
      settings,
      id: created.id,
      newContent: '正在维护 Obsidian 插件',
      keywords: [],
    })
    expect(readByPath(created.filePath)).not.toContain('<!-- keywords:')
  })

  it('reads global and assistant prompt context', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          name: '助手A',
          systemPrompt: 'You are helper.',
        },
      ],
    }

    await memoryAdd({
      app,
      settings,
      content: '用户希望回答简洁',
      category: 'preferences',
      scope: 'global',
    })
    const assistantMemory = await memoryAdd({
      app,
      settings,
      content: '当前在实现记忆工具',
      category: 'other',
      scope: 'assistant',
    })
    await memoryUpdate({
      app,
      settings,
      id: assistantMemory.id,
      newContent: '当前在实现 YOLO 记忆机制',
      scope: 'assistant',
    })

    const context = await getMemoryPromptContext({
      app,
      settings,
      assistantId: 'helper',
    })

    expect(context.global).toContain('Preference_1')
    expect(context.assistant).toContain('Memory_1: 当前在实现 YOLO 记忆机制')
  })

  it('keeps raw content and parsed snapshot reads of the same file isolated in cache', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          name: '助手A',
          systemPrompt: 'You are helper.',
        },
      ],
    }

    await memoryAdd({
      app,
      settings,
      content: '用户喜欢简洁回答',
      category: 'preferences',
      scope: 'global',
    })

    // Regression: the parsed-snapshot read and the raw-content read share
    // the same vault-file cache. If one overwrites the other's slot, the raw
    // read later receives a parsed object and `content.trim()` crashes.
    await loadMemorySourceSnapshot({
      app,
      settings,
      scope: 'global',
    })

    const context = await getMemoryPromptContext({
      app,
      settings,
      assistantId: 'helper',
    })
    expect(typeof context.global).toBe('string')
    expect(context.global).toContain('Preference_1')
  })

  it('reads assistant memory when system prompt is empty', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [
        {
          id: 'helper',
          name: '助手A',
          systemPrompt: '',
        },
      ],
    }

    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO')
    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO/memory')
    await (
      app as unknown as {
        vault: { create: (path: string, content: string) => Promise<unknown> }
      }
    ).vault.create(
      'YOLO/memory/助手A.md',
      '# User Profile\n\n# Preferences\n\n# Other Memory\n- Memory_1: 这个助手的记忆\n',
    )

    const context = await getMemoryPromptContext({
      app,
      settings,
      assistantId: 'helper',
    })

    expect(context.assistant).toContain('Memory_1: 这个助手的记忆')
  })

  it('parses section heading aliases and preserves custom text', async () => {
    const { app, readByPath } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
    }

    const seedContent = [
      '## user profile',
      '> keep this note',
      '',
      '* Profile_4：已有记录',
      '',
      '## Preferences',
      '- Preference_1: existing pref',
      '',
      '## Other Memory',
      '- Memory_2: other item',
      '',
      'Some custom footer text.',
      '',
    ].join('\n')

    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO')
    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO/memory')
    await (
      app as unknown as {
        vault: { create: (path: string, content: string) => Promise<unknown> }
      }
    ).vault.create('YOLO/memory/global.md', seedContent)

    const result = await memoryAdd({
      app,
      settings,
      content: '新增档案',
      category: 'profile',
      scope: 'global',
    })

    expect(result.id).toBe('Profile_5')
    const content = readByPath('YOLO/memory/global.md')
    expect(content).toContain('> keep this note')
    expect(content).toContain('Some custom footer text.')
    expect(content).toContain('- Profile_5: 新增档案')
  })

  it('throws when duplicated id is found in memory file', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
    }

    const duplicatedContent = [
      '# User Profile',
      '- Profile_1: A',
      '',
      '# Preferences',
      '- Profile_1: B',
      '',
      '# Other Memory',
      '',
    ].join('\n')

    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO')
    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO/memory')
    await (
      app as unknown as {
        vault: { create: (path: string, content: string) => Promise<unknown> }
      }
    ).vault.create('YOLO/memory/global.md', duplicatedContent)

    await expect(
      memoryUpdate({
        app,
        settings,
        id: 'Profile_1',
        newContent: 'C',
        scope: 'global',
      }),
    ).rejects.toThrow('Memory id duplicated: Profile_1')
  })

  it('uses assistant name and appends index for duplicate names', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper-2',
      assistants: [
        {
          id: 'helper-1',
          name: '测试 Agent',
          systemPrompt: 'A1',
        },
        {
          id: 'helper-2',
          name: '测试 Agent',
          systemPrompt: 'A2',
        },
      ],
    }

    const addResult = await memoryAdd({
      app,
      settings,
      content: 'test memory',
      scope: 'assistant',
    })
    expect(addResult.filePath).toBe('YOLO/memory/测试 Agent (2).md')

    const context = await getMemoryPromptContext({
      app,
      settings,
      assistantId: 'helper-2',
    })
    expect(context.assistant).toContain('Memory_1: test memory')
  })

  it('loads an empty valid snapshot for a missing global source', async () => {
    const { app } = createMockVaultApp()
    const snapshot = await loadMemorySourceSnapshot({
      app,
      settings: { yolo: { baseDir: 'YOLO' } },
      scope: 'global',
    })

    expect(snapshot.valid).toBe(true)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.sourcePath).toBe('YOLO/memory/global.md')
    expect(snapshot.sourceFileFingerprint).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    )
  })

  it('parses aliases with normalized sorted keywords and stable entry fingerprints', async () => {
    const { app } = createMockVaultApp()
    const settings = { yolo: { baseDir: 'YOLO' } }
    const seedContent = [
      '# 用户画像',
      '> description',
      '- Profile_1: cafe\u0301  fact <!-- keywords: z, A, z -->',
      '',
      '# 偏好',
      '- Preference_1： concise answers <!-- keywords:  concise, A  -->',
      '',
      '# Other Memory',
      '- Memory_1: note',
      '',
      '# Custom Notes',
      'ordinary user-authored text',
      '',
    ].join('\n')

    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO')
    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO/memory')
    await (
      app as unknown as {
        vault: { create: (path: string, content: string) => Promise<unknown> }
      }
    ).vault.create('YOLO/memory/global.md', seedContent)

    const snapshot = await loadMemorySourceSnapshot({
      app,
      settings,
      scope: 'global',
    })

    expect(snapshot.valid).toBe(true)
    expect(snapshot.entries).toHaveLength(3)
    expect(snapshot.entries[0]).toMatchObject({
      localId: 'Profile_1',
      content: 'café  fact',
      keywords: ['A', 'z'],
      category: 'profile',
      partition: {
        scope: 'global',
        assistantId: null,
        partitionKey: 'global',
      },
      sourcePath: 'YOLO/memory/global.md',
    })
    expect(snapshot.entries[0]?.entryFingerprint).toHaveLength(64)
    expect(snapshot.entries[0]?.entryFingerprint).not.toBe(
      snapshot.entries[1]?.entryFingerprint,
    )
  })

  it('changes file and entry fingerprints when content or keywords change', async () => {
    const { app } = createMockVaultApp()
    const settings = { yolo: { baseDir: 'YOLO' } }
    const path = 'YOLO/memory/global.md'
    const create = (
      app as unknown as {
        vault: { create: (path: string, content: string) => Promise<unknown> }
      }
    ).vault.create

    await create(
      path,
      '# Other Memory\n- Memory_1: first <!-- keywords: one -->\n',
    )
    const first = await loadMemorySourceSnapshot({
      app,
      settings,
      scope: 'global',
    })
    await create(
      path,
      '# Other Memory\n- Memory_1: second <!-- keywords: two -->\n',
    )
    const second = await loadMemorySourceSnapshot({
      app,
      settings,
      scope: 'global',
    })

    expect(second.entries).toHaveLength(first.entries.length)
    expect(second.sourceFileFingerprint).not.toBe(first.sourceFileFingerprint)
    expect(second.entries[0]?.entryFingerprint).not.toBe(
      first.entries[0]?.entryFingerprint,
    )
  })

  it('marks duplicate IDs and malformed entries invalid without fallback', async () => {
    const { app } = createMockVaultApp()
    const settings = { yolo: { baseDir: 'YOLO' } }
    const seedContent = [
      '# User Profile',
      '- Profile_1: first',
      '',
      '# Preferences',
      '- Profile_1: duplicate',
      '- malformed entry',
      '',
      '# Other Memory',
    ].join('\n')
    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO')
    await (
      app as unknown as {
        vault: { createFolder: (path: string) => Promise<unknown> }
      }
    ).vault.createFolder('YOLO/memory')
    await (
      app as unknown as {
        vault: { create: (path: string, content: string) => Promise<unknown> }
      }
    ).vault.create('YOLO/memory/global.md', seedContent)

    const snapshot = await loadMemorySourceSnapshot({
      app,
      settings,
      scope: 'global',
    })

    expect(snapshot.valid).toBe(false)
    expect(snapshot.partition.partitionKey).toBe('global')
    expect(snapshot.sourcePath).toBe('YOLO/memory/global.md')
  })

  it('keeps ordinary custom text readable while rejecting repeated sections', async () => {
    const { app } = createMockVaultApp()
    const settings = { yolo: { baseDir: 'YOLO' } }
    const content = [
      '# User Profile',
      'ordinary user-authored text',
      '- Profile_1: one',
      '# User Profile',
      '- Profile_2: two',
    ].join('\n')
    const create = (
      app as unknown as {
        vault: { create: (path: string, content: string) => Promise<unknown> }
      }
    ).vault.create
    await create('YOLO/memory/global.md', content)

    const snapshot = await loadMemorySourceSnapshot({
      app,
      settings,
      scope: 'global',
    })

    expect(snapshot.valid).toBe(false)
    expect(snapshot.entries).toHaveLength(2)
  })

  it('resolves global and stable assistant partitions by canonical paths', async () => {
    const settings = {
      yolo: { baseDir: 'YOLO' },
      assistants: [
        { id: 'a-2', name: 'Same Name' },
        { id: 'a-1', name: 'Same Name' },
      ],
    }

    expect(
      resolveMemoryPartitionByPath({
        settings,
        path: 'YOLO\\memory\\global.md',
      }),
    ).toEqual({ scope: 'global', assistantId: null, partitionKey: 'global' })
    expect(
      resolveMemoryPartitionByPath({
        settings,
        path: 'YOLO/memory/Same Name (2).md',
      }),
    ).toEqual({
      scope: 'assistant',
      assistantId: 'a-2',
      partitionKey: expect.stringMatching(/^assistant:/),
    })
    expect(
      resolveMemoryPartitionByPath({
        settings,
        path: 'YOLO/memory/unknown.md',
      }),
    ).toBeNull()
  })

  it('loads global and current assistant snapshots once each', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [{ id: 'helper', name: 'Helper' }],
    }

    const snapshots = await loadMemorySourceSnapshots({ app, settings })

    expect(snapshots).toHaveLength(2)
    expect(snapshots.map((snapshot) => snapshot.partition.scope)).toEqual([
      'global',
      'assistant',
    ])
  })

  it('calls onSourceCommitted only after successful writes', async () => {
    const { app } = createMockVaultApp()
    const settings = {
      yolo: { baseDir: 'YOLO' },
      currentAssistantId: 'helper',
      assistants: [{ id: 'helper', name: 'Helper' }],
    }
    const commits: Array<{ partitionKey: string; sourcePath: string }> = []
    const onSourceCommitted = jest.fn(
      async (input: {
        partition: { partitionKey: string }
        sourcePath: string
      }) => {
        commits.push({
          partitionKey: input.partition.partitionKey,
          sourcePath: input.sourcePath,
        })
      },
    )

    const created = await memoryAdd({
      app,
      settings,
      content: 'committed',
      onSourceCommitted,
    })
    expect(onSourceCommitted).toHaveBeenCalledTimes(1)
    expect(commits[0]).toEqual({
      partitionKey: expect.stringMatching(/^assistant:/),
      sourcePath: created.filePath,
    })

    await memoryUpdate({
      app,
      settings,
      id: created.id,
      newContent: 'skipped',
      shouldWrite: () => false,
      onSourceCommitted,
    })
    await expect(
      memoryDelete({
        app,
        settings,
        id: 'missing',
        onSourceCommitted,
      }),
    ).rejects.toThrow('Memory id not found')
    expect(onSourceCommitted).toHaveBeenCalledTimes(1)
  })

  it('does not fail a successful write when the commit callback rejects', async () => {
    const { app, readByPath } = createMockVaultApp()
    const onSourceCommitted = jest
      .fn()
      .mockRejectedValue(new Error('index unavailable'))

    const result = await memoryAdd({
      app,
      settings: { yolo: { baseDir: 'YOLO' } },
      content: 'still committed',
      scope: 'global',
      onSourceCommitted,
    })

    expect(onSourceCommitted).toHaveBeenCalledTimes(1)
    expect(readByPath(result.filePath)).toContain('- Memory_1: still committed')
  })
})
