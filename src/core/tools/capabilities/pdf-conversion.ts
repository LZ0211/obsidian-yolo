import { defineCapability } from '../define'
import { mineruConvertDefinition } from '../mineru_convert/definition'

export const pdfConversionCapability = defineCapability({
  id: 'pdf_conversion',
  label: {
    key: 'settings.agent.builtinMineruConvertLabel',
    fallback: 'MinerU PDF Conversion',
  },
  description: {
    key: 'settings.agent.builtinMineruConvertDesc',
    fallback: 'Convert PDF files to Markdown and extracted images with MinerU',
  },
  category: 'vault',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [mineruConvertDefinition],
})
