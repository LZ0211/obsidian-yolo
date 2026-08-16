import { TFile, normalizePath } from 'obsidian'

import type { McpTool } from '../../../types/mcp.types'
import { ToolCallResponseStatus } from '../../../types/tool-call.types'
import {
  convertPdfToMarkdown,
  isMinerUEnabled,
  toArrayBuffer,
} from '../../../utils/pdf/mineruClient'
import {
  ensureFolderPathExists,
  validateVaultPath,
} from '../../mcp/vaultFileOps'
import { defineTool } from '../define'
import { getTextArg } from '../tool-args'

const MINERU_CONVERT_MCP_TOOL: Omit<McpTool, 'name'> = {
  description:
    'Convert a PDF file to Markdown and images via the configured MinerU service (only available when MinerU is enabled and reachable in settings). Pass inputPath (vault-relative PDF path) and outputDir (vault-relative target folder); returns the written markdown/image file list.',
  inputSchema: {
    type: 'object',
    properties: {
      inputPath: {
        type: 'string',
        description: 'Vault-relative path of the PDF to convert.',
      },
      outputDir: {
        type: 'string',
        description:
          'Vault-relative target folder for the extracted markdown and images.',
      },
    },
    required: ['inputPath', 'outputDir'],
  },
}

export const mineruConvertDefinition = defineTool({
  name: 'mineru_convert',
  getMcpTool: () => MINERU_CONVERT_MCP_TOOL,
  chatLabel: {
    key: 'settings.agent.builtinMineruConvertLabel',
    fallback: 'MinerU PDF Conversion',
  },
  contextPrunable: true,
  execute: async (args, { app, settings, signal }) => {
    if (!isMinerUEnabled(settings) || !settings?.mineru) {
      throw new Error('MinerU is not enabled or not configured in settings.')
    }

    const inputPath = validateVaultPath(getTextArg(args, 'inputPath'))
    const outputDir = validateVaultPath(getTextArg(args, 'outputDir'))
    const file = app.vault.getAbstractFileByPath(inputPath)
    if (!file || !(file instanceof TFile)) {
      throw new Error(`File not found: ${inputPath}`)
    }
    if ((file.extension ?? '').toLowerCase() !== 'pdf') {
      throw new Error(`Not a PDF file: ${inputPath}`)
    }

    const pdfBytes = await app.vault.readBinary(file)
    const raw = await convertPdfToMarkdown({
      pdfBytes,
      fileName: file.name,
      baseUrl: settings.mineru.baseUrl,
      apiKey: settings.mineru.apiKey,
      signal,
    })
    if (signal?.aborted) {
      return { status: ToolCallResponseStatus.Aborted }
    }

    await ensureFolderPathExists(app, `${outputDir}/images`)
    const resultPath = normalizePath(`${outputDir}/result.md`)
    const adapter = app.vault.adapter
    await adapter.write(resultPath, raw.markdown)
    const imageFiles: string[] = []
    for (const image of raw.images) {
      const vaultPath = normalizePath(`${outputDir}/images/${image.name}`)
      await adapter.writeBinary(vaultPath, toArrayBuffer(image.data))
      imageFiles.push(vaultPath)
    }

    return {
      status: ToolCallResponseStatus.Success,
      text: JSON.stringify({
        markdownFiles: [resultPath],
        imageFiles,
      }),
    }
  },
})
