import type { McpTool } from '../../types/mcp.types'
import {
  type ToolCallResponse,
  ToolCallResponseStatus,
} from '../../types/tool-call.types'
import type { WorkspaceAccessPolicy } from '../agent/workspaceScope'
import { isReadablePath } from '../agent/workspaceScope'
import type { InProcessToolServer } from '../mcp/inProcessToolServer'
import { getOptionalTextArg } from '../tools/tool-args'

import { validateAttachmentPath } from './attachment-security'
import { SEND_ATTACHMENT_TOOL_NAME } from './message-converter'

const SEND_ATTACHMENT_TOOL: McpTool = {
  name: SEND_ATTACHMENT_TOOL_NAME,
  description:
    'Send a file already present in the vault as an attachment to the current bot chat. Only available in bot conversations. The path must be vault-relative and fall under one of the admin-configured allowed directories, or the call fails.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Vault-relative path of the file to send.',
      },
      label: {
        type: 'string',
        description:
          'Optional short caption shown alongside the attachment (images only).',
      },
    },
    required: ['path'],
  },
}

export function createSendAttachmentToolServer(
  workspaceAccessPolicy: WorkspaceAccessPolicy | undefined,
): InProcessToolServer {
  return {
    listTools: () => [SEND_ATTACHMENT_TOOL],
    async callTool({ toolName, args, signal }): Promise<ToolCallResponse> {
      if (signal.aborted) {
        return { status: ToolCallResponseStatus.Aborted }
      }
      if (toolName !== SEND_ATTACHMENT_TOOL_NAME) {
        return {
          status: ToolCallResponseStatus.Error,
          error: `Unknown bot tool: ${toolName}`,
        }
      }

      const path = getOptionalTextArg(args, 'path')
      if (!path || path.trim() === '') {
        return {
          status: ToolCallResponseStatus.Error,
          error: 'path is required.',
        }
      }
      const validation = validateAttachmentPath(path, {
        isAllowed: (normalizedPath) => {
          try {
            return isReadablePath(normalizedPath, workspaceAccessPolicy)
          } catch {
            return false
          }
        },
      })
      if (!validation.ok) {
        return {
          status: ToolCallResponseStatus.Error,
          error: validation.error,
        }
      }

      return {
        status: ToolCallResponseStatus.Success,
        data: {
          type: 'text',
          text: JSON.stringify({
            ok: true,
            path: validation.normalizedPath,
          }),
        },
      }
    },
  }
}
