import type { WorkflowCopy } from '../i18n'

import type {
  CreateWorkflowInput,
  WorkflowRepository,
} from './workflow-repository'

type WorkflowToolResult = Awaited<
  ReturnType<YoloModuleHostChatModeToolV1['handler']>
>

const READ_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: { path: { type: 'string', minLength: 1 } },
  required: ['path'],
  additionalProperties: false,
}

const CREATE_INPUT_SCHEMA: Record<string, unknown> = {
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
}

export type WorkflowChatTools = Readonly<{
  read: YoloModuleHostChatModeToolV1
  create: YoloModuleHostChatModeToolV1
}>

export function createWorkflowChatTools(
  repository: WorkflowRepository,
  copy: WorkflowCopy | (() => WorkflowCopy),
): WorkflowChatTools {
  const getCopy = typeof copy === 'function' ? copy : () => copy
  const initialCopy = getCopy()

  return Object.freeze({
    read: {
      name: 'workflow_read',
      description: initialCopy.chatTool.readDescription,
      inputSchema: READ_INPUT_SCHEMA,
      handler: (input) => readWorkflow(repository, getCopy(), input),
    },
    create: {
      name: 'workflow_create',
      description: initialCopy.chatTool.createDescription,
      inputSchema: CREATE_INPUT_SCHEMA,
      requiresApproval: true,
      handler: (input) => createWorkflow(repository, getCopy(), input),
    },
  })
}

async function readWorkflow(
  repository: WorkflowRepository,
  copy: WorkflowCopy,
  input: Record<string, unknown>,
): Promise<WorkflowToolResult> {
  const path = readPath(input)
  if (path === null) return invalidInput(copy.chatToolError.invalidInput)

  const bundle = await repository.read(path)
  if (!bundle) return invalidInput(copy.chatToolError.notFound, 'not-found')

  return result({
    ok: true,
    path: bundle.path,
    document: bundle.document,
    files: bundle.files.map((file) => ({
      relativePath: file.relativePath,
      content: file.snapshot.content,
    })),
  })
}

async function createWorkflow(
  repository: WorkflowRepository,
  copy: WorkflowCopy,
  input: Record<string, unknown>,
): Promise<WorkflowToolResult> {
  const createInput = parseCreateInput(input)
  if (!createInput) return invalidInput(copy.chatToolError.invalidInput)

  const created = await repository.create(createInput)
  if (!created.ok) {
    return invalidInput(
      created.reason === 'target-exists'
        ? copy.chatToolError.targetExists
        : copy.chatToolError.invalidInput,
      created.reason,
    )
  }

  return result({ ok: true, path: `${createInput.slug}/WORKFLOW.md` })
}

function readPath(input: unknown): string | null {
  if (!hasKeys(input, ['path'])) return null
  const path = input.path
  return isNonBlankString(path) ? path : null
}

function parseCreateInput(input: unknown): CreateWorkflowInput | null {
  if (!hasKeys(input, ['slug', 'manifestContent', 'stepFiles'])) return null
  if (!isNonBlankString(input.slug)) return null
  if (typeof input.manifestContent !== 'string') return null
  if (!input.manifestContent.trim() || !Array.isArray(input.stepFiles))
    return null

  const stepFiles = input.stepFiles.map((file) => {
    if (!hasKeys(file, ['relativePath', 'content'])) return null
    if (!isNonBlankString(file.relativePath)) return null
    if (!isNonBlankString(file.content)) return null
    return { relativePath: file.relativePath, content: file.content }
  })
  if (stepFiles.some((file) => file === null)) return null

  return {
    slug: input.slug,
    manifestContent: input.manifestContent,
    stepFiles: stepFiles as readonly Readonly<{
      relativePath: string
      content: string
    }>[],
  }
}

function hasKeys(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (!isPlainRecord(value)) return false
  const actualKeys = Object.keys(value).sort()
  return (
    actualKeys.length === keys.length &&
    actualKeys.every((key, index) => key === [...keys].sort()[index])
  )
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function result(payload: Record<string, unknown>): WorkflowToolResult {
  return { content: JSON.stringify(payload) }
}

function invalidInput(
  message: string,
  reason:
    | 'invalid-input'
    | 'not-found'
    | 'target-exists'
    | 'stale' = 'invalid-input',
): WorkflowToolResult {
  return {
    content: JSON.stringify({ ok: false, reason, message }),
    isError: true,
  }
}
