// The three built-in tools with an environment availability gate
// (`isAvailable`), and the invariant that every other tool has none —
// user authorization is a separate axis (`builtinCapabilityOptions` /
// `builtinCapabilityPreferences`), decided by `McpManager` / the settings
// UI. This pins the gates directly; the registry/catalog suites cover their
// wiring.

jest.mock('obsidian')

import { setRuntimeComponentEnabledOverrideForTests } from '../runtime-components/runtimeComponentAccess'
import { getToolDefinition, listBuiltinTools } from './registry'

afterEach(() => {
  setRuntimeComponentEnabledOverrideForTests(null)
})

describe('built-in tool availability gates (isAvailable)', () => {
  it('bash follows the bash-engine runtime component', () => {
    const bash = getToolDefinition('bash')
    setRuntimeComponentEnabledOverrideForTests(() => true)
    expect(bash?.isAvailable?.({})).toBe(true)
    setRuntimeComponentEnabledOverrideForTests(() => false)
    expect(bash?.isAvailable?.({})).toBe(false)
  })

  it('web_search requires a configured search provider; web_scrape deliberately has no gate', () => {
    const search = getToolDefinition('web_search')
    const scrape = getToolDefinition('web_scrape')

    // No settings at all → the gate resolves to unavailable.
    expect(search?.isAvailable?.({})).toBe(false)
    // No providers configured → unavailable.
    expect(
      search?.isAvailable?.({
        settings: { webSearch: { providers: [] } },
      }),
    ).toBe(false)
    // A configured provider → available.
    expect(
      search?.isAvailable?.({
        settings: {
          webSearch: {
            providers: [{ id: 'tavily', type: 'tavily', apiKey: 'k' }],
          },
        },
      }),
    ).toBe(true)

    // web_scrape falls back to the static-HTML scraper — no provider gate.
    expect(scrape?.isAvailable).toBeUndefined()
  })

  it('terminal_command follows the desktop platform', () => {
    const terminal = getToolDefinition('terminal_command')
    // The obsidian mock pins Platform.isDesktop = true.
    expect(terminal?.isAvailable?.({})).toBe(true)
  })

  it('every other built-in tool declares no availability gate', () => {
    const gated = new Set(['bash', 'web_search', 'terminal_command'])
    for (const tool of listBuiltinTools()) {
      if (gated.has(tool.name)) continue
      expect(tool.isAvailable).toBeUndefined()
    }
  })
})
