import { en } from '../i18n'
import {
  parseWorkflowDocument,
  updateWorkflowManagedBlocks,
} from '../domain/workflow-document'
import type { WorkflowBundle } from '../domain/workflow-repository'
import type { WorkflowTopology } from '../domain/workflow-model'
import { runWorkflowReview } from './workflow-review'

type AgentRequest = Parameters<YoloModuleHostApiV1['agent']['stream']>[0]
type AgentToolResult = Awaited<
  ReturnType<NonNullable<AgentRequest['tools']>[number]['handler']>
>

const topology: WorkflowTopology = {
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
      id: 'output',
      kind: 'output',
      label: 'Output',
      stepPath: 'steps/output/STEP.md',
      position: { x: 315, y: 90 },
    },
  ],
  edges: [{ id: 'input-output', source: 'input', target: 'output' }],
}

describe('runWorkflowReview', () => {
  it('uses a no-write agent and accepts only a validated proposal tool result', async () => {
    const content = updateWorkflowManagedBlocks('# Demo\n', topology, en)
    const bundle = createBundle(content)
    const agent = {
      stream: jest.fn(async function* (request: AgentRequest) {
        expect(request.modelId).toBe('provider/model')
        expect(request.capability).toBe('none')
        expect(request.tools).toHaveLength(1)
        expect(request.tools?.[0]?.name).toBe('submit_workflow_proposal')
        expect(request.prompt).toContain('Keep the proposal inside the tool')
        const result = await request.tools![0]!.handler({
          content: `${content}\nA reviewed note.\n`,
        })
        expect(result.isError).toBeUndefined()
        yield { type: 'completed' as const, text: '' }
      }),
    }

    await expect(
      runWorkflowReview({
        agent,
        bundle,
        copy: en,
        modelId: 'provider/model',
        target: 'document',
      }),
    ).resolves.toEqual({
      ok: true,
      content: `${content}\nA reviewed note.\n`,
    })
  })

  it('accepts workflow prose changes when the existing step files stay addressable', async () => {
    const content = updateWorkflowManagedBlocks('# Demo\n', topology, en)
    const agent = {
      stream: jest.fn(async function* (request: AgentRequest) {
        const result = await request.tools![0]!.handler({
          content: `${content}\nA workflow note.\n`,
        })
        expect(result.isError).toBeUndefined()
        yield { type: 'completed' as const, text: '' }
      }),
    }

    await expect(
      runWorkflowReview({
        agent,
        bundle: createBundle(content),
        copy: en,
        modelId: 'provider/model',
        target: 'workflow',
      }),
    ).resolves.toEqual({
      ok: true,
      content: `${content}\nA workflow note.\n`,
    })
  })

  it('does not parse final prose as a proposal', async () => {
    const content = updateWorkflowManagedBlocks('# Demo\n', topology, en)
    const agent = {
      stream: jest.fn(async function* () {
        yield {
          type: 'completed' as const,
          text: `${content}\nLooks good.`,
        }
      }),
    }

    await expect(
      runWorkflowReview({
        agent,
        bundle: createBundle(content),
        copy: en,
        modelId: 'provider/model',
        target: 'document',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'no-proposal' })
  })

  it('rejects an invalid proposal through the tool result', async () => {
    const content = updateWorkflowManagedBlocks('# Demo\n', topology, en)
    let toolResult: AgentToolResult | undefined
    const agent = {
      stream: jest.fn(async function* (request: AgentRequest) {
        toolResult = await request.tools![0]!.handler({ content: '# broken' })
        yield { type: 'completed' as const, text: '' }
      }),
    }

    await expect(
      runWorkflowReview({
        agent,
        bundle: createBundle(content),
        copy: en,
        modelId: 'provider/model',
        target: 'workflow',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'no-proposal' })
    expect(toolResult?.isError).toBe(true)
  })

  it('rejects workflow proposals that require unprovided step files', async () => {
    const content = updateWorkflowManagedBlocks('# Demo\n', topology, en)
    const changedTopology: WorkflowTopology = {
      ...topology,
      nodes: topology.nodes.map((node) =>
        node.id === 'input'
          ? { ...node, stepPath: 'steps/review/STEP.md' }
          : node,
      ),
    }
    const proposal = updateWorkflowManagedBlocks(
      '# Demo\n',
      changedTopology,
      en,
    )
    let toolResult: AgentToolResult | undefined
    const agent = {
      stream: jest.fn(async function* (request: AgentRequest) {
        toolResult = await request.tools![0]!.handler({ content: proposal })
        yield { type: 'completed' as const, text: '' }
      }),
    }

    await expect(
      runWorkflowReview({
        agent,
        bundle: createBundle(content),
        copy: en,
        modelId: 'provider/model',
        target: 'workflow',
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'no-proposal' })
    expect(toolResult?.isError).toBe(true)
  })
})

function createBundle(content: string): WorkflowBundle {
  const document = parseWorkflowDocument(content, en)
  return {
    path: 'demo/WORKFLOW.md',
    document,
    files: [
      {
        nodeId: 'workflow',
        relativePath: 'demo/WORKFLOW.md',
        snapshot: { path: 'managed/workflows/demo/WORKFLOW.md', content },
      },
    ],
  }
}
