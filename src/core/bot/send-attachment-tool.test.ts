import { ToolCallResponseStatus } from '../../types/tool-call.types'
import type { WorkspaceAccessPolicy } from '../agent/workspaceScope'

import { createSendAttachmentToolServer } from './send-attachment-tool'

const signal = new AbortController().signal

const callTool = (
  workspaceAccessPolicy: WorkspaceAccessPolicy | undefined,
  args: Record<string, unknown>,
) =>
  createSendAttachmentToolServer(workspaceAccessPolicy).callTool({
    toolName: 'send_attachment',
    args,
    signal,
  })

describe('send_attachment bot tool', () => {
  const allowExports = {
    enabled: true,
    workspaceRoot: 'exports',
    readExtraIncludes: [],
    readExcludes: [],
    writeExcludes: [],
  } satisfies WorkspaceAccessPolicy

  it('exposes a path-required schema', () => {
    const tool = createSendAttachmentToolServer(undefined).listTools()[0]
    expect(tool).toBeDefined()
    expect(tool.inputSchema.required).toEqual(['path'])
    expect(
      (tool.inputSchema.properties as Record<string, unknown>).path,
    ).toBeDefined()
    expect(
      (tool.inputSchema.properties as Record<string, unknown>).label,
    ).toBeDefined()
  })

  it('succeeds when the bound assistant has unrestricted vault access', async () => {
    const result = await callTool(undefined, { path: 'attachments/a.png' })
    expect(result.status).toBe(ToolCallResponseStatus.Success)
  })

  it('rejects a path outside the bound assistant readable workspace', async () => {
    const result = await callTool(allowExports, { path: 'other/a.png' })
    expect(result.status).toBe(ToolCallResponseStatus.Error)
  })

  it('rejects path traversal', async () => {
    const result = await callTool(allowExports, {
      path: 'exports/../secret.md',
    })
    expect(result.status).toBe(ToolCallResponseStatus.Error)
  })

  it('rejects hidden or system paths', async () => {
    const result = await callTool(allowExports, {
      path: '.hidden/workspace.json',
    })
    expect(result.status).toBe(ToolCallResponseStatus.Error)
  })

  it('returns the normalized path when it is readable by the bound assistant', async () => {
    const result = await callTool(allowExports, {
      path: 'exports/report.pdf',
      label: 'Report',
    })
    expect(result.status).toBe(ToolCallResponseStatus.Success)
    if (result.status !== ToolCallResponseStatus.Success) {
      throw new Error('expected success')
    }
    expect(JSON.parse(result.data.text)).toEqual({
      ok: true,
      path: 'exports/report.pdf',
    })
  })
})
