import { type App, TFile } from 'obsidian'

import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import { getCapability, getToolDefinition } from '../registry'
import type { ToolContext } from '../types'

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

describe('meta_search definition', () => {
  it('is registered as an independent metadata search capability', () => {
    expect(
      getCapability('metadata_search')?.tools.map((tool) => tool.name),
    ).toEqual(['meta_search'])
  })

  it('returns only files readable through the workspace policy', async () => {
    const app = {
      vault: {
        getFiles: () => [
          makeFile('Allowed/visible.md'),
          makeFile('Private/hidden.md'),
        ],
      },
      metadataCache: {
        getFileCache: () => ({ frontmatter: {} }),
      },
    } as unknown as App

    const result = await getToolDefinition('meta_search')?.execute(
      { meta: 'select $title from *', maxResults: 20 },
      {
        app,
        workspaceAccessPolicy: {
          enabled: true,
          workspaceRoot: 'Allowed',
          readExtraIncludes: [],
          readExcludes: [],
          writeExcludes: [],
        },
      } as ToolContext,
    )

    expect(result?.status).toBe(ToolCallResponseStatus.Success)
    expect(result && 'text' in result ? JSON.parse(result.text) : null).toEqual(
      {
        tool: 'meta_search',
        resultKind: 'file',
        results: [
          {
            path: 'Allowed/visible.md',
            matchedKeys: [],
            metadata: { $title: ['visible'] },
          },
        ],
      },
    )
  })
})
