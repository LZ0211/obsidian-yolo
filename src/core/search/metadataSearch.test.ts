import { type App, TFile } from 'obsidian'

import {
  type MetadataFileSearchHit,
  collectFileMetadataRows,
  searchFilesByMetadataDsl,
} from './metadataSearch'

const makeFile = (path: string): TFile =>
  Object.assign(new TFile(), {
    path,
    basename:
      path
        .split('/')
        .pop()
        ?.replace(/\.[^.]+$/, '') ?? path,
    extension: path.split('.').pop() ?? '',
  })

describe('metadataSearch', () => {
  it('collects built-in metadata beyond frontmatter', () => {
    const file = makeFile('Projects/gpu.md')
    const app = {
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: {
            status: 'open',
            aliases: ['GPU Spec'],
          },
          tags: [{ tag: '#hardware' }],
          links: [{ link: 'CUDA', original: '[[CUDA]]' }],
          embeds: [{ link: 'diagram.png', original: '![[diagram.png]]' }],
          headings: [{ heading: 'Requirements', level: 2 }],
          sections: [{ type: 'heading' }, { type: 'paragraph' }],
          listItems: [{ task: 'x' }, {}],
        }),
      },
    } as unknown as App

    expect(collectFileMetadataRows(app, file)).toEqual(
      expect.arrayContaining([
        { key: '$file_name', valueType: 'text', value: 'gpu.md' },
        { key: '$title', valueType: 'text', value: 'gpu' },
        { key: '$alias', valueType: 'text', value: 'GPU Spec' },
        { key: '$tag', valueType: 'text', value: 'hardware' },
        { key: '$link', valueType: 'text', value: 'CUDA' },
        { key: '$embed', valueType: 'text', value: 'diagram.png' },
        { key: '$heading', valueType: 'text', value: 'Requirements' },
        { key: '$heading_level', valueType: 'number', value: 2 },
        { key: '$section_type', valueType: 'text', value: 'heading' },
        { key: '$section_type', valueType: 'text', value: 'paragraph' },
        { key: '$list_item_count', valueType: 'number', value: 2 },
        { key: '$task_count', valueType: 'number', value: 1 },
      ]),
    )
  })

  it('lets SQL metadata search filter and project built-in fields', () => {
    const file = makeFile('Projects/gpu.md')
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([file]),
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: {},
          headings: [{ heading: 'Requirements', level: 2 }],
        }),
      },
    } as unknown as App

    expect(
      searchFilesByMetadataDsl(
        app,
        'select $title, $heading from Projects where heading like "Require"',
        { maxResults: 10 },
      ),
    ).toEqual([
      {
        kind: 'file',
        path: 'Projects/gpu.md',
        source: 'metadata',
        matchedKeys: ['$heading'],
        metadata: {
          $title: ['gpu'],
          $heading: ['Requirements'],
        },
      },
    ])
  })

  it('exposes document outlinks and backlinks as built-in metadata', () => {
    const source = makeFile('Projects/source.md')
    const target = makeFile('Projects/target.md')
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([source, target]),
      },
      metadataCache: {
        resolvedLinks: {
          'Projects/source.md': {
            'Projects/target.md': 1,
          },
        },
        getFileCache: jest.fn((file: TFile) => ({
          frontmatter: {},
          links:
            file.path === 'Projects/source.md'
              ? [{ link: 'target', original: '[[target]]' }]
              : [],
        })),
      },
    } as unknown as App

    expect(
      searchFilesByMetadataDsl(
        app,
        'select $title, $outlink from Projects where outlink = "Projects/target.md"',
        { maxResults: 10 },
      ),
    ).toEqual([
      {
        kind: 'file',
        path: 'Projects/source.md',
        source: 'metadata',
        matchedKeys: ['$outlink'],
        metadata: {
          $title: ['source'],
          $outlink: ['Projects/target.md'],
        },
      },
    ])

    expect(
      searchFilesByMetadataDsl(
        app,
        'select $title, $inlink from Projects where inlink = "Projects/source.md"',
        { maxResults: 10 },
      ),
    ).toEqual([
      {
        kind: 'file',
        path: 'Projects/target.md',
        source: 'metadata',
        matchedKeys: ['$inlink'],
        metadata: {
          $title: ['target'],
          $inlink: ['Projects/source.md'],
        },
      },
    ])
  })

  it('resolves built-in field aliases and returns canonical metadata keys', () => {
    const file = makeFile('Projects/gpu.md')
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([file]),
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: {},
          tags: [{ tag: '#hardware' }],
        }),
      },
    } as unknown as App

    expect(
      searchFilesByMetadataDsl(
        app,
        'select $title, tags from Projects where file title = "gpu"',
        { maxResults: 10 },
      ),
    ).toEqual([
      {
        kind: 'file',
        path: 'Projects/gpu.md',
        source: 'metadata',
        matchedKeys: ['$title'],
        metadata: {
          $title: ['gpu'],
          $tag: ['hardware'],
        },
      },
    ])
  })

  it('matches frontmatter fields by exact key name', () => {
    const file = makeFile('Projects/gpu.md')
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([file]),
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: { product_model: 'RTX-4090' },
        }),
      },
    } as unknown as App

    expect(
      searchFilesByMetadataDsl(
        app,
        'select product_model from Projects where product_model = "RTX-4090"',
        { maxResults: 10 },
      ),
    ).toEqual([
      {
        kind: 'file',
        path: 'Projects/gpu.md',
        source: 'metadata',
        matchedKeys: ['product_model'],
        metadata: {
          product_model: ['RTX-4090'],
        },
      },
    ])
  })

  it('matches exact field names when multiple frontmatter keys exist', () => {
    const file = makeFile('Projects/gpu.md')
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([file]),
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: {
            型号: 'RTX-4090',
            product_model: 'RX-7900',
          },
        }),
      },
    } as unknown as App

    expect(
      searchFilesByMetadataDsl(
        app,
        'select 型号 from Projects where 型号 = "RTX-4090"',
        { maxResults: 10 },
      ),
    ).toEqual([
      {
        kind: 'file',
        path: 'Projects/gpu.md',
        source: 'metadata',
        matchedKeys: ['型号'],
        metadata: {
          型号: ['RTX-4090'],
        },
      },
    ])
  })

  it('matches fields containing non-ASCII unicode keys', () => {
    const file = makeFile('Projects/gpu.md')
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([file]),
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: {
            型号: 'RTX-4090',
          },
        }),
      },
    } as unknown as App

    expect(
      searchFilesByMetadataDsl(
        app,
        'select 型号 from Projects where 型号 = "RTX-4090"',
        { maxResults: 10 },
      ),
    ).toEqual([
      {
        kind: 'file',
        path: 'Projects/gpu.md',
        source: 'metadata',
        matchedKeys: ['型号'],
        metadata: {
          型号: ['RTX-4090'],
        },
      },
    ])
  })

  it('orders and limits file metadata results', () => {
    const files = [
      makeFile('Projects/low.md'),
      makeFile('Projects/high.md'),
      makeFile('Projects/mid.md'),
    ]
    const priorities: Record<string, number> = {
      'Projects/low.md': 1,
      'Projects/high.md': 9,
      'Projects/mid.md': 5,
    }
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue(files),
      },
      metadataCache: {
        getFileCache: jest.fn((file: TFile) => ({
          frontmatter: { priority: priorities[file.path] },
        })),
      },
    } as unknown as App

    expect(
      searchFilesByMetadataDsl(
        app,
        'select $title, priority from Projects order by priority desc limit 2',
        { maxResults: 10 },
      )
        .filter((hit) => hit.kind === 'file')
        .map((hit) => hit.path),
    ).toEqual(['Projects/high.md', 'Projects/mid.md'])
  })

  it('compares dates in numeric comparisons through coercion', () => {
    const file1 = makeFile('Projects/a.md')
    const file2 = makeFile('Projects/b.md')
    file1.basename = 'a'
    file2.basename = 'b'
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([file1, file2]),
      },
      metadataCache: {
        getFileCache: jest.fn().mockImplementation((file: TFile) => {
          if (file.path === 'Projects/a.md') {
            return { frontmatter: { date: '2024-03-15' } }
          }
          return { frontmatter: { date: '2025-01-10' } }
        }),
      },
    } as unknown as App

    const results = searchFilesByMetadataDsl(
      app,
      'select title from Projects where date >= "2024-06-01"',
      { maxResults: 10 },
    )
    expect(results).toEqual([
      {
        kind: 'file',
        path: 'Projects/b.md',
        source: 'metadata',
        matchedKeys: ['date'],
        metadata: { $title: ['b'] },
      },
    ])
  })

  it('returns available keys via keys(*)', () => {
    const file = makeFile('Projects/gpu.md')
    const app = {
      vault: { getFiles: jest.fn().mockReturnValue([file]) },
      metadataCache: {
        getFileCache: jest
          .fn()
          .mockReturnValue({ frontmatter: { 价格: 9999 } }),
      },
    } as unknown as App

    const results = searchFilesByMetadataDsl(
      app,
      'select keys(*) from Projects',
      { maxResults: 20 },
    )

    expect(results).toEqual([
      {
        kind: 'distinct',
        key: 'available_keys',
        values: expect.arrayContaining([
          '$document_type: str',
          '$file_name: str',
          '$folder_path: str',
          '$source_path: str',
          '$title: str',
          '价格: int',
        ]),
      },
    ])
  })

  it('matches files by folder_path and file_name substring', () => {
    const file = makeFile(
      '00-Email/Inbox/2026-05-07_转发：样品分析报告_65c6d96a.md',
    )
    file.basename = '2026-05-07_转发：样品分析报告_65c6d96a'
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([file]),
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: { from: '孙晓 <andreas@reliance-battery.com>' },
        }),
      },
    } as unknown as App

    const results = searchFilesByMetadataDsl(
      app,
      'select $source_path, $file_name from * where $folder_path = "00-Email/Inbox" and $file_name contains "2026-05"',
      { maxResults: 10 },
    )

    expect(results).toEqual([
      {
        kind: 'file',
        path: '00-Email/Inbox/2026-05-07_转发：样品分析报告_65c6d96a.md',
        source: 'metadata',
        matchedKeys: expect.arrayContaining(['$folder_path', '$file_name']),
        metadata: {
          $source_path: [expect.stringContaining('2026-05')],
          $file_name: [expect.stringContaining('2026-05')],
        },
      },
    ])
  })

  it('treats INCLUDES as a contains alias in metadata search', () => {
    const file = makeFile('Projects/gpu.md')
    const app = {
      vault: {
        getFiles: jest.fn().mockReturnValue([file]),
      },
      metadataCache: {
        getFileCache: jest.fn().mockReturnValue({
          frontmatter: {
            tags: ['gpu', 'cuda'],
            note: 'requires cuda toolkit',
          },
        }),
      },
    } as unknown as App

    const results = searchFilesByMetadataDsl(
      app,
      'select tags, note from Projects where tags includes "gpu" and note includes "cuda"',
      { maxResults: 10 },
    )

    expect(results).toEqual([
      {
        kind: 'file',
        path: 'Projects/gpu.md',
        source: 'metadata',
        matchedKeys: expect.arrayContaining(['tags', 'note']),
        metadata: {
          note: ['requires cuda toolkit'],
        },
      },
    ])
  })

  it('excludes files matching neq operator', () => {
    const files = [makeFile('a.md'), makeFile('b.md')]
    const app = {
      vault: { getFiles: jest.fn().mockReturnValue(files) },
      metadataCache: {
        getFileCache: jest.fn((file: TFile) => ({
          frontmatter: { status: file.path === 'a.md' ? 'open' : 'closed' },
        })),
      },
    } as unknown as App

    const neqResults = searchFilesByMetadataDsl(
      app,
      'select * from * where status != "open"',
      { maxResults: 10 },
    )
    expect(neqResults).toHaveLength(1)
    if (neqResults[0]?.kind === 'file') {
      expect(neqResults[0].path).toBe('b.md')
    }
  })

  it('uses strict gt comparison for numbers', () => {
    const files = [makeFile('a.md'), makeFile('b.md'), makeFile('c.md')]
    const app = {
      vault: { getFiles: jest.fn().mockReturnValue(files) },
      metadataCache: {
        getFileCache: jest.fn((file: TFile) => ({
          frontmatter: {
            score: file.path === 'a.md' ? 10 : file.path === 'b.md' ? 5 : 5,
          },
        })),
      },
    } as unknown as App

    const results = searchFilesByMetadataDsl(
      app,
      'select * from * where score > 5',
      { maxResults: 10 },
    )
    const paths = results
      .filter((r): r is MetadataFileSearchHit => r.kind === 'file')
      .map((r) => r.path)
    expect(paths).toEqual(['a.md'])
  })
})
