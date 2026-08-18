import { en, zh } from '../i18n'
import type { WorkflowCopy } from '../i18n'

import {
  parseWorkflowDocument,
  updateWorkflowManagedBlocks,
} from './workflow-document'
import type { WorkflowTopology } from './workflow-model'
import type {
  CreateWorkflowResult,
  WorkflowBundle,
  WorkflowRepository,
} from './workflow-repository'
import { createWorkflowChatTools } from './workflow-tools'

describe('workflow chat tools', () => {
  it('serializes read bundles without exposing Host snapshot paths', async () => {
    const repository = fakeRepository()
    const bundle: WorkflowBundle = {
      path: 'alpha/WORKFLOW.md',
      document: parseWorkflowDocument('# Alpha'),
      files: [
        {
          nodeId: 'workflow',
          relativePath: 'alpha/WORKFLOW.md',
          snapshot: {
            path: 'managed/workflows/alpha/WORKFLOW.md',
            content: '# Alpha',
          },
        },
        {
          nodeId: 'input',
          relativePath: 'alpha/steps/input/STEP.md',
          snapshot: {
            path: 'managed/workflows/alpha/steps/input/STEP.md',
            content: 'Accept input.',
          },
        },
      ],
    }
    repository.read.mockResolvedValue(bundle)
    const tools = createWorkflowChatTools(repository, en)

    const result = await tools.read.handler({ path: 'alpha/WORKFLOW.md' })
    const payload = parseResult(result)

    expect(repository.read).toHaveBeenCalledWith('alpha/WORKFLOW.md')
    expect(result.isError).toBeUndefined()
    expect(payload).toMatchObject({
      ok: true,
      path: 'alpha/WORKFLOW.md',
      document: bundle.document,
    })
    expect(payload.files).toEqual([
      { relativePath: 'alpha/WORKFLOW.md', content: '# Alpha' },
      {
        relativePath: 'alpha/steps/input/STEP.md',
        content: 'Accept input.',
      },
    ])
    expect(result.content).not.toContain('managed/workflows')
  })

  it.each([
    null,
    {},
    { path: null },
    { path: '   ' },
    { path: 'alpha/WORKFLOW.md', extra: true },
  ])('rejects invalid read input %p without repository access', async (input) => {
    const repository = fakeRepository()
    const tools = createWorkflowChatTools(repository, en)

    const result = await tools.read.handler(input as Record<string, unknown>)

    expect(result.isError).toBe(true)
    expect(parseResult(result)).toMatchObject({
      ok: false,
      reason: 'invalid-input',
    })
    expect(repository.read).not.toHaveBeenCalled()
  })

  it('returns a machine-readable error when a workflow is missing', async () => {
    const repository = fakeRepository()
    repository.read.mockResolvedValue(null)
    const tools = createWorkflowChatTools(repository, en)

    const result = await tools.read.handler({ path: 'missing/WORKFLOW.md' })

    expect(result.isError).toBe(true)
    expect(parseResult(result)).toMatchObject({
      ok: false,
      reason: 'not-found',
    })
  })

  it('resolves error copy from the getter for every invocation', async () => {
    const repository = fakeRepository()
    let copy: WorkflowCopy = en
    const tools = createWorkflowChatTools(repository, () => copy)

    const invalidInput = await tools.read.handler({})
    expect(parseResult(invalidInput).message).toBe(en.chatToolError.invalidInput)

    repository.read.mockResolvedValue(null)
    const notFound = await tools.read.handler({ path: 'missing/WORKFLOW.md' })
    expect(parseResult(notFound).message).toBe(en.chatToolError.notFound)

    repository.create.mockResolvedValue({ ok: false, reason: 'target-exists' })
    const input = validCreateInput()
    const targetExists = await tools.create.handler(input)
    expect(parseResult(targetExists).message).toBe(en.chatToolError.targetExists)

    copy = zh

    const invalidInputInChinese = await tools.read.handler({})
    expect(parseResult(invalidInputInChinese).message).toBe(
      zh.chatToolError.invalidInput,
    )
    const notFoundInChinese = await tools.read.handler({
      path: 'missing/WORKFLOW.md',
    })
    expect(parseResult(notFoundInChinese).message).toBe(zh.chatToolError.notFound)
    const targetExistsInChinese = await tools.create.handler(input)
    expect(parseResult(targetExistsInChinese).message).toBe(
      zh.chatToolError.targetExists,
    )
  })

  it('propagates Host errors from read', async () => {
    const repository = fakeRepository()
    const failure = new Error('Host read failed')
    repository.read.mockRejectedValue(failure)
    const tools = createWorkflowChatTools(repository, en)

    await expect(
      tools.read.handler({ path: 'alpha/WORKFLOW.md' }),
    ).rejects.toBe(failure)
  })

  it('delegates a valid create and returns only the public workflow path', async () => {
    const repository = fakeRepository()
    repository.create.mockResolvedValue({
      ok: true,
      snapshot: {
        path: 'managed/workflows/alpha/WORKFLOW.md',
        content: 'private manifest',
      },
    })
    const tools = createWorkflowChatTools(repository, en)
    const input = validCreateInput()

    const result = await tools.create.handler(input)

    expect(repository.create).toHaveBeenCalledWith(input)
    expect(parseResult(result)).toEqual({
      ok: true,
      path: 'alpha/WORKFLOW.md',
    })
    expect(result.content).not.toContain('private manifest')
  })

  it('rejects a create request whose managed document is not a valid workflow', async () => {
    const repository = fakeRepository()
    const tools = createWorkflowChatTools(repository, en)

    const result = await tools.create.handler({
      slug: 'alpha',
      manifestContent:
        '# Alpha\n\n<!-- yolo:workflow-topology:start -->\n{}\n<!-- yolo:workflow-topology:end -->',
      stepFiles: [],
    })

    expect(result.isError).toBe(true)
    expect(parseResult(result)).toMatchObject({
      ok: false,
      reason: 'invalid-input',
      message: en.chatToolError.invalidWorkflow,
    })
    expect(repository.create).not.toHaveBeenCalled()
  })

  it.each([
    null,
    {},
    {
      slug: 'alpha',
      manifestContent: null,
      stepFiles: [],
    },
    {
      slug: '   ',
      manifestContent: '# Alpha',
      stepFiles: [],
    },
    {
      slug: 'alpha',
      manifestContent: '   ',
      stepFiles: [],
    },
    {
      slug: 'alpha',
      manifestContent: '# Alpha',
      stepFiles: [{ relativePath: null, content: 'Input' }],
    },
    {
      slug: 'alpha',
      manifestContent: '# Alpha',
      stepFiles: [{ relativePath: 'steps/input/STEP.md', content: null }],
    },
    {
      slug: 'alpha',
      manifestContent: '# Alpha',
      stepFiles: [{ relativePath: 'steps/input/STEP.md', content: '   ' }],
    },
    {
      slug: 'alpha',
      manifestContent: '# Alpha',
      stepFiles: [{ relativePath: 'steps/input/STEP.md', content: 'Input', extra: true }],
    },
    {
      slug: 'alpha',
      manifestContent: '# Alpha',
      stepFiles: [],
      extra: true,
    },
  ])('rejects invalid create input %p without repository access', async (input) => {
    const repository = fakeRepository()
    const tools = createWorkflowChatTools(repository, en)

    const result = await tools.create.handler(input as Record<string, unknown>)

    expect(result.isError).toBe(true)
    expect(parseResult(result)).toMatchObject({
      ok: false,
      reason: 'invalid-input',
    })
    expect(repository.create).not.toHaveBeenCalled()
  })

  it.each([
    { ok: false, reason: 'invalid-input' },
    { ok: false, reason: 'target-exists' },
  ] satisfies CreateWorkflowResult[])('maps repository create failure %p', async (failure) => {
    const repository = fakeRepository()
    repository.create.mockResolvedValue(failure)
    const tools = createWorkflowChatTools(repository, en)

    const result = await tools.create.handler(validCreateInput())

    expect(result.isError).toBe(true)
    expect(parseResult(result)).toMatchObject({ ok: false, reason: failure.reason })
  })

  it('propagates Host errors from create', async () => {
    const repository = fakeRepository()
    const failure = new Error('Host create failed')
    repository.create.mockRejectedValue(failure)
    const tools = createWorkflowChatTools(repository, en)

    await expect(
      tools.create.handler(validCreateInput()),
    ).rejects.toBe(failure)
  })

  it('publishes strict schemas and approval policy', () => {
    const tools = createWorkflowChatTools(fakeRepository(), en)

    expect(tools.read.name).toBe('workflow_read')
    expect(tools.read.requiresApproval).toBeUndefined()
    expect(tools.read.inputSchema).toEqual({
      type: 'object',
      properties: { path: { type: 'string', minLength: 1 } },
      required: ['path'],
      additionalProperties: false,
    })
    expect(tools.create.name).toBe('workflow_create')
    expect(tools.create.requiresApproval).toBe(true)
    expect(tools.create.inputSchema).toEqual({
      type: 'object',
      properties: {
        slug: { type: 'string', minLength: 1 },
        manifestContent: { type: 'string' },
        stepFiles: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              relativePath: { type: 'string', minLength: 1 },
              content: { type: 'string' },
            },
            required: ['relativePath', 'content'],
            additionalProperties: false,
          },
        },
      },
      required: ['slug', 'manifestContent', 'stepFiles'],
      additionalProperties: false,
    })
  })
})

function fakeRepository(): WorkflowRepository & {
  read: jest.MockedFunction<WorkflowRepository['read']>
  create: jest.MockedFunction<WorkflowRepository['create']>
} {
  return {
    read: jest.fn(),
    create: jest.fn(),
  } as unknown as WorkflowRepository & {
    read: jest.MockedFunction<WorkflowRepository['read']>
    create: jest.MockedFunction<WorkflowRepository['create']>
  }
}

function parseResult(result: { content: string }): Record<string, unknown> {
  return JSON.parse(result.content) as Record<string, unknown>
}

function validCreateInput() {
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
  return {
    slug: 'alpha',
    manifestContent: updateWorkflowManagedBlocks('# Alpha\n', topology, en),
    stepFiles: [
      { relativePath: 'steps/input/STEP.md', content: '# Input\n' },
      { relativePath: 'steps/output/STEP.md', content: '# Output\n' },
    ],
  }
}
