import { defineCapability } from '../define'
import { metaSearchDefinition } from '../meta_search/definition'

export const metadataSearchCapability = defineCapability({
  id: 'metadata_search',
  label: {
    key: 'settings.agent.builtinMetaSearchLabel',
    fallback: 'Search Metadata',
  },
  description: {
    key: 'settings.agent.builtinMetaSearchDesc',
    fallback: 'Search indexed metadata and matching files',
  },
  category: 'vault',
  defaultEnabled: true,
  approval: {
    defaultMode: 'full_access',
    allowedModes: ['full_access', 'require_approval'],
    allowAlwaysAllow: true,
  },
  hasSettings: false,
  tools: [metaSearchDefinition],
})
