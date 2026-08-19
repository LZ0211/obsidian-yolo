import type { SerializedEditorState } from 'lexical'
import { TFile, TFolder } from 'obsidian'

jest.mock('../../database/json/chat/promptSnapshotStore', () => ({
  readPromptSnapshotEntries: jest.fn(async () => ({})),
}))

jest.mock('../../core/memory/memoryManager', () => ({
  getMemoryPromptContext: jest.fn(async () => ''),
  resolveMemoryFilePaths: jest.fn(() => ({
    global: 'YOLO/memory/global.md',
    assistant: null,
  })),
}))

jest.mock('../llm/image', () => ({
  isImageTFile: jest.fn(() => false),
  tFileToImageDataUrl: jest.fn(async () => 'data:image/png;base64,fake'),
}))

jest.mock('../pdf/mineruCacheStore', () => ({
  convertPdfViaMinerU: jest.fn(),
}))

jest.mock('../../core/skills/liteSkills', () => ({
  ...jest.requireActual('../../core/skills/liteSkills'),
  getLiteSkillDocument: jest.fn(),
  listLiteSkillEntries: jest.fn(async () => []),
}))

import { SystemPromptSnapshotStore } from '../../core/agent/systemPromptSnapshotStore'
import { getMemoryPromptContext } from '../../core/memory/memoryManager'
import {
  getLiteSkillDocument,
  listLiteSkillEntries,
} from '../../core/skills/liteSkills'
import { readPromptSnapshotEntries } from '../../database/json/chat/promptSnapshotStore'
import type { YoloSettings } from '../../settings/schema/setting.types'
import type {
  ChatMessage,
  ChatToolMessage,
  ChatUserMessage,
} from '../../types/chat'
import type { ChatModel } from '../../types/chat-model.types'
import type { ContentPart, RequestMessage } from '../../types/llm/request'
import { ToolCallResponseStatus } from '../../types/tool-call.types'
import { createCompleteToolCallArguments } from '../../types/tool-call.types'
import { convertPdfViaMinerU } from '../pdf/mineruCacheStore'

import {
  RequestContextBuilder,
  extractMarkdownAtxHeadings,
  stripUnsupportedImages,
} from './requestContextBuilder'

const mockGetLiteSkillDocument = getLiteSkillDocument as jest.MockedFunction<
  typeof getLiteSkillDocument
>
const mockListLiteSkillEntries = listLiteSkillEntries as jest.MockedFunction<
  typeof listLiteSkillEntries
>
const mockReadPromptSnapshotEntries = jest.mocked(readPromptSnapshotEntries)

const MODULE_SKILL_FIXTURE_PATH =
  // eslint-disable-next-line obsidianmd/hardcoded-config-path -- Fixture literal mirroring a module-shipped skill path; no live vault to read configDir from.
  '.obsidian/plugins/yolo/modules/learning/1.0.0/outline.md'

function createMockFile(path: string): InstanceType<typeof TFile> {
  const extension = path.split('.').pop() ?? ''
  return Object.assign(new TFile(), {
    path,
    extension,
  })
}

function createMockFolder(
  path: string,
  children: Array<InstanceType<typeof TFile> | InstanceType<typeof TFolder>>,
): InstanceType<typeof TFolder> {
  return Object.assign(new TFolder(), {
    path,
    children,
  })
}

function createUserMessage(
  mentionables: ChatUserMessage['mentionables'],
): ChatUserMessage {
  return {
    role: 'user',
    id: 'message-1',
    content: null,
    promptContent: null,
    mentionables,
  }
}

function createTextEditorState(text: string): SerializedEditorState {
  return {
    root: {
      children: [
        {
          children: [
            {
              detail: 0,
              format: 0,
              mode: 'normal',
              style: '',
              text,
              type: 'text',
              version: 1,
            },
          ],
          direction: 'ltr',
          format: '',
          indent: 0,
          type: 'paragraph',
          version: 1,
          textFormat: 0,
          textStyle: '',
        },
      ],
      direction: 'ltr',
      format: '',
      indent: 0,
      type: 'root',
      version: 1,
    },
  } as unknown as SerializedEditorState
}

function getTextContent(
  promptContent: ChatUserMessage['promptContent'],
): string {
  if (!promptContent) {
    throw new Error('Expected prompt content to be present')
  }

  if (typeof promptContent === 'string') {
    return promptContent
  }

  const textPart = promptContent.find((part) => part.type === 'text')
  if (!textPart || textPart.type !== 'text') {
    throw new Error('Expected text content part')
  }

  return textPart.text
}

function createMockApp({
  files,
  folders,
  fileContents,
  frontmatters,
}: {
  files: InstanceType<typeof TFile>[]
  folders?: InstanceType<typeof TFolder>[]
  fileContents: Map<string, string>
  frontmatters?: Map<string, Record<string, unknown>>
}) {
  const folderEntries = folders ?? []
  const fileFrontmatters = frontmatters ?? new Map()

  return {
    metadataCache: {
      getFileCache: jest.fn((file: { path: string }) => {
        const frontmatter = fileFrontmatters.get(file.path)
        return frontmatter ? { frontmatter } : null
      }),
    },
    vault: {
      cachedRead: jest.fn(async (file: { path: string }) => {
        return fileContents.get(file.path) ?? ''
      }),
      getFileByPath: jest.fn((path: string) => {
        return files.find((file) => file.path === path) ?? null
      }),
      getFolderByPath: jest.fn((path: string) => {
        return folderEntries.find((folder) => folder.path === path) ?? null
      }),
    },
  }
}

beforeEach(() => {
  mockGetLiteSkillDocument.mockReset()
  mockGetLiteSkillDocument.mockResolvedValue(null)
})

describe('extractMarkdownAtxHeadings', () => {
  it('extracts ATX headings and ignores fenced code blocks', () => {
    const content = [
      '# Intro',
      '',
      '```ts',
      '# not-a-heading',
      '```',
      '## Details ###',
      'text',
      '~~~md',
      '### still-not-a-heading',
      '~~~',
      '#### Final',
    ].join('\n')

    expect(extractMarkdownAtxHeadings(content)).toEqual([
      { level: 1, line: 1, text: 'Intro' },
      { level: 2, line: 6, text: 'Details' },
      { level: 4, line: 11, text: 'Final' },
    ])
  })
})

describe('RequestContextBuilder compileUserMessagePrompt', () => {
  const settings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    chatOptions: {
      includeCurrentFileContent: true,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  it('does not auto-fetch URL mention content into the prompt', async () => {
    const app = createMockApp({
      files: [],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: {
        ...createUserMessage([{ type: 'url', url: 'https://example.com' }]),
        content: createTextEditorState('Please check https://example.com'),
      },
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('Please check https://example.com')
    expect(textContent).not.toContain('Potentially Relevant Websearch Results')
    expect(textContent).not.toContain('Website Content:')
  })

  it('compiles plain prompts without constructing editor state', async () => {
    const app = createMockApp({
      files: [],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compilePlainUserMessagePrompt({
      prompt: 'Explain this note',
      mentionables: [],
    })

    expect(getTextContent(result.promptContent)).toBe(
      '\n\nExplain this note\n\n',
    )
  })

  it('marks selected vault text with its source range', async () => {
    const file = createMockFile('notes/selected.md')
    const app = createMockApp({
      files: [file],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: {
        ...createUserMessage([
          {
            type: 'block',
            file,
            content: 'Alpha\nBeta',
            startLine: 12,
            endLine: 13,
          },
        ]),
        content: createTextEditorState('Explain this selection'),
      },
    })

    expect(getTextContent(result.promptContent)).toContain(
      [
        '<user_selected_content path="notes/selected.md" startLine="12" endLine="13">',
        '```notes/selected.md',
        '12|Alpha',
        '13|Beta',
        '```',
        '</user_selected_content>',
      ].join('\n'),
    )
  })

  it('keeps assistant reply quotes paired with their comments', async () => {
    const app = createMockApp({
      files: [],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compilePlainUserMessagePrompt({
      prompt: '',
      mentionables: [
        {
          type: 'assistant-quote',
          id: 'annotation-1',
          annotationNumber: 4,
          conversationId: 'conversation-1',
          messageId: 'assistant-1',
          content: 'Quoted answer',
          comment: 'Make this more concrete.',
        },
      ],
    })

    expect(getTextContent(result.promptContent)).toContain(
      [
        '<assistant_quote index="4" conversationId="conversation-1" messageId="assistant-1">',
        '<quote>',
        'Quoted answer',
        '</quote>',
        '<comment>',
        'Make this more concrete.',
        '</comment>',
        '</assistant_quote>',
      ].join('\n'),
    )
  })

  it('renders conversation mention snapshots into the prompt', async () => {
    const app = createMockApp({
      files: [],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compilePlainUserMessagePrompt({
      prompt: '',
      mentionables: [
        {
          type: 'conversation',
          conversationId: 'conversation-2',
          title: '打开的对话',
          content: 'user: 之前的需求\nassistant: 已实现',
        },
      ],
    })

    const text = getTextContent(result.promptContent)
    expect(text).toContain('Referenced conversation snapshots')
    expect(text).toContain(
      '<conversation_context conversationId="conversation-2" title="打开的对话">',
    )
    expect(text).toContain('user: 之前的需求')
    expect(text).toContain('assistant: 已实现')
    expect(text).toContain('</conversation_context>')
  })

  it('marks PDF and table selections with source-specific metadata', async () => {
    const pdf = createMockFile('docs/paper.pdf')
    const table = createMockFile('notes/table.md')
    const app = createMockApp({
      files: [pdf, table],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compilePlainUserMessagePrompt({
      prompt: 'Compare these selections',
      mentionables: [
        {
          type: 'block',
          file: pdf,
          content: 'Selected PDF text',
          startLine: 0,
          endLine: 0,
          pageNumber: 3,
        },
        {
          type: 'block',
          file: table,
          content: '| A | B |\n| - | - |',
          startLine: 20,
          endLine: 21,
          contentFormat: 'markdown-table',
        },
      ],
    })

    const textContent = getTextContent(result.promptContent)
    expect(textContent).toContain(
      '<user_selected_content path="docs/paper.pdf" page="3">',
    )
    expect(textContent).toContain(
      '<user_selected_content path="notes/table.md" startLine="20" endLine="21" format="markdown-table">',
    )
  })

  it('adds index and <comment> to a PDF selection carrying a batch annotation', async () => {
    const pdf = createMockFile('docs/paper.pdf')
    const app = createMockApp({
      files: [pdf],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compilePlainUserMessagePrompt({
      prompt: 'What does annotation 1 mean?',
      mentionables: [
        {
          type: 'block',
          file: pdf,
          content: 'Selected PDF text',
          startLine: 0,
          endLine: 0,
          pageNumber: 3,
          source: 'selection-pinned',
          comment: 'Explain this clause.',
          annotationNumber: 1,
        },
      ],
    })

    expect(getTextContent(result.promptContent)).toContain(
      [
        '<user_selected_content path="docs/paper.pdf" page="3" index="1">',
        '```docs/paper.pdf (page 3)',
        'Selected PDF text',
        '```',
        '<comment>',
        'Explain this clause.',
        '</comment>',
        '</user_selected_content>',
      ].join('\n'),
    )
  })

  it('omits index and <comment> for a PDF selection without a comment (byte-identical to the pre-annotation format)', async () => {
    const pdf = createMockFile('docs/paper.pdf')
    const app = createMockApp({
      files: [pdf],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compilePlainUserMessagePrompt({
      prompt: 'Summarize this page',
      mentionables: [
        {
          type: 'block',
          file: pdf,
          content: 'Selected PDF text',
          startLine: 0,
          endLine: 0,
          pageNumber: 3,
        },
      ],
    })

    expect(getTextContent(result.promptContent)).toContain(
      [
        '<user_selected_content path="docs/paper.pdf" page="3">',
        '```docs/paper.pdf (page 3)',
        'Selected PDF text',
        '```',
        '</user_selected_content>',
      ].join('\n'),
    )
  })

  it('reuses file mention compilation for plain prompts', async () => {
    const explicitFile = createMockFile('notes/explicit.md')
    const app = createMockApp({
      files: [explicitFile],
      fileContents: new Map([[explicitFile.path, '# Explicit\nBody']]),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compilePlainUserMessagePrompt({
      prompt: 'Summarize this file',
      mentionables: [{ type: 'file', file: explicitFile }],
    })

    const textContent = getTextContent(result.promptContent)
    expect(textContent).toContain('## Mentioned Vault Files (outline only)')
    expect(textContent).toContain('- `notes/explicit.md`\n  - L1 # Explicit')
    expect(textContent).toContain('Summarize this file')
  })

  it('adds selected skill content for plain prompts', async () => {
    mockGetLiteSkillDocument.mockResolvedValueOnce({
      entry: {
        name: 'skill-creator',
        description: 'Create skills',
        mode: 'lazy',
        path: 'builtin://skills/skill-creator',
        isReadOnly: true,
      },
      content: '# skill body',
    })

    const app = createMockApp({
      files: [],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compilePlainUserMessagePrompt({
      prompt: 'Use the skill',
      mentionables: [],
      selectedSkills: [
        {
          name: 'skill-creator',
          description: 'Create skills',
          path: 'builtin://skills/skill-creator',
        },
      ],
    })

    expect(getTextContent(result.promptContent)).toContain(
      '<user_selected_skills>',
    )
    expect(getTextContent(result.promptContent)).toContain('# skill body')
    expect(getTextContent(result.promptContent)).toContain('Use the skill')
  })

  it('threads an explicit scope through to getLiteSkillDocument for selected skills (compilePlainUserMessagePrompt)', async () => {
    mockGetLiteSkillDocument.mockResolvedValueOnce({
      entry: {
        name: 'outline-skill',
        description: 'Outline conventions',
        mode: 'lazy',
        path: MODULE_SKILL_FIXTURE_PATH,
        isReadOnly: true,
      },
      content: '# outline body',
    })

    const app = createMockApp({ files: [], fileContents: new Map() })
    const builder = new RequestContextBuilder(app as never, settings)

    await builder.compilePlainUserMessagePrompt({
      prompt: 'Plan a course',
      mentionables: [],
      selectedSkills: [
        {
          name: 'outline-skill',
          description: 'Outline conventions',
          path: MODULE_SKILL_FIXTURE_PATH,
        },
      ],
      scope: { moduleChatModeId: 'module:learning:chat' },
    })

    expect(mockGetLiteSkillDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'outline-skill',
        scope: { moduleChatModeId: 'module:learning:chat' },
      }),
    )
  })

  it('threads an explicit scope through to getLiteSkillDocument for selected skills (compileUserMessagePrompt)', async () => {
    mockGetLiteSkillDocument.mockResolvedValueOnce({
      entry: {
        name: 'outline-skill',
        description: 'Outline conventions',
        mode: 'lazy',
        path: MODULE_SKILL_FIXTURE_PATH,
        isReadOnly: true,
      },
      content: '# outline body',
    })

    const app = createMockApp({ files: [], fileContents: new Map() })
    const builder = new RequestContextBuilder(app as never, settings)

    await builder.compileUserMessagePrompt({
      message: {
        ...createUserMessage([]),
        content: createTextEditorState('Plan a course'),
        selectedSkills: [
          {
            name: 'outline-skill',
            description: 'Outline conventions',
            path: MODULE_SKILL_FIXTURE_PATH,
          },
        ],
      },
      scope: { moduleChatModeId: 'module:learning:chat' },
    })

    expect(mockGetLiteSkillDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'outline-skill',
        scope: { moduleChatModeId: 'module:learning:chat' },
      }),
    )
  })

  it('omits scope by default so ordinary (non-module) calls are unaffected', async () => {
    mockGetLiteSkillDocument.mockResolvedValueOnce({
      entry: {
        name: 'skill-creator',
        description: 'Create skills',
        mode: 'lazy',
        path: 'builtin://skills/skill-creator',
        isReadOnly: true,
      },
      content: '# skill body',
    })

    const app = createMockApp({ files: [], fileContents: new Map() })
    const builder = new RequestContextBuilder(app as never, settings)

    await builder.compilePlainUserMessagePrompt({
      prompt: 'Use the skill',
      mentionables: [],
      selectedSkills: [
        {
          name: 'skill-creator',
          description: 'Create skills',
          path: 'builtin://skills/skill-creator',
        },
      ],
    })

    expect(mockGetLiteSkillDocument).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'skill-creator', scope: undefined }),
    )
  })

  it('builds direct file outlines and a lightweight folder summary', async () => {
    const explicitFile = createMockFile('notes/explicit.md')
    const currentFile = createMockFile('notes/current.md')
    const folderFile = createMockFile('docs/from-folder.md')
    const textFile = createMockFile('docs/plain.txt')
    const folder = createMockFolder('docs', [folderFile, textFile])

    const fileContents = new Map<string, string>([
      [explicitFile.path, '# Explicit\n## Part A'],
      [currentFile.path, '# Current'],
      [folderFile.path, '## Folder Heading'],
      [textFile.path, 'plain text content'],
    ])
    const frontmatters = new Map<string, Record<string, unknown>>([
      [
        explicitFile.path,
        {
          title: 'Explicit Title',
          tags: ['alpha', 'beta'],
        },
      ],
      [
        folderFile.path,
        {
          exported_from: 'YOLO',
        },
      ],
    ])

    const app = createMockApp({
      files: [explicitFile, currentFile, folderFile, textFile],
      folders: [folder],
      fileContents,
      frontmatters,
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'file', file: explicitFile },
        { type: 'folder', folder },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('## Mentioned Vault Files (outline only)')
    expect(textContent).toContain(
      [
        '- `notes/explicit.md`',
        '  - Properties:',
        '    - `title`: `Explicit Title`',
        '    - `tags`: `["alpha","beta"]`',
        '  - L1 # Explicit',
        '  - L2 ## Part A',
      ].join('\n'),
    )
    // current-file is no longer surfaced via the mention path.
    expect(textContent).not.toContain('notes/current.md')
    expect(textContent).toContain(
      [
        'Folder file preview (paths only):',
        '  - `docs/from-folder.md`',
        '  - `docs/plain.txt`',
      ].join('\n'),
    )
    expect(textContent).not.toContain('exported_from')
    expect(textContent).not.toContain('Folder Heading')
    expect(textContent).toContain('## Mentioned Vault Folders\n- `docs`')
    expect(textContent).toContain('Folder scope contains at least 2 files.')
    expect(textContent).toContain(
      'This section provides paths and a small preview only. Use file tools only if you need the full contents or a specific line range.',
    )
  })

  it('does not read folder files when compiling a light folder mention', async () => {
    const folderFile = createMockFile('docs/large-note.md')
    const folder = createMockFolder('docs', [folderFile])
    const app = createMockApp({
      files: [folderFile],
      folders: [folder],
      fileContents: new Map([
        [folderFile.path, '# Should not be loaded\nLarge body'],
      ]),
      frontmatters: new Map([
        [folderFile.path, { title: 'Should not be loaded' }],
      ]),
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'folder', folder }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(app.vault.cachedRead).not.toHaveBeenCalled()
    expect(app.metadataCache.getFileCache).not.toHaveBeenCalled()
    expect(textContent).toContain('Folder scope contains at least 1 file.')
    expect(textContent).toContain('  - `docs/large-note.md`')
    expect(textContent).not.toContain('Should not be loaded')
    expect(textContent).not.toContain('Large body')
  })

  it('caps direct markdown outlines and reports omitted files', async () => {
    const mentionedFiles = Array.from({ length: 11 }, (_, index) =>
      createMockFile(`docs/file-${index + 1}.md`),
    )

    const fileContents = new Map<string, string>([
      ...mentionedFiles.map(
        (file, index) => [file.path, `# Folder ${index + 1}`] as const,
      ),
    ])

    const app = createMockApp({
      files: mentionedFiles,
      fileContents,
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage(
        mentionedFiles.map((file) => ({ type: 'file', file })),
      ),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent.match(/- L1 # /g)?.length).toBe(10)
    expect(textContent).toContain(
      'Additional mentioned markdown files omitted from outline due to limit: 1',
    )
  })

  it('caps the folder path preview and reports omitted files', async () => {
    const folderFiles = Array.from({ length: 51 }, (_, index) =>
      createMockFile(`docs/file-${index + 1}.md`),
    )
    const folder = createMockFolder('docs', folderFiles)
    const app = createMockApp({
      files: folderFiles,
      folders: [folder],
      fileContents: new Map(),
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'folder', folder }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('  - `docs/file-12.md`')
    expect(textContent).not.toContain('  - `docs/file-13.md`')
    expect(textContent).not.toContain('  - `docs/file-51.md`')
    expect(textContent).toContain('Folder scope contains at least 51 files.')
    expect(textContent).toContain(
      'Additional folder files omitted from the path preview: 39',
    )
  })

  it('uses light mode by default for mentioned files even without tool-read preference', async () => {
    const explicitFile = createMockFile('notes/explicit.md')
    const currentFile = createMockFile('notes/current.md')

    const fileContents = new Map<string, string>([
      [explicitFile.path, '# Explicit\nBody'],
      [currentFile.path, '# Current\nMore'],
    ])

    const app = createMockApp({
      files: [explicitFile, currentFile],
      fileContents,
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'file', file: explicitFile }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('- `notes/explicit.md`\n  - L1 # Explicit')
    expect(textContent).not.toContain('Body')
    expect(textContent).not.toContain('More')
  })

  it('includes frontmatter properties without internal metadata fields', async () => {
    const explicitFile = createMockFile('notes/with-properties.md')

    const app = createMockApp({
      files: [explicitFile],
      fileContents: new Map([[explicitFile.path, '# Heading']]),
      frontmatters: new Map([
        [
          explicitFile.path,
          {
            title: '工具上下文管理详解',
            exported_at: '2026-04-09T12:10:14.480Z',
            draft: false,
            position: {
              start: { line: 0, col: 0, offset: 0 },
              end: { line: 4, col: 3, offset: 80 },
            },
          },
        ],
      ]),
    })

    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'file', file: explicitFile }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('    - `title`: `工具上下文管理详解`')
    expect(textContent).toContain(
      '    - `exported_at`: `2026-04-09T12:10:14.480Z`',
    )
    expect(textContent).toContain('    - `draft`: `false`')
    expect(textContent).not.toContain('`position`')
  })

  it('uses full content for explicit files in full mode', async () => {
    const explicitFile = createMockFile('notes/explicit.md')
    const folderFile = createMockFile('docs/from-folder.md')
    const folder = createMockFolder('docs', [folderFile])

    const fileContents = new Map<string, string>([
      [explicitFile.path, '# Explicit\nBody'],
      [folderFile.path, '## Folder Heading\nFolder body'],
    ])

    const app = createMockApp({
      files: [explicitFile, folderFile],
      folders: [folder],
      fileContents,
    })

    const builder = new RequestContextBuilder(
      app as never,
      {
        ...settings,
        chatOptions: {
          includeCurrentFileContent: true,
          mentionContextMode: 'full',
        },
      } as unknown as YoloSettings,
    )

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([
        { type: 'file', file: explicitFile },
        { type: 'folder', folder },
      ]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain(
      '## Mentioned Vault Files (full content already provided below)',
    )
    expect(textContent).toContain('- `notes/explicit.md` (2 lines)')
    expect(textContent).toContain(
      'Do NOT call any file-reading tool (e.g. read_file) to re-read them',
    )
    expect(textContent).toContain(
      '### `notes/explicit.md` (full content, 2 lines)',
    )
    expect(textContent).toContain(
      '```notes/explicit.md\n1|# Explicit\n2|Body\n```',
    )
    expect(textContent).toContain('## Mentioned Vault Folders\n- `docs`')
    expect(textContent).toContain(
      'Folder file preview (paths only):\n  - `docs/from-folder.md`',
    )
    expect(textContent).not.toContain('L1 ## Folder Heading')
    expect(textContent).not.toContain('Folder body')
  })

  it('omits the full-content section when all mentioned files fail to read', async () => {
    const explicitFile = createMockFile('notes/unreadable.md')

    const app = createMockApp({
      files: [explicitFile],
      fileContents: new Map(),
    })
    ;(app.vault.cachedRead as jest.Mock).mockImplementation(async () => {
      throw new Error('forced read failure')
    })

    const builder = new RequestContextBuilder(
      app as never,
      {
        ...settings,
        chatOptions: {
          includeCurrentFileContent: true,
          mentionContextMode: 'full',
        },
      } as unknown as YoloSettings,
    )

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'file', file: explicitFile }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).not.toContain(
      '## Mentioned Vault Files (full content already provided below)',
    )
    expect(textContent).not.toContain('### `notes/unreadable.md`')
  })

  it('reports zero lines for empty files in full mode', async () => {
    const emptyFile = createMockFile('notes/empty.md')

    const app = createMockApp({
      files: [emptyFile],
      fileContents: new Map([[emptyFile.path, '']]),
    })

    const builder = new RequestContextBuilder(
      app as never,
      {
        ...settings,
        chatOptions: {
          includeCurrentFileContent: true,
          mentionContextMode: 'full',
        },
      } as unknown as YoloSettings,
    )

    const result = await builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'file', file: emptyFile }]),
    })

    const textContent = getTextContent(result.promptContent)

    expect(textContent).toContain('- `notes/empty.md` (0 lines)')
    expect(textContent).toContain(
      '### `notes/empty.md` (full content, 0 lines)',
    )
    expect(textContent).toContain('```notes/empty.md\n\n```')
  })
})

describe('RequestContextBuilder MinerU PDF mention integration', () => {
  const visionModel = {
    id: 'vision-model',
    providerId: 'openai',
    name: 'Vision',
    modalities: ['text', 'vision'],
  } as unknown as ChatModel
  const textOnlyModel = {
    id: 'text-model',
    providerId: 'openai',
    name: 'Text',
    modalities: ['text'],
  } as unknown as ChatModel

  const MINERU_IMAGE_VAULT_PATH = 'YOLO/mineru-cache/abc/images/fig1.png'

  const buildSettings = (model: ChatModel) =>
    ({
      systemPrompt: '',
      currentAssistantId: undefined,
      assistants: [],
      chatModelId: model.id,
      chatModels: [model],
      chatOptions: {
        includeCurrentFileContent: true,
        mentionContextMode: 'full',
      },
      mineru: { enabled: true, baseUrl: 'http://localhost:7860', apiKey: '' },
      skills: {},
    }) as unknown as YoloSettings

  beforeEach(() => {
    ;(convertPdfViaMinerU as jest.Mock).mockReset()
    ;(convertPdfViaMinerU as jest.Mock).mockResolvedValue({
      markdown: '# MinerU PDF\n\n![figure](images/fig1.png)',
      images: [{ name: 'fig1.png', vaultPath: MINERU_IMAGE_VAULT_PATH }],
    })
  })

  const compilePdfMention = async (model: ChatModel) => {
    const pdfFile = createMockFile('notes/paper.pdf')
    const imageFile = createMockFile(MINERU_IMAGE_VAULT_PATH)
    const app = createMockApp({
      files: [pdfFile, imageFile],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(
      app as never,
      buildSettings(model),
    )
    return builder.compileUserMessagePrompt({
      message: createUserMessage([{ type: 'file', file: pdfFile }]),
    })
  }

  it('includes md text + resolved image parts for a vision-capable model', async () => {
    const result = await compilePdfMention(visionModel)

    const parts = result.promptContent as ContentPart[]
    expect(Array.isArray(parts)).toBe(true)
    const textPart = parts.find((part) => part.type === 'text')
    expect(textPart?.type === 'text' && textPart.text).toContain('# MinerU PDF')
    // Image reference in the markdown was rewritten to the vault path.
    expect(textPart?.type === 'text' && textPart.text).toContain(
      `![figure](${MINERU_IMAGE_VAULT_PATH})`,
    )
    // No legacy per-page text extraction was used.
    expect(textPart?.type === 'text' && textPart.text).not.toContain('<page ')
    // Resolved ref is shipped as an image part.
    expect(parts).toEqual(
      expect.arrayContaining([
        {
          type: 'image_url',
          image_url: { url: 'data:image/png;base64,fake' },
        },
      ]),
    )
    expect(convertPdfViaMinerU).toHaveBeenCalledTimes(1)
  })

  it('includes only md text for a text-only model (no image parts)', async () => {
    const result = await compilePdfMention(textOnlyModel)

    const parts = result.promptContent as ContentPart[]
    expect(parts.some((part) => part.type === 'image_url')).toBe(false)
    const textPart = parts.find((part) => part.type === 'text')
    expect(textPart?.type === 'text' && textPart.text).toContain('# MinerU PDF')
  })
})

describe('RequestContextBuilder generateRequestMessages', () => {
  const settings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    yolo: { baseDir: 'YOLO' },
    chatOptions: {
      includeCurrentFileContent: false,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  const emptyArgs = createCompleteToolCallArguments({ value: {} })

  it('replays historical attachment/skill prompts from snapshots without recompiling them', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>
    const builder = new RequestContextBuilder(app as never, settings)
    const compileSpy = jest.spyOn(builder, 'compileUserMessagePrompt')
    mockReadPromptSnapshotEntries.mockResolvedValueOnce({
      'historical-hash': 'frozen historical skill prompt',
    })

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'user',
          id: 'historical',
          content: null,
          promptContent: null,
          snapshotRef: { hash: 'historical-hash' },
          mentionables: [],
          selectedSkills: [
            { name: 'old-skill', description: 'old', path: 'old/SKILL.md' },
          ],
        },
        {
          role: 'assistant',
          id: 'assistant',
          content: 'done',
        },
        {
          role: 'user',
          id: 'latest',
          content: null,
          promptContent: null,
          mentionables: [],
        },
      ],
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-snapshot',
      systemPromptSnapshotMode: 'create',
    })

    expect(compileSpy).toHaveBeenCalledTimes(1)
    expect(compileSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ id: 'latest' }),
      }),
    )
    expect(requestMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'user',
          content: 'frozen historical skill prompt',
        }),
      ]),
    )
  })

  it('includes a rejection reason in the model tool result', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>
    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'read the file',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: '',
          toolCallRequests: [
            {
              id: 'read-1',
              name: 'yolo_local__fs_read',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-1',
          toolCalls: [
            {
              request: {
                id: 'read-1',
                name: 'yolo_local__fs_read',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Rejected,
                reason:
                  'Path "Private/secret.md" is outside this agent\'s workspace scope.',
              },
            },
          ],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      systemPromptSnapshotMode: 'create',
    })

    expect(
      requestMessages.find(
        (message) =>
          message.role === 'tool' && message.tool_call.id === 'read-1',
      ),
    ).toMatchObject({
      content:
        'Tool call read-1 was rejected: Path "Private/secret.md" is outside this agent\'s workspace scope.',
    })
  })

  it('hides pruned tool results from future request context', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'first prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-tool',
          content: '',
          toolCallRequests: [
            {
              id: 'edit-1',
              name: 'yolo_local__fs_edit',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-edit',
          toolCalls: [
            {
              request: {
                id: 'edit-1',
                name: 'yolo_local__fs_edit',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'fs_edit',
                    path: 'note.md',
                    status: 'ok',
                  }),
                },
              },
            },
          ],
        },
        {
          role: 'assistant',
          id: 'assistant-prune',
          content: '',
          toolCallRequests: [
            {
              id: 'prune-1',
              name: 'yolo_local__context_prune_tool_results',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-prune',
          toolCalls: [
            {
              request: {
                id: 'prune-1',
                name: 'yolo_local__context_prune_tool_results',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'context_prune_tool_results',
                    operation: 'prune_selected',
                    acceptedToolCallIds: ['edit-1'],
                    ignoredToolCallIds: [],
                  }),
                },
              },
            },
          ],
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'follow-up prompt',
          mentionables: [],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      systemPromptSnapshotMode: 'create',
    })

    expect(
      requestMessages.some(
        (message) =>
          message.role === 'tool' && message.tool_call.id === 'edit-1',
      ),
    ).toBe(false)
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'assistant' &&
          (message.tool_calls ?? []).some(
            (toolCall) => toolCall.id === 'edit-1',
          ),
      ),
    ).toBe(false)
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'tool' && message.tool_call.id === 'prune-1',
      ),
    ).toBe(true)
  })

  it('injects compact summary and retains the latest assistant tool boundary', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'old prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'old answer',
        },
        {
          role: 'assistant',
          id: 'assistant-tools',
          content: 'checking files',
          toolCallRequests: [
            {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-compact',
          toolCalls: [
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'context_compact',
                    toolCallId: 'compact-1',
                    operation: 'compact_restart',
                  }),
                },
              },
            },
          ],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: {
        anchorMessageId: 'tool-compact',
        summary: 'Earlier history summary',
        compactedAt: 1,
        triggerToolCallId: 'compact-1',
      },
    })

    expect(requestMessages[1]).toEqual({
      role: 'user',
      content: expect.stringContaining('Earlier history summary'),
    })
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'assistant' && message.content === 'checking files',
      ),
    ).toBe(true)
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'tool' && message.tool_call.id === 'compact-1',
      ),
    ).toBe(true)
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'assistant' && message.content === 'old answer',
      ),
    ).toBe(false)
    expect(requestMessages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining(
        'Resume the task that was active immediately before compaction.',
      ),
    })
  })

  it('does not append compact resume instruction after a new user turn', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'assistant',
          id: 'assistant-tools',
          content: 'checking files',
          toolCallRequests: [
            {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-compact',
          toolCalls: [
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'context_compact',
                    toolCallId: 'compact-1',
                    operation: 'compact_restart',
                  }),
                },
              },
            },
          ],
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'new turn after compact',
          mentionables: [],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: {
        anchorMessageId: 'tool-compact',
        summary: 'Earlier history summary',
        compactedAt: 1,
        triggerToolCallId: 'compact-1',
      },
    })

    expect(requestMessages.at(-1)).toEqual({
      role: 'user',
      content: 'new turn after compact',
    })
  })

  it('injects manual compaction summary even without a compact tool boundary', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'old prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'old answer',
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: {
        anchorMessageId: 'assistant-1',
        summary: 'Earlier history summary',
        compactedAt: 1,
      },
    })

    expect(requestMessages[1]).toEqual({
      role: 'user',
      content: expect.stringContaining('Earlier history summary'),
    })
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'assistant' && message.content === 'old answer',
      ),
    ).toBe(false)
    expect(requestMessages.at(-1)).toEqual({
      role: 'user',
      content: expect.stringContaining(
        'Resume the task that was active immediately before compaction.',
      ),
    })
  })

  it('retainRecentTurns compaction replaces only the window before the retention start', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'old phase prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'old phase answer',
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'retained turn prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-2',
          content: 'retained turn answer',
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      // retainRecentTurns anchors at the message before the retention start
      // and records no trigger tool call id.
      compaction: {
        anchorMessageId: 'assistant-1',
        summary: 'Earlier phase summary',
        compactedAt: 1,
      },
    })

    const summaryIndex = requestMessages.findIndex(
      (message) =>
        message.role === 'user' &&
        typeof message.content === 'string' &&
        message.content.includes('Earlier phase summary'),
    )
    expect(summaryIndex).toBeGreaterThanOrEqual(0)
    // The retained window (user-2 onward) must survive after the summary.
    const retainedIndex = requestMessages.findIndex(
      (message) =>
        message.role === 'user' && message.content === 'retained turn prompt',
    )
    expect(retainedIndex).toBeGreaterThan(summaryIndex)
    expect(
      requestMessages.some(
        (message) =>
          message.role === 'assistant' &&
          message.content === 'old phase answer',
      ),
    ).toBe(false)
  })

  it('uses the latest compaction entry when multiple compactions exist', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'old prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'old answer',
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'new follow-up',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-2',
          content: 'new answer',
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: [
        {
          anchorMessageId: 'assistant-1',
          summary: 'Earlier history summary',
          compactedAt: 1,
        },
        {
          anchorMessageId: 'assistant-2',
          summary: 'Latest history summary',
          compactedAt: 2,
        },
      ],
    })

    expect(requestMessages[1]).toEqual({
      role: 'user',
      content: expect.stringContaining('Latest history summary'),
    })
    expect(requestMessages[1]).not.toEqual({
      role: 'user',
      content: expect.stringContaining('Earlier history summary'),
    })
  })

  it('does not reuse an older compact tool boundary after a newer manual compaction', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'old prompt',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'old answer',
        },
        {
          role: 'assistant',
          id: 'assistant-tools',
          content: '好的，我来帮您压缩上下文。',
          toolCallRequests: [
            {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-compact',
          toolCalls: [
            {
              request: {
                id: 'compact-1',
                name: 'yolo_local__context_compact',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: JSON.stringify({
                    tool: 'context_compact',
                    toolCallId: 'compact-1',
                    operation: 'compact_restart',
                  }),
                },
              },
            },
          ],
        },
        {
          role: 'assistant',
          id: 'assistant-after-compact',
          content: '上下文压缩已完成。现在我们可以继续工作了。',
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: '在吗',
          mentionables: [],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-1',
      compaction: [
        {
          anchorMessageId: 'tool-compact',
          summary: 'Earlier history summary',
          compactedAt: 1,
          triggerToolCallId: 'compact-1',
        },
        {
          anchorMessageId: 'assistant-after-compact',
          summary: 'Latest manual summary',
          compactedAt: 2,
        },
      ],
    })

    expect(requestMessages).toEqual([
      expect.objectContaining({ role: 'system' }),
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('Latest manual summary'),
      }),
      {
        role: 'user',
        content: '在吗',
      },
    ])
  })

  it('preserves all messages when history exceeds 32', async () => {
    const app = {
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
      },
    } as unknown as ReturnType<typeof createMockApp>

    const builder = new RequestContextBuilder(app as never, settings)

    // Build 34 messages (17 user + 17 assistant alternating), first user is the one we track
    const historyMessages: Parameters<
      typeof builder.generateRequestMessages
    >[0]['messages'] = []
    for (let i = 0; i < 34; i++) {
      if (i % 2 === 0) {
        historyMessages.push({
          role: 'user',
          id: `user-${i}`,
          content: null,
          promptContent: i === 0 ? 'first user message' : `user message ${i}`,
          mentionables: [],
        })
      } else {
        historyMessages.push({
          role: 'assistant',
          id: `assistant-${i}`,
          content: `assistant reply ${i}`,
        })
      }
    }

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: historyMessages,
      hasTools: false,
      hasMemoryTools: false,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conversation-truncation-regression',
    })

    const systemMessages = requestMessages.filter((m) => m.role === 'system')
    const nonSystemMessages = requestMessages.filter((m) => m.role !== 'system')

    // No truncation: total = system + all 34 history messages
    expect(requestMessages).toHaveLength(systemMessages.length + 34)

    // First non-system message must be the earliest user message
    expect(nonSystemMessages[0]).toEqual({
      role: 'user',
      content: 'first user message',
    })
  })
})

describe('RequestContextBuilder project instructions injection', () => {
  function makeApp(rootFiles: Map<string, string>) {
    return {
      metadataCache: { getFileCache: jest.fn(() => null) },
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
        cachedRead: jest.fn(async (file: { path: string }) => {
          return rootFiles.get(file.path) ?? ''
        }),
        getAbstractFileByPath: jest.fn((path: string) => {
          if (!rootFiles.has(path)) return null
          const file = Object.assign(new TFile(), { path })
          ;(
            file as unknown as { parent: InstanceType<typeof TFolder> }
          ).parent = Object.assign(new TFolder(), { path: '', parent: null })
          return file
        }),
        getRoot: jest.fn(() =>
          Object.assign(new TFolder(), { path: '', parent: null }),
        ),
        getFileByPath: jest.fn(() => null),
        getFolderByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
      },
    }
  }

  const baseSettings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    chatOptions: {
      includeCurrentFileContent: true,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  async function buildSystemContent(
    app: ReturnType<typeof makeApp>,
    settings: YoloSettings,
  ): Promise<string> {
    const builder = new RequestContextBuilder(app as never, settings)
    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'hi',
          mentionables: [],
        },
      ],
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conv-pi',
    })
    const system = requestMessages.find((m) => m.role === 'system')
    expect(system).toBeDefined()
    return typeof system!.content === 'string' ? system!.content : ''
  }

  it('does not inject project instructions by default (no assistant selected)', async () => {
    const app = makeApp(
      new Map([
        ['AGENTS.md', 'rule from agents'],
        ['CLAUDE.md', 'rule from claude'],
      ]),
    )
    const content = await buildSystemContent(app, baseSettings)
    expect(content).not.toContain('## Project instructions: AGENTS.md')
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
  })

  it('injects AGENTS.md and CLAUDE.md when current assistant enables it explicitly', async () => {
    const app = makeApp(
      new Map([
        ['AGENTS.md', 'rule from agents'],
        ['CLAUDE.md', 'rule from claude'],
      ]),
    )
    const settings = {
      ...baseSettings,
      currentAssistantId: 'a-1',
      assistants: [
        {
          id: 'a-1',
          name: 'Enabled',
          systemPrompt: '',
          enableProjectInstructions: true,
        },
      ],
    } as unknown as YoloSettings
    const content = await buildSystemContent(app, settings)
    expect(content).toContain('## Project instructions: AGENTS.md')
    expect(content).toContain('rule from agents')
    expect(content).toContain('## Project instructions: CLAUDE.md')
    expect(content).toContain('rule from claude')
    // Project instructions should appear after the base behavior section,
    // not as the first thing in the system message.
    const projectIdx = content.indexOf('project instructions in the vault')
    expect(projectIdx).toBeGreaterThan(0)
  })

  it('resolves project instructions from a workspace agent template', async () => {
    const app = makeApp(new Map([['AGENTS.md', 'workspace rule']]))
    const settings = {
      ...baseSettings,
      currentAssistantId: 'workspace-1',
      assistants: [
        {
          id: 'template-1',
          name: 'Template',
          systemPrompt: '',
          enableProjectInstructions: true,
        },
      ],
      workspaceAgents: [
        {
          id: 'workspace-1',
          name: 'Workspace 1',
          templateId: 'template-1',
          workspacePolicy: {
            workspaceRoot: 'Projects/One',
            readAllowlist: [],
            readDenylist: [],
            writeDenylist: [],
          },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    } as unknown as YoloSettings

    const content = await buildSystemContent(app, settings)

    expect(content).toContain('## Project instructions: AGENTS.md')
    expect(content).toContain('workspace rule')
  })

  it('omits project instructions when current assistant disables it explicitly', async () => {
    const app = makeApp(new Map([['CLAUDE.md', 'rule from claude']]))
    const settings = {
      ...baseSettings,
      currentAssistantId: 'a-1',
      assistants: [
        {
          id: 'a-1',
          name: 'Disabled',
          systemPrompt: '',
          enableProjectInstructions: false,
        },
      ],
    } as unknown as YoloSettings
    const content = await buildSystemContent(app, settings)
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
    expect(content).not.toContain('rule from claude')
  })

  it('defaults to disabled when currentAssistantId points to a non-existent assistant', async () => {
    const app = makeApp(new Map([['CLAUDE.md', 'rule from claude']]))
    const settings = {
      ...baseSettings,
      currentAssistantId: 'missing-id',
      assistants: [
        {
          id: 'other-id',
          name: 'Other',
          systemPrompt: '',
          enableProjectInstructions: true,
        },
      ],
    } as unknown as YoloSettings
    const content = await buildSystemContent(app, settings)
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
    expect(content).not.toContain('rule from claude')
  })

  it('defaults to disabled when assistant exists but enableProjectInstructions is undefined', async () => {
    const app = makeApp(new Map([['CLAUDE.md', 'rule from claude']]))
    const settings = {
      ...baseSettings,
      currentAssistantId: 'a-1',
      assistants: [{ id: 'a-1', name: 'Default', systemPrompt: '' }],
    } as unknown as YoloSettings
    const content = await buildSystemContent(app, settings)
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
  })

  it('omits project instructions section when neither file exists', async () => {
    const app = makeApp(new Map())
    const content = await buildSystemContent(app, baseSettings)
    expect(content).not.toContain('## Project instructions: AGENTS.md')
    expect(content).not.toContain('## Project instructions: CLAUDE.md')
    expect(content).not.toContain('project instructions in the vault')
  })
})

describe('RequestContextBuilder generateRequestMessages currentFile merging', () => {
  const baseSettings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    chatOptions: {
      includeCurrentFileContent: true,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  function makeApp() {
    return {
      metadataCache: { getFileCache: jest.fn(() => null) },
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
        cachedRead: jest.fn(async () => ''),
        getFileByPath: jest.fn(() => null),
        getFolderByPath: jest.fn(() => null),
      },
    }
  }

  it('merges currentFileMessage into last user message content parts when last history message is user', async () => {
    const app = makeApp()
    const builder = new RequestContextBuilder(app as never, baseSettings)
    const currentFile = createMockFile('notes/focus.md')

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'hello',
          mentionables: [],
        },
      ],
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conv-1',
      contextualInjections: [
        { type: 'current-file-pointer', file: currentFile },
      ],
    })

    // Should have system + 1 user (not system + 2 user)
    const userMessages = requestMessages.filter((m) => m.role === 'user')
    expect(userMessages).toHaveLength(1)

    // The single user message content must be an array (merged ContentPart[])
    const lastUser = userMessages[0]
    expect(Array.isArray(lastUser.content)).toBe(true)
    const parts = lastUser.content as Array<{ type: string; text?: string }>
    const textParts = parts.filter((p) => p.type === 'text')
    // Original promptContent text
    expect(textParts.some((p) => p.text?.includes('hello'))).toBe(true)
    // Current-file pointer text
    expect(textParts.some((p) => p.text?.includes('notes/focus.md'))).toBe(true)
  })

  it('appends currentFileMessage as independent user message when last history message is not user (agent loop continuation)', async () => {
    const app = makeApp()
    const emptyArgs = createCompleteToolCallArguments({ value: {} })
    const builder = new RequestContextBuilder(app as never, baseSettings)
    const currentFile = createMockFile('notes/focus.md')

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'do something',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: '',
          toolCallRequests: [
            {
              id: 'tool-call-1',
              name: 'yolo_local__fs_read',
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-1',
          toolCalls: [
            {
              request: {
                id: 'tool-call-1',
                name: 'yolo_local__fs_read',
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: { type: 'text', text: 'file content' },
              },
            },
          ],
        },
      ],
      hasTools: true,
      model: {
        provider: 'openai',
        model: 'gpt-test',
        name: 'gpt-test',
      } as never,
      conversationId: 'conv-2',
      contextualInjections: [
        { type: 'current-file-pointer', file: currentFile },
      ],
    })

    // Last message should be an independent user message containing the current-file pointer
    const lastMsg = requestMessages.at(-1)
    expect(lastMsg?.role).toBe('user')
    const content = lastMsg?.content
    const text =
      typeof content === 'string'
        ? content
        : Array.isArray(content)
          ? (content as Array<{ type: string; text?: string }>)
              .filter((p) => p.type === 'text')
              .map((p) => p.text)
              .join('')
          : ''
    expect(text).toContain('notes/focus.md')

    // The original user message should still exist separately
    const userMessages = requestMessages.filter((m) => m.role === 'user')
    expect(userMessages.length).toBeGreaterThanOrEqual(2)
  })
})

describe('stripUnsupportedImages', () => {
  const visionModel = {
    id: 'v/vision',
    modalities: ['text', 'vision'],
  } as unknown as ChatModel

  const textOnlyModel = {
    id: 'v/text',
    modalities: ['text'],
  } as unknown as ChatModel

  const imageUrlPart: ContentPart = {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAA' },
  }
  const textPart: ContentPart = { type: 'text', text: 'hello' }

  it('returns messages unchanged when model supports vision', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: [imageUrlPart, textPart] },
    ]
    expect(stripUnsupportedImages(messages, visionModel)).toBe(messages)
  })

  it('replaces image_url parts with placeholder text for text-only model', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: [imageUrlPart, textPart] },
    ]
    const result = stripUnsupportedImages(messages, textOnlyModel)
    expect(result).not.toBe(messages)
    const content = result[0]?.content as ContentPart[]
    expect(content).toHaveLength(2)
    expect(content[0]).toEqual({
      type: 'text',
      text: '[图片已省略：模型不支持视觉]',
    })
    expect(content[1]).toEqual(textPart)
  })

  it('handles user message that is all images — result has only placeholder text parts', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: [imageUrlPart, imageUrlPart] },
    ]
    const result = stripUnsupportedImages(messages, textOnlyModel)
    const content = result[0]?.content as ContentPart[]
    expect(content).toHaveLength(2)
    expect(content.every((p) => p.type === 'text')).toBe(true)
  })

  it('does not touch messages whose content is a string', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: 'plain text' },
      { role: 'system', content: 'system prompt' },
    ]
    const result = stripUnsupportedImages(messages, textOnlyModel)
    expect(result[0]?.content).toBe('plain text')
    expect(result[1]?.content).toBe('system prompt')
  })

  it('strips images from a user message appended after tool calls (tool image path)', () => {
    // Images from tool calls are appended as a user message with content array
    const messages: RequestMessage[] = [
      {
        role: 'tool',
        tool_call: {
          id: 'tc1',
          name: 'fs_read',
          arguments: createCompleteToolCallArguments({ value: {} }),
        },
        content: 'text result',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: '[Images from tool call: fs_read]' },
          imageUrlPart,
        ],
      },
    ]
    const result = stripUnsupportedImages(messages, textOnlyModel)
    // tool message untouched (string content)
    expect(result[0]?.content).toBe('text result')
    // user message: image replaced
    const userContent = result[1]?.content as ContentPart[]
    expect(userContent[1]).toEqual({
      type: 'text',
      text: '[图片已省略：模型不支持视觉]',
    })
  })

  it('strips images when model is null (conservative: unknown model treated as text-only)', () => {
    const messages: RequestMessage[] = [
      { role: 'user', content: [imageUrlPart] },
    ]
    // null model → chatModelSupportsVision returns false → images stripped
    const result = stripUnsupportedImages(messages, null)
    const content = result[0]?.content as ContentPart[]
    expect(content[0]).toEqual({
      type: 'text',
      text: '[图片已省略：模型不支持视觉]',
    })
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// parseToolMessage document hoisting
// ──────────────────────────────────────────────────────────────────────────────

describe('parseToolMessage document hoisting', () => {
  const emptyArgs = createCompleteToolCallArguments({ value: {} })

  const mockApp = {
    vault: {
      adapter: {
        exists: jest.fn().mockResolvedValue(false),
        mkdir: jest.fn().mockResolvedValue(undefined),
        read: jest.fn().mockResolvedValue(''),
        write: jest.fn().mockResolvedValue(undefined),
      },
    },
  }

  const mockSettings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    yolo: { baseDir: 'YOLO' },
    chatOptions: {
      includeCurrentFileContent: false,
      mentionContextMode: 'light',
    },
    skills: {},
    // A PDF-capable model so prepareDocumentsForModel doesn't strip document parts.
    chatModels: [
      {
        id: 'pdf-provider/pdf-model',
        providerId: 'pdf-provider',
        model: 'pdf-model',
        modalities: ['text', 'vision', 'pdf'],
      },
    ],
  } as unknown as YoloSettings

  // Use this model ID when building request messages so the PDF modality gate passes.
  const PDF_MODEL_ID = 'pdf-provider/pdf-model'

  it('limits tool results in request context without changing the stored result', () => {
    const settings = {
      ...mockSettings,
      chatOptions: {
        ...mockSettings.chatOptions,
        toolResultMaxChars: 1_024,
      },
    } as YoloSettings
    const builder = new RequestContextBuilder(mockApp as never, settings)
    const storedText = 'x'.repeat(4_000)
    const message: ChatToolMessage = {
      role: 'tool',
      id: 'tool-1',
      toolCalls: [
        {
          request: {
            id: 'tc-1',
            name: 'yolo_bridge__plugin_read',
            arguments: emptyArgs,
          },
          response: {
            status: ToolCallResponseStatus.Success,
            data: { type: 'text', text: storedText },
          },
        },
      ],
    }

    const requestMessages = builder.parseTurnMessagesToRequestMessages([
      {
        role: 'assistant',
        id: 'assistant-1',
        content: '',
        toolCallRequests: [
          {
            id: 'tc-1',
            name: 'yolo_bridge__plugin_read',
            arguments: emptyArgs,
          },
        ],
      },
      message,
    ])
    const requestTool = requestMessages.find((item) => item.role === 'tool')

    expect(
      requestTool?.role === 'tool' ? requestTool.content.length : undefined,
    ).toBeLessThanOrEqual(1_024)
    expect(message.toolCalls[0]?.response.status).toBe(
      ToolCallResponseStatus.Success,
    )
    if (
      message.toolCalls[0]?.response.status === ToolCallResponseStatus.Success
    ) {
      expect(message.toolCalls[0].response.data.text).toBe(storedText)
    }
  })

  /**
   * Build a minimal conversation with one assistant turn (with tool calls),
   * one tool response turn carrying the given contentParts, and a final user
   * message. Returns the generated request messages.
   */
  const buildMessagesWithToolResponse = async (
    toolName: string,
    contentParts: ContentPart[],
  ) => {
    const builder = new RequestContextBuilder(mockApp as never, mockSettings)
    return builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'read some file',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'asst-1',
          content: 'ok',
          toolCallRequests: [
            {
              id: 'tc-1',
              name: toolName,
              arguments: emptyArgs,
            },
          ],
        },
        {
          role: 'tool',
          id: 'tool-1',
          toolCalls: [
            {
              request: {
                id: 'tc-1',
                name: toolName,
                arguments: emptyArgs,
              },
              response: {
                status: ToolCallResponseStatus.Success,
                data: {
                  type: 'text',
                  text: 'tool result text',
                  contentParts,
                },
              },
            },
          ],
        },
        {
          role: 'user',
          id: 'user-2',
          content: null,
          promptContent: 'follow-up',
          mentionables: [],
        },
      ],
      hasTools: true,
      hasMemoryTools: false,
      // Use a PDF-capable model so prepareDocumentsForModel passes document parts through.
      model: {
        id: PDF_MODEL_ID,
        providerId: 'pdf-provider',
        model: 'pdf-model',
        name: 'pdf-model',
        modalities: ['text', 'vision', 'pdf'],
      } as never,
      conversationId: 'conv-doc-hoist',
    })
  }

  it('hoists document part from tool response into follow-up user message', async () => {
    const documentPart: ContentPart = {
      type: 'document',
      mediaType: 'application/pdf',
      name: 'report.pdf (pages 1–3)',
      data: 'base64data',
      pageCount: 3,
    }

    const messages = await buildMessagesWithToolResponse(
      'yolo_local__fs_read',
      [documentPart],
    )

    // There should be a user message with the document part and a header label.
    const userMessages = messages.filter((m) => m.role === 'user')
    const hoistMsg = userMessages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'document'),
    )
    expect(hoistMsg).toBeDefined()
    const content = hoistMsg!.content as ContentPart[]
    const headerPart = content.find((p) => p.type === 'text')
    expect(headerPart?.type === 'text' && headerPart.text).toContain(
      'PDF attachments from tool call',
    )
    expect(headerPart?.type === 'text' && headerPart.text).toContain(
      'yolo_local__fs_read',
    )
    const docPart = content.find((p) => p.type === 'document')
    expect(docPart).toEqual(documentPart)
  })

  it('hoists image_url part alone → header is "Images from tool call"', async () => {
    const imagePart: ContentPart = {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,AAA' },
    }

    const messages = await buildMessagesWithToolResponse(
      'yolo_local__fs_read',
      [imagePart],
    )

    const userMessages = messages.filter((m) => m.role === 'user')
    const hoistMsg = userMessages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url'),
    )
    expect(hoistMsg).toBeDefined()
    const content = hoistMsg!.content as ContentPart[]
    const headerPart = content.find((p) => p.type === 'text')
    expect(headerPart?.type === 'text' && headerPart.text).toContain(
      'Images from tool call',
    )
  })

  it('mixed image + document → header is "Attachments from tool call"', async () => {
    const imagePart: ContentPart = {
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,BBB' },
    }
    const documentPart: ContentPart = {
      type: 'document',
      mediaType: 'application/pdf',
      name: 'file.pdf',
      data: 'base64',
    }

    const messages = await buildMessagesWithToolResponse(
      'yolo_local__fs_read',
      [imagePart, documentPart],
    )

    const userMessages = messages.filter((m) => m.role === 'user')
    const hoistMsg = userMessages.find(
      (m) =>
        Array.isArray(m.content) &&
        m.content.some((p) => p.type === 'image_url' || p.type === 'document'),
    )
    expect(hoistMsg).toBeDefined()
    const content = hoistMsg!.content as ContentPart[]
    const headerPart = content.find((p) => p.type === 'text')
    expect(headerPart?.type === 'text' && headerPart.text).toContain(
      'Attachments from tool call',
    )
  })
})

describe('RequestContextBuilder system prompt freezing', () => {
  const baseSettings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    yolo: { baseDir: 'YOLO' },
    chatOptions: {
      includeCurrentFileContent: false,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  const model = {
    provider: 'openai',
    model: 'gpt-test',
    name: 'gpt-test',
  } as never

  const userMessages: ChatUserMessage[] = [
    {
      role: 'user',
      id: 'u1',
      content: null,
      promptContent: 'hello',
      mentionables: [],
    },
  ]

  const memMock = jest.mocked(getMemoryPromptContext)

  const makeApp = () =>
    createMockApp({ files: [], fileContents: new Map() }) as never

  const getSystemContent = (messages: RequestMessage[]): string => {
    const system = messages.find((message) => message.role === 'system')
    if (!system || typeof system.content !== 'string') {
      throw new Error('Expected a string system message')
    }
    return system.content
  }

  // C4 splits memory into a stable snapshot path and a per-request dynamic
  // path: only the stable call receives the `salienceByMemoryKey` option, and
  // only it is subject to snapshot freezing. Call-count assertions below
  // therefore count stable-path calls only — the dynamic fallback re-reads
  // memory per request by design and must not fail the freeze assertions.
  const stableMemoryCalls = (): unknown[][] =>
    memMock.mock.calls.filter(
      (call) => 'salienceByMemoryKey' in (call[0] as Record<string, unknown>),
    )

  afterAll(() => {
    memMock.mockResolvedValue({ global: null, assistant: null })
  })

  it('does not include skill loading guidance in generic tool instructions', async () => {
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
    })

    memMock.mockResolvedValue({ global: null, assistant: null })

    const messages = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-no-skills',
      hasTools: true,
      systemPromptSnapshotMode: 'create',
    })

    const systemContent = getSystemContent(messages)
    expect(systemContent).toContain('You have access to tools')
    expect(systemContent).toContain(
      'Before calling file-reading tools, use relevant content already present in the conversation, especially <user_selected_content> and prior tool results.',
    )
    expect(systemContent).toContain(
      'Do not re-read the same or an overlapping range; if more context is necessary, read only the smallest missing range.',
    )
    expect(systemContent).not.toContain(
      'If available skills are listed, use yolo_local__fs_read',
    )
  })

  it('requires Obsidian-compatible math delimiters', async () => {
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
    })

    const messages = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-math-format',
      systemPromptSnapshotMode: 'create',
    })

    const systemContent = getSystemContent(messages)
    expect(systemContent).toContain(
      'use Obsidian-compatible LaTeX delimiters: $...$ for inline math and $$...$$ for display math',
    )
    expect(systemContent).toContain(
      'Put opening and closing $$ delimiters on separate lines.',
    )
    expect(systemContent).toContain('Do not use \\(...\\) or \\[...\\].')
  })

  it('describes the active workspace scope in the system prompt', async () => {
    const settings = {
      ...baseSettings,
      currentAssistantId: 'agent-1',
      assistants: [
        {
          id: 'agent-1',
          name: 'Scoped agent',
          systemPrompt: '',
          workspaceAccessPolicy: {
            enabled: true,
            workspaceRoot: '',
            readExtraIncludes: ['Notes', 'Projects'],
            readExcludes: ['Notes/Private'],
            writeExcludes: ['Notes/Private'],
          },
        },
      ],
    } as unknown as YoloSettings
    const builder = new RequestContextBuilder(makeApp(), settings, {
      includeSkills: false,
    })

    const messages = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-workspace-scope',
      hasTools: true,
      systemPromptSnapshotMode: 'create',
    })

    const systemContent = getSystemContent(messages)
    expect(systemContent).toContain(`<workspace_scope>
- Included paths: Notes, Projects`)
    expect(systemContent).toContain(
      'If the task requires an out-of-scope path, tell the user about the workspace restriction.',
    )
    // #577: exclude paths must never be surfaced to the model — the tool
    // layer enforces them regardless of what the prompt says.
    expect(systemContent).not.toContain('Notes/Private')
    expect(systemContent).not.toContain('Excluded paths')
  })

  it('lists delegatable assistant roles in the request context (delegatedRoleId discoverability)', async () => {
    const settings = {
      ...baseSettings,
      assistants: [
        { id: 'role-1', name: 'Research Analyst', delegatable: true },
        { id: 'role-2', name: 'Plain Helper' },
      ],
    } as unknown as YoloSettings
    const builder = new RequestContextBuilder(makeApp(), settings, {
      includeSkills: false,
    })

    const messages = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-delegatable-roles',
      hasTools: true,
      systemPromptSnapshotMode: 'create',
    })

    const systemContent = getSystemContent(messages)
    // The `delegate_subagent` schema promises "the available roles listed in
    // the request context" — the catalogue must be there, delegatable-only,
    // in the backup-compatible XML format.
    expect(systemContent).toContain(
      '<assistant id="role-1" name="Research Analyst" />',
    )
    expect(systemContent).not.toContain('role-2')
  })

  it('appends fixed runtime instructions and suppresses the catalogue when runtimeOverrides are set (S2 regression: delegated runs lost both)', async () => {
    const settings = {
      ...baseSettings,
      assistants: [
        { id: 'role-1', name: 'Research Analyst', delegatable: true },
      ],
    } as unknown as YoloSettings
    const builder = new RequestContextBuilder(makeApp(), settings, {
      includeSkills: false,
      runtimeOverrides: {
        fixedRuntimeInstructions: ['Isolate me from the parent conversation.'],
        suppressDelegatableAssistantCatalogue: true,
      },
    })

    const messages = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-delegated-overrides',
      hasTools: true,
      systemPromptSnapshotMode: 'create',
    })

    const systemContent = getSystemContent(messages)
    // RED before S2: the builder had no runtime-override mechanism at all —
    // the isolation instructions were missing and the catalogue was always
    // injected, even into delegated child runs that cannot dispatch roles.
    expect(systemContent).toContain('Isolate me from the parent conversation.')
    expect(systemContent).not.toContain('delegatable_assistants')
    expect(systemContent).not.toContain('role-1')
  })

  it('refreshes the frozen prompt when the delegatable role set changes', async () => {
    const store = new SystemPromptSnapshotStore()
    memMock.mockResolvedValue({ global: 'MEM', assistant: null })

    const builderA = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })
    const a = await builderA.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(a)).not.toContain('NEW_ROLE')

    // A newly delegatable assistant must refresh the frozen system prompt,
    // otherwise the model keeps answering from a stale role list.
    const builderB = new RequestContextBuilder(
      makeApp(),
      {
        ...baseSettings,
        assistants: [{ id: 'role-new', name: 'NEW_ROLE', delegatable: true }],
      } as unknown as YoloSettings,
      { includeSkills: false, systemPromptSnapshotStore: store },
    )
    const b = await builderB.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(b)).toContain('NEW_ROLE')
  })

  it('describes exclude-only scope as allowing all other vault paths', async () => {
    const settings = {
      ...baseSettings,
      currentAssistantId: 'agent-1',
      assistants: [
        {
          id: 'agent-1',
          name: 'Scoped agent',
          systemPrompt: '',
          workspaceAccessPolicy: {
            enabled: true,
            workspaceRoot: '',
            readExtraIncludes: [],
            readExcludes: ['Private'],
            writeExcludes: ['Private'],
          },
        },
      ],
    } as unknown as YoloSettings
    const builder = new RequestContextBuilder(makeApp(), settings, {
      includeSkills: false,
    })

    const messages = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-workspace-exclude-only',
      hasTools: true,
      systemPromptSnapshotMode: 'create',
    })

    const systemContent = getSystemContent(messages)
    expect(systemContent).toContain('<workspace_scope>')
    expect(systemContent).toContain(
      'Some vault paths are outside your working range.',
    )
    // #577: exclude paths must never be surfaced to the model — the tool
    // layer enforces them regardless of what the prompt says.
    expect(systemContent).not.toContain('Private')
    expect(systemContent).not.toContain('Included paths')
    expect(systemContent).not.toContain('Excluded paths')
  })

  it('omits an enabled but unrestricted workspace scope', async () => {
    const settings = {
      ...baseSettings,
      currentAssistantId: 'agent-1',
      assistants: [
        {
          id: 'agent-1',
          name: 'Unrestricted agent',
          systemPrompt: '',
          workspaceAccessPolicy: {
            enabled: true,
            workspaceRoot: '',
            readExtraIncludes: [],
            readExcludes: [],
            writeExcludes: [],
          },
        },
      ],
    } as unknown as YoloSettings
    const builder = new RequestContextBuilder(makeApp(), settings, {
      includeSkills: false,
    })

    const messages = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-workspace-unrestricted',
      hasTools: true,
      systemPromptSnapshotMode: 'create',
    })

    expect(getSystemContent(messages)).not.toContain('<workspace_scope>')
  })

  it('refreshes the frozen prompt when on-demand tool availability changes', async () => {
    const store = new SystemPromptSnapshotStore()
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })

    memMock.mockResolvedValue({ global: null, assistant: null })

    const withoutOnDemand = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-on-demand',
      hasTools: true,
      hasOnDemandTools: false,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(withoutOnDemand)).not.toContain('ON-DEMAND')

    const withOnDemand = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-on-demand',
      hasTools: true,
      hasOnDemandTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(withOnDemand)).toContain(
      'Some tools are ON-DEMAND stubs',
    )
  })

  it('always includes the authoritative tool policy', async () => {
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
    })

    const messages = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-tool-policy',
      hasTools: false,
      systemPromptSnapshotMode: 'create',
    })

    const systemContent = getSystemContent(messages)
    expect(systemContent).toContain('Only use tools exposed in this request')
    expect(systemContent).toContain(
      'Never simulate unavailable tool calls or claim an action succeeded without a successful tool result',
    )
  })

  it('freezes memory in the system prompt for the conversation lifetime (create mode)', async () => {
    const store = new SystemPromptSnapshotStore()
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })

    memMock.mockResolvedValue({ global: 'MEM_V1', assistant: null })
    memMock.mockClear()

    const first = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(first)).toContain('MEM_V1')

    // Memory is rewritten mid-conversation (e.g. a memory_add tool call).
    memMock.mockResolvedValue({ global: 'MEM_V2', assistant: null })

    const second = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    // Frozen: still V1, and stable memory was not re-read for the second
    // iteration (the per-request dynamic fallback re-read is C4 behavior).
    expect(getSystemContent(second)).toContain('MEM_V1')
    expect(getSystemContent(second)).not.toContain('MEM_V2')
    expect(stableMemoryCalls()).toHaveLength(1)

    // A fresh conversation picks up the latest memory.
    const other = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-2',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(other)).toContain('MEM_V2')
  })

  it('refreshes on the next real request after an external prompt source change', async () => {
    const store = new SystemPromptSnapshotStore()
    let revision = 0
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
      getPromptSourceRevision: () => revision,
    })

    memMock.mockResolvedValue({ global: 'MEM_V1', assistant: null })
    memMock.mockClear()

    const first = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(first)).toContain('MEM_V1')

    revision += 1
    memMock.mockResolvedValue({ global: 'MEM_EXTERNAL', assistant: null })

    const second = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })

    expect(getSystemContent(second)).toContain('MEM_EXTERNAL')
    expect(stableMemoryCalls()).toHaveLength(2)
  })

  it('refreshes memory in the system prompt after conversation compaction', async () => {
    const store = new SystemPromptSnapshotStore()
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })

    memMock.mockResolvedValue({ global: 'MEM_BEFORE_COMPACT', assistant: null })
    memMock.mockClear()

    const beforeCompact = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(beforeCompact)).toContain('MEM_BEFORE_COMPACT')

    memMock.mockResolvedValue({ global: 'MEM_AFTER_COMPACT', assistant: null })

    const afterMemoryWrite = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(afterMemoryWrite)).toContain('MEM_BEFORE_COMPACT')
    expect(getSystemContent(afterMemoryWrite)).not.toContain(
      'MEM_AFTER_COMPACT',
    )

    const afterCompact = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      compaction: {
        anchorMessageId: 'tool-compact',
        summary: 'Earlier context summary',
        compactedAt: 1,
        triggerToolCallId: 'compact-1',
      },
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(afterCompact)).toContain('MEM_AFTER_COMPACT')
    expect(stableMemoryCalls()).toHaveLength(2)
  })

  it('refreshes the snapshot when a prompt-relevant setting changes', async () => {
    const store = new SystemPromptSnapshotStore()
    memMock.mockResolvedValue({ global: 'MEM', assistant: null })

    const builderA = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })
    const a = await builderA.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(a)).not.toContain('CUSTOM_SP')

    // settings.systemPrompt changes -> fingerprint changes -> snapshot refreshes
    // even within the same conversationId (a new RCB instance, shared store).
    const builderB = new RequestContextBuilder(
      makeApp(),
      { ...baseSettings, systemPrompt: 'CUSTOM_SP' } as unknown as YoloSettings,
      { includeSkills: false, systemPromptSnapshotStore: store },
    )
    const b = await builderB.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(b)).toContain('CUSTOM_SP')
  })

  it('injects runtime mode prompt and refreshes when it changes', async () => {
    const store = new SystemPromptSnapshotStore()
    memMock.mockResolvedValue({ global: 'MEM', assistant: null })

    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })
    const ask = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      runtimeModePrompt: '<runtime_mode>Ask mode prompt</runtime_mode>',
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(ask)).toContain('Ask mode prompt')

    const agent = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(agent)).not.toContain('Ask mode prompt')
  })

  it('does NOT refresh the snapshot for a setting that never reaches the system prompt', async () => {
    const store = new SystemPromptSnapshotStore()
    memMock.mockResolvedValue({ global: 'MEM_V1', assistant: null })

    const builderA = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })
    const a = await builderA.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(a)).toContain('MEM_V1')

    // Memory changes AND an unrelated, non-system setting (chatOptions) changes.
    // The fingerprint must be unchanged, so the frozen V1 snapshot is kept.
    memMock.mockResolvedValue({ global: 'MEM_V2', assistant: null })
    const builderB = new RequestContextBuilder(
      makeApp(),
      {
        ...baseSettings,
        chatOptions: {
          includeCurrentFileContent: true,
          mentionContextMode: 'full',
        },
      } as unknown as YoloSettings,
      { includeSkills: false, systemPromptSnapshotStore: store },
    )
    const b = await builderB.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(b)).toContain('MEM_V1')
    expect(getSystemContent(b)).not.toContain('MEM_V2')
  })

  it('reuse mode never freezes ahead of the real request', async () => {
    const store = new SystemPromptSnapshotStore()
    const builder = new RequestContextBuilder(makeApp(), baseSettings, {
      includeSkills: false,
      systemPromptSnapshotStore: store,
    })

    memMock.mockResolvedValue({ global: 'MEM_V1', assistant: null })
    const estimate = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'reuse',
    })
    expect(getSystemContent(estimate)).toContain('MEM_V1')

    // The estimate must not have frozen V1: the real request sees current memory.
    memMock.mockResolvedValue({ global: 'MEM_V2', assistant: null })
    const real = await builder.generateRequestMessages({
      messages: userMessages,
      model,
      conversationId: 'conv-1',
      hasMemoryTools: true,
      systemPromptSnapshotMode: 'create',
    })
    expect(getSystemContent(real)).toContain('MEM_V2')
  })
})

describe('RequestContextBuilder C4 memory layering (stable snapshot / dynamic user block)', () => {
  const settings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    yolo: { baseDir: 'YOLO' },
    chatOptions: {
      includeCurrentFileContent: false,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  const model = {
    provider: 'openai',
    model: 'gpt-test',
    name: 'gpt-test',
  } as never

  const memMock = jest.mocked(getMemoryPromptContext)

  const makeApp = () =>
    createMockApp({ files: [], fileContents: new Map() }) as never

  const emptyArgs = createCompleteToolCallArguments({ value: {} })

  // Capture the file-wide default before this describe's tests override it,
  // and restore it in afterAll — never install a new default for later suites.
  const priorMemMockImplementation = memMock.getMockImplementation()

  afterAll(() => {
    memMock.mockImplementation(priorMemMockImplementation)
  })

  it('merges the dynamic memory block into the last real user message, preserving tool-loop order and input immutability (C4)', async () => {
    memMock.mockResolvedValue({ global: 'MEM_FALLBACK', assistant: null })

    const builder = new RequestContextBuilder(makeApp(), settings, {
      includeSkills: false,
    })

    const messages: ChatMessage[] = [
      {
        role: 'user',
        id: 'user-1',
        content: null,
        promptContent: 'hello',
        mentionables: [],
      },
      {
        role: 'assistant',
        id: 'assistant-tools',
        content: 'checking files',
        toolCallRequests: [
          {
            id: 'tool-1',
            name: 'yolo_local__fs_read',
            arguments: emptyArgs,
          },
        ],
      },
      {
        role: 'tool',
        id: 'tool-1-result',
        toolCalls: [
          {
            request: {
              id: 'tool-1',
              name: 'yolo_local__fs_read',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: { type: 'text', text: 'tool result' },
            },
          },
        ],
      },
    ]
    const inputCopy = structuredClone(messages)

    const requestMessages = await builder.generateRequestMessages({
      messages,
      model,
      conversationId: 'conv-c4-tool-loop',
      systemPromptSnapshotMode: 'create',
    })

    // The dynamic block is merged into the existing last user message — never
    // a fresh user message appended after the tool result.
    expect(requestMessages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
    ])
    expect(
      requestMessages.filter((message) => message.role === 'user'),
    ).toHaveLength(1)

    const lastUser = requestMessages.filter(
      (message) => message.role === 'user',
    )[0]
    expect(typeof lastUser.content).toBe('string')
    // RED before C4: no dynamic block exists at all (SQLite unavailable →
    // markdown bounded fallback must land in the current user message).
    expect(lastUser.content).toContain('<recalled_memory')
    expect(lastUser.content).toContain('MEM_FALLBACK')

    // Neither the input array nor the original ChatMessage objects change.
    expect(messages).toEqual(inputCopy)
  })

  it('attributes the dynamic block to a single memory.dynamic section and keeps memory.context stable (C4)', async () => {
    memMock.mockResolvedValue({ global: 'MEM_STABLE', assistant: null })

    const builder = new RequestContextBuilder(makeApp(), settings, {
      includeSkills: false,
    })

    const sections = await builder.generateRequestSections({
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'hello',
          mentionables: [],
        },
      ],
      model,
      conversationId: 'conv-c4-sections',
      systemPromptSnapshotMode: 'create',
    })

    const dynamicSections = sections.filter((section) =>
      section.id.startsWith('memory.dynamic.'),
    )
    // RED before C4: the dynamic block lives inside the frozen system section,
    // so there is no dedicated memory.dynamic section at all.
    expect(dynamicSections).toHaveLength(1)
    expect(dynamicSections[0]?.bucket).toBe('memory')
    const dynamicContent = dynamicSections[0]?.content
    expect(typeof dynamicContent).toBe('string')
    expect(dynamicContent).toContain('<recalled_memory')

    // The stable section survives with its snapshot identity.
    expect(sections.some((section) => section.id === 'memory.context')).toBe(
      true,
    )

    // The same block must not be double-counted under the conversation bucket.
    const conversation = sections.find((section) =>
      section.id.startsWith('conversation.'),
    )
    expect(conversation).toBeDefined()
    expect(JSON.stringify(conversation?.content)).not.toContain(
      '<recalled_memory',
    )
  })

  it('keeps request order across a compaction boundary — the block merges into the last real user message, never after the tool result (C4)', async () => {
    memMock.mockResolvedValue({ global: 'MEM_FALLBACK', assistant: null })

    const builder = new RequestContextBuilder(makeApp(), settings, {
      includeSkills: false,
    })

    const messages: ChatMessage[] = [
      {
        role: 'user',
        id: 'user-pre',
        content: null,
        promptContent: 'before compact',
        mentionables: [],
      },
      {
        role: 'assistant',
        id: 'assistant-compact',
        content: 'compacting',
        toolCallRequests: [
          {
            id: 'compact-1',
            name: 'yolo_local__context_compact',
            arguments: emptyArgs,
          },
        ],
      },
      {
        role: 'tool',
        id: 'tool-compact',
        toolCalls: [
          {
            request: {
              id: 'compact-1',
              name: 'yolo_local__context_compact',
              arguments: emptyArgs,
            },
            response: {
              status: ToolCallResponseStatus.Success,
              data: {
                type: 'text',
                text: JSON.stringify({
                  tool: 'context_compact',
                  toolCallId: 'compact-1',
                  operation: 'compact_restart',
                }),
              },
            },
          },
        ],
      },
      {
        role: 'user',
        id: 'user-2',
        content: null,
        promptContent: 'new turn after compact',
        mentionables: [],
      },
    ]
    const inputCopy = structuredClone(messages)

    const requestMessages = await builder.generateRequestMessages({
      messages,
      model,
      conversationId: 'conv-c4-compaction',
      hasTools: true,
      compaction: {
        anchorMessageId: 'tool-compact',
        summary: 'Earlier history summary',
        compactedAt: 1,
        triggerToolCallId: 'compact-1',
      },
      systemPromptSnapshotMode: 'create',
    })

    // Compaction summary message + the retained window; the dynamic block
    // merges into the last real user message (user-2) — never a fresh user
    // message appended after the tool result.
    expect(requestMessages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ])
    const lastMessage = requestMessages.at(-1)
    expect(lastMessage).toEqual(
      expect.objectContaining({
        role: 'user',
        content: expect.stringContaining('new turn after compact'),
      }),
    )
    expect(typeof lastMessage?.content).toBe('string')
    expect(lastMessage?.content).toContain('<recalled_memory')
    expect(lastMessage?.content).toContain('MEM_FALLBACK')
    expect(messages).toEqual(inputCopy)
  })

  it('keeps request order with no assistant selected — the block merges into the single user message before the assistant turn (C4)', async () => {
    memMock.mockResolvedValue({ global: 'MEM_FALLBACK', assistant: null })

    const builder = new RequestContextBuilder(makeApp(), settings, {
      includeSkills: false,
    })

    const requestMessages = await builder.generateRequestMessages({
      messages: [
        {
          role: 'user',
          id: 'user-1',
          content: null,
          promptContent: 'hello',
          mentionables: [],
        },
        {
          role: 'assistant',
          id: 'assistant-1',
          content: 'hi there',
        },
      ],
      model,
      conversationId: 'conv-c4-no-assistant',
      systemPromptSnapshotMode: 'create',
    })

    // No assistant configured: the recall partition is global, and the block
    // still lands in the existing user message — nothing is appended after
    // the assistant message.
    expect(requestMessages.map((message) => message.role)).toEqual([
      'system',
      'user',
      'assistant',
    ])
    const lastUser = requestMessages.filter(
      (message) => message.role === 'user',
    )[0]
    expect(typeof lastUser.content).toBe('string')
    expect(lastUser.content).toContain('<recalled_memory')
    expect(lastUser.content).toContain('MEM_FALLBACK')
  })
})

describe('RequestContextBuilder ChatContextPolicy (module chat modes)', () => {
  function makeApp(rootFiles: Map<string, string> = new Map()) {
    return {
      metadataCache: { getFileCache: jest.fn(() => null) },
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          mkdir: jest.fn().mockResolvedValue(undefined),
          read: jest.fn().mockResolvedValue(''),
          write: jest.fn().mockResolvedValue(undefined),
        },
        cachedRead: jest.fn(async (file: { path: string }) => {
          return rootFiles.get(file.path) ?? ''
        }),
        getAbstractFileByPath: jest.fn((path: string) => {
          if (!rootFiles.has(path)) return null
          const file = Object.assign(new TFile(), { path })
          ;(
            file as unknown as { parent: InstanceType<typeof TFolder> }
          ).parent = Object.assign(new TFolder(), { path: '', parent: null })
          return file
        }),
        getRoot: jest.fn(() =>
          Object.assign(new TFolder(), { path: '', parent: null }),
        ),
        getFileByPath: jest.fn(() => null),
        getFolderByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
      },
    }
  }

  const model = {
    provider: 'openai',
    model: 'gpt-test',
    name: 'gpt-test',
  } as never

  const settingsWithAssistant = {
    systemPrompt: 'GLOBAL_SYSTEM_PROMPT',
    currentAssistantId: 'agent-1',
    assistants: [
      {
        id: 'agent-1',
        name: 'Scoped agent',
        systemPrompt: 'ASSISTANT_INSTRUCTIONS',
        enableProjectInstructions: true,
        workspaceAccessPolicy: {
          enabled: true,
          workspaceRoot: '',
          readExtraIncludes: ['Notes'],
          readExcludes: [],
          writeExcludes: [],
        },
      },
    ],
    chatOptions: {
      includeCurrentFileContent: false,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  const memMock = jest.mocked(getMemoryPromptContext)

  beforeEach(() => {
    // Mirrors real getMemoryPromptContext gating: assistant memory only
    // materializes when an assistantId is actually passed in — required so
    // this suite can tell "assistant cut off" apart from "mock ignores args".
    memMock.mockImplementation(async ({ assistantId }) => ({
      global: 'GLOBAL_MEMORY',
      assistant: assistantId ? 'ASSISTANT_MEMORY' : null,
    }))
  })

  async function buildSystemContent(
    settings: YoloSettings,
    opts: {
      conversationId: string
      contextPolicy?: { useAssistant: boolean }
      modePersonaPrompt?: string
      modePersonaModuleId?: string
      store?: SystemPromptSnapshotStore
    },
  ): Promise<string> {
    const builder = new RequestContextBuilder(makeApp() as never, settings, {
      includeSkills: false,
      systemPromptSnapshotStore: opts.store,
    })
    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'u1',
          content: null,
          promptContent: 'hi',
          mentionables: [],
        },
      ],
      model,
      conversationId: opts.conversationId,
      contextPolicy: opts.contextPolicy,
      modePersonaPrompt: opts.modePersonaPrompt,
      modePersonaModuleId: opts.modePersonaModuleId,
    })
    const system = requestMessages.find((m) => m.role === 'system')
    expect(system).toBeDefined()
    return typeof system!.content === 'string' ? system!.content : ''
  }

  it('keeps built-in-mode behavior unchanged when contextPolicy is omitted', async () => {
    const content = await buildSystemContent(settingsWithAssistant, {
      conversationId: 'conv-builtin-mode',
    })

    expect(content).toContain('<assistant_instructions name="Scoped agent">')
    expect(content).toContain('ASSISTANT_INSTRUCTIONS')
    expect(content).toContain('ASSISTANT_MEMORY')
    expect(content).toContain('<workspace_scope>')
    expect(content).not.toContain('module_mode_instructions')
  })

  it('replaces assistant instructions with the module persona and cuts the assistant out of memory/workspace scope/project instructions', async () => {
    const content = await buildSystemContent(settingsWithAssistant, {
      conversationId: 'conv-module-mode',
      contextPolicy: { useAssistant: false },
      modePersonaPrompt: 'You are the learning course assistant.',
      modePersonaModuleId: 'learning',
    })

    // In-place substitution: same slot as assistant instructions would use.
    expect(content).toContain('<module_mode_instructions module="learning">')
    expect(content).toContain('You are the learning course assistant.')
    expect(content).not.toContain('ASSISTANT_INSTRUCTIONS')
    expect(content).not.toContain('<assistant_instructions')

    // Assistant memory dropped; global memory retained.
    expect(content).toContain('GLOBAL_MEMORY')
    expect(content).not.toContain('ASSISTANT_MEMORY')

    // Workspace scope and project instructions are assistant-scoped fields —
    // fully cut off, not partially preserved.
    expect(content).not.toContain('<workspace_scope>')
    expect(content).not.toContain('Project instructions')

    // Global systemPrompt is user-level context, not assistant-level — kept.
    expect(content).toContain('GLOBAL_SYSTEM_PROMPT')
  })

  it('omits the persona section when a module mode has no persona text (defensive)', async () => {
    const content = await buildSystemContent(settingsWithAssistant, {
      conversationId: 'conv-module-mode-empty-persona',
      contextPolicy: { useAssistant: false },
    })

    expect(content).not.toContain('module_mode_instructions')
    expect(content).not.toContain('<assistant_instructions')
  })

  it('includes contextPolicy and the persona prompt in the system prompt fingerprint', async () => {
    const store = new SystemPromptSnapshotStore()

    const builtIn = await buildSystemContent(settingsWithAssistant, {
      conversationId: 'conv-fingerprint',
      store,
    })
    // Same conversationId, 'create' mode: only a fingerprint change refreshes
    // the frozen snapshot — proves contextPolicy/modePersonaPrompt are part
    // of the cache key, not silently reusing the built-in-mode snapshot.
    const moduleMode = await buildSystemContent(settingsWithAssistant, {
      conversationId: 'conv-fingerprint',
      store,
      contextPolicy: { useAssistant: false },
      modePersonaPrompt: 'Persona V1',
      modePersonaModuleId: 'learning',
    })
    expect(moduleMode).not.toEqual(builtIn)
    expect(moduleMode).toContain('Persona V1')

    const moduleModePersonaChanged = await buildSystemContent(
      settingsWithAssistant,
      {
        conversationId: 'conv-fingerprint',
        store,
        contextPolicy: { useAssistant: false },
        modePersonaPrompt: 'Persona V2',
        modePersonaModuleId: 'learning',
      },
    )
    expect(moduleModePersonaChanged).not.toEqual(moduleMode)
    expect(moduleModePersonaChanged).toContain('Persona V2')
  })
})

describe('RequestContextBuilder module chat mode skill scope (D6)', () => {
  function makeApp() {
    return {
      metadataCache: { getFileCache: jest.fn(() => null) },
      vault: {
        adapter: {
          exists: jest.fn().mockResolvedValue(false),
          read: jest.fn().mockResolvedValue(''),
        },
        cachedRead: jest.fn().mockResolvedValue(''),
        getFileByPath: jest.fn(() => null),
        getFolderByPath: jest.fn(() => null),
        getMarkdownFiles: jest.fn(() => []),
      },
    }
  }

  const model = {
    provider: 'openai',
    model: 'gpt-test',
    name: 'gpt-test',
  } as never

  const settings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    chatOptions: {
      includeCurrentFileContent: false,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  beforeEach(() => {
    mockListLiteSkillEntries.mockReset()
    mockListLiteSkillEntries.mockResolvedValue([])
  })

  it('passes { moduleChatModeId } scope to listLiteSkillEntries for a module chat mode run', async () => {
    const builder = new RequestContextBuilder(makeApp() as never, settings, {
      includeSkills: true,
    })

    await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'u1',
          content: null,
          promptContent: 'hi',
          mentionables: [],
        },
      ],
      model,
      conversationId: 'conv-module-skills',
      contextPolicy: { useAssistant: false },
      moduleChatModeId: 'module:learning:chat',
    })

    expect(mockListLiteSkillEntries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        scope: { moduleChatModeId: 'module:learning:chat' },
      }),
    )
  })

  it('passes scope: undefined for a built-in mode run with an assistant selected (no moduleChatModeId)', async () => {
    const builder = new RequestContextBuilder(
      makeApp() as never,
      {
        ...settings,
        currentAssistantId: 'agent-1',
        assistants: [{ id: 'agent-1', name: 'Agent' }],
      } as unknown as YoloSettings,
      { includeSkills: true },
    )

    await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'u1',
          content: null,
          promptContent: 'hi',
          mentionables: [],
        },
      ],
      model,
      conversationId: 'conv-builtin-skills',
    })

    expect(mockListLiteSkillEntries).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ scope: undefined }),
    )
  })

  it('calls listLiteSkillEntries at all only when an assistant is selected (built-in mode, no assistant)', async () => {
    const builder = new RequestContextBuilder(makeApp() as never, settings, {
      includeSkills: true,
    })

    await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'u1',
          content: null,
          promptContent: 'hi',
          mentionables: [],
        },
      ],
      model,
      conversationId: 'conv-builtin-skills-no-assistant',
    })

    expect(mockListLiteSkillEntries).not.toHaveBeenCalled()
  })

  it('renders a mode-scoped skill into <available_skills>', async () => {
    mockListLiteSkillEntries.mockResolvedValue([
      {
        name: 'outline-skill',
        description: 'Outline conventions',
        mode: 'lazy',
        path: MODULE_SKILL_FIXTURE_PATH,
        isReadOnly: true,
      },
    ])
    const builder = new RequestContextBuilder(makeApp() as never, settings, {
      includeSkills: true,
    })

    const requestMessages = await builder.generateRequestMessages({
      systemPromptSnapshotMode: 'create',
      messages: [
        {
          role: 'user',
          id: 'u1',
          content: null,
          promptContent: 'hi',
          mentionables: [],
        },
      ],
      model,
      conversationId: 'conv-module-skills-render',
      contextPolicy: { useAssistant: false },
      moduleChatModeId: 'module:learning:chat',
    })

    const system = requestMessages.find((m) => m.role === 'system')
    const content = typeof system?.content === 'string' ? system.content : ''
    expect(content).toContain('<available_skills>')
    expect(content).toContain('name: outline-skill')
  })
})

describe('RequestContextBuilder local-folder mentionables', () => {
  const settings = {
    systemPrompt: '',
    currentAssistantId: undefined,
    assistants: [],
    chatOptions: {
      includeCurrentFileContent: true,
      mentionContextMode: 'light',
    },
    skills: {},
  } as unknown as YoloSettings

  it('renders absolute local folder paths into the compiled prompt', async () => {
    const app = createMockApp({
      files: [],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: {
        ...createUserMessage([
          { type: 'local-folder', path: 'D:/workspace/project-a' },
          { type: 'local-folder', path: 'D:/workspace/project-b' },
        ]),
        content: createTextEditorState('Summarize these folders'),
      },
    })

    const textContent = getTextContent(result.promptContent)
    expect(textContent).toContain(
      '## Mentioned Local Folders (outside the vault)',
    )
    expect(textContent).toContain('- `D:/workspace/project-a`')
    expect(textContent).toContain('- `D:/workspace/project-b`')
    expect(textContent).toContain(
      'Absolute filesystem paths — vault file tools cannot reach them.',
    )
  })

  it('deduplicates repeated local folder paths', async () => {
    const app = createMockApp({
      files: [],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: {
        ...createUserMessage([
          { type: 'local-folder', path: 'D:/workspace/project-a' },
          { type: 'local-folder', path: 'D:/workspace/project-a' },
        ]),
        content: createTextEditorState('Summarize'),
      },
    })

    const textContent = getTextContent(result.promptContent)
    const occurrences = textContent.match(/D:\/workspace\/project-a/g) ?? []
    expect(occurrences.length).toBe(1)
  })

  it('omits the local folder section when no local folders are mentioned', async () => {
    const app = createMockApp({
      files: [],
      fileContents: new Map(),
    })
    const builder = new RequestContextBuilder(app as never, settings)

    const result = await builder.compileUserMessagePrompt({
      message: {
        ...createUserMessage([]),
        content: createTextEditorState('Plain message'),
      },
    })

    expect(getTextContent(result.promptContent)).not.toContain(
      'Mentioned Local Folders',
    )
  })
})
