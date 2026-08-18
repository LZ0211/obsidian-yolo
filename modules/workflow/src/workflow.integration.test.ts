import { updateWorkflowManagedBlocks } from './domain/workflow-document'
import {
  type WorkflowTopology,
  validateWorkflowTopology,
} from './domain/workflow-model'
import { createWorkflowRepository } from './domain/workflow-repository'
import { runWorkflowReview } from './assistant/workflow-review'
import { createWorkflowCopy } from './i18n'
import { createWorkflowEditorModel } from './ui/workflow-editor-model'

describe('workflow cross-layer integration', () => {
  it('reviews a loaded workflow and persists the accepted proposal', async () => {
    const host = new IntegrationHost()
    const copy = createWorkflowCopy('en')
    const topology = createTopology()
    const manifestPath = 'managed/workflows/demo/WORKFLOW.md'
    const manifest = updateWorkflowManagedBlocks('# Demo\n', topology, copy)
    host.file(manifestPath, manifest)
    host.file('managed/workflows/demo/steps/input/STEP.md', '# Input\n')
    host.file('managed/workflows/demo/steps/agent/STEP.md', '# Agent\n')
    host.file('managed/workflows/demo/steps/output/STEP.md', '# Output\n')

    const repository = createWorkflowRepository(host.api)
    const editor = createWorkflowEditorModel(repository, copy)
    await expect(editor.load('demo/WORKFLOW.md')).resolves.toEqual({ ok: true })
    const bundle = editor.getSnapshot().bundle
    expect(bundle).not.toBeNull()
    expect(validateWorkflowTopology(editor.getSnapshot().topology!)).toEqual([])

    const agent = {
      stream: async function* (request: {
        tools?: readonly {
          handler(value: Record<string, unknown>): Promise<{
            content: string
            isError?: boolean
          }>
        }[]
      }) {
        const tool = request.tools?.[0]
        if (!tool) throw new Error('proposal tool missing')
        const result = await tool.handler({
          content: `${bundle!.document.content}\nReviewed in integration.\n`,
        })
        expect(result.isError).toBeUndefined()
        yield { type: 'completed' as const, text: '' }
      },
    } as unknown as YoloModuleHostApiV1['agent']

    const review = await runWorkflowReview({
      agent,
      bundle: bundle!,
      copy,
      modelId: 'integration-model',
      target: 'document',
    })
    expect(review).toEqual({
      ok: true,
      content: `${manifest}\nReviewed in integration.\n`,
    })

    if (!review.ok) return
    expect(editor.updateFile('workflow', review.content)).toBe(true)
    await expect(editor.apply()).resolves.toEqual({ ok: true })
    expect(host.files.get(manifestPath)).toContain('Reviewed in integration.')
    expect(editor.getSnapshot().dirty).toBe(false)
  })
})

function createTopology(): WorkflowTopology {
  return {
    revision: 1,
    nodes: [
      {
        id: 'input',
        kind: 'input',
        label: 'Input',
        stepPath: 'steps/input/STEP.md',
        position: { x: 70, y: 90 },
      },
      {
        id: 'agent',
        kind: 'agent',
        label: 'Agent',
        stepPath: 'steps/agent/STEP.md',
        position: { x: 315, y: 90 },
      },
      {
        id: 'output',
        kind: 'output',
        label: 'Output',
        stepPath: 'steps/output/STEP.md',
        position: { x: 560, y: 90 },
      },
    ],
    edges: [
      { id: 'input-agent', source: 'input', target: 'agent' },
      { id: 'agent-output', source: 'agent', target: 'output' },
    ],
  }
}

class IntegrationHost {
  readonly files = new Map<string, string>()
  private readonly folders = new Set<string>()

  readonly api = {
    paths: {
      getSnapshot: () => ({ contentRoot: 'managed/workflows' }),
      subscribe: () => () => undefined,
      runExclusive: async <T>(
        _namespace: string,
        operation: () => T | PromiseLike<T>,
      ) => operation(),
    },
    vault: {
      getEntry: (path: string) => this.entry(path),
      listChildren: (folder: string) => this.children(folder),
      exists: async (path: string) =>
        this.files.has(path) || this.folders.has(path),
      readTextSnapshot: async (path: string) => {
        const content = this.files.get(path)
        return content === undefined ? null : { path, content }
      },
      ensureFolder: async (path: string) => this.addFolder(path),
      createTextIfAbsent: async (path: string, content: string) => {
        if (this.files.has(path)) return null
        this.file(path, content)
        return { path, content }
      },
      replaceTextIfUnchanged: async (
        expected: { path: string; content: string },
        content: string,
      ) => {
        if (this.files.get(expected.path) !== expected.content) return null
        this.file(expected.path, content)
        return { path: expected.path, content }
      },
      trashPath: async (path: string) => {
        const prefix = `${path}/`
        const targets = [...this.files.keys()].filter(
          (filePath) => filePath === path || filePath.startsWith(prefix),
        )
        for (const target of targets) this.files.delete(target)
        return targets.length > 0
      },
      removeFileExact: async (path: string) => this.files.delete(path),
      subscribe: () => () => undefined,
    },
  } as unknown as Pick<YoloModuleHostApiV1, 'paths' | 'vault'>

  file(path: string, content: string): void {
    this.addFolder(path.slice(0, path.lastIndexOf('/')))
    this.files.set(path, content)
  }

  private addFolder(path: string): void {
    const parts = path.split('/').filter(Boolean)
    for (let index = 1; index <= parts.length; index++)
      this.folders.add(parts.slice(0, index).join('/'))
  }

  private entry(path: string) {
    if (this.files.has(path))
      return {
        kind: 'file' as const,
        path,
        name: path.split('/').at(-1)!,
        ctime: 0,
        mtime: 0,
      }
    if (this.folders.has(path))
      return { kind: 'folder' as const, path, name: path.split('/').at(-1)! }
    return null
  }

  private children(folder: string) {
    const prefix = `${folder}/`
    const paths = [...this.folders, ...this.files.keys()].filter(
      (path) =>
        path.startsWith(prefix) && !path.slice(prefix.length).includes('/'),
    )
    return paths.map((path) => this.entry(path)!).filter(Boolean)
  }
}
